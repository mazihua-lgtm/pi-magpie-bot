/**
 * Proves the two halves of the stack talk to each other before the bot exists:
 * magpie serves a model, and pi asks it something.
 *
 *   pnpm smoke                       first model in the gateway's catalog
 *   pnpm smoke our-free-model/beam-free
 */
import type { Context } from '@earendil-works/pi-ai';
import { ensureGateway, gatewayConfig, openModels } from '../packages/gateway/src/index.ts';

const config = gatewayConfig();
await ensureGateway(config);

const models = await openModels(config);
const wanted = process.argv[2];
const model =
	(wanted ? models.getModel('magpie', wanted) : undefined) ??
	models.getModel('magpie', 'our-free-model/mimo-v2.6-flash-free') ??
	models.getModels()[0];

if (!model) throw new Error('the gateway offers no models at all');
console.log(`model: ${model.provider}/${model.id} (context ${model.contextWindow}, maxTokens ${model.maxTokens})`);

const context: Context = {
	systemPrompt: '你是一个简洁的中文助理。',
	messages: [{ role: 'user', content: '用一句话介绍你自己，并说明你是什么模型。', timestamp: Date.now() }],
};

const started = Date.now();
const reply = await models.complete(model, context);
const text = reply.content
	.filter((part) => part.type === 'text')
	.map((part) => part.text)
	.join('');
console.log(`reply (${Date.now() - started}ms): ${text}`);
if (reply.stopReason === 'error') console.error(`error: ${JSON.stringify(reply)}`);
console.log(`usage: ${reply.usage.input} in / ${reply.usage.output} out / $${reply.usage.cost.total.toFixed(6)}`);
