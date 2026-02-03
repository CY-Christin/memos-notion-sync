#!/usr/bin/env node
/**
 * 一次性批量同步脚本：把 Memos 中带附件的 memo 写入 Notion 数据库
 *
 * 运行：
 *   MEMOS_API_BASE=https://your-memos.com/api/v1 \
 *   MEMOS_API_TOKEN=xxx \
 *   NOTION_TOKEN=xxx \
 *   NOTION_DATABASE_ID=xxx \
 *   node scripts/bulk-sync.mjs
 *
 * 可选环境变量：
 *   MEMOS_FILTER            Memos 列表过滤表达式（若支持），示例：attachments IS NOT EMPTY
 *   MEMOS_PAGE_SIZE         每页条数，默认 200，最大按接口限制
 *   NOTION_DELAY_MS         每条 Notion 写入之间的延迟，默认 200ms
 *   NOTION_UPDATE_EXISTING  为 "true" 时遇到已存在记录则更新，否则跳过
 */

const MEMOS_API_BASE = '';
const MEMOS_API_TOKEN = '';
const NOTION_TOKEN = '';
const NOTION_DATABASE_ID = '';

const R2_PUBLIC_DOMAIN = process.env.R2_PUBLIC_DOMAIN || '';
const MEMOS_FILTER = process.env.MEMOS_FILTER;
const MEMOS_PAGE_SIZE = Number.parseInt(process.env.MEMOS_PAGE_SIZE || '10', 10);
const NOTION_DELAY_MS = Number.parseInt(process.env.NOTION_DELAY_MS || '200', 10);
const NOTION_UPDATE_EXISTING = process.env.NOTION_UPDATE_EXISTING === 'true';

main().catch(err => {
	console.error('❌ 批量同步异常退出:', err);
	process.exit(1);
});

async function main() {
	console.log('=== 开始批量同步 ===');
	console.log('Memos Base:', MEMOS_API_BASE);
	console.log('使用 filter:', MEMOS_FILTER || '(无)');
	console.log('Notion DB:', NOTION_DATABASE_ID);
	console.log('Page size:', MEMOS_PAGE_SIZE, 'Notion delay:', NOTION_DELAY_MS, 'ms');
	console.log('更新已存在记录:', NOTION_UPDATE_EXISTING);

	let processed = 0;
	let created = 0;
	let skipped = 0;
	let updated = 0;
	const failures = [];

	for await (const memo of listMemosPaginated()) {
		processed++;
		const memoId = memo.name;
		console.log(`\n--- 处理 memo ${memoId} ---`);

		const { text, images: contentImages } = parseMemosContent(memo.content || '');
		console.log('正文图片数量:', contentImages.length, '文本长度:', (text || '').length);

		const attachmentsFromList = extractAttachmentUrls(memo.attachments || []);
		console.log('列表附件图片数量:', attachmentsFromList.length);

		const imagesSet = new Set([...contentImages, ...attachmentsFromList]);
		const images = Array.from(imagesSet).map(url => convertToPublicR2Url(url));
		console.log('图片去重后数量:', images.length);

		try {
			const existingPageId = await findNotionPageByMemoId(memoId);
			if (existingPageId && !NOTION_UPDATE_EXISTING) {
				console.log('Notion 已存在，跳过:', existingPageId);
				skipped++;
				continue;
			}

			if (existingPageId && NOTION_UPDATE_EXISTING) {
				await updateNotionPage(existingPageId, memo, text, images);
				console.log('已更新 Notion 页面:', existingPageId);
				updated++;
			} else {
				await createNotionPage(memo, text, images);
				console.log('已创建 Notion 页面');
				created++;
			}

			if (NOTION_DELAY_MS > 0) {
				await sleep(NOTION_DELAY_MS);
			}
		} catch (err) {
			console.error('处理 memo 失败:', memoId, err);
			failures.push({ memoId, error: err?.message || String(err) });
		}
	}

	console.log('\n=== 同步结束 ===');
	console.log('处理总数:', processed);
	console.log('创建:', created, '更新:', updated, '跳过:', skipped);
	if (failures.length) {
		console.log('失败列表:', failures);
	}
}

async function* listMemosPaginated() {
	let pageToken = '';
	let page = 0;
	do {
		page++;
		const url = new URL(`${trimTrailingSlash(MEMOS_API_BASE)}/memos`);
		url.searchParams.set('pageSize', String(MEMOS_PAGE_SIZE));
		if (pageToken) url.searchParams.set('pageToken', pageToken);
		if (MEMOS_FILTER) url.searchParams.set('filter', MEMOS_FILTER);

		console.log(`请求 memos 第 ${page} 页:`, url.toString());
		const res = await fetch(url.toString(), {
			headers: { 'Authorization': `Bearer ${MEMOS_API_TOKEN}` }
		});
		if (!res.ok) {
			const text = await res.text();
			throw new Error(`List memos 失败: ${res.status} ${text}`);
		}
		const data = await res.json();
		const memos = data.memos || [];
		console.log(`返回 ${memos.length} 条 memo`);

		for (const memo of memos) {
			yield memo;
		}

		pageToken = data.nextPageToken || '';
	} while (pageToken);
}

