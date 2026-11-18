#!/usr/bin/env node
/**
 * A stable front for the local free-model service.
 *
 * The upstream service exposes many models, but some lanes (OpenCode Zen) are
 * quota-limited per egress IP. A gateway that sees one 429 locks the whole
 * provider, which then refuses even lanes that still work. This proxy hides
 * that: it offers a single model, `free`, and quietly moves between the lanes
 * that are not subject to that shared quota. To the agent the model name never
 * changes and one lane running dry is invisible.
 *
 * New free lanes are picked up by reading the upstream catalogue on a timer,
 * so "the free models changed" needs no new release of this app.
 */
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';

export const STABLE_MODEL = 'free';

const unwrap = (text) => {
	try {
		const body = JSON.parse(text);
		return body.data?.map((model) => model.id) ?? [];
	} catch {
		return [];
	}
};

/**
 * Which upstream lanes are safe to use: the auto-routed free pools and the
 * `provider/model:free` catalogue entries. The named OpenCode models are left
 * out on purpose — they share one per-IP quota and trigger the lock.
 */
function freeLanes(ids) {
	return ids.filter((id) =>
		id === 'kilo-auto/free' ||
		id === 'openrouter/free' ||
		(id.includes('/') && id.endsWith(':free')),
	);
}

/**
 * Lanes outside the free-model service: two public endpoints that answer with
 * no account and no key. They sit behind the free pool, so they are only tried
 * when it is out of quota, and a request they cannot serve (tools, vision) just
 * fails over as usual. Verified by hand on 2026-11-18: OVH's endpoint answered
 * in 1-2 s, Pollinations in about 5 s.
 */
export const DEFAULT_EXTERNAL = [
	{
		name: 'ovh/DeepSeek-V4.1-Flash-1017',
		url: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/chat/completions',
		model: 'DeepSeek-V4.1-Flash-1017',
	},
	{
		name: 'ovh/Qwen3.5-397B-A17B',
		url: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/chat/completions',
		model: 'Qwen3.5-397B-A17B',
	},
	{
		name: 'ovh/gpt-oss-120b',
		url: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/chat/completions',
		model: 'gpt-oss-120b',
	},
	{ name: 'pollinations/openai-fast', url: 'https://text.pollinations.ai/openai', model: 'openai-fast' },
];

/** A pool lane is a model name on the free-model service; an external one carries its own address. */
function asLane(entry, upstream) {
	if (typeof entry === 'string') return { name: entry, url: `${upstream}/v1/chat/completions`, model: entry, external: false };
	return { name: entry.name ?? entry.model, url: entry.url, model: entry.model, key: entry.key, external: true };
}

