/**
 * pi-durable is the run loop the bot is built on: it writes the turn to disk
 * before showing it, and picks the work up again after a crash.
 *
 *   pnpm smoke:durable [provider/model]
 */
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { Harness, createRegistry } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureGateway, gatewayConfig, openModels } from '../packages/gateway/src/index.ts';

const config = gatewayConfig();
await ensureGateway(config);
const models = await openModels(config);

const modelId = process.argv[2] ?? 'wokey/claude-haiku-5-5';
if (!models.getModel('magpie', modelId)) throw new Error(`no such model on the gateway: ${modelId}`);

const context = BACKGROUND_CONTEXT;
const dir = await mkdtemp(join(tmpdir(), 'pi-durable-smoke-'));
const storage = await openNodeSqliteStorage(join(dir, 'session.sqlite'));
const harness = await Harness.open(storage, { models, registry: createRegistry() }, context);

const root = await harness.root(context, { agent: { model: { provider: 'magpie', modelId } } });
const submission = await root.submit({ type: 'input', content: '用一句话说明你正在持久化运行时里工作。' }, context);
const settled = await submission.wait(context);

if (settled.status !== 'done' || settled.type !== 'input') {
	throw new Error(`run did not finish: ${JSON.stringify(settled).slice(0, 300)}`);
}

const history = await root.context(context);
const last = history.messages.at(-1);
const parts = Array.isArray(last?.content) ? last.content : [];
const text = parts
	.filter((part): part is { type: 'text'; text: string } => part.type === 'text')
	.map((part) => part.text)
	.join('');
console.log(`answer (${last?.role ?? 'none'}): ${text}`);
console.log(`entries read back: ${(await root.entries({}, 50, undefined, context)).items.length}`);

await harness.close(context);
console.log(`stored at ${join(dir, 'session.sqlite')}`);
