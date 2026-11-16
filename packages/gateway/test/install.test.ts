import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checksumFor, ensureFreeRoute, FREE_GROUP, installMagpie, releaseAsset } from '../src/install.ts';

const scratch: string[] = [];
const servers: Server[] = [];

const tempDir = async () => {
	const dir = await mkdtemp(join(tmpdir(), 'magpie-install-'));
	scratch.push(dir);
	return dir;
};

afterEach(async () => {
	for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
	for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
});

describe('release asset', () => {
	it('names the build for the system it runs on', () => {
		expect(releaseAsset('darwin', 'arm64')).toBe('magpie-cli-darwin-arm64');
		expect(releaseAsset('linux', 'x64')).toBe('magpie-cli-linux-amd64');
	});

	it('has nothing for a system magpie does not build for', () => {
		expect(releaseAsset('win32', 'x64')).toBeUndefined();
		expect(releaseAsset('linux', 'ia32')).toBeUndefined();
	});
});

describe('checksums', () => {
	// What GitHub releases actually publish: two spaces, lowercase hex.
	const sums = `${'a'.repeat(64)}  magpie-cli-linux-amd64\n${'b'.repeat(64)}  magpie-cli-darwin-arm64\n`;

	it('finds the line for one asset', () => {
		expect(checksumFor(sums, 'magpie-cli-darwin-arm64')).toBe('b'.repeat(64));
	});

	it('says nothing for an asset the list does not mention', () => {
		expect(checksumFor(sums, 'magpie-cli-windows-amd64')).toBeUndefined();
	});
});

describe('installing magpie', () => {
	/** Serves one release, with or without an honest checksum. */
	const release = async (bytes: Buffer, honest: boolean) => {
		const asset = releaseAsset() as string;
		const sums = `${honest ? createHash('sha256').update(bytes).digest('hex') : 'c'.repeat(64)}  ${asset}\n`;
		const server = createServer((request, response) => {
			if (request.url === '/SHA256SUMS') return response.end(sums);
			if (request.url === `/${asset}`) return response.end(bytes);
			response.statusCode = 404;
			response.end('no');
		});
		servers.push(server);
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		const address = server.address();
		const port = typeof address === 'object' && address ? address.port : 0;
		return `http://127.0.0.1:${port}`;
	};

	it('puts a checked binary where it is asked to', async () => {
		const dir = await tempDir();
		const releases = await release(Buffer.from('#!/bin/sh\necho magpie\n'), true);

		const path = await installMagpie({ dir: join(dir, 'bin'), releases });

		expect(await readFile(path, 'utf8')).toBe('#!/bin/sh\necho magpie\n');
		expect((await stat(path)).mode & 0o777).toBe(0o755);
	});

	it('refuses a binary that does not match its published checksum', async () => {
		const dir = await tempDir();
		const releases = await release(Buffer.from('tampered'), false);

		await expect(installMagpie({ dir: join(dir, 'bin'), releases })).rejects.toThrow(/checksum mismatch/);
		await expect(stat(join(dir, 'bin', 'magpie'))).rejects.toThrow();
	});
});

describe('the free route', () => {
	it('adds the plugin, then the group it feeds', async () => {
		const dir = await tempDir();
		const calls = join(dir, 'calls');
		const fake = join(dir, 'magpie');
		// Records what it was asked to do; the real one talks to the gateway.
		await writeFile(fake, `#!/bin/sh\necho "$@" >> "${calls}"\n`);
		await chmod(fake, 0o755);

		await ensureFreeRoute({ binary: fake });

		const lines = (await readFile(calls, 'utf8')).trim().split('\n');
		expect(lines[0]).toBe('plugin add https://github.com/mu-zi-lee/magpie-our-free-model');
		expect(lines[1]).toBe(`group add ${FREE_GROUP} models=our-free-model/* routing=smart`);
	});
});
