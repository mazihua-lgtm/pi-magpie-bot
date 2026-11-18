import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModels, fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { AppError, AppService, Bot, type AppBackend, type AppEvent } from '@pi-magpie-bot/brain';
import { afterEach, describe, expect, it } from 'vitest';
import { WebChannel } from '../src/index.ts';

/**
 * The app's HTTP surface (docs/app-api.md). The routes are tested against a
 * fake backend that records what it was asked, so each test says exactly what
 * goes over the wire; one test at the end runs the whole way through a bot.
 */
const SID = '0b5e7d4c-1a2f-4e3d-8c9b-7a6f5e4d3c2b';
const COOKIE = `sid=${SID}`;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

type Call = [string, ...unknown[]];

function fakeBackend() {
	const calls: Call[] = [];
	const listeners = new Set<(owner: string, event: AppEvent) => void>();
	let restarts = 0;
	const chat = (id: string) => ({ id, title: 't', createdAt: 1, updatedAt: 2, pinned: false, model: null, thinking: false, busy: false });
	const backend: AppBackend = {
		chats: (owner) => (calls.push(['chats', owner]), [chat('a')]),
		createChat: (owner, title) => (calls.push(['createChat', owner, title]), chat('new1')),
		updateChat: (owner, id, patch) => {
			calls.push(['updateChat', owner, id, patch]);
			if (id === 'missing') throw new AppError(404, '没有这个对话 / no such chat');
			return chat(id);
		},
		deleteChat: async (owner, id) => void calls.push(['deleteChat', owner, id]),
		messages: async (owner, id) => (calls.push(['messages', owner, id]), { messages: [{ id: '1', role: 'user', text: 'hi' }], busy: true, partial: { text: '正在', thinking: '', tools: [] } }),
		send: (owner, id, input) => (calls.push(['send', owner, id, input]), { ...chat(id === 'new' ? 'made' : id), busy: true }),
		stop: async (owner, id) => void calls.push(['stop', owner, id]),
		decide: (owner, id, allow) => void calls.push(['decide', owner, id, allow]),
		pendingApprovals: (owner) => [{ event: 'approval', data: { chat: 'a', id: 'ap1', action: '读取文件 x', expiresAt: 99 } }].filter(() => owner === SID) as AppEvent[],
		models: () => ({ models: [{ id: 'm1', name: 'M1', reasoning: true, vision: false }], default: 'm1' }),
		setDefaultModel: (model) => {
			calls.push(['setDefaultModel', model]);
			if (model !== 'm1') throw new AppError(400, '没有这个模型 / no such model');
		},
		schedules: (owner) => (calls.push(['schedules', owner]), [{ id: 's1', chat: 'a', text: '喝水', nextRunAt: 5, everyMs: null }]),
		addSchedule: (owner, input) => (calls.push(['addSchedule', owner, input]), { id: 's2', chat: 'a', text: '开会', nextRunAt: 6, everyMs: 60_000 }),
		removeSchedule: (owner, id) => void calls.push(['removeSchedule', owner, id]),
		memory: async (owner) => (calls.push(['memory', owner]), [{ name: 'car', content: '比亚迪' }]),
		writeMemory: async (owner, name, content) => void calls.push(['writeMemory', owner, name, content]),
		deleteMemory: async (owner, name) => void calls.push(['deleteMemory', owner, name]),
		vendors: () => [{ preset: 'deepseek', name: 'DeepSeek', signupUrl: 'https://platform.deepseek.com' }, { preset: 'x', name: 'X' }],
		saveProvider: async (input) => (calls.push(['saveProvider', input.preset ?? input.custom?.name, input.custom ? input.custom.key : input.key]), '加好了'),
		restart: () => {
			restarts += 1;
		},
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
	return {
		backend,
		calls,
		restarts: () => restarts,
		push: (owner: string, event: AppEvent) => {
			for (const listener of listeners) listener(owner, event);
		},
	};
}

async function serve(app: AppBackend, options: { password?: string } = {}) {
	const channel = new WebChannel({ port: 0, app, ...options, onMessage: () => {} });
	const { url } = await channel.start();
	cleanups.push(() => channel.stop());
	return { channel, url };
}

const call = (url: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
	fetch(`${url}${path}`, {
		method,
		headers: { cookie: COOKIE, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
		...(body !== undefined ? { body: JSON.stringify(body) } : {}),
	});

/** An open SSE stream, read until the text it has seen satisfies `done`. */
async function stream(url: string, path: string, cookie = COOKIE) {
	const response = await fetch(`${url}${path}`, { headers: { cookie } });
	const reader = response.body!.getReader();
	const decoder = new TextDecoder();
	let seen = '';
	let ended = false;
	// One read in flight at a time, kept across waits: a read abandoned by a
	// timeout would swallow the chunk it later gets.
	let pending: Promise<void> | undefined;
	const read = () =>
		(pending ??= reader.read().then((chunk) => {
			pending = undefined;
			if (chunk.value) seen += decoder.decode(chunk.value, { stream: true });
			if (chunk.done) ended = true;
		}));
	cleanups.push(async () => {
		await reader.cancel().catch(() => {});
	});
	return {
		response,
		async until(done: (seen: string) => boolean, ms = 5_000): Promise<string> {
			const end = Date.now() + ms;
			while (!done(seen) && !ended) {
				if (Date.now() > end) throw new Error(`stream never said it; saw:\n${seen}`);
				await Promise.race([read(), new Promise((resolve) => setTimeout(resolve, 100))]);
			}
			return seen;
		},
		get seen() {
			return seen;
		},
	};
}

/** The named events of a stream, parsed. */
const events = (seen: string) =>
	seen
		.split('\n\n')
		.map((block) => /^event: (\S+)\ndata: (.*)$/m.exec(block))
		.filter((match): match is RegExpExecArray => match !== null)
		.map((match) => ({ event: match[1], data: JSON.parse(match[2]!) as Record<string, unknown> }));

describe('chat routes', () => {
	it('lists, creates, changes and deletes chats for the phone that asks', async () => {
		const fake = fakeBackend();
		const { url } = await serve(fake.backend);

		expect(await (await call(url, 'GET', '/api/chats')).json()).toEqual({ chats: [expect.objectContaining({ id: 'a' })] });
		expect(await (await call(url, 'POST', '/api/chats', { title: '工作' })).json()).toEqual({ chat: expect.objectContaining({ id: 'new1' }) });
		const patched = await call(url, 'PATCH', '/api/chats/a', { pinned: true, title: '置顶' });
		expect(patched.status).toBe(200);
		expect(await (await call(url, 'DELETE', '/api/chats/a')).json()).toEqual({ ok: true });

		expect(fake.calls).toEqual([
			['chats', SID],
			['createChat', SID, '工作'],
			['updateChat', SID, 'a', { pinned: true, title: '置顶' }],
			['deleteChat', SID, 'a'],
		]);
	});

	it('takes a POST that says it is a PATCH, since Android cannot send PATCH', async () => {
		const fake = fakeBackend();
		const { url } = await serve(fake.backend);
		const response = await call(url, 'POST', '/api/chats/a', { model: 'm1', thinking: true }, { 'x-http-method-override': 'PATCH' });
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ chat: expect.objectContaining({ id: 'a' }) });
		expect(fake.calls).toEqual([['updateChat', SID, 'a', { model: 'm1', thinking: true }]]);

		// Without the header a POST to a chat is not a route.
		expect((await call(url, 'POST', '/api/chats/a', { model: 'm1' })).status).toBe(404);
	});

	it('answers a refusal with its status and its sentence', async () => {
		const fake = fakeBackend();
		const { url } = await serve(fake.backend);
		const response = await call(url, 'PATCH', '/api/chats/missing', { title: 'x' });
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: '没有这个对话 / no such chat' });
	});

	it('sends a message, with pictures up to 20 MB, and answers 202 with the chat', async () => {
		const fake = fakeBackend();
		const { url } = await serve(fake.backend);
		const big = 'A'.repeat(8 * 1024 * 1024);
		const response = await call(url, 'POST', '/api/chats/new/messages', { text: '看图', images: [{ data: big, mimeType: 'image/png' }] });
		expect(response.status).toBe(202);
		expect(await response.json()).toEqual({ chat: expect.objectContaining({ id: 'made', busy: true }) });
		const [name, owner, id, input] = fake.calls[0]!;
		expect([name, owner, id]).toEqual(['send', SID, 'new']);
		expect((input as { images: Array<{ data: string }> }).images[0]?.data.length).toBe(big.length);
	});

	it('refuses a body over 20 MB on the message route and over 64 KB elsewhere', async () => {
		const fake = fakeBackend();
		const { url } = await serve(fake.backend);
		const huge = await call(url, 'POST', '/api/chats/a/messages', { text: 'x', images: [{ data: 'A'.repeat(21 * 1024 * 1024), mimeType: 'image/png' }] }).catch(
			() => undefined,
		);
		// The server answers 413 and drops the rest; a client may see the answer or a reset.
		if (huge) expect(huge.status).toBe(413);
		const title = await call(url, 'POST', '/api/chats', { title: 'x'.repeat(70 * 1024) }).catch(() => undefined);
		if (title) expect(title.status).toBe(413);
		expect(fake.calls).toEqual([]);
	});

	it('gives the history with the partial answer, and stops a chat', async () => {
		const fake = fakeBackend();
		const { url } = await serve(fake.backend);
		expect(await (await call(url, 'GET', '/api/chats/a/messages')).json()).toEqual({
			messages: [{ id: '1', role: 'user', text: 'hi' }],
			busy: true,
			partial: { text: '正在', thinking: '', tools: [] },
		});
		// A POST with nothing to say still says it is JSON: a foreign page cannot.
		expect((await call(url, 'POST', '/api/chats/a/stop')).status).toBe(415);
		expect(await (await call(url, 'POST', '/api/chats/a/stop', {})).json()).toEqual({ ok: true });
		expect(fake.calls).toEqual([
			['messages', SID, 'a'],
			['stop', SID, 'a'],
		]);
	});

	it('decodes ids in the path', async () => {
		const fake = fakeBackend();
		const { url } = await serve(fake.backend);
		await call(url, 'DELETE', '/api/memory/%E8%BD%A6');
		expect(fake.calls).toEqual([['deleteMemory', SID, '车']]);
		expect((await call(url, 'DELETE', '/api/memory/%E0%A4')).status).toBe(400);
	});
});

