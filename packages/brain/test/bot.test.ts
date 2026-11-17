import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModels } from '@earendil-works/pi-ai';
import { openHostDb } from '@pi-magpie-bot/events';
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
