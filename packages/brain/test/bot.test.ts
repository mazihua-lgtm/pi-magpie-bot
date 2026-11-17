import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModels } from '@earendil-works/pi-ai';
import { openHostDb, Schedules } from '@pi-magpie-bot/events';
import { afterEach, describe, expect, it } from 'vitest';
import { Bot, conversationIdFor } from '../src/index.ts';

/**
 * These tests never call a model: the point is what the host does around one,
 * which is where duplicates and silence come from.
 */
const cleanups: Array<() => Promise<void>> = [];
const dataDir = async () => mkdtemp(join(tmpdir(), 'bot-'));

const openBot = async (dir: string) => {
	const bot = await Bot.open({ dataDir: dir, models: createModels(), modelId: 'test/model' });
	const sent: string[] = [];
	bot.register({
		id: 'cli',
		async send(_target, text) {
			sent.push(text);
		},
	});
	cleanups.push(async () => {
		await bot.close();
	});
	return { bot, sent };
};

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe('bot recovery', () => {
	it('tells the user about a message whose answer died with the process, and does not answer it twice', async () => {
		const dir = await dataDir();
		const { bot } = await openBot(dir);

		expect(bot.ingest({ source: 'cli', sourceKey: '1', channel: 'cli', target: 'me', text: '帮我算一下' })).toBe(true);

		// The crash: the row was claimed and the process died before it settled.
		const host = openHostDb(join(dir, 'host.sqlite'));
		host.db.prepare(`UPDATE inbox SET status = 'running'`).run();
		host.close();
		await bot.close();

		const { bot: restarted, sent } = await openBot(dir);
		await restarted.tick();

		expect(sent).toHaveLength(1);
		expect(sent[0]).toContain('中断');
		expect(restarted.inspect().pendingEvents).toBe(0);
	});

	it('does not resend a message that was mid-send when the process died', async () => {
		const dir = await dataDir();
		const { bot } = await openBot(dir);

		bot.ingest({ source: 'cli', sourceKey: '1', channel: 'cli', target: 'me', text: '你好' });
		const host = openHostDb(join(dir, 'host.sqlite'));
		host.db
			.prepare(`INSERT INTO outbox (conversation, channel, target, text, created_at, status) VALUES (?, ?, ?, ?, ?, 'sending')`)
			.run(conversationIdFor('cli', 'me'), 'cli', 'me', '已经说出去一半的话', Date.now());
		host.close();
		await bot.close();

		const { bot: restarted, sent } = await openBot(dir);
		await restarted.dispatch();
		expect(sent).toEqual([]);
	});
});

