import { createModels, createProvider, type Model, type Models } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { type GatewayConfig, type MagpieModel, listModels } from './config.ts';

const PROVIDER_ID = 'magpie';

/** magpie prices in dollars per token; pi-ai wants dollars per million. */
function perMillion(value: string | undefined): number {
	const parsed = Number(value ?? 0);
	return Number.isFinite(parsed) ? parsed * 1_000_000 : 0;
}

/**
 * magpie speaks the OpenAI chat shape, so every model it offers is
 * `openai-completions` here, whatever vendor or plan actually serves it.
 */
export function toPiModel(entry: MagpieModel, baseUrl: string): Model<'openai-completions'> {
	const input = (entry.modalities?.input ?? ['text']).filter(
		(modality): modality is 'text' | 'image' => modality === 'text' || modality === 'image',
	);
	return {
		id: entry.id,
		name: entry.display_name ?? entry.id,
		api: 'openai-completions',
		provider: PROVIDER_ID,
		baseUrl: `${baseUrl}/v1`,
		reasoning: entry.reasoning ?? false,
		input: input.length > 0 ? input : ['text'],
		cost: {
			input: perMillion(entry.pricing?.prompt),
			output: perMillion(entry.pricing?.completion),
			cacheRead: perMillion(entry.pricing?.input_cache_read),
			cacheWrite: perMillion(entry.pricing?.input_cache_write),
		},
		contextWindow: entry.context_window ?? entry.max_input_tokens ?? 128_000,
		maxTokens: entry.max_output_tokens ?? 8_192,
	};
}

/**
 * One provider standing in for everything magpie serves. Read the catalog at
 * start-up: swapping the free group for an API key or a local Ollama is a
 * magpie setting, not a rebuild.
 */
export async function createMagpieProvider(config: GatewayConfig) {
	const entries = await listModels(config);
	return createProvider({
		id: PROVIDER_ID,
		name: 'magpie',
		baseUrl: `${config.baseUrl}/v1`,
		auth: { apiKey: { name: 'magpie gateway key', resolve: async () => ({ auth: { apiKey: config.apiKey } }) } },
		models: entries.map((entry) => toPiModel(entry, config.baseUrl)),
		api: openAICompletionsApi(),
	});
}

/** A `Models` collection with only the gateway's provider registered. */
export async function openModels(config: GatewayConfig): Promise<Models> {
	const models = createModels();
	models.setProvider(await createMagpieProvider(config));
	return models;
}
