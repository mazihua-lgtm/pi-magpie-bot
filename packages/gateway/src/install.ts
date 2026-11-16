/**
 * Getting magpie onto the machine, and getting the free route onto magpie.
 *
 * `install.sh` does both with curl and git, but the product is meant to be
 * started by someone who only has Node: the same two steps happen here, in
 * TypeScript, with the checksum the release publishes actually checked.
 */
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

const RELEASES = 'https://github.com/yetone/magpie/releases/latest/download';

/** The plugin that serves the anonymous free pool. */
export const FREE_PLUGIN = 'https://github.com/mu-zi-lee/magpie-our-free-model';
/** The routing group the free pool goes into. */
export const FREE_GROUP = 'free';
/** How the plugin's models are named, before the group gathers them. */
export const FREE_MODEL_PREFIX = 'our-free-model/';

/**
 * The release asset this machine runs. magpie ships one binary per system,
 * named for the shell it is used from; there is no build for Windows itself.
 */
export function releaseAsset(platform: string = process.platform, arch: string = process.arch): string | undefined {
	if (platform !== 'darwin' && platform !== 'linux') return undefined;
	const cpu = arch === 'x64' ? 'amd64' : arch === 'arm64' ? 'arm64' : undefined;
	return cpu ? `magpie-cli-${platform}-${cpu}` : undefined;
}

/** The hash the release publishes for one asset, if it is in the list at all. */
export function checksumFor(sums: string, asset: string): string | undefined {
	for (const line of sums.split('\n')) {
		// "hash  name" or "hash *name", as sha256sum and friends write it.
		const [hash, name] = line.trim().split(/\s+\*?/, 2);
		if (name === asset && hash && /^[0-9a-f]{64}$/i.test(hash)) return hash.toLowerCase();
	}
	return undefined;
}

export interface InstallMagpieOptions {
	/** Where to keep the binary: the product's own directory, not the user's PATH. */
	dir: string;
	/** Releases root, for a mirror or a test server. */
	releases?: string;
	/** Injected in tests. */
	fetch?: typeof globalThis.fetch;
	log?: (line: string) => void;
}

/**
 * Downloads the current magpie release once and returns its path. A binary that
 * does not match its published checksum is never written and never run.
 */
export async function installMagpie(options: InstallMagpieOptions): Promise<string> {
	const asset = releaseAsset();
	if (!asset) {
		throw new Error(
			`magpie has no build for ${process.platform}/${process.arch}: on Windows use WSL, or the desktop app from https://usemagpie.ai`,
		);
	}
	const log = options.log ?? (() => {});
	const get = options.fetch ?? globalThis.fetch;
	const releases = (options.releases ?? RELEASES).replace(/\/+$/, '');

	log(`downloading magpie (${asset})`);
	const response = await get(`${releases}/${asset}`);
	if (!response.ok) throw new Error(`magpie release ${asset} failed: ${response.status}`);
	const bytes = Buffer.from(await response.arrayBuffer());

	const sums = await get(`${releases}/SHA256SUMS`).catch(() => undefined);
	if (sums?.ok) {
		const expected = checksumFor(await sums.text(), asset);
		const actual = createHash('sha256').update(bytes).digest('hex');
		if (!expected) throw new Error(`the release does not list a checksum for ${asset}; not installing it`);
		if (expected !== actual) throw new Error(`checksum mismatch for ${asset}; not installing it`);
		log('checksum ok');
	} else {
		log(`no SHA256SUMS published for ${asset}; installing without a checksum`);
	}

	await mkdir(options.dir, { recursive: true });
	const path = join(options.dir, 'magpie');
	await writeFile(path, bytes, { mode: 0o755 });
	await chmod(path, 0o755);
	return path;
}

export interface FreeRouteOptions {
	binary: string;
	baseUrl?: string;
	log?: (line: string) => void;
}

/** The environment magpie's own downloads must not inherit: a stale proxy breaks git. */
function cleanEnv(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete env[key];
	return env;
}