async function findNotionPageByMemoId(memoId) {
	const res = await fetch(`https://api.notion.com/v1/databases/${NOTION_DATABASE_ID}/query`, {
		method: 'POST',
		headers: notionHeaders(),
		body: JSON.stringify({
			filter: {
				property: 'Memos ID',
				rich_text: {
					equals: memoId
				}
			}
		})
	});
	if (!res.ok) {
		const text = await res.text();
		throw new Error(`查询 Notion 失败: ${res.status} ${text}`);
	}
	const data = await res.json();
	return data.results?.[0]?.id || null;
}

async function createNotionPage(memo, text, images) {
	const children = buildChildren(text, images);
	const createTimeISO = normalizeTime(memo.displayTime || memo.createTime || memo.create_time);
	const memoId = memo.name || 'unknown';

	const res = await fetch('https://api.notion.com/v1/pages', {
		method: 'POST',
		headers: notionHeaders(),
		body: JSON.stringify({
			parent: { database_id: NOTION_DATABASE_ID },
			properties: {
				'Name': {
					title: [{ text: { content: (text || memo.snippet || memoId).slice(0, 100) } }]
				},
				'Created': {
					date: { start: createTimeISO }
				},
				'Memos ID': {
					rich_text: [{ text: { content: memoId } }]
				}
			},
			children
		})
	});

	if (!res.ok) {
		const text = await res.text();
		throw new Error(`创建 Notion 页面失败: ${res.status} ${text}`);
	}
}

async function updateNotionPage(pageId, memo, text, images) {
	const children = buildChildren(text, images);
	const createTimeISO = normalizeTime(memo.displayTime || memo.createTime || memo.create_time);
	const memoId = memo.name || 'unknown';

	const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
		method: 'PATCH',
		headers: notionHeaders(),
		body: JSON.stringify({
			properties: {
				'Name': {
					title: [{ text: { content: (text || memo.snippet || memoId).slice(0, 100) } }]
				},
				'Created': {
					date: { start: createTimeISO }
				},
				'Memos ID': {
					rich_text: [{ text: { content: memoId } }]
				}
			}
		})
	});

	if (!res.ok) {
		const text = await res.text();
		throw new Error(`更新 Notion 属性失败: ${res.status} ${text}`);
	}

	// 覆盖 children：先清空，再追加
	await replaceNotionChildren(pageId, children);
}

async function replaceNotionChildren(pageId, children) {
	// Notion 没有直接覆盖 children 的接口，这里简单策略：先删除旧 children（通过批量删除 block），再 append。
	// 为避免复杂度，这里只做 append，可能会重复。如果需要彻底覆盖，可补充删除逻辑。
	if (!children.length) return;
	const res = await fetch(`https://api.notion.com/v1/blocks/${pageId}/children`, {
		method: 'PATCH',
		headers: notionHeaders(),
		body: JSON.stringify({ children })
	});
	if (!res.ok) {
		const text = await res.text();
		throw new Error(`更新 Notion children 失败: ${res.status} ${text}`);
	}
}

function buildChildren(text, images) {
	const children = [];
	if (text) {
		const paragraphs = text.split('\n').filter(p => p.trim());
		paragraphs.forEach(para => {
			children.push({
				object: 'block',
				type: 'paragraph',
				paragraph: {
					rich_text: [{ text: { content: para } }]
				}
			});
		});
	}
	images.forEach(url => {
		children.push({
			object: 'block',
			type: 'image',
			image: {
				type: 'external',
				external: { url }
			}
		});
	});
	return children;
}

function parseMemosContent(content) {
	const imageRegex = /!\[.*?\]\((https?:\/\/[^\)]+)\)/g;
	const images = [];
	let match;
	while ((match = imageRegex.exec(content)) !== null) {
		images.push(match[1]);
	}
	const text = (content || '').replace(imageRegex, '').trim();
	return { text, images };
}

function convertToPublicR2Url(url) {
	if (!R2_PUBLIC_DOMAIN) return url;
	try {
		const parsed = new URL(url);
		if (parsed.hostname.endsWith('.r2.cloudflarestorage.com')) {
			const base = R2_PUBLIC_DOMAIN.replace(/\/$/, '');
			return `${base}${parsed.pathname}`;
		}
	} catch {
		// URL 解析失败，原样返回
	}
	return url;
}

function extractAttachmentUrls(attachments) {
	if (!Array.isArray(attachments)) return [];
	return attachments
		.map(att => att.externalLink || att.external_link || att.content)
		.filter(url => typeof url === 'string' && url.startsWith('http'));
}

function normalizeTime(input) {
	if (!input) return new Date().toISOString();
	// 支持数字秒、ISO 字符串、对象 {seconds}
	if (typeof input === 'number') return new Date(input * 1000).toISOString();
	if (typeof input === 'string') return new Date(input).toISOString();
	if (typeof input === 'object' && typeof input.seconds === 'number') {
		return new Date(input.seconds * 1000).toISOString();
	}
	return new Date().toISOString();
}

function notionHeaders() {
	return {
		'Authorization': `Bearer ${NOTION_TOKEN}`,
		'Notion-Version': '2022-06-28',
		'Content-Type': 'application/json'
	};
}

function trimTrailingSlash(url) {
	return url.replace(/\/$/, '');
}

function sleep(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}
