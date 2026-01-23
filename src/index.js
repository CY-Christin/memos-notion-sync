/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

export default {
	async fetch(request, env) {
		console.log('=== 收到请求 ===');
		console.log('请求方法:', request.method);
		console.log('请求URL:', request.url);
		console.log('环境变量检查:');
		console.log('- NOTION_TOKEN 已配置:', !!env.NOTION_TOKEN);
		console.log('- NOTION_DATABASE_ID:', env.NOTION_DATABASE_ID);

		// 只接受 POST 请求
		if (request.method !== 'POST') {
			console.log('拒绝非POST请求');
			return new Response('Method not allowed', { status: 405 });
		}

		try {
			const payload = await request.json();
			console.log('收到的payload:', JSON.stringify(payload, null, 2));

			const { activityType, memo } = payload;
			console.log('activityType:', activityType);
			console.log('memo对象:', memo ? JSON.stringify(memo, null, 2) : 'null');

			// 只处理创建事件
			if (activityType !== 'memos.memo.created') {
				console.log('忽略非创建事件:', activityType);
				return new Response(JSON.stringify({ status: 'ignored' }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				});
			}

			console.log('开始处理memo.created事件');

			// 解析正文里的图片
			const { text, images: contentImages } = parseMemosContent(memo.content);
			console.log('解析后的文本:', text);
			console.log('正文解析到的图片数量:', contentImages.length);
			console.log('正文图片URLs:', contentImages);

			// 收集附件中的图片（payload 自带 + 延迟后主动拉取）
			const imagesSet = new Set(contentImages);

			// 1) payload 附件（如果有）
			const payloadAttachmentImages = extractAttachmentUrls(memo.attachments || []);
			payloadAttachmentImages.forEach(url => imagesSet.add(url));
			console.log('payload 附件图片数量:', payloadAttachmentImages.length, 'URLs:', payloadAttachmentImages);

			// 2) 延迟 10 秒后从 Memos API 再拉一次附件，防止创建事件里还没生成外链
			const fetchedAttachmentImages = await fetchAttachmentImagesAfterDelay(memo, env, 10_000);
			fetchedAttachmentImages.forEach(url => imagesSet.add(url));
			console.log('API 拉取附件图片数量:', fetchedAttachmentImages.length, 'URLs:', fetchedAttachmentImages);

			const images = Array.from(imagesSet);
			console.log('最终图片去重后数量:', images.length);
			console.log('最终图片URLs:', images);

			// 构建 Notion blocks
			const children = [];

			// 添加文字段落
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

			// 添加图片
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

			// 提取memo ID和创建时间
			const memoId = memo.name || 'unknown';
			const createTimeISO = memo.create_time?.seconds
				? new Date(memo.create_time.seconds * 1000).toISOString()
				: new Date().toISOString();

			console.log('构建的Notion blocks数量:', children.length);
			console.log('准备发送到Notion的数据:');
			console.log('- Database ID:', env.NOTION_DATABASE_ID);
			console.log('- Token存在:', !!env.NOTION_TOKEN);
			console.log('- Memo Name:', memoId);
			console.log('- 标题:', (text || memoId).slice(0, 100));
			console.log('- 创建时间:', createTimeISO);

			// 调用 Notion API
			const notionResponse = await fetch('https://api.notion.com/v1/pages', {
				method: 'POST',
				headers: {
					'Authorization': `Bearer ${env.NOTION_TOKEN}`,
					'Notion-Version': '2022-06-28',
					'Content-Type': 'application/json'
				},
				body: JSON.stringify({
					parent: {
						database_id: env.NOTION_DATABASE_ID
					},
					properties: {
						'Name': {
							title: [{
								text: {
									content: (text || memoId).slice(0, 100)
								}
							}]
						},
						'Created': {
							date: { start: createTimeISO }
						},
						'Memos ID': {
							rich_text: [{
								text: {
									content: memoId
								}
							}]
						}
					},
					children: children
				})
			});

			console.log('Notion API 响应状态:', notionResponse.status);
			console.log('Notion API 响应OK:', notionResponse.ok);

			if (!notionResponse.ok) {
				const error = await notionResponse.text();
				console.error('❌ Notion API 错误:');
				console.error('状态码:', notionResponse.status);
				console.error('错误内容:', error);
				return new Response(JSON.stringify({ error }), {
					status: 500,
					headers: { 'Content-Type': 'application/json' }
				});
			}

			const notionResult = await notionResponse.json();
			console.log('✅ Notion API 成功响应:', JSON.stringify(notionResult, null, 2));

			return new Response(JSON.stringify({
				status: 'success',
				memo_id: memoId,
				images_count: images.length
			}), {
				status: 200,
				headers: { 'Content-Type': 'application/json' }
			});

		} catch (error) {
			console.error('❌ Worker 捕获到错误:');
			console.error('错误信息:', error.message);
			console.error('错误堆栈:', error.stack);
			console.error('错误对象:', error);
			return new Response(JSON.stringify({
				error: error.message,
				stack: error.stack
			}), {
				status: 500,
				headers: { 'Content-Type': 'application/json' }
			});
		}
	}
};

