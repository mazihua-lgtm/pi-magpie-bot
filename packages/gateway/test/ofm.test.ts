import { createServer, type Server } from 'node:http';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureOfmRoute, OFM_STABLE_MODEL } from '../src/ofm.ts';

const scratch: string[] = [];
const servers: Server[] = [];
// The same suite also runs from build/android/stage; random bases keep the two
// copies from fighting over the same fixed ports.
const portBase = 19000 + Math.floor(Math.random() * 500) * 4;
const tempDir = async () => {
	const dir = await mkdtemp(join(tmpdir(), 'ofm-route-'));
	scratch.push(dir);
	return dir;
};

afterEach(async () => {
	for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
	for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
});

/** A health endpoint that is already up, so the function need not spawn anything. */
async function fakeUp(port: number, proxy = false) {
	const service = createServer((request, response) => {
		if (request.url === '/health') { response.writeHead(200).end('{"ok":true}'); return; }
		if (request.url === '/v1/models') {
			response.writeHead(200).end(JSON.stringify({ data: proxy ? [{ id: OFM_STABLE_MODEL }] : [] }));
			return;
		}
		response.writeHead(200).end('{}');
	});
	await new Promise<void>((resolve) => service.listen(port, '127.0.0.1', resolve));
	servers.push(service);
}

/** A CLI that records commands; `exists` decides whether `provider ofm` succeeds. */
async function fakeCli(dir: string, exists: boolean) {
	const calls = join(dir, 'calls');
	const fake = join(dir, 'magpie');
	await writeFile(
		fake,
		`#!/bin/sh
echo "$@" >> "${calls}"
[ "$1 $2" = "provider ofm" ] && ${exists ? 'exit 0' : 'exit 1'}
exit 0
`,
	);
	await chmod(fake, 0o755);
	return { fake, calls };
}

async function withKey(dir: string) {
	const dataDir = join(dir, 'ofm-data');
	const sourceDir = join(dir, 'source');
	await mkdir(dataDir, { recursive: true });
	await writeFile(join(dir, 'settings.json'), JSON.stringify({ forwardKey: 'ofm-test-key' }));
	await copyFile(join(dir, 'settings.json'), join(dataDir, 'settings.json'));
	return { dataDir, sourceDir };
}

describe('the free-model route', () => {
	it('registers the proxy as one stable model and leaves lane failover to it', async () => {
		const dir = await tempDir();
		const port = portBase;
		const proxyPort = portBase + 20;
		await fakeUp(port); // upstream service
		await fakeUp(proxyPort, true); // proxy already up
		const { fake, calls } = await fakeCli(dir, false);
		const { dataDir, sourceDir } = await withKey(dir);

		const ok = await ensureOfmRoute({ binary: fake, sourceDir, dataDir, port, proxyPort, log: () => {} });
		expect(ok).toBe(true);

		const lines = (await readFile(calls, 'utf8')).trim().split('\n');
		const add = lines.find((line) => line.startsWith('provider add ofm '));
		expect(add).toContain(`url=http://127.0.0.1:${proxyPort}/v1`);
		expect(add).toContain(`models=${OFM_STABLE_MODEL}`);
		expect(add).toContain('list=off');
		// No live catalogue and no group: the proxy handles all of that.
		expect(lines.some((line) => line.includes('catalog=openai'))).toBe(false);
		expect(lines.some((line) => line.startsWith('group add'))).toBe(false);
	});

	it('never adds the provider twice', async () => {
		const dir = await tempDir();
		const port = portBase + 1;
		const proxyPort = portBase + 21;
		await fakeUp(port);
		await fakeUp(proxyPort, true);
		const { fake, calls } = await fakeCli(dir, true);
		const { dataDir, sourceDir } = await withKey(dir);

		await ensureOfmRoute({ binary: fake, sourceDir, dataDir, port, proxyPort, log: () => {} });
		const lines = (await readFile(calls, 'utf8')).trim().split('\n');
		expect(lines.some((line) => line.startsWith('provider add'))).toBe(false);
	});

	it('still registers the proxy when the service has no key yet (external lanes work without one)', async () => {
		const dir = await tempDir();
		const port = portBase + 2;
		const proxyPort = portBase + 22;
		await fakeUp(port);
		await fakeUp(proxyPort, true);
		const { fake, calls } = await fakeCli(dir, false);
		const sourceDir = join(dir, 'source');
		const dataDir = join(dir, 'empty');
		await mkdir(dataDir, { recursive: true });

		const ok = await ensureOfmRoute({ binary: fake, sourceDir, dataDir, port, proxyPort, log: () => {} });
		expect(ok).toBe(true);
		// A keyless placeholder is used: the proxy needs only a non-empty key
		// from magpie, and the public endpoints need none of their own.
		const lines = (await readFile(calls, 'utf8')).trim().split('\n');
		expect(lines.find((line) => line.startsWith('provider add ofm '))).toContain('key=public-endpoints');
	});

	it('falls back to public endpoints when the local free service cannot start at all', async () => {
		const dir = await tempDir();
		const port = portBase + 3;
		const proxyPort = portBase + 23;
		// No fakeUp(port): the local service is down. Proxy is up with the stable model.
		await fakeUp(proxyPort, true);
		const { fake, calls } = await fakeCli(dir, false);
		const sourceDir = join(dir, 'source'); // empty: no cli.mjs to spawn
		const dataDir = join(dir, 'ofm-data');
		await mkdir(dataDir, { recursive: true });

		const logged: string[] = [];
		const ok = await ensureOfmRoute({ binary: fake, sourceDir, dataDir, port, proxyPort, log: (line) => logged.push(line) });
		expect(ok).toBe(true);
		expect(logged.join('\n')).toContain('public endpoints only');
		const lines = (await readFile(calls, 'utf8')).trim().split('\n');
		expect(lines.find((line) => line.startsWith('provider add ofm '))).toContain(`url=http://127.0.0.1:${proxyPort}/v1`);
	});
});