describe('the other routes', () => {
	it('answers approvals, models, reminders and memory', async () => {
		const fake = fakeBackend();
		const { url } = await serve(fake.backend);

		expect(await (await call(url, 'POST', '/api/approvals/ap1', { allow: true })).json()).toEqual({ ok: true });
		expect(await (await call(url, 'GET', '/api/models')).json()).toEqual({
			models: [{ id: 'm1', name: 'M1', reasoning: true, vision: false }],
			default: 'm1',
		});
		expect(await (await call(url, 'PUT', '/api/settings/model', { model: 'm1' })).json()).toEqual({ ok: true });
		expect((await call(url, 'PUT', '/api/settings/model', { model: 'zz' })).status).toBe(400);

		expect(await (await call(url, 'GET', '/api/schedules')).json()).toEqual({ schedules: [{ id: 's1', chat: 'a', text: '喝水', nextRunAt: 5, everyMs: null }] });
		expect(await (await call(url, 'POST', '/api/schedules', { chat: 'a', text: '开会', at: 6, everyMs: 60_000 })).json()).toEqual({
			schedule: { id: 's2', chat: 'a', text: '开会', nextRunAt: 6, everyMs: 60_000 },
		});
		expect(await (await call(url, 'DELETE', '/api/schedules/s1')).json()).toEqual({ ok: true });

		expect(await (await call(url, 'GET', '/api/memory')).json()).toEqual({ notes: [{ name: 'car', content: '比亚迪' }] });
		expect(await (await call(url, 'PUT', '/api/memory/car', { content: '蓝色比亚迪' })).json()).toEqual({ ok: true });
		expect(await (await call(url, 'DELETE', '/api/memory/car')).json()).toEqual({ ok: true });

		expect(fake.calls).toEqual([
			['decide', SID, 'ap1', true],
			['setDefaultModel', 'm1'],
			['setDefaultModel', 'zz'],
			['schedules', SID],
			['addSchedule', SID, { chat: 'a', text: '开会', at: 6, everyMs: 60_000 }],
			['removeSchedule', SID, 's1'],
			['memory', SID],
			['writeMemory', SID, 'car', '蓝色比亚迪'],
			['deleteMemory', SID, 'car'],
		]);
	});

	it('lists vendors, saves a key, and restarts only after the answer went out', async () => {
		const fake = fakeBackend();
		const { url } = await serve(fake.backend);
		expect(await (await call(url, 'GET', '/api/providers')).json()).toEqual({
			vendors: [
				{ preset: 'deepseek', name: 'DeepSeek', signupUrl: 'https://platform.deepseek.com' },
				{ preset: 'x', name: 'X', signupUrl: null },
			],
		});
		const saved = await call(url, 'POST', '/api/providers', { preset: 'deepseek', key: 'sk-1' });
		expect(await saved.json()).toEqual({ ok: true, note: '加好了' });
		// An endpoint of the user's own goes down the same path and is passed on
		// whole: the app, not this route, decides whether it is one it knows.
		const own = await call(url, 'POST', '/api/providers', { custom: { name: '家里的服务器', url: 'http://192.168.1.9:11434/v1', models: 'qwen3:32b', key: 'sk-1' } });
		expect(await own.json()).toEqual({ ok: true, note: '加好了' });
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(fake.restarts()).toBe(2);
		expect(fake.calls).toEqual([
			['saveProvider', 'deepseek', 'sk-1'],
			['saveProvider', '家里的服务器', 'sk-1'],
		]);
	});

	it('keeps the guards: JSON bodies only, local Host only, a password when set, a sid that can be a target', async () => {
		const fake = fakeBackend();
		const { url } = await serve(fake.backend);
		const plain = await fetch(`${url}/api/chats`, { method: 'POST', headers: { cookie: COOKIE, 'content-type': 'text/plain' }, body: '{}' });
		expect(plain.status).toBe(415);
		const put = await fetch(`${url}/api/memory/x`, { method: 'PUT', headers: { cookie: COOKIE, 'content-type': 'text/plain' }, body: '{}' });
		expect(put.status).toBe(415);
		expect((await call(url, 'GET', '/api/chats', undefined, { cookie: 'sid=has/slash' })).status).toBe(400);
		expect(fake.calls).toEqual([]);

		const locked = await serve(fakeBackend().backend, { password: 'pw' });
		expect((await call(locked.url, 'GET', '/api/chats')).status).toBe(401);
		expect((await call(locked.url, 'GET', '/api/events?v=2')).status).toBe(401);
	});

	it('takes a sid the app made up itself, from the first request on', async () => {
		const fake = fakeBackend();
		const { url } = await serve(fake.backend);
		const response = await call(url, 'GET', '/api/chats');
		expect(response.status).toBe(200);
		// Nothing minted over it.
		expect(response.headers.get('set-cookie')).toBeNull();
		expect(fake.calls).toEqual([['chats', SID]]);
	});

	it('has none of these routes without an app backend', async () => {
		const channel = new WebChannel({ port: 0, onMessage: () => {} });
		const { url } = await channel.start();
		cleanups.push(() => channel.stop());
		expect((await call(url, 'GET', '/api/chats')).status).toBe(404);
	});
});

