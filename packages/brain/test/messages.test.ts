import { describe, expect, it } from 'vitest';
import { appMessages, livePartial } from '../src/messages.ts';
import { toolLabel } from '../src/tool-labels.ts';

const at = 1_790_000_000_000;
const user = (content: unknown) => ({ role: 'user', content, timestamp: at });
const assistant = (content: unknown[]) => ({ role: 'assistant', content, timestamp: at + 1 });
const result = (toolCallId: string) => ({ role: 'toolResult', toolCallId, toolName: 'x', content: [{ type: 'text', text: 'ok' }], timestamp: at + 2 });

/** A context view as pi-durable returns it: entries, and what each puts in the model's context. */
function view(messages: unknown[][]) {
	return {
		entries: messages.map((_, index) => ({ id: index + 1, conversationId: 1, kind: 'x' })),
		contributions: messages,
	} as never;
}

describe('chat bubbles from a conversation', () => {
	it('folds one run into one bubble: words, thinking and tools, without tool results or system notes', () => {
		const messages = appMessages(
			view([
				[user('寿光明天天气怎么样')],
				[{ role: 'system', content: 'time', timestamp: at }],
				[assistant([{ type: 'thinking', thinking: '要查天气' }, { type: 'text', text: '我查一下。' }, { type: 'toolCall', id: 'c1', name: 'web_search', arguments: { query: '寿光 明天 天气' } }])],
				[result('c1')],
				[assistant([{ type: 'text', text: '明天晴，12 到 20 度。' }])],
			]),
		);
		expect(messages).toEqual([
			{ id: '1', role: 'user', text: '寿光明天天气怎么样', at },
			{
				id: '3',
				role: 'assistant',
				text: '我查一下。\n\n明天晴，12 到 20 度。',
				thinking: '要查天气',
				tools: [{ name: 'web_search', label: '搜索：寿光 明天 天气' }],
				at: at + 1,
			},
		]);
	});

	it('gives pictures back as data URIs', () => {
		const [message] = appMessages(view([[user([{ type: 'text', text: '这是什么' }, { type: 'image', data: 'AAAA', mimeType: 'image/png' }])]]));
		expect(message).toMatchObject({ role: 'user', text: '这是什么', images: ['data:image/png;base64,AAAA'] });
	});

	it('shows a reminder that woke the agent as the reminder, not as something the user said', () => {
		const messages = appMessages(view([[user('[定时任务触发] 该关火了')], [assistant([{ type: 'text', text: '记得关火。' }])]]));
		expect(messages.map((message) => [message.role, message.text])).toEqual([
			['assistant', '⏰ 该关火了'],
			['assistant', '记得关火。'],
		]);
	});

	it('keeps a line said on the way as words of the answer, not as a tool', () => {
		const [, answer] = appMessages(
			view([
				[user('写篇长文')],
				[assistant([{ type: 'toolCall', id: 'c1', name: 'send_message', arguments: { text: '这就写，要几分钟。' } }])],
				[result('c1')],
				[assistant([{ type: 'text', text: '写好了。' }])],
			]),
		);
		expect(answer).toMatchObject({ role: 'assistant', text: '这就写，要几分钟。\n\n写好了。' });
		expect(answer?.tools).toBeUndefined();
	});

	it('leaves out the silence a plain reminder is answered with', () => {
		const messages = appMessages(view([[user('[定时任务触发] 喝水')], [assistant([{ type: 'text', text: 'NO_REPLY' }])]]));
		expect(messages.map((message) => message.text)).toEqual(['⏰ 喝水']);
	});

	it('drops an empty answer and keeps the newest when there are too many', () => {
		const many = Array.from({ length: 10 }, (_, index) => [user(`第 ${index} 条`)]);
		expect(appMessages(view([...many, [assistant([])]]), 3).map((message) => message.text)).toEqual(['第 7 条', '第 8 条', '第 9 条']);
	});
});

describe('the answer being written', () => {
	const entries = (messages: unknown[][], first = 1) =>
		messages.map((model, index) => ({ id: first + index, conversationId: 1, kind: 'x', model }));

	it('counts only what came after the run started, then the generation still streaming', () => {
		const partial = livePartial(
			{
				entries: entries([
					[assistant([{ type: 'text', text: '上一次的回答' }])],
					[user('新问题')],
					[assistant([{ type: 'text', text: '我查一下。' }, { type: 'toolCall', id: 'c1', name: 'web_fetch', arguments: { url: 'https://www.weather.com.cn/x' } }])],
					[result('c1')],
				]),
				docs: {
					'pi.live': {
						run: { taskId: 1, inputs: [], turns: 1 },
						generation: { attempt: 1, message: assistant([{ type: 'thinking', thinking: '整理一下' }, { type: 'text', text: '明天' }]) },
					},
				},
			} as never,
			1,
		);
		expect(partial).toEqual({
			text: '我查一下。\n\n明天',
			thinking: '整理一下',
			tools: [{ name: 'web_fetch', label: '打开网页：www.weather.com.cn', done: true }],
		});
	});

	it('marks a tool done from its live slot before its result is committed', () => {
		const partial = livePartial(
			{
				entries: entries([[assistant([{ type: 'toolCall', id: 'c9', name: 'memory_search', arguments: { query: '车' } }])]], 5),
				docs: { 'pi.live': { tools: [{ callId: 'c9', name: 'memory_search', status: 'done' }] } },
			} as never,
			4,
		);
		expect(partial.tools).toEqual([{ name: 'memory_search', label: '查找记忆：车', done: true }]);
	});

	it('is empty before anything was written', () => {
		expect(livePartial({ entries: [], docs: {} } as never, 0)).toEqual({ text: '', thinking: '', tools: [] });
	});
});

describe('tool labels', () => {
	it('says what each tool does, short', () => {
		expect(toolLabel('web_search', { query: '寿光天气' })).toBe('搜索：寿光天气');
		expect(toolLabel('memory_write', { name: 'car', content: 'x' })).toBe('记下：car');
		expect(toolLabel('set_reminder', { text: '关火' })).toBe('设提醒：关火');
		expect(toolLabel('list_reminders', {})).toBe('查看提醒');
		expect(toolLabel('web_search', { query: '很'.repeat(60) })).toHaveLength('搜索：'.length + 41);
		expect(toolLabel('something_new', null)).toBe('使用工具：something_new');
	});
});
