/**
 * A tool call as one short line a person can read on a phone: "搜索：寿光天气"
 * rather than `web_search {"query":"寿光天气"}`. Unknown tools still get a line.
 */
export function toolLabel(name: string, args: unknown): string {
	const input = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
	const field = (key: string): string => {
		const value = input[key];
		return typeof value === 'string' ? value.trim() : '';
	};
	const with_ = (prefix: string, value: string) => (value ? `${prefix}：${short(value)}` : prefix);
	switch (name) {
		case 'web_search':
			return with_('搜索', field('query'));
		case 'web_fetch':
			return with_('打开网页', hostOf(field('url')));
		case 'memory_write':
			return with_('记下', field('name'));
		case 'memory_read':
			return with_('翻看记忆', field('name'));
		case 'memory_search':
			return with_('查找记忆', field('query'));
		case 'set_reminder':
			return with_('设提醒', field('text'));
		case 'list_reminders':
			return '查看提醒';
		case 'cancel_reminder':
			return '取消提醒';
		case 'send_message':
			return '发消息';
		case 'read':
			return with_('读取文件', field('path'));
		case 'write':
			return with_('写入文件', field('path'));
		case 'edit':
			return with_('修改文件', field('path'));
		case 'bash':
			return with_('执行命令', field('command'));
		default:
			return `使用工具：${name}`;
	}
}

function hostOf(url: string): string {
	try {
		return new URL(url).hostname || url;
	} catch {
		return url;
	}
}

function short(text: string, max = 40): string {
	const line = text.replace(/\s+/g, ' ');
	return line.length > max ? `${line.slice(0, max)}…` : line;
}
