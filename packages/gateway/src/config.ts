/**
 * The magpie gateway is the only thing between an agent and a model.
 * Everything here is read from magpie's own HTTP surface, so a new provider,
 * a new free model or a routing group shows up without touching this file.
 */

export interface GatewayConfig {
	/** Where magpie listens. Local by default; a shared gateway when set. */
	baseUrl: string;
	/** magpie's gateway key. `magpie` is what a local, unguarded gateway takes. */
	apiKey: string;
}

export function gatewayConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
	return {
		baseUrl: (env.MAGPIE_BASE_URL ?? 'http://127.0.0.1:3425').replace(/\/+$/, ''),
		apiKey: env.MAGPIE_API_KEY ?? 'magpie',
	};
}

export interface MagpieModel {
	id: string;
	display_name?: string;
	context_window?: number;
	max_input_tokens?: number;
	max_output_tokens?: number;
	reasoning?: boolean;
	tool_call?: boolean;
	modalities?: { input?: string[] };
	pricing?: { prompt?: string; completion?: string; input_cache_read?: string; input_cache_write?: string };
}

interface MagpieModelList {
	data: MagpieModel[];
}

async function request(config: GatewayConfig, path: string, init?: RequestInit): Promise<Response> {
	const response = await fetch(`${config.baseUrl}${path}`, {
		...init,
		// Without this, a gateway that accepts the connection and never answers
		// hangs startup forever: the deadline in `ensureGateway` bounds the sleeps
		// between calls, never the call itself.
		signal: init?.signal ?? AbortSignal.timeout(15_000),
		headers: {
			Authorization: `Bearer ${config.apiKey}`,
			'Content-Type': 'application/json',
			...(init?.headers ?? {}),
		},
	});
	if (!response.ok) {
		const body = await response.text().catch(() => '');
		throw new Error(`magpie ${path} failed: ${response.status} ${body.slice(0, 300)}`);
	}
	return response;
}

/** Every model the gateway can serve right now, including routing groups. */
export async function listModels(config: GatewayConfig): Promise<MagpieModel[]> {
	const response = await request(config, '/v1/models');
	const body = (await response.json()) as MagpieModelList;
	return body.data;
}

export async function healthcheck(config: GatewayConfig): Promise<boolean> {
	try {
		await listModels(config);
		return true;
	} catch {
		return false;
	}
}
