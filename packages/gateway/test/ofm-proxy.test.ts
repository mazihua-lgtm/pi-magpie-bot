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
});
