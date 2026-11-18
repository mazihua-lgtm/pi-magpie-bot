import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxThinking,
	fauxToolCall,
	type FauxResponseStep,
	type SimpleStreamOptions,
	type TranscriptContext,
} from '@earendil-works/pi-ai';
import { afterEach, describe, expect, it } from 'vitest';
import { AppError, AppService, type AppEvent, type AppServiceOptions, Bot, conversationIdFor } from '../src/index.ts';

/**
 * The app's view of the bot, against a real bot and a scripted model: what
 * these tests care about is the chats, the live events and the settings around
 * a run, so the model only has to say something, slowly when it matters.
 */
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const OWNER = '6f1c2a90-4b7e-4c55-9d1e-3a2b1c0d9e8f';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

interface Seen {
	model: string;
	reasoning: SimpleStreamOptions['reasoning'];
	context: TranscriptContext;
}

async function setup(
	options: { dataDir?: string; tokensPerSecond?: number; workspaceDir?: string; app?: AppServiceOptions; responses?: FauxResponseStep[] } = {},
) {
	const seen: Seen[] = [];
	const faux = fauxProvider({
		provider: 'magpie',
		models: [
			{ id: 'm1', name: 'Model One', reasoning: true, input: ['text', 'image'] },
			{ id: 'm2', name: 'Model Two', reasoning: false, input: ['text'] },
		],
		...(options.tokensPerSecond ? { tokensPerSecond: options.tokensPerSecond } : {}),
	});
	const models = createModels();
	models.setProvider(faux.provider);
	/** Every request is recorded, then answered with the next scripted step. */
	const script = (steps: FauxResponseStep[]) =>
		faux.setResponses(
			steps.map((step) => async (context, streamOptions, state, model) => {
				seen.push({ model: model.id, reasoning: streamOptions?.reasoning, context });
				return typeof step === 'function' ? step(context, streamOptions, state, model) : step;
			}),
		);
	script(options.responses ?? []);

	const dataDir = options.dataDir ?? (await mkdtemp(join(tmpdir(), 'app-')));
	const bot = await Bot.open({ dataDir, models, modelId: 'm1', ...(options.workspaceDir ? { workspaceDir: options.workspaceDir } : {}) });
	const sent: Array<{ target: string; text: string; kind?: string }> = [];
	bot.register({
		id: 'web',
		async send(target, text, meta) {
			sent.push({ target, text, ...(meta?.kind ? { kind: meta.kind } : {}) });
		},
	});
	const app = new AppService(bot, { titler: async () => '天气问答', ...options.app });
	const events: Array<{ owner: string; at: number } & AppEvent> = [];
	app.subscribe((owner, event) => events.push({ owner, at: Date.now(), ...event }));
	const stop = bot.start(60 * 60_000);
	let closed = false;
	const close = async () => {
		if (closed) return;
		closed = true;
		stop();
		await bot.close();
	};
	cleanups.push(close);
	return { bot, app, sent, events, seen, script, dataDir, close };
}