export function createProxy(options) {
	const upstream = (options.upstream ?? 'http://127.0.0.1:18900').replace(/\/+$/, '');
	const keyFile = options.keyFile;
	// A short, fixed priority: these two auto-route within their own free pools,
	// and the external lanes come after them.
	let lanes = [
		...(options.lanes ?? ['kilo-auto/free', 'openrouter/free']).map((lane) => asLane(lane, upstream)),
		...(options.extra ?? []).map((lane) => asLane(lane, upstream)).filter((lane) => lane.url && lane.model),
	];
	let key = options.key ?? '';

	const readKey = () => {
		if (!keyFile || !existsSync(keyFile)) return;
		try {
			const found = JSON.parse(readFileSync(keyFile, 'utf8')).forwardKey;
			if (typeof found === 'string' && found) key = found;
		} catch {
			// Keep the last good key; the upstream will say so if it is stale.
		}
	};

	/** Pull newly listed free lanes in without dropping the ones we know. */
	const refresh = async () => {
		readKey();
		try {
			const response = await fetch(`${upstream}/v1/models`, {
				headers: { Authorization: `Bearer ${key}` },
				signal: AbortSignal.timeout(10_000),
			});
			if (!response.ok) return lanes.map((lane) => lane.name);
			const discovered = freeLanes(unwrap(await response.text()));
			// An empty or failed discovery must never wipe the lanes we know:
			// that leaves the proxy with nothing to try and every call 429s.
			if (discovered.length === 0) return lanes.map((lane) => lane.name);
			// Known lanes first (sticky order), then any that appeared since. The
			// external lanes are not in this catalogue, so they are carried over.
			const external = lanes.filter((lane) => lane.external);
			const known = lanes.filter((lane) => !lane.external).map((lane) => lane.model);
			const ordered = [...known.filter((id) => discovered.includes(id)), ...discovered.filter((id) => !known.includes(id))];
			lanes = [...ordered.map((id) => asLane(id, upstream)), ...external];
		} catch {
			// No network yet: the known lanes are still worth trying.
		}
		return lanes.map((lane) => lane.name);
	};

	readKey();

	const handle = async (request, response) => {
		const url = request.url ?? '';
		if (url.startsWith('/health')) {
			response.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
			return;
		}
		if (url.startsWith('/v1/models')) {
			const body = JSON.stringify({
				object: 'list',
				data: [{ id: STABLE_MODEL, object: 'model', owned_by: 'pi-magpie-bot' }],
			});
			response.writeHead(200, { 'content-type': 'application/json' }).end(body);
			return;
		}
		if (!url.startsWith('/v1/chat/completions')) {
			response.writeHead(404).end('{"error":"not found"}');
			return;
		}

		// The upstream may have been restarted with a fresh key; pick it up.
		readKey();

		const chunks = [];
		for await (const chunk of request) chunks.push(chunk);
		let body;
		try {
			body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
		} catch {
			response.writeHead(400).end('{"error":"invalid json"}');
			return;
		}

		// Try each lane in order. A quota or server error moves to the next lane; a
		// client error is passed straight back, since trying it elsewhere only
		// burns the other lanes' quota on a request that cannot succeed.
		let started = false;
		let last;
		for (const lane of lanes.length > 0 ? [...lanes] : []) {
			try {
				const headers = { 'Content-Type': 'application/json' };
				// The free-model service wants its own key; the external public
				// endpoints want none, and sending one only invites a 401.
				const token = lane.external ? lane.key : key;
				if (token) headers.Authorization = `Bearer ${token}`;
				const forwarded = await fetch(lane.url, {
					method: 'POST',
					headers,
					body: JSON.stringify({ ...body, model: lane.model }),
					signal: AbortSignal.timeout(options.timeoutMs ?? 120_000),
				});
				// 4xx other than a rate limit is the request's own fault: hand it back.
				if (forwarded.status >= 400 && forwarded.status < 500 && forwarded.status !== 429) {
					const text = await forwarded.text().catch(() => '{"error":"upstream refused"}');
					response.writeHead(forwarded.status, { 'content-type': 'application/json' }).end(text);
					return;
				}
				if (forwarded.status >= 400) {
					last = forwarded.status;
					continue;
				}
				// Success: this lane is healthy, keep it first.
				lanes = [lane, ...lanes.filter((entry) => entry !== lane)];
				const type = forwarded.headers.get('content-type') ?? 'application/json';
				response.writeHead(forwarded.status, { 'content-type': type });
				started = true;
				if (forwarded.body) for await (const chunk of forwarded.body) response.write(chunk);
				response.end();
				return;
			} catch {
				last = 502;
				// Headers already went out: this response cannot be restarted, and
				// trying another lane would throw ERR_HTTP_HEADERS_SENT and crash the
				// proxy. End it instead and let the caller retry a fresh request.
				if (started) {
					response.end();
					return;
				}
			}
		}
		if (response.headersSent) {
			response.end();
			return;
		}
		// 503, not 429: a gateway that sees 429 locks the whole provider, which is
		// exactly what this proxy exists to prevent.
		response.writeHead(503, { 'content-type': 'application/json' }).end(
			JSON.stringify({ error: { message: `no free lane available (last ${last})`, type: 'server_error' } }),
		);
	};

	// Nothing a single request does may take the whole proxy down: if this
	// process exits, every message fails until the app restarts.
	const server = createServer((request, response) => {
		handle(request, response).catch((error) => {
			try {
				if (!response.headersSent) {
					response.writeHead(500, { 'content-type': 'application/json' }).end(
						JSON.stringify({ error: { message: `proxy error: ${error?.message ?? error}`, type: 'server_error' } }),
					);
				} else {
					response.end();
				}
			} catch {
				// The socket is already gone; nothing left to say.
			}
		});
	});

	return {
		server,
		lanes: () => lanes.map((lane) => lane.name),
		refresh,
		listen: (port = options.port ?? 18_901, host = '127.0.0.1') =>
			new Promise((resolve) => server.listen(port, host, () => resolve(server.address()))),
		close: () => new Promise((resolve) => server.close(resolve)),
	};
}

// Running directly: take settings from the environment and keep refreshing.
const invokedDirectly = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly) {
	// The keyless endpoints outside the free pool are on unless the environment
	// says otherwise: `OFM_EXTRA_LANES=[]` turns them off, and a JSON array of
	// {name, url, model, key} replaces them.
	let extra = DEFAULT_EXTERNAL;
	if (process.env.OFM_EXTRA_LANES !== undefined) {
		try {
			const parsed = JSON.parse(process.env.OFM_EXTRA_LANES);
			if (Array.isArray(parsed)) extra = parsed;
		} catch {
			console.error('OFM_EXTRA_LANES is not JSON; keeping the built-in external lanes');
		}
	}
	// `OFM_POOL_LANES=[]` drops the lanes that go through the local service,
	// leaving only the keyless public endpoints. Used when that service could
	// not start on this device: OVH and Pollinations still answer.
	let poolLanes = ['kilo-auto/free', 'openrouter/free'];
	if (process.env.OFM_POOL_LANES !== undefined) {
		try {
			const parsed = JSON.parse(process.env.OFM_POOL_LANES);
			if (Array.isArray(parsed)) poolLanes = parsed.map(String);
		} catch {
			console.error('OFM_POOL_LANES is not JSON; keeping the pool lanes');
		}
	}
	const proxy = createProxy({
		upstream: process.env.OFM_UPSTREAM,
		port: Number(process.env.OFM_PROXY_PORT ?? 18_901),
		keyFile: process.env.OFM_KEY_FILE,
		lanes: poolLanes,
		extra,
	});
	await proxy.listen();
	const every = Number(process.env.OFM_REFRESH_MS ?? 30 * 60_000);
	const timer = setInterval(() => void proxy.refresh(), every);
	timer.unref?.();
	void proxy.refresh();
	console.log(`free-model proxy on ${proxy.server.address().port}, lanes: ${proxy.lanes().join(', ')}`);
}
