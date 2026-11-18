/**
 * Getting magpie onto the machine, and getting the free route onto magpie.
 *
 * `install.sh` does both with curl and git, but the product is meant to be
 * started by someone who only has Node: the same two steps happen here, in
 * TypeScript, with the checksum the release publishes actually checked.
 */
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

const RELEASES = 'https://github.com/yetone/magpie/releases/latest/download';

/** The plugin that serves the anonymous free pool. */
export const FREE_PLUGIN = 'https://github.com/mu-zi-lee/magpie-our-free-model';
/** What that plugin is called once magpie has installed it: the name it is asked by. */
const FREE_PACKAGE = 'magpie-our-free-model';
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

	const sumsResponse = await get(`${releases}/SHA256SUMS`).catch((error: Error) => error);
	if (sumsResponse instanceof Response) {
		if (!sumsResponse.ok) {
			// Only a release that really publishes no list may skip the check. A
			// network error must not: it would run a binary nobody has verified.
			if (sumsResponse.status === 404) log(`no SHA256SUMS published for ${asset}; installing without a checksum`);
			else throw new Error(`SHA256SUMS could not be fetched (${sumsResponse.status}); not installing without it`);
		} else {
			const expected = checksumFor(await sumsResponse.text(), asset);
			const actual = createHash('sha256').update(bytes).digest('hex');
			if (!expected) throw new Error(`the release does not list a checksum for ${asset}; not installing it`);
			if (expected !== actual) throw new Error(`checksum mismatch for ${asset}; not installing it`);
			log('checksum ok');
		}
	} else {
		throw new Error(`SHA256SUMS could not be fetched (${sumsResponse.message}); not installing without it`);
	}

	await mkdir(options.dir, { recursive: true });
	const path = join(options.dir, 'magpie');
	// Written whole and moved into place: a download cut off by a crash must not
	// leave a half binary where the next start looks for a working one.
	const partial = `${path}.partial`;
	await writeFile(partial, bytes, { mode: 0o755 });
	await chmod(partial, 0o755);
	await rename(partial, path);
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

/** Whether this machine hands every child a proxy. */
function proxied(env: NodeJS.ProcessEnv = process.env): boolean {
	return ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'].some((key) => Boolean(env[key]));
}

/**
 * Runs one of magpie's commands, and tries again without this machine's proxy
 * settings if the first try failed. Both halves of that matter in the wild: a
 * proxy that is set and dead breaks every download, and a network where GitHub
 * raw is only reachable through the proxy breaks them the other way round.
 */
async function magpieRun(binary: string, args: string[], timeout: number): Promise<void> {
	try {
		await run(binary, args, { env: process.env, timeout });
	} catch (error) {
		if (!proxied()) throw error;
		await run(binary, args, { env: cleanEnv(), timeout });
	}
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

	// `group add` replaces a group of the same name, and `free` is a name people
	// give their own groups. One that is not ours is the user's, and so is the
	// whole of that magpie: nothing is added to it.
	const existing = await groupShow(options.binary, FREE_GROUP);
	if (existing !== undefined && !existing.includes('our-free-model')) {
		log(`magpie already has a group named '${FREE_GROUP}' of its own; leaving it and the free pool alone`);
		return;
	}

	try {
		log('adding the free-model plugin');
		await magpieRun(options.binary, ['plugin', 'add', FREE_PLUGIN], 180_000);
	} catch (error) {
		log(`the free-model plugin did not install: ${(error as Error).message.split('\n')[0]}`);
	}
	// The plugin runs the pool's channels on Node, and would fetch a second copy
	// of Node to do it: forty megabytes and a minute on a first run, on a phone
	// that already has one - this process. It is told where to look instead.
	try {
		const wanted = { managed: { nodePath: process.execPath } };
		await magpieRun(options.binary, ['plugin', 'options', FREE_PACKAGE, JSON.stringify(wanted)], 60_000);
	} catch (error) {
		log(`the free-model plugin kept its own Node: ${(error as Error).message.split('\n')[0]}`);
	}
	if ((await freePluginSignedIn(options.binary)) !== true) {
		try {
			await signInFree({ binary: options.binary, log });
		} catch (error) {
			log(`signing in to the free pool did not finish: ${(error as Error).message.split('\n')[0]}`);
		}
	}
	if (existing !== undefined) {
		log(`routing group '${FREE_GROUP}' is in place`);
		return;
	}
	try {
		await magpieRun(options.binary, ['group', 'add', FREE_GROUP, 'models=our-free-model/*', 'routing=smart'], 30_000);
		log(`routing group '${FREE_GROUP}' is in place`);
	} catch (error) {
		log(`the free routing group was not created: ${(error as Error).message.split('\n')[0]}`);
	}
}

/**
 * Whether magpie already has a provider configured, checked straight from its
 * config with the gateway down. The free pool's sign-in needs the gateway
 * stopped and can take minutes; a boot that already has a model must not pay
 * that just to find out it has nothing to gain. `undefined` means the check
 * itself failed, in which case the caller should try the pool as before.
 */