async function until(check: () => boolean | Promise<boolean>, ms = 5_000): Promise<void> {
	const end = Date.now() + ms;
	while (!(await check())) {
		if (Date.now() > end) throw new Error('timed out waiting');
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

/** The data of every event of one name, in order. */
const named = <E extends AppEvent['event']>(events: Array<{ owner: string; at: number } & AppEvent>, event: E) =>
	events.filter((entry) => entry.event === event).map((entry) => entry.data as Extract<AppEvent, { event: E }>['data']);

describe('chats', () => {
	it('makes a chat from its first message, streams the answer, and names the chat after it', async () => {
		const answer = '明天寿光晴，最高二十度，最低十二度，东北风三级，适合出门。'.repeat(3);
		const { app, sent, events } = await setup({
			tokensPerSecond: 40,
			responses: [fauxAssistantMessage([fauxThinking('先想想明天的天气'), fauxText(answer)])],
		});

		const question = '明天寿光的天气怎么样？我要不要带伞出门呢，还是穿厚一点就够了';
		const chat = app.send(OWNER, 'new', { text: `  ${question}  ` });
		expect(chat).toMatchObject({ title: `${question.slice(0, 24)}…`, busy: true, pinned: false, model: null, thinking: false });

		await until(() => sent.length > 0);
		expect(sent).toEqual([{ target: `${OWNER}/${chat.id}`, text: answer, kind: 'answer' }]);

		// Partial answers grew as it was written, at most about ten a second.
		const partials = named(events, 'partial');
		expect(partials.length).toBeGreaterThan(1);
		expect(partials.every((partial) => partial.chat === chat.id)).toBe(true);
		const times = events.filter((entry) => entry.event === 'partial').map((entry) => entry.at);
		for (let i = 1; i < times.length; i++) expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(90);
		const texts = partials.map((partial) => partial.text);
		for (let i = 1; i < texts.length; i++) expect(texts[i]!.length).toBeGreaterThanOrEqual(texts[i - 1]!.length);
		expect(answer.startsWith(texts[texts.length - 1]!)).toBe(true);

		// Busy, then not.
		await until(() => named(events, 'status').some((status) => !status.busy));
		expect(named(events, 'status').map((status) => status.busy)).toEqual([true, false]);

		// The first-words title, then the model's.
		await until(() => named(events, 'chat').some((entry) => entry.title === '天气问答'));
		expect(app.chats(OWNER)).toEqual([expect.objectContaining({ id: chat.id, title: '天气问答', busy: false })]);

		const history = await app.messages(OWNER, chat.id);
		expect(history.busy).toBe(false);
		expect(history.partial).toBeUndefined();
		expect(history.messages.map((message) => [message.role, message.text])).toEqual([
			['user', question],
			['assistant', answer],
		]);
		expect(history.messages[1]?.thinking).toBe('先想想明天的天气');
	});

	it('asks the default model for a title when no titler is given', async () => {
		const { app, events, sent } = await setup({
			app: { titler: undefined },
			responses: [fauxAssistantMessage('好的'), fauxAssistantMessage('标题：「记账提醒」。')],
		});
		const chat = app.send(OWNER, 'new', { text: '提醒我每个月记账' });
		await until(() => sent.length > 0);
		await until(() => named(events, 'chat').some((entry) => entry.title === '记账提醒'));
		expect(app.chats(OWNER)[0]).toMatchObject({ id: chat.id, title: '记账提醒' });
	});

	it('lists pinned chats first, then the newest, and keeps a title the user typed', async () => {
		const { app } = await setup();
		const first = app.createChat(OWNER, '工作');
		await new Promise((resolve) => setTimeout(resolve, 5));
		const second = app.createChat(OWNER);
		expect(second.title).toBe('新对话');
		expect(app.chats(OWNER).map((chat) => chat.id)).toEqual([second.id, first.id]);

		app.updateChat(OWNER, first.id, { pinned: true });
		expect(app.chats(OWNER).map((chat) => chat.id)).toEqual([first.id, second.id]);

		expect(app.updateChat(OWNER, second.id, { title: '  家里的事 ' }).title).toBe('家里的事');
		expect(() => app.updateChat(OWNER, second.id, { title: '' })).toThrow(AppError);
		expect(() => app.updateChat(OWNER, second.id, { pinned: 'yes' })).toThrow(AppError);
		// Another phone sees none of it.
		expect(app.chats('someone-else-entirely')).toEqual([]);
		expect(() => app.updateChat('someone-else-entirely', first.id, { pinned: false })).toThrow(/没有这个对话/);
	});

	it('shows the conversation an older page had as the chat "default"', async () => {
		const { app, bot, sent, script } = await setup();
		script([fauxAssistantMessage('你好呀')]);
		bot.ingest({ source: 'web', sourceKey: '1', channel: 'web', target: OWNER, text: '你好' });
		await until(() => sent.length > 0);

		expect(app.chats(OWNER)).toEqual([expect.objectContaining({ id: 'default', title: '之前的对话' })]);
		const history = await app.messages(OWNER, 'default');
		expect(history.messages.map((message) => message.text)).toEqual(['你好', '你好呀']);
	});

	it('deletes a chat with its reminders, and a new message to the same id starts fresh', async () => {
		const { app } = await setup();
		const chat = app.createChat(OWNER, '要删的');
		app.addSchedule(OWNER, { chat: chat.id, text: '喝水', at: Date.now() + 60_000 });
		expect(app.schedules(OWNER)).toHaveLength(1);

		await app.deleteChat(OWNER, chat.id);
		expect(app.chats(OWNER)).toEqual([]);
		expect(app.schedules(OWNER)).toEqual([]);
		await expect(app.messages(OWNER, chat.id)).rejects.toMatchObject({ status: 404 });
		await expect(app.deleteChat(OWNER, chat.id)).rejects.toMatchObject({ status: 404 });
	});

	it('drops what the outbox still holds for a deleted chat', async () => {
		const { bot } = await setup();
		const row = bot.tables.chats.create({ conversation: conversationIdFor('web', `${OWNER}/x`), channel: 'web', owner: OWNER, chat: 'x', title: 'X', titleState: 'user' });
		bot.tables.outbox.enqueue({ conversation: row.conversation, channel: 'web', target: `${OWNER}/x`, text: '删了还会到吗' });
		const app = new AppService(bot);
		await app.deleteChat(OWNER, 'x');
		expect(bot.tables.outbox.next(9_999_999_999_999)?.conversation === row.conversation).toBe(false);
	});

	it('refuses an empty message and a bad image', async () => {
		const { app } = await setup();
		expect(() => app.send(OWNER, 'new', { text: '  ' })).toThrow(/空的/);
		expect(() => app.send(OWNER, 'new', { text: 'x', images: [{ data: PNG, mimeType: 'image/tiff' }] })).toThrow(/png/);
		expect(() => app.send(OWNER, 'new', { text: 'x', images: [{ data: '不是 base64!', mimeType: 'image/png' }] })).toThrow(/坏了/);
		expect(() => app.send(OWNER, 'new', { text: 'x', images: 'nope' })).toThrow(AppError);
		expect(() => app.send(OWNER, 'nonexistent', { text: 'x' })).toThrow(/没有这个对话/);
		// Nothing was made by the refusals.
		expect(app.chats(OWNER)).toEqual([]);
	});
});

describe('models and thinking', () => {
	it('lists the models with what they can do, and keeps a new default across a restart', async () => {
		const { app, close, dataDir } = await setup();
		expect(app.models()).toEqual({
			models: [
				{ id: 'm1', name: 'Model One', reasoning: true, vision: true },
				{ id: 'm2', name: 'Model Two', reasoning: false, vision: false },
			],
			default: 'm1',
		});
		expect(() => app.setDefaultModel('nope')).toThrow(AppError);
		app.setDefaultModel('m2');
		expect(app.models().default).toBe('m2');

		await close();
		const again = await setup({ dataDir });
		expect(again.app.models().default).toBe('m2');
	});

	it('runs a chat on its own model and thinking, and the rest on the default', async () => {
		const { app, sent, seen, script } = await setup();
		script([fauxAssistantMessage('一'), fauxAssistantMessage('二'), fauxAssistantMessage('三'), fauxAssistantMessage('四')]);

		const chat = app.createChat(OWNER);
		app.send(OWNER, chat.id, { text: '第一句' });
		await until(() => sent.length === 1);
		expect(seen[0]).toMatchObject({ model: 'm1', reasoning: undefined });
		// The system prompt is the conversation's instructions.
		expect(JSON.stringify(seen[0]?.context.messages)).toContain('You are 喜鹊 (Magpie), a personal assistant living in a chat window');

		app.updateChat(OWNER, chat.id, { thinking: true });
		app.send(OWNER, chat.id, { text: '第二句' });
		await until(() => sent.length === 2);
		expect(seen[1]).toMatchObject({ model: 'm1', reasoning: 'medium' });

		// m2 cannot reason: thinking on asks for nothing there.
		expect(() => app.updateChat(OWNER, chat.id, { model: 'nope' })).toThrow(AppError);
		app.updateChat(OWNER, chat.id, { model: 'm2' });
		app.send(OWNER, chat.id, { text: '第三句' });
		await until(() => sent.length === 3);
		expect(seen[2]).toMatchObject({ model: 'm2', reasoning: undefined });

		// Back to the default, which has moved meanwhile.
		app.setDefaultModel('m2');
		app.updateChat(OWNER, chat.id, { model: null, thinking: false });
		app.send(OWNER, chat.id, { text: '第四句' });
		await until(() => sent.length === 4);
		expect(seen[3]?.model).toBe('m2');
	});

	it('hands pictures to the model and gives them back in the history', async () => {
		const { app, sent, seen, script } = await setup();
		script([fauxAssistantMessage('一个红点')]);
		const chat = app.send(OWNER, 'new', { text: '这是什么', images: [{ data: `data:image/png;base64,${PNG}` }] });
		expect(chat.title).toBe('这是什么');
		await until(() => sent.length === 1);

		const last = seen[0]?.context.messages.at(-1);
		expect(last?.role).toBe('user');
		expect(JSON.stringify(last?.content)).toContain('"type":"image"');

		const history = await app.messages(OWNER, chat.id);
		expect(history.messages[0]).toMatchObject({ role: 'user', text: '这是什么', images: [`data:image/png;base64,${PNG}`] });

		// A model that cannot see refuses up front instead of failing the run.
		app.updateChat(OWNER, chat.id, { model: 'm2' });
		expect(() => app.send(OWNER, chat.id, { text: '再看看', images: [{ data: PNG, mimeType: 'image/png' }] })).toThrow(/看不了图片/);
	});
});

describe('stopping', () => {
	it('stops a run in the middle, with no "no answer" notice, and shows the partial meanwhile', async () => {
		const { app, sent, events } = await setup({
			tokensPerSecond: 30,
			responses: [fauxAssistantMessage('这是一段很长的回答，'.repeat(40))],
		});
		const chat = app.send(OWNER, 'new', { text: '讲个长故事' });
		await until(() => named(events, 'partial').length > 0);

		const during = await app.messages(OWNER, chat.id);
		expect(during.busy).toBe(true);
		expect(during.partial?.text).toMatch(/^这是一段/);

		await app.stop(OWNER, chat.id);
		await until(() => named(events, 'status').some((status) => !status.busy));
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(sent).toEqual([]);
		expect(app.chats(OWNER)[0]?.busy).toBe(false);
	});
});

describe('reminders', () => {
	it('adds, lists and removes the reminders of every chat of one phone', async () => {
		const { app } = await setup();
		const a = app.createChat(OWNER, 'A');
		const b = app.createChat(OWNER, 'B');
		const now = Date.now();
		const later = app.addSchedule(OWNER, { chat: a.id, text: '开会', at: now + 120_000, everyMs: 24 * 60 * 60_000 });
		const sooner = app.addSchedule(OWNER, { chat: b.id, text: '喝水', at: now + 60_000 });
		expect(later).toMatchObject({ chat: a.id, text: '开会', nextRunAt: now + 120_000, everyMs: 86_400_000 });
		expect(app.schedules(OWNER).map((schedule) => schedule.id)).toEqual([sooner.id, later.id]);
		expect(app.schedules('another-phone-0000')).toEqual([]);

		expect(() => app.removeSchedule('another-phone-0000', sooner.id)).toThrow(/没有这个提醒/);
		app.removeSchedule(OWNER, sooner.id);
		expect(app.schedules(OWNER).map((schedule) => schedule.id)).toEqual([later.id]);
	});

	it('refuses a time already past, a repeat under a minute, and a chat that is not there', async () => {
		const { app } = await setup();
		const chat = app.createChat(OWNER);
		expect(() => app.addSchedule(OWNER, { chat: chat.id, text: 'x', at: Date.now() - 1 })).toThrow(/过去/);
		expect(() => app.addSchedule(OWNER, { chat: chat.id, text: 'x', at: Date.now() + 60_000, everyMs: 0 })).toThrow(/一分钟/);
		expect(() => app.addSchedule(OWNER, { chat: chat.id, text: '', at: Date.now() + 60_000 })).toThrow(/空的/);
		expect(() => app.addSchedule(OWNER, { chat: 'missing', text: 'x', at: Date.now() + 60_000 })).toThrow(/没有这个对话/);
	});

	it('fires a reminder into its chat', async () => {
		const { app, sent, script } = await setup();
		script([fauxAssistantMessage('别忘了')]);
		const chat = app.createChat(OWNER);
		app.addSchedule(OWNER, { chat: chat.id, text: '该关火了', at: Date.now() + 150 });
		await until(() => sent.some((message) => message.text === '⏰ 该关火了'));
		expect(sent.find((message) => message.text === '⏰ 该关火了')).toEqual({ target: `${OWNER}/${chat.id}`, text: '⏰ 该关火了', kind: 'reminder' });
	});

	it('says a plain reminder once: the run behind it may stay silent', async () => {
		const { app, sent, events, script } = await setup();
		script([fauxAssistantMessage('NO_REPLY')]);
		const chat = app.createChat(OWNER);
		app.addSchedule(OWNER, { chat: chat.id, text: '喝水', at: Date.now() + 150 });
		await until(() => named(events, 'status').some((status) => !status.busy));
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(sent.map((message) => message.text)).toEqual(['⏰ 喝水']);
		const history = await app.messages(OWNER, chat.id);
		expect(history.messages.map((message) => message.text)).toEqual(['⏰ 喝水']);
	});
});

describe('memory', () => {
	it('is shared by every chat of one phone', async () => {
		const { app, sent, script } = await setup();
		script([
			fauxAssistantMessage([fauxToolCall('memory_write', { name: 'car', content: '车是蓝色的比亚迪' })], { stopReason: 'toolUse' }),
			fauxAssistantMessage('记下了'),
			fauxAssistantMessage([fauxToolCall('memory_read', { name: 'car' })], { stopReason: 'toolUse' }),
			(context) => {
				const last = context.messages.at(-1);
				return fauxAssistantMessage(JSON.stringify(last?.content ?? '').includes('比亚迪') ? '蓝色比亚迪' : '不知道');
			},
		]);
		const one = app.send(OWNER, 'new', { text: '我的车是蓝色比亚迪' });
		await until(() => sent.length === 1);
		app.send(OWNER, 'new', { text: '我的车是什么' });
		await until(() => sent.length === 2);
		expect(sent[1]?.text).toBe('蓝色比亚迪');
		expect(one.id).not.toBe(app.chats(OWNER)[0]?.id ?? one.id);

		expect(await app.memory(OWNER)).toEqual([{ name: 'car', content: '车是蓝色的比亚迪' }]);
		expect(await app.memory('another-phone-0000')).toEqual([]);
	});

	it('writes and deletes notes, and keeps the index in step', async () => {
		const { app, bot } = await setup();
		await app.writeMemory(OWNER, 'work-hours', '九点上班');
		await app.writeMemory(OWNER, 'pet', '猫叫豆包');
		expect((await app.memory(OWNER)).map((note) => note.name)).toEqual(['pet', 'work-hours']);
		await expect(app.writeMemory(OWNER, 'x', '')).rejects.toMatchObject({ status: 400 });

		await app.deleteMemory(OWNER, 'pet');
		expect((await app.memory(OWNER)).map((note) => note.name)).toEqual(['work-hours']);
		const scope = await bot.memoryScope('web', OWNER);
		expect(await bot.tables.memory.readIndex(scope)).not.toContain('pet');
		await expect(app.deleteMemory(OWNER, 'pet')).rejects.toMatchObject({ status: 404 });
	});

	it('brings along the notes an older version kept for the first conversation', async () => {
		const first = await setup();
		first.script([fauxAssistantMessage('你好')]);
		first.bot.ingest({ source: 'web', sourceKey: '1', channel: 'web', target: OWNER, text: '你好' });
		await until(() => first.sent.length === 1);
		const legacy = first.bot.tables.targets.get(conversationIdFor('web', OWNER))?.agentConversation;
		expect(legacy).toBeDefined();
		await first.close();

		// What the old version left: notes under the numeric conversation id.
		const dir = join(first.dataDir, 'memory', String(legacy), 'notes');
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, 'name.md'), '叫我老张');
		await writeFile(join(dir, 'index.md'), '- name: 叫我老张\n');

		const { app } = await setup({ dataDir: first.dataDir });
		expect(await app.memory(OWNER)).toEqual([{ name: 'name', content: '叫我老张' }]);
		// Every new chat of the phone sees them too, not only the old one.
		await app.writeMemory(OWNER, 'city', '寿光');
		expect((await app.memory(OWNER)).map((note) => note.name)).toEqual(['city', 'name']);
	});
});