describe('the live stream', () => {
	it('sends named events for every chat of the owner, and only that owner', async () => {
		const fake = fakeBackend();
		const { channel, url } = await serve(fake.backend);
		const live = await stream(url, '/api/events?v=2');
		expect(live.response.headers.get('content-type')).toContain('text/event-stream');
		// A card still waiting is shown on connect.
		await live.until((seen) => seen.includes('event: approval'));

		fake.push(SID, { event: 'status', data: { chat: 'a', busy: true } });
		fake.push(SID, { event: 'partial', data: { chat: 'a', text: '正在写', thinking: '', tools: [{ name: 'web_search', label: '搜索：x', done: false }] } });
		fake.push('someone-else-1234', { event: 'status', data: { chat: 'z', busy: true } });
		await channel.send(`${SID}/a`, '写完了', { kind: 'answer' });
		await channel.send(SID, '旧页面那一段的话');
		fake.push(SID, { event: 'approval_done', data: { chat: 'a', id: 'ap1', status: 'allowed' } });
		fake.push(SID, { event: 'chat', data: { id: 'a', title: '新标题', createdAt: 1, updatedAt: 2, pinned: false, model: null, thinking: false, busy: false } });

		const seen = await live.until((text) => text.includes('新标题'));
		expect(events(seen)).toEqual([
			{ event: 'approval', data: { chat: 'a', id: 'ap1', action: '读取文件 x', expiresAt: 99 } },
			{ event: 'status', data: { chat: 'a', busy: true } },
			{ event: 'partial', data: { chat: 'a', text: '正在写', thinking: '', tools: [{ name: 'web_search', label: '搜索：x', done: false }] } },
			{ event: 'message', data: { chat: 'a', text: '写完了' } },
			{ event: 'message', data: { chat: 'default', text: '旧页面那一段的话' } },
			{ event: 'approval_done', data: { chat: 'a', id: 'ap1', status: 'allowed' } },
			{ event: 'chat', data: expect.objectContaining({ id: 'a', title: '新标题' }) },
		]);
		expect(seen).not.toContain('someone-else');
	});

	it('leaves the words of an approval card out of the app stream but not out of the old one', async () => {
		const fake = fakeBackend();
		const { channel, url } = await serve(fake.backend);
		const live = await stream(url, '/api/events?v=2');
		const old = await stream(url, '/api/events');
		await live.until((seen) => seen.includes(': connected'));
		await old.until((seen) => seen.includes(': connected'));

		await channel.send(`${SID}/a`, '⚠️ 需要你同意才能继续', { kind: 'approval' });
		await channel.send(`${SID}/a`, '下一句');
		await live.until((seen) => seen.includes('下一句'));
		await old.until((seen) => seen.includes('下一句'));
		expect(live.seen).not.toContain('需要你同意');
		expect(old.seen).toContain('data: {"text":"⚠️ 需要你同意才能继续"}');
		// The old stream stays unnamed lines.
		expect(old.seen).not.toContain('event:');
	});

	it('replays what the transcript never holds, but not answers, to an app that was away', async () => {
		const fake = fakeBackend();
		const { channel, url } = await serve(fake.backend);
		await channel.send(`${SID}/a`, '一个回答', { kind: 'answer' });
		await channel.send(`${SID}/a`, '⏰ 该关火了', { kind: 'reminder' });
		await channel.send(`${SID}/a`, '卡片', { kind: 'approval' });

		const live = await stream(url, '/api/events?v=2');
		const seen = await live.until((text) => text.includes('该关火了'));
		expect(events(seen).filter((entry) => entry.event === 'message')).toEqual([{ event: 'message', data: { chat: 'a', text: '⏰ 该关火了' } }]);

		// Replayed once, not on every connect.
		const again = await stream(url, '/api/events?v=2');
		await again.until((text) => text.includes('event: approval'));
		expect(again.seen).not.toContain('该关火了');
	});
});