// 解析 Memos 内容
function parseMemosContent(content) {
	// 匹配 Markdown 图片: ![alt](url)
	const imageRegex = /!\[.*?\]\((https?:\/\/[^\)]+)\)/g;
	const images = [];
	let match;

	while ((match = imageRegex.exec(content)) !== null) {
		images.push(match[1]);
	}

	// 去掉图片标记，保留纯文本
	const text = content.replace(imageRegex, '').trim();

	return { text, images };
}

// 从附件列表里提取图片 URL，支持 externalLink / external_link / content
function extractAttachmentUrls(attachments) {
	if (!Array.isArray(attachments)) return [];
	return attachments
		.map(att => att.externalLink || att.external_link || att.content)
		.filter(url => typeof url === 'string' && url.startsWith('http'));
}

// 等待指定时间后调用 Memos API 获取附件
async function fetchAttachmentImagesAfterDelay(memo, env, delayMs) {
	if (!memo?.name) {
		console.warn('缺少 memo.name，无法拉取附件');
		return [];
	}

	const memosConfig = validateMemosConfig(env);
	if (!memosConfig.ok) {
		console.warn('Memos 配置校验未通过，跳过附件拉取', memosConfig);
		return [];
	}

	if (delayMs > 0) {
		console.log(`等待 ${delayMs}ms 后再去拉取附件`);
		await new Promise(resolve => setTimeout(resolve, delayMs));
	}

	const memoId = memo.name.split('/').pop();
	const base = memosConfig.base;
	const url = `${base}/memos/${memoId}/attachments`;

	console.log('请求 Memos 附件:', url);
	console.log('请求头 Authorization 是否存在:', !!memosConfig.token);

	const res = await fetch(url, {
		method: 'GET',
		headers: {
			'Authorization': `Bearer ${memosConfig.token}`
		}
	});

	if (!res.ok) {
		const errText = await res.text();
		console.error('拉取附件失败', res.status, errText);
		return [];
	}

	let data;
	try {
		data = await res.json();
	} catch (e) {
		console.error('解析附件响应失败', e);
		return [];
	}

	const attachments = data?.attachments || [];
	console.log('拉取到附件数量:', attachments.length, 'attachments:', attachments);
	return extractAttachmentUrls(attachments);
}

// 校验 Memos 配置，确保 base/token 基本合法
function validateMemosConfig(env) {
	const errors = [];
	const base = env.MEMOS_API_BASE;
	const token = env.MEMOS_API_TOKEN;

	if (!base) {
		errors.push('缺少 MEMOS_API_BASE');
	} else if (!/^https?:\/\//.test(base)) {
		errors.push('MEMOS_API_BASE 必须是 http/https URL');
	}

	if (!token) {
		errors.push('缺少 MEMOS_API_TOKEN');
	}

	return {
		ok: errors.length === 0,
		base: base ? base.replace(/\/$/, '') : '',
		token,
		errors
	};
}
