/**
 * The whole loop without a chat platform: a fake channel stands in for
 * Telegram, so this proves inbox → pi-durable run → outbox → channel.
 *
 *   pnpm smoke:bot [model]
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bot } from '../packages/brain/src/index.ts';
import { ensureGateway, gatewayConfig } from '../packages/gateway/src/index.ts';

await ensureGateway(gatewayConfig());

const dir = await mkdtemp(join(tmpdir(), 'pi-magpie-bot-'));
const bot = await Bot.open({ dataDir: dir, modelId: process.argv[2] ?? 'auto/claude-haiku-5-5' });

const said: string[] = [];
bot.register({
	id: 'cli',
	async send(target, text) {
		said.push(text);
		console.log(`→ ${target}: ${text}`);
	},
});

const ask = (id: string, text: string) =>
	bot.ingest({ source: 'cli', sourceKey: id, channel: 'cli', target: 'me', text });

console.log(`data: ${dir}`);
console.log(`accepted: ${ask('1', '你好，用一句话介绍你自己。')} (a second time: ${ask('1', '你好，用一句话介绍你自己。')})`);

// Three messages that arrive together become one run, so the user gets one answer.
ask('2', '顺便说一句，我叫小张。');
ask('3', '记住我喜欢简短的回答。');
ask('4', '现在告诉我你记住了什么。');

const started = Date.now();
await bot.tick();
console.log(`\ntick took ${Date.now() - started}ms, replies: ${said.length}`);
console.log(`queue now: ${JSON.stringify(bot.inspect())}`);

await bot.close();