/**
 * Puts the free pool in the gateway: the plugin, the one-time sign-in, then the
 * routing group that fans out over whatever models it brought. Someone may have
 * done this already, so a failure is reported and stepped over rather than
 * thrown: the model check that follows is what decides whether it worked.
 *
 * The sign-in has to happen while no gateway is running (magpie's CLI asks the
 * running one for its management page and is refused when it holds no web key),
 * which is why the bot does this before it starts magpie.
 */
export async function ensureFreeRoute(options: FreeRouteOptions): Promise<void> {
	const log = options.log ?? (() => {});
	const env = cleanEnv();
	try {
		log('adding the free-model plugin');
		await run(options.binary, ['plugin', 'add', FREE_PLUGIN], { env, timeout: 180_000 });
	} catch (error) {
		log(`the free-model plugin did not install: ${(error as Error).message.split('\n')[0]}`);
	}
	if ((await freePluginSignedIn(options.binary, env)) !== true) {
		try {
			await signInFree({ binary: options.binary, log });
		} catch (error) {
			log(`signing in to the free pool did not finish: ${(error as Error).message.split('\n')[0]}`);
		}
	}
	try {
		await run(options.binary, ['group', 'add', FREE_GROUP, 'models=our-free-model/*', 'routing=smart'], {
			env,
			timeout: 30_000,
		});
		log(`routing group '${FREE_GROUP}' is in place`);
	} catch (error) {
		log(`the free routing group was not created: ${(error as Error).message.split('\n')[0]}`);
	}
}

/**
 * Whether magpie considers the free pool signed in, as it reports itself.
 * `undefined` when the machine is too old to say (no `--json`, no plugin yet):
 * then the sign-in is attempted, and it is its own answer that counts.
 */
async function freePluginSignedIn(binary: string, env: NodeJS.ProcessEnv): Promise<boolean | undefined> {
	try {
		const { stdout } = await run(binary, ['plugin', 'list', '--json'], { env, timeout: 60_000, maxBuffer: 32 << 20 });
		const listed = JSON.parse(stdout) as { providers?: Array<{ id?: string; signedIn?: boolean }> };
		const provider = listed.providers?.find((entry) => entry.id === 'our-free-model');
		return provider ? provider.signedIn === true : undefined;
	} catch {
		return undefined;
	}
}

export interface SignInOptions {
	binary: string;
	/** The first run downloads a runtime for the plugin, so this is generous. */
	timeoutMs?: number;
	log?: (line: string) => void;
}

/**
 * The free pool's own one-time sign-up, driven the way a person would drive it:
 * magpie asks how to sign in, and the first answer is the one that hands the
 * gateway its models without a browser. It exits by itself when it is done; the
 * address it prints is the management console, which is only needed to add
 * channels beyond the anonymous pool.
 */
export async function signInFree(options: SignInOptions): Promise<void> {
	const log = options.log ?? (() => {});
	log('signing in to the free pool');
	const timeoutMs = options.timeoutMs ?? 300_000;

	await new Promise<void>((resolve, reject) => {
		const child = spawn(options.binary, ['plugin', 'login', 'our-free-model'], {
			env: cleanEnv(),
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		let seen = '';
		let answered = false;
		const timer = setTimeout(() => {
			child.kill('SIGTERM');
			reject(new Error(`no answer from the free pool within ${Math.round(timeoutMs / 1000)}s`));
		}, timeoutMs);
		const watch = (chunk: Buffer) => {
			seen += chunk.toString();
			// "  1. 启用模型 / 打开账号管理控制台" — answer the menu, once.
			if (!answered && /(^|\n)\s*1\.\s/.test(seen)) {
				answered = true;
				child.stdin.write('1\n');
			}
		};
		child.stdout.on('data', watch);
		child.stderr.on('data', watch);
		child.once('error', (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once('exit', (code) => {
			clearTimeout(timer);
			if (code === 0) resolve();
			else if (!answered) reject(new Error(`magpie plugin login exited ${code} without asking anything`));
			else reject(new Error(`magpie plugin login exited ${code}`));
		});
	});
}
