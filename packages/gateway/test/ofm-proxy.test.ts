import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createProxy } from '../../../scripts/ofm-proxy.mjs';

const servers: Server[] = [];
afterEach(async () => {
	for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
});

async function upstreamWith(catalogue: string, answer: (model: string) => [number, string]) {
	const server = createServer(async (request, response) => {
		if (request.url === '/v1/models') {
			response.writeHead(200).end(catalogue);
			return;
		}
		let body = '';
		for await (const chunk of request) body += chunk;
		const model = JSON.parse(body).model;
		const [status, text] = answer(model);
		response.writeHead(status, { 'content-type': 'application/json' }).end(text);
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	servers.push(server);
	return (server.address() as { port: number }).port;
}

async function call(port: number): Promise<[number, string]> {
	const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ model: 'free', messages: [{ role: 'user', content: 'hi' }] }),
	});
	return [response.status, await response.text()];
}

describe('the free-model proxy', () => {
	const emptyCatalogue = JSON.stringify({ data: [] });

	it('fails over from a quota-limited lane to a working one', async () => {
		const port = await upstreamWith(emptyCatalogue, (model) =>
			model === 'kilo-auto/free'
				? [429, '{"error":"quota"}']
				: [200, JSON.stringify({ id: 'x', choices: [{ message: { content: model } }] })],
		);
		const proxy = createProxy({ upstream: `http://127.0.0.1:${port}`, port: 0, lanes: ['kilo-auto/free', 'openrouter/free'] });
		await proxy.listen(0);
		const address = proxy.server.address() as { port: number };
		const [status, body] = await call(address.port);
		expect(status).toBe(200);
		expect(body).toContain('openrouter/free');
		// The lane that answered is now first for the next request.
		expect(proxy.lanes()[0]).toBe('openrouter/free');
		await proxy.close();
	});

	it('keeps its known lanes when the upstream catalogue comes back empty', async () => {
		const port = await upstreamWith(emptyCatalogue, (_model) => [200, '{"ok":true}']);
		const proxy = createProxy({ upstream: `http://127.0.0.1:${port}`, port: 0, lanes: ['kilo-auto/free', 'openrouter/free'] });
		await proxy.listen(0);
		const address = proxy.server.address() as { port: number };
		await proxy.refresh();
		expect(proxy.lanes()).toEqual(['kilo-auto/free', 'openrouter/free']);
		await proxy.close();
	});

	it('offers exactly one stable model', async () => {
		const port = await upstreamWith(emptyCatalogue, () => [200, '{}']);
		const proxy = createProxy({ upstream: `http://127.0.0.1:${port}`, port: 0 });
		await proxy.listen(0);
		const address = proxy.server.address() as { port: number };
		const response = await fetch(`http://127.0.0.1:${address.port}/v1/models`);
		const body = (await response.json()) as { data: Array<{ id: string }> };
		expect(body.data.map((model) => model.id)).toEqual(['free']);
		await proxy.close();
	});

	it('survives a lane that dies mid-stream instead of taking the process down', async () => {
		// A lane that sends headers and one chunk, then drops the connection. Before
		// the fix the retry threw ERR_HTTP_HEADERS_SENT and exited the proxy.
		const upstream = createServer(async (request, response) => {
			if (request.url === '/v1/models') {
				response.writeHead(200).end(JSON.stringify({ data: [] }));
				return;
			}
			response.writeHead(200, { 'content-type': 'text/event-stream' });
			response.write('data: {"partial":true}\n\n');
			setTimeout(() => response.destroy(), 40);
		});
		await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
		servers.push(upstream);
		const port = (upstream.address() as { port: number }).port;

		const proxy = createProxy({ upstream: `http://127.0.0.1:${port}`, port: 0, lanes: ['kilo-auto/free', 'openrouter/free'] });
		await proxy.listen(0);
		const address = proxy.server.address() as { port: number };

		const first = await fetch(`http://127.0.0.1:${address.port}/v1/chat/completions`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ model: 'free', messages: [{ role: 'user', content: 'hi' }] }),
		}).catch(() => undefined);
		await first?.text().catch(() => '');

		// The point: the proxy is still serving.
		const health = await fetch(`http://127.0.0.1:${address.port}/health`);
		expect(health.status).toBe(200);
		await proxy.close();
	});

	it('answers 503, never 429, when every lane is down', async () => {
		// 429 makes a gateway lock the whole provider, which is what this proxy exists
		// to prevent; the error must not look like a quota problem.
		const port = await upstreamWith(emptyCatalogue, () => [429, '{"error":"quota"}']);
		const proxy = createProxy({ upstream: `http://127.0.0.1:${port}`, port: 0, lanes: ['kilo-auto/free'] });
		await proxy.listen(0);
		const address = proxy.server.address() as { port: number };
		const [status] = await call(address.port);
		expect(status).toBe(503);
		await proxy.close();
	});

	it('passes a client error straight back instead of burning other lanes', async () => {
		const seen: string[] = [];
		const port = await upstreamWith(emptyCatalogue, (model) => {
			seen.push(model);
			return [400, '{"error":"context too long"}'];
		});
		const proxy = createProxy({ upstream: `http://127.0.0.1:${port}`, port: 0, lanes: ['kilo-auto/free', 'openrouter/free'] });
		await proxy.listen(0);
		const address = proxy.server.address() as { port: number };
		const [status, body] = await call(address.port);
		expect(status).toBe(400);
		expect(body).toContain('context too long');
		// Only the first lane was tried: trying more would waste their quota.
		expect(seen).toEqual(['kilo-auto/free']);
		await proxy.close();
	});

	describe('endpoints outside the free pool', () => {
		it('moves to one when the free pool is out of quota, and sends it no key', async () => {
			const seen: Array<{ model: string; auth?: string }> = [];
			const pool = await upstreamWith(emptyCatalogue, () => [429, '{"error":"quota"}']);
			const outside = await outsideWith(() => [200, JSON.stringify({ id: 'x', choices: [{ message: { content: 'from outside' } }] })], seen);
			const proxy = createProxy({
				upstream: `http://127.0.0.1:${pool}`,
				port: 0,
				lanes: ['kilo-auto/free'],
				extra: [{ name: 'outside/test', url: `http://127.0.0.1:${outside}/v1/chat/completions`, model: 'outside-model' }],
			});
			await proxy.listen(0);
			const address = proxy.server.address() as { port: number };
			const [status, body] = await call(address.port);
			expect(status).toBe(200);
			expect(body).toContain('from outside');
			// A public keyless endpoint is not sent the free pool's key.
			expect(seen).toEqual([{ model: 'outside-model' }]);
			// The lane that answered is now first, ahead of the exhausted pool.
			expect(proxy.lanes()[0]).toBe('outside/test');
			await proxy.close();
		});

		it('keeps them through a catalogue refresh', async () => {
			const pool = await upstreamWith(JSON.stringify({ data: [{ id: 'kilo-auto/free' }, { id: 'vendor/model:free' }] }), () => [200, '{}']);
			const outside = await outsideWith(() => [200, '{}']);
			const proxy = createProxy({
				upstream: `http://127.0.0.1:${pool}`,
				port: 0,
				lanes: ['kilo-auto/free'],
				extra: [{ name: 'outside/test', url: `http://127.0.0.1:${outside}/v1/chat/completions`, model: 'outside-model' }],
			});
			await proxy.refresh();
			expect(proxy.lanes()).toEqual(['kilo-auto/free', 'vendor/model:free', 'outside/test']);
			await proxy.close();
		});
	});
});

/** A public endpoint outside the free pool: records what it was sent, answers as told. */
async function outsideWith(answer: () => [number, string], seen?: Array<{ model: string; auth?: string }>) {
	const server = createServer(async (request, response) => {
		let body = '';
		for await (const chunk of request) body += chunk;
		seen?.push({ model: JSON.parse(body).model, auth: request.headers.authorization });
		const [status, text] = answer();
		response.writeHead(status, { 'content-type': 'application/json' }).end(text);
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	servers.push(server);
	return (server.address() as { port: number }).port;
}