describe('the whole way through a bot', () => {
	it('sends a message, streams the answer as it is written, and says when it is done', async () => {
		const faux = fauxProvider({ provider: 'magpie', models: [{ id: 'm1', reasoning: true }], tokensPerSecond: 40 });
		const models = createModels();
		models.setProvider(faux.provider);
		const answer = '寿光明天晴，最高二十度。出门不用带伞，早晚凉，穿件外套就行。'.repeat(2);
		faux.setResponses([fauxAssistantMessage(answer)]);
		const bot = await Bot.open({ dataDir: await mkdtemp(join(tmpdir(), 'web-app-')), models, modelId: 'm1' });
		const app = new AppService(bot, { titler: async () => '寿光天气' });
		const { channel, url } = await serve(app);
		bot.register(channel);
		const stop = bot.start(60 * 60_000);
		cleanups.push(async () => {
			stop();
			await bot.close();
		});

		const live = await stream(url, '/api/events?v=2');
		await live.until((seen) => seen.includes(': connected'));
		const sent = await call(url, 'POST', '/api/chats/new/messages', { text: '明天寿光天气' });
		expect(sent.status).toBe(202);
		const { chat } = (await sent.json()) as { chat: { id: string; title: string; busy: boolean } };
		expect(chat).toMatchObject({ title: '明天寿光天气', busy: true });

		const seen = await live.until((text) => text.includes('寿光天气"') && text.includes('"busy":false') && text.includes('event: message'), 8_000);
		const stream_ = events(seen);
		const partials = stream_.filter((entry) => entry.event === 'partial');
		expect(partials.length).toBeGreaterThan(1);
		expect(partials.every((entry) => entry.data.chat === chat.id)).toBe(true);
		expect(stream_.find((entry) => entry.event === 'message')?.data).toEqual({ chat: chat.id, text: answer });
		expect(stream_.filter((entry) => entry.event === 'status').map((entry) => entry.data)).toEqual([
			{ chat: chat.id, busy: true },
			{ chat: chat.id, busy: false },
		]);
		expect(stream_.filter((entry) => entry.event === 'chat').map((entry) => entry.data.title)).toContain('寿光天气');

		const history = (await (await call(url, 'GET', `/api/chats/${chat.id}/messages`)).json()) as { messages: Array<{ role: string; text: string }>; busy: boolean };
		expect(history.busy).toBe(false);
		expect(history.messages.map((message) => [message.role, message.text])).toEqual([
			['user', '明天寿光天气'],
			['assistant', answer],
		]);
		expect(await (await call(url, 'GET', '/api/chats')).json()).toEqual({ chats: [expect.objectContaining({ id: chat.id, title: '寿光天气' })] });
	}, 15_000);
});