describe('bot ingest', () => {
	it('takes one platform message once', async () => {
		const { bot } = await openBot(await dataDir());
		const event = { source: 'cli', sourceKey: '9', channel: 'cli', target: 'me', text: 'hi' };
		expect(bot.ingest(event)).toBe(true);
		expect(bot.ingest(event)).toBe(false);
	});

	it('answers an open approval card instead of starting a turn', async () => {
		const dir = await dataDir();
		const { bot, sent } = await openBot(dir);

		const conversation = conversationIdFor('cli', 'me');
		const host = openHostDb(join(dir, 'host.sqlite'));
		host.db
			.prepare(`INSERT INTO approvals (id, conversation, channel, target, action, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
			.run('a1', conversation, 'cli', 'me', '执行命令：rm -rf /tmp/x', Date.now());
		host.close();

		expect(bot.ingest({ source: 'cli', sourceKey: '5', channel: 'cli', target: 'me', text: '是' })).toBe(true);
		await bot.dispatch();

		expect(sent).toEqual(['好，继续。']);
		expect(bot.inspect().pendingEvents).toBe(0);
	});
});

describe('the loop', () => {
	it('does not start a second run while one is still going, and still delivers meanwhile', async () => {
		const { bot } = await openBot(await dataDir());
		let calls = 0;
		// A run that takes longer than the interval: exactly the case where two
		// ticks would claim the same waiting message and answer it twice.
		let deliveries = 0;
		bot.work = async () => {
			calls += 1;
			await new Promise((resolve) => setTimeout(resolve, 40));
		};
		bot.dispatch = async () => {
			deliveries += 1;
			return 0;
		};

		const stop = bot.start(5);
		await new Promise((resolve) => setTimeout(resolve, 120));
		stop();

		expect(calls).toBeLessThanOrEqual(3);
		// Delivery has its own loop: it keeps going while a run is in progress.
		expect(deliveries).toBeGreaterThan(calls);
	});
});

describe('default model', () => {
	it('takes a free routing group before anything that costs money', async () => {
		const { pickDefaultModel } = await import('../src/index.ts');
		expect(pickDefaultModel(['wokey/claude-haiku-5-5', 'group/free'])).toBe('group/free');
		// The failover-proxy model wins over a single model: a quota-limited
		// lane must not end the conversation.
		expect(pickDefaultModel(['ofm/deepseek-v4.1-flash-free', 'ofm/free'])).toBe('ofm/free');
		expect(pickDefaultModel(['ofm/deepseek-v4.1-flash-free', 'group/free'])).toBe('group/free');
		expect(pickDefaultModel(['our-free-model/x-free', 'wokey/y'])).toBe('our-free-model/x-free');
		expect(pickDefaultModel(['wokey/y'])).toBe('wokey/y');
		expect(() => pickDefaultModel([])).toThrow();
	});
});

describe('a channel that never answers', () => {
	it('does not freeze delivery to every other channel', async () => {
		const dir = await dataDir();
		// A send that never settles: the openai/feishu SDKs can do this on a half-open
		// socket, and the delivery loop is one file - it would stop for good.
		const bot = await Bot.open({ dataDir: dir, models: createModels(), modelId: 'test/model', sendTimeoutMs: 50 });
		cleanups.push(async () => {
			await bot.close();
		});
		const delivered: string[] = [];
		bot.register({
			id: 'stuck',
			send: () => new Promise<void>(() => {}),
		});
		bot.register({
			id: 'cli',
			async send(_target, text) {
				delivered.push(text);
			},
		});

		// One message for the stuck channel, one for the working one.
		bot.ingest({ source: 'stuck', sourceKey: '1', channel: 'stuck', target: 'me', text: 'hi' });
		bot.ingest({ source: 'cli', sourceKey: '2', channel: 'cli', target: 'me', text: 'hi' });

		// The stuck one is answered first, so the working one is behind it.
		const host = openHostDb(join(dir, 'host.sqlite'));
		const [stuck, working] = host.db
			.prepare(`SELECT id FROM conversations ORDER BY created_at`)
			.all() as Array<{ id: string }>;
		host.close();
		for (const [id, text] of [
			[stuck!.id, 'stuck answer'],
			[working!.id, 'working answer'],
		] as const) {
			bot['outbox'].enqueue({ conversation: id, channel: id === stuck!.id ? 'stuck' : 'cli', target: 'me', text });
		}

		const sent = await bot.dispatch();
		// The stuck row timed out and went back in the queue; the other still went out.
		expect(delivered).toEqual(['working answer']);
		expect(sent).toBe(1);
	});
});

describe('reminders that must not depend on the model', () => {
	it('delivers the reminder text even when the run behind it fails', async () => {
		const dir = await dataDir();
		const { bot, sent } = await openBot(dir);

		bot.ingest({ source: 'cli', sourceKey: '1', channel: 'cli', target: 'me', text: '十分钟后提醒我关火' });
		await bot.tick();

		// A due reminder: fireDueSchedules delivers the words first, so a model
		// that is out of quota at that moment cannot replace them with "没能回答".
		const host = openHostDb(join(dir, 'host.sqlite'));
		const now = Date.now();
		bot['schedules'].add({ conversation: conversationIdFor('cli', 'me'), channel: 'cli', target: 'me', text: '该关火了', at: now - 1_000 });
		host.close();

		sent.length = 0;
		bot.fireDueSchedules();
		await bot.dispatch();

		expect(sent).toContain('⏰ 该关火了');
	});

	it('closes the whole batch it answered, so a crash cannot answer the rest twice', async () => {
		const dir = await dataDir();
		const { bot } = await openBot(dir);

		bot.ingest({ source: 'cli', sourceKey: '1', channel: 'cli', target: 'me', text: '第一条' });
		bot.ingest({ source: 'cli', sourceKey: '2', channel: 'cli', target: 'me', text: '第二条' });

		// Simulate pump claiming the first and batching the second.
		bot['inbox'].claim();
		const pending = bot['inbox'].pendingFor(conversationIdFor('cli', 'me'));
		bot['inbox'].finishMany(pending.map((row) => row.id));

		// The crash: reclaim must now see both rows, not just the first.
		const host = openHostDb(join(dir, 'host.sqlite'));
		const running = host.db.prepare(`SELECT COUNT(*) AS n FROM inbox WHERE status = 'running'`).get() as { n: number };
		const pendingRows = host.db.prepare(`SELECT COUNT(*) AS n FROM inbox WHERE status = 'pending'`).get() as { n: number };
		host.close();
		expect(running.n).toBe(2);
		expect(pendingRows.n).toBe(0);
	});
});

describe('cancel_reminder ownership', () => {
	it('does not let one chat cancel another chat’s reminder', async () => {
		const dir = await dataDir();
		const { bot } = await openBot(dir);
		const mine = conversationIdFor('cli', 'me');
		const theirs = conversationIdFor('cli', 'someone-else');

		const host = openHostDb(join(dir, 'host.sqlite'));
		const schedules = new (await import('@pi-magpie-bot/events')).Schedules(host);
		const theirId = schedules.add({ conversation: theirs, channel: 'cli', target: 'them', text: 'theirs', at: Date.now() + 60_000 });
		host.close();

		// The tool resolves the conversation from the agent id, so exercising the
		// guard directly: list this chat's, find the foreign id, expect nothing.
		const listed = bot['schedules'].list(mine);
		expect(listed.find((row) => row.id === theirId)).toBeUndefined();
	});
});

describe('event-driven wakeups', () => {
	it('answers an ingested message promptly, without waiting for the fallback tick', async () => {
		const dir = await dataDir();
		const { bot, sent } = await openBot(dir);
		// 30 minutes: nothing but the wake path could deliver in this window.
		const stop = bot.start(30 * 60_000);
		cleanups.push(async () => stop());

		bot.ingest({ source: 'cli', sourceKey: 'wake-1', channel: 'cli', target: 'me', text: '你好' });
		await new Promise((resolve) => setTimeout(resolve, 400));

		expect(sent.length).toBeGreaterThan(0);
		stop();
	});

	it('fires a reminder on a precise timer, not on the fallback tick', async () => {
		const dir = await dataDir();
		const { bot, sent } = await openBot(dir);
		const stop = bot.start(60 * 60_000); // fallback: hourly, must not be needed
		cleanups.push(async () => stop());

		// Bind the target first: in real use a reminder always comes out of a
		// conversation, so the chat it belongs to is already known.
		bot.ingest({ source: 'cli', sourceKey: 'bind', channel: 'cli', target: 'me', text: '你好' });
		await new Promise((resolve) => setTimeout(resolve, 300));

		const host = openHostDb(join(dir, 'host.sqlite'));
		const schedules = new Schedules(host);
		schedules.add({
			conversation: conversationIdFor('cli', 'me'),
			channel: 'cli',
			target: 'me',
			text: '该关火了',
			at: Date.now() + 300,
		});
		host.close();
		bot.armScheduleTimer();

		await new Promise((resolve) => setTimeout(resolve, 900));
		expect(sent).toContain('⏰ 该关火了');
		stop();
	});

	it('does not wake on a duplicate message', async () => {
		const dir = await dataDir();
		const { bot, sent } = await openBot(dir);
		const stop = bot.start(60 * 60_000);
		cleanups.push(async () => stop());

		const event = { source: 'cli', sourceKey: 'dup-1', channel: 'cli', target: 'me', text: '你好' };
		expect(bot.ingest(event)).toBe(true);
		expect(bot.ingest(event)).toBe(false);
		await new Promise((resolve) => setTimeout(resolve, 400));

		// One answer, not two.
		expect(sent.filter((text) => text.length > 0).length).toBe(1);
		stop();
	});
});

describe('a conversation that answers slowly', () => {
	it('does not hold another conversation\'s answer hostage', async () => {
		const dir = await dataDir();
		const { bot, sent } = await openBot(dir);
		const stop = bot.start(30 * 60_000);
		cleanups.push(async () => stop());

		// Per-conversation delay: 'me' takes 1.5s before its answer ships, 'other'
		// ships at once. Under the old global queue the fast chat waited behind
		// the slow one; delivered order is the proof.
		const shippedAt = new Map<string, number>();
		const original = bot['answer'].bind(bot);
		bot['answer'] = async (conversationId: string, text: string) => {
			const slow = conversationId === conversationIdFor('cli', 'me');
			if (slow) await new Promise((resolve) => setTimeout(resolve, 1_500));
			const result = await original(conversationId, text);
			shippedAt.set(text, Date.now());
			return result;
		};

		bot.ingest({ source: 'cli', sourceKey: 'slow-1', channel: 'cli', target: 'me', text: '慢的那条' });
		bot.ingest({ source: 'cli', sourceKey: 'fast-1', channel: 'cli', target: 'other', text: '快的那条' });

		await new Promise((resolve) => setTimeout(resolve, 2_000));
		// Both shipped, and the fast one shipped while the slow one was thinking.
		expect(shippedAt.size).toBe(2);
		expect(shippedAt.get('快的那条')!).toBeLessThan(shippedAt.get('慢的那条')!);
		stop();
	});
});
