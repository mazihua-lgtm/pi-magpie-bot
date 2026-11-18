import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { addProvider, checksumFor, ensureFreeRoute, FREE_GROUP, hasConfiguredModel, installMagpie, providerId, releaseAsset } from '../src/install.ts';

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

describe('offline model check', () => {
	const fakeProviders = async (dir: string, answer: string, fails = false) => {
		const fake = join(dir, 'magpie');
		await writeFile(fake, `#!/bin/sh\n[ "$1" = providers ] || exit 2\n${fails ? 'exit 1' : `printf '%s\\n' '${answer}'`}\n`);
		await chmod(fake, 0o755);
		return fake;
	};

	it('sees a provider from magpie\'s config with the gateway down', async () => {
		const fake = await fakeProviders(await tempDir(), 'mock custom  mock  127.0.0.1:9000  1 of 1 models');
		expect(await hasConfiguredModel(fake)).toBe(true);
	});

	it('recognises an empty config', async () => {
		const fake = await fakeProviders(await tempDir(), 'no providers yet · magpie provider add deepseek sk-…');
		expect(await hasConfiguredModel(fake)).toBe(false);
	});

	it('reports nothing when the command itself fails, so the caller tries the pool', async () => {
		const fake = await fakeProviders(await tempDir(), '', true);
		expect(await hasConfiguredModel(fake)).toBeUndefined();
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
	/**
	 * A magpie that records what it was asked to do. `plugin login` waits on
	 * stdin the way the real one does, so the sign-in is driven for real; with
	 * `behindProxy` it fails when handed a proxy, as a blocked download does.
	 */
	const fakeMagpie = async (
		dir: string,
		options: { signedIn: boolean; behindProxy?: boolean; group?: string },
	) => {
		const calls = join(dir, 'calls');
		const fake = join(dir, 'magpie');
		await writeFile(
			fake,
			`#!/bin/sh
if [ "$1 $2" = "group show" ]; then
  ${options.group === undefined ? 'echo "magpie: no group" >&2\n  exit 1' : `echo '${options.group}'\n  exit 0`}
fi
echo "$@" >> "${calls}"
if [ "$1 $2" = "plugin list" ]; then
  echo '{"providers":[{"id":"our-free-model","signedIn":${options.signedIn}}]}'
  exit 0
fi
if [ "$1 $2" = "plugin login" ]; then
  printf 'How do you sign in to Our Free Model?\\n  1. 启用模型 / 打开账号管理控制台\\n  2. 临时远程控制台（免登录）\\n> '
  read -r answer
  ${options.behindProxy ? 'if [ -n "${HTTPS_PROXY:-}" ]; then\n    echo "magpie: 内置服务启动失败：原渠道包下载失败"\n    exit 1\n  fi' : ''}
  echo "answer=$answer" >> "${calls}"
fi
`,
		);
		await chmod(fake, 0o755);
		return { fake, calls };
	};

	it('adds the plugin, signs it in, then adds the group it feeds', async () => {
		const dir = await tempDir();
		const { fake, calls } = await fakeMagpie(dir, { signedIn: false });

		await ensureFreeRoute({ binary: fake });

		const lines = (await readFile(calls, 'utf8')).trim().split('\n');
		expect(lines[0]).toBe('plugin add https://github.com/mu-zi-lee/magpie-our-free-model');
		expect(lines).toContain('answer=1');
		expect(lines.at(-1)).toBe(`group add ${FREE_GROUP} models=our-free-model/* routing=smart`);
	});

	it('leaves a group of the user\'s own called free, and everything else, alone', async () => {
		const dir = await tempDir();
		const { fake, calls } = await fakeMagpie(dir, { signedIn: false, group: 'free: deepseek/deepseek-chat' });
		const logged: string[] = [];

		await ensureFreeRoute({ binary: fake, log: (line) => logged.push(line) });

		await expect(readFile(calls, 'utf8')).rejects.toThrow();
		expect(logged.join('\n')).toContain('of its own');
	});

	it('keeps its own group when it is already there, without adding it twice', async () => {
		const dir = await tempDir();
		const { fake, calls } = await fakeMagpie(dir, { signedIn: true, group: 'free: our-free-model/*' });

		await ensureFreeRoute({ binary: fake });

		const lines = (await readFile(calls, 'utf8')).trim().split('\n');
		expect(lines.some((line) => line.startsWith('group add'))).toBe(false);
	});

	it('does not sign in again when the pool already is', async () => {
		const dir = await tempDir();
		const { fake, calls } = await fakeMagpie(dir, { signedIn: true });

		await ensureFreeRoute({ binary: fake });

		const lines = (await readFile(calls, 'utf8')).trim().split('\n');
		expect(lines).not.toContain('plugin login our-free-model');
		expect(lines.some((line) => line.startsWith('answer='))).toBe(false);
		expect(lines.at(-1)).toBe(`group add ${FREE_GROUP} models=our-free-model/* routing=smart`);
	});

	it('signs in again without the proxy when the first try is blocked', async () => {
		const dir = await tempDir();
		const { fake, calls } = await fakeMagpie(dir, { signedIn: false, behindProxy: true });
		const logged: string[] = [];
		const before = process.env.HTTPS_PROXY;
		process.env.HTTPS_PROXY = 'http://127.0.0.1:9';
		try {
			await ensureFreeRoute({ binary: fake, log: (line) => logged.push(line) });
		} finally {
			if (before === undefined) delete process.env.HTTPS_PROXY;
			else process.env.HTTPS_PROXY = before;
		}

		const lines = (await readFile(calls, 'utf8')).trim().split('\n');
		expect(lines).toContain('answer=1');
		// It says why, rather than only that the sign-in failed.
		expect(logged.join('\n')).toContain('原渠道包下载失败');
		expect(logged.join('\n')).toContain("trying again without this machine's proxy settings");
		expect(lines.at(-1)).toBe(`group add ${FREE_GROUP} models=our-free-model/* routing=smart`);
	});
});

describe('a key from the first-run page', () => {
	/** A magpie that refuses keys the way a real one does, and echoes the command line. */
	const refusingMagpie = async (dir: string) => {
		const fake = join(dir, 'magpie');
		await writeFile(
			fake,
			`#!/bin/sh
echo "magpie: 401 Unauthorized: the key $3 is not valid" >&2
exit 1
`,
		);
		await chmod(fake, 0o755);
		return fake;
	};

	it('gives a vendor key to magpie and says nothing when it works', async () => {
		const dir = await tempDir();
		const calls = join(dir, 'calls');
		const fake = join(dir, 'magpie');
		await writeFile(fake, `#!/bin/sh\necho "$@" >> "${calls}"\n`);
		await chmod(fake, 0o755);

		await addProvider({ binary: fake, preset: 'deepseek', key: 'sk-good' });

		expect((await readFile(calls, 'utf8')).trim()).toBe('provider add deepseek sk-good');
	});

	it('repeats magpie\'s refusal without repeating the key', async () => {
		const dir = await tempDir();
		const fake = await refusingMagpie(dir);

		const failure = await addProvider({ binary: fake, preset: 'deepseek', key: 'sk-secret-123' }).catch(
			(error: Error) => error,
		);

		expect(failure).toBeInstanceOf(Error);
		const said = (failure as Error).message;
		expect(said).toContain('refused');
		expect(said).toContain('401');
		expect(said).not.toContain('sk-secret-123');
	});

	it('hands magpie an endpoint of its own, key or no key', async () => {
		const dir = await tempDir();
		const calls = join(dir, 'calls');
		const fake = join(dir, 'magpie');
		await writeFile(fake, `#!/bin/sh\necho "$@" >> "${calls}"\n`);
		await chmod(fake, 0o755);

		await addProvider({
			binary: fake,
			preset: 'example',
			key: 'sk-1',
			custom: { name: '我常用的中转', url: 'https://api.example.com/v1', models: ['gpt-5', 'claude-sonnet-5-5'] },
		});
		await addProvider({
			binary: fake,
			preset: 'ollama',
			key: '',
			custom: { name: '家里的服务器', url: 'http://192.168.1.9:11434/v1', models: ['qwen3:32b'] },
		});

		const lines = (await readFile(calls, 'utf8')).trim().split('\n');
		expect(lines[0]).toBe('provider add example name=我常用的中转 url=https://api.example.com/v1 models=gpt-5,claude-sonnet-5-5 key=sk-1');
		// An endpoint on the LAN takes no key, and the arrow is not passed empty.
		expect(lines[1]).toBe('provider add ollama name=家里的服务器 url=http://192.168.1.9:11434/v1 models=qwen3:32b');
	});

	it('files a custom vendor under a name magpie takes', () => {
		expect(providerId('My Relay', 'https://api.example.com/v1')).toBe('my-relay');
		expect(providerId('我常用的中转', 'https://api.example.com/v1')).toBe('example');
		expect(providerId('家里的服务器', 'http://192.168.1.9:11434/v1')).toBe('custom');
		expect(providerId('api.deepseek.com', 'https://api.deepseek.com')).toBe('api.deepseek.com');
		expect(providerId('', 'https://open.bigmodel.cn/api/paas/v4')).toBe('open');
		// A name that would read as a flag to magpie loses its dashes rather than
		// reaching the command line as one.
		expect(providerId('--help', 'not a url')).toBe('help');
	});
});