describe('approvals', () => {
	it('sends a card as an event, takes the answer from a button, and says how it ended', async () => {
		const workspaceDir = await mkdtemp(join(tmpdir(), 'ws-'));
		await writeFile(join(workspaceDir, 'note.txt'), '秘密内容');
		const { app, sent, events } = await setup({
			workspaceDir,
			responses: [fauxAssistantMessage([fauxToolCall('read', { path: 'note.txt' })], { stopReason: 'toolUse' }), fauxAssistantMessage('读完了')],
		});
		const chat = app.send(OWNER, 'new', { text: '读一下 note.txt' });

		await until(() => named(events, 'approval').length === 1);
		const [card] = named(events, 'approval');
		expect(card).toMatchObject({ chat: chat.id, action: '读取文件 note.txt' });
		expect(card!.expiresAt).toBeGreaterThan(Date.now());
		// The words of the card still go out, marked, for the channel to leave out.
		await until(() => sent.some((message) => message.kind === 'approval'));
		expect(app.pendingApprovals(OWNER)).toEqual([{ event: 'approval', data: expect.objectContaining({ id: card!.id, chat: chat.id }) }]);

		expect(() => app.decide('another-phone-0000', card!.id, true)).toThrow(/没有这个请求/);
		expect(() => app.decide(OWNER, card!.id, 'yes')).toThrow(AppError);
		app.decide(OWNER, card!.id, true);
		expect(() => app.decide(OWNER, card!.id, false)).toThrow(/处理过了/);

		await until(() => named(events, 'approval_done').length === 1, 4_000);
		expect(named(events, 'approval_done')).toEqual([{ chat: chat.id, id: card!.id, status: 'allowed' }]);
		await until(() => sent.some((message) => message.text === '读完了'));
		expect(app.pendingApprovals(OWNER)).toEqual([]);

		const history = await app.messages(OWNER, chat.id);
		expect(history.messages[1]).toMatchObject({ role: 'assistant', text: '读完了', tools: [{ name: 'read', label: '读取文件：note.txt' }] });
	}, 15_000);
});