export async function hasConfiguredModel(binary: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean | undefined> {
	try {
		const { stdout } = await run(binary, ['providers'], { env, timeout: 30_000 });
		return !/no providers yet/i.test(stdout) && stdout.trim().length > 0;
	} catch {
		// A magpie too old for this command, or one that exited 1: try the pool.
		return undefined;
	}
}

/** What magpie prints for one group, or undefined when there is no such group (it exits 1). */
async function groupShow(binary: string, id: string): Promise<string | undefined> {
	try {
		const { stdout } = await run(binary, ['group', 'show', id], { env: process.env, timeout: 30_000 });
		return stdout;
	} catch {
		return undefined;
	}
}

export interface AddProviderOptions {
	binary: string;
	/** magpie's id for the vendor: a preset's name, or one made for a custom vendor. */
	preset: string;
	/** The key itself. Never logged, never put in an error message. magpie requires one on a custom vendor. */
	key: string;
	/** A vendor magpie has no preset for: an OpenAI-compatible endpoint and the models to name. */
	custom?: CustomProvider;
}

/** An endpoint someone runs or subscribes to, whose magpie preset does not exist. */
export interface CustomProvider {
	name: string;
	/** The base URL, e.g. `https://api.example.com/v1`. */
	url: string;
	models: string[];
}

/**
 * The id magpie files a custom vendor under. An ASCII name is used as it is,
 * kebab-cased; a name in Chinese (or anything else magpie's ids do not take)
 * falls back to the endpoint's host, minus `api.`, which is what people
 * recognise: `api.deepseek.com` becomes `deepseek`.
 */
export function providerId(name: string, url: string): string {
	const ascii = name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, '-')
		.replace(/^[-.]+|[-.]+$/g, '')
		.slice(0, 40);
	if (/^[a-z0-9][a-z0-9._-]*$/.test(ascii)) return ascii;
	let host = '';
	try {
		host = new URL(url).hostname;
	} catch {
		host = '';
	}
	// An address is not a name: `192.168.1.9` would become "192", which tells
	// nobody anything, so a bare IP gets the plain id instead.
	if (/^[0-9.]+$/.test(host) || host.includes(':')) return 'custom';
	const fromHost = host
		.replace(/^api\./, '')
		.split('.')[0]
		?.toLowerCase()
		.replace(/[^a-z0-9-]+/g, '-')
		.replace(/^-+|-+$/g, '');
	return fromHost && /^[a-z0-9]/.test(fromHost) ? fromHost : 'custom';
}

/**
 * Registers a vendor key with magpie, so the user's own model is available where
 * the free pool is not. `execFile`'s failure text starts with the whole command
 * line, key included, so what comes out of here is magpie's own last word with
 * the key struck out.
 */
export async function addProvider(options: AddProviderOptions): Promise<void> {
	const args = options.custom
		? ['provider', 'add', options.preset, `name=${options.custom.name}`, `url=${options.custom.url}`, `models=${options.custom.models.join(',')}`, ...(options.key ? [`key=${options.key}`] : [])]
		: ['provider', 'add', options.preset, options.key];
	try {
		await magpieRun(options.binary, args, 120_000);
	} catch (error) {
		const last = String((error as { stderr?: string }).stderr ?? '')
			.split('\n')
			.map((line) => line.trim())
			.filter(Boolean)
			.at(-1);
		if (!last) throw new Error('magpie refused that key');
		// A custom vendor's refusal can be about the URL or a model name rather
		// than the key, but the key is never in it and never in this one.
		const said = (options.key ? last.replaceAll(options.key, '***') : last).replace(/^magpie:\s*/i, '');
		throw new Error(`magpie refused that key: ${said}`);
	}
}

/**
 * Whether magpie considers the free pool signed in, as it reports itself.
 * `undefined` when the machine is too old to say (no `--json`, no plugin yet):
 * then the sign-in is attempted, and it is its own answer that counts.
 */
async function freePluginSignedIn(binary: string): Promise<boolean | undefined> {
	const ask = async (env: NodeJS.ProcessEnv) => {
		const { stdout } = await run(binary, ['plugin', 'list', '--json'], { env, timeout: 60_000, maxBuffer: 32 << 20 });
		const listed = JSON.parse(stdout) as { providers?: Array<{ id?: string; signedIn?: boolean }> };
		const provider = listed.providers?.find((entry) => entry.id === 'our-free-model');
		return provider ? provider.signedIn === true : undefined;
	};
	try {
		return await ask(process.env);
	} catch {
		try {
			return await ask(cleanEnv());
		} catch {
			return undefined;
		}
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
	try {
		await askOnce(options, process.env);
	} catch (error) {
		const message = (error as Error).message;
		if (!proxied() || message.startsWith('no answer')) throw error;
		log(`${message}; trying again without this machine's proxy settings`);
		await askOnce(options, cleanEnv());
	}
}

/** The line worth repeating from what the sign-in printed, for a terminal or a log. */
function whyFailed(seen: string): string {
	// The prompt ends in "> " with no newline, so the error arrives on its line.
	const lines = seen
		.split('\n')
		.map((line) => line.replace(/^[>\s]+/, '').trim())
		.filter(Boolean);
	const said =
		lines.filter((line) => line.includes('magpie:')).at(-1) ??
		lines.filter((line) => !/^(\d+\.|How do you|Sign in in)/.test(line)).at(-1);
	return said ? `: ${said.replace(/^\d{4}\/\d\d\/\d\d [\d:]+\s*/, '')}` : '';
}

/** One attempt at the prompt, with the environment it is handed. */
async function askOnce(options: SignInOptions, env: NodeJS.ProcessEnv): Promise<void> {
	const timeoutMs = options.timeoutMs ?? 300_000;
	await new Promise<void>((resolve, reject) => {
		const child = spawn(options.binary, ['plugin', 'login', 'our-free-model'], {
			env,
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
		// 'close', not 'exit': the last thing magpie prints is the reason it failed,
		// and it is still in the pipe when the process is gone.
		child.once('close', (code) => {
			clearTimeout(timer);
			if (code === 0) return resolve();
			// It exits 1 when the pool's own service cannot start, which is what a
			// blocked download looks like; that line is the whole explanation.
			reject(new Error(answered ? `magpie plugin login exited ${code}${whyFailed(seen)}` : `magpie plugin login exited ${code} without asking anything`));
		});
	});
}
