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

export function createProxy(options) {
	const upstream = (options.upstream ?? 'http://127.0.0.1:18900').replace(/\/+$/, '');
	const keyFile = options.keyFile;
	// A short, fixed priority: these two auto-route within their own free pools.
	let lanes = options.lanes ?? ['kilo-auto/free', 'openrouter/free'];
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
			if (!response.ok) return lanes;
			const discovered = freeLanes(unwrap(await response.text()));
			// An empty or failed discovery must never wipe the lanes we know:
			// that leaves the proxy with nothing to try and every call 429s.
			if (discovered.length === 0) return lanes;
			// Known lanes first (sticky order), then any that appeared since.
			lanes = [...lanes.filter((id) => discovered.includes(id)), ...discovered.filter((id) => !lanes.includes(id))];
		} catch {
			// No network yet: the known lanes are still worth trying.
		}
		return lanes;
	};

	readKey();

	const server = createServer(async (request, response) => {
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

		// Try each lane in order. A 429 or a server error moves to the next; a
		// successful response is streamed straight back, chunks and all.
		const order = [...lanes];
		let last;
		for (const lane of order) {
			try {
				const forwarded = await fetch(`${upstream}/v1/chat/completions`, {
					method: 'POST',
					headers: {
						Authorization: `Bearer ${key}`,
						'Content-Type': 'application/json',
					},
					body: JSON.stringify({ ...body, model: lane }),
					signal: AbortSignal.timeout(options.timeoutMs ?? 120_000),
				});
				if (forwarded.status >= 400) {
					last = forwarded.status;
					continue;
				}
				// Success: this lane is healthy, keep it first.
				lanes = [lane, ...lanes.filter((id) => id !== lane)];
				const type = forwarded.headers.get('content-type') ?? 'application/json';
				response.writeHead(forwarded.status, { 'content-type': type });
				if (forwarded.body) for await (const chunk of forwarded.body) response.write(chunk);
				response.end();
				return;
			} catch {
				last = 502;
			}
		}
		response.writeHead(429, { 'content-type': 'application/json' }).end(
			JSON.stringify({ error: { message: `no free lane available (last ${last})`, type: 'rate_limit_error' } }),
		);
	});

	return {
		server,
		lanes: () => [...lanes],
		refresh,
		listen: (port = options.port ?? 18_901, host = '127.0.0.1') =>
			new Promise((resolve) => server.listen(port, host, () => resolve(server.address()))),
		close: () => new Promise((resolve) => server.close(resolve)),
	};
}

// Running directly: take settings from the environment and keep refreshing.
const invokedDirectly = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly) {
	const proxy = createProxy({
		upstream: process.env.OFM_UPSTREAM,
		port: Number(process.env.OFM_PROXY_PORT ?? 18_901),
		keyFile: process.env.OFM_KEY_FILE,
	});
	await proxy.listen();
	const every = Number(process.env.OFM_REFRESH_MS ?? 30 * 60_000);
	const timer = setInterval(() => void proxy.refresh(), every);
	timer.unref?.();
	void proxy.refresh();
	console.log(`free-model proxy on ${proxy.server.address().port}, lanes: ${proxy.lanes().join(', ')}`);
}