describe('model keys', () => {
	it('lists the vendors, saves a key through the host, and restarts only when asked', async () => {
		const saved: Array<{ preset?: string; key: string; custom?: unknown }> = [];
		let restarts = 0;
		const { app } = await setup({
			app: {
				vendors: [{ preset: 'deepseek', name: 'DeepSeek', signupUrl: 'https://platform.deepseek.com' }],
				saveProvider: async (input) => {
					saved.push(input);
					return '加好了';
				},
				restart: () => {
					restarts += 1;
				},
			},
		});
		expect(app.vendors()).toEqual([{ preset: 'deepseek', name: 'DeepSeek', signupUrl: 'https://platform.deepseek.com' }]);
		// A vendor the guide names but the first-run list leaves out still goes
		// through: magpie, not this list, decides which vendors it knows.
		expect(await app.saveProvider({ preset: 'siliconflow', key: ' sk-123 ' })).toBe('加好了');
		await expect(app.saveProvider({ preset: 'Nope', key: 'sk-1' })).rejects.toMatchObject({ status: 400 });
		await expect(app.saveProvider({ preset: '--help', key: 'sk-1' })).rejects.toMatchObject({ status: 400 });
		await expect(app.saveProvider({ preset: 'deepseek', key: 'sk 1' })).rejects.toMatchObject({ status: 400 });
		expect(saved).toEqual([{ preset: 'siliconflow', key: 'sk-123' }]);
		expect(restarts).toBe(0);
		app.restart();
		expect(restarts).toBe(1);
	});

	it("takes an endpoint of the user's own with a key", async () => {
		const saved: Array<{ preset?: string; key: string; custom?: unknown }> = [];
		const { app } = await setup({
			app: {
				vendors: [],
				saveProvider: async (input) => {
					saved.push(input);
					return '加好了';
				},
			},
		});
		expect(await app.saveProvider({ custom: { name: ' 家里的服务器 ', url: 'http://192.168.1.9:11434/v1', models: 'qwen3:32b、llama3', key: ' sk-1 ' } })).toBe('加好了');
		expect(saved).toEqual([{ key: 'sk-1', custom: { name: '家里的服务器', url: 'http://192.168.1.9:11434/v1', models: ['qwen3:32b', 'llama3'] } }]);

		for (const bad of [
			{ name: '', url: 'https://api.example.com/v1', models: 'm' },
			{ name: 'x'.repeat(41), url: 'https://api.example.com/v1', models: 'm' },
			{ name: 'ok', url: 'api.example.com', models: 'm' },
			{ name: 'ok', url: 'file:///etc/passwd', models: 'm' },
			{ name: 'ok', url: 'https://api.example.com/v1', models: '' },
			{ name: 'ok', url: 'https://api.example.com/v1', models: 'm', key: 'sk 1' },
			{ name: 'ok', url: 'https://api.example.com/v1', models: '-m' },
		]) {
			await expect(app.saveProvider({ custom: bad })).rejects.toMatchObject({ status: 400 });
		}
		expect(saved).toHaveLength(1);
	});

	it('says so where keys cannot be added', async () => {
		const { app } = await setup();
		await expect(app.saveProvider({ preset: 'deepseek', key: 'sk-1' })).rejects.toMatchObject({ status: 501 });
		await expect(app.saveProvider({ custom: { name: 'x', url: 'https://api.example.com/v1', models: 'm' } })).rejects.toMatchObject({ status: 501 });
	});
});
