/**
 * The free models, as a local OpenAI-compatible service behind magpie.
 *
 * A companion service (a slimmed copy of dsh-our-free-model's standalone
 * gateway, shipped inside the Android payload) serves free models on loopback.
 * Between it and magpie sits a small proxy (scripts/ofm-proxy.mjs) that offers
 * one stable model and retries the next free lane when one runs out of quota:
 * a gateway that sees a single lane's 429 locks the whole provider, refusing
 * even the lanes that still work. When either process is unreachable the usual
 * key page takes over — the free pool is a convenience, not a single point of
 * failure.
 */
import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

const run = promisify(execFile);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The id magpie knows this provider by, and the head of its model ids. */
const OFM_PROVIDER = 'ofm';
const OFM_PORT = 18_900;
/** The stable model the proxy offers and agents pick. */
export const OFM_STABLE_MODEL = 'free';
/** The proxy sits between magpie and the upstream service, hiding lane 429s. */
const OFM_PROXY_PORT = 18_901;

export interface OfmRouteOptions {
	/** magpie's CLI, for registering the provider. */
	binary: string;
	/** Node, to run the standalone service with (no Bun needed on a phone). */
	node?: string;
	/** Where the service source is inside this root: /opt/ofm on a phone. */
	sourceDir: string;
	/** A real, writable directory for the service's own state and API key. */
	dataDir: string;
	/** Only for tests or a non-default port. */
	port?: number;
	/** The proxy script shipped with this repository. Default: alongside this package. */
	proxyScript?: string;
	proxyPort?: number;
	log?: (line: string) => void;
}

function cleanEnv(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete env[key];
	return env;
}

async function magpieRun(binary: string, args: string[], timeout = 30_000): Promise<void> {
	try {
		await run(binary, args, { env: process.env, timeout });
	} catch (error) {
		if (!/HTTP_PROXY|HTTPS_PROXY/i.test(JSON.stringify(process.env))) throw error;
		await run(binary, args, { env: cleanEnv(), timeout });
	}
}

async function gatewayUp(base: string): Promise<boolean> {
	try {
		const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(3_000) });
		return response.ok;
	} catch {
		return false;
	}
}

/** Health alone is not enough: an old proxy may still hold the port. */
async function proxyIsOurs(base: string): Promise<boolean> {
	try {
		const response = await fetch(`${base}/v1/models`, { signal: AbortSignal.timeout(3_000) });
		const body = (await response.json()) as { data?: Array<{ id?: string }> };
		return body.data?.some((model) => model.id === OFM_STABLE_MODEL) === true;
	} catch {
		return false;
	}
}

/** The service writes its own API key here on first start. */
function readKey(dataDir: string): string | undefined {
	const path = join(dataDir, 'settings.json');
	if (!existsSync(path)) return undefined;
	try {
		const key = (JSON.parse(readFileSync(path, 'utf8')) as { forwardKey?: string }).forwardKey;
		return typeof key === 'string' && key ? key : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Start the failover proxy in front of the service. It offers one stable model
 * and hides the per-lane quota errors that make a gateway lock a provider.
 */
async function ensureProxy(options: OfmRouteOptions, upstreamPort: number, node: string): Promise<string | undefined> {
	const proxyPort = options.proxyPort ?? OFM_PROXY_PORT;
	const base = `http://127.0.0.1:${proxyPort}`;
	if (await proxyIsOurs(base)) return base; // our proxy is already up
	const script = options.proxyScript ?? join(process.env.OFM_PROXY_DIR ?? '/app/scripts', 'ofm-proxy.mjs');
	if (!existsSync(script)) {
		(options.log ?? (() => {}))(`the free-model proxy is not bundled at ${script}`);
		return undefined;
	}
	// Not detached: the proxy is a child of this process, so a restart or a
	// force-stop takes it with it. A detached one can survive holding the port
	// with stale code and stale lanes.
	spawn(node, [script], {
		stdio: 'ignore',
		env: {
			...cleanEnv(),
			OFM_UPSTREAM: `http://127.0.0.1:${upstreamPort}`,
			OFM_PROXY_PORT: String(proxyPort),
			OFM_KEY_FILE: join(options.dataDir, 'settings.json'),
			NO_PROXY: '*',
			no_proxy: '*',
		},
	})
		// Without this an ENOENT/EACCES on spawn is an uncaught 'error' event that
		// takes the whole bot down before it can say why.
		.on('error', (error) => (options.log ?? (() => {}))(`the free-model proxy could not start: ${error.message}`))
		.on('exit', (code, signal) => {
			if (code === 0 || signal === 'SIGTERM') return;
			// The proxy dying means every free request fails until someone
			// restarts it. Say so where a person can see it.
			(options.log ?? (() => {}))(`the free-model proxy exited (${signal ?? code}); free models are down until restart`);
		});

	for (let waited = 0; waited < 15_000; waited += 500) {
		await sleep(500);
		if (await proxyIsOurs(base)) return base;
	}
	(options.log ?? (() => {}))('the free-model proxy did not answer');
	return undefined;
}

/** Whether magpie already has this provider; adding the same one twice duplicates it. */
async function providerExists(binary: string): Promise<boolean> {
	try {
		await run(binary, ['provider', OFM_PROVIDER], { env: process.env, timeout: 15_000 });
		return true;
	} catch {
		return false;
	}
}

/**
 * Start the local free-model service and its failover proxy (if not already
 * up), and teach magpie about the single stable model the proxy offers. Safe
 * to call on every boot: it starts only what is down and never adds the
 * provider twice.
 */
export async function ensureOfmRoute(options: OfmRouteOptions): Promise<boolean> {
	const log = options.log ?? (() => {});
	const port = options.port ?? OFM_PORT;
	const base = `http://127.0.0.1:${port}`;

	if (!await gatewayUp(base)) {
		const cli = join(options.sourceDir, 'packages', 'standalone', 'cli.mjs');
		if (!existsSync(cli)) {
			log(`the free-model service is not bundled at ${cli}`);
			return false;
		}
		const node = options.node ?? process.execPath;
		const env: NodeJS.ProcessEnv = {
			...cleanEnv(),
			// The default lane wants Bun; a phone has only this node.
			OUR_FREE_MODEL_FREE_TRANSPORT: 'node',
			NO_PROXY: '*',
			no_proxy: '*',
		};
		// A child of this process, not detached: a restart or force-stop takes
		// it with it, so an old instance never holds the port with stale state.
		spawn(node, [cli, '--port', String(port), '--data-dir', options.dataDir], {
			stdio: 'ignore',
			env,
		})
			.on('error', (error) => log(`the free-model service could not start: ${error.message}`))
			.on('exit', (code, signal) => {
				if (code === 0 || signal === 'SIGTERM') return;
				log(`the free-model service exited (${signal ?? code}); free models are down until restart`);
			});
		log('starting the free-model service');

		let up = false;
		for (let waited = 0; waited < 60_000; waited += 1_000) {
			await sleep(1_000);
			if (await gatewayUp(base)) {
				up = true;
				break;
			}
		}
		if (!up) {
			log('the free-model service did not answer; the key page will take over');
			return false;
		}
	}

	const key = readKey(options.dataDir);
	if (!key) {
		log('the free-model service has no key yet; the key page will take over');
		return false;
	}

	const node = options.node ?? process.execPath;
	const proxy = await ensureProxy(options, port, node);
	if (!proxy) return false;
	log(`free-model proxy at ${proxy}/v1`);

	try {
		if (!await providerExists(options.binary)) {
			// One stable model, no live catalogue: the proxy decides which free
			// lane answers each request, so magpie never sees a quota-limited
			// model name and never locks the provider on one lane's 429.
			await magpieRun(options.binary, [
				'provider', 'add', OFM_PROVIDER,
				`url=${proxy}/v1`, `key=${key}`, `models=${OFM_STABLE_MODEL}`, 'list=off',
			]);
			log(`added the free provider from ${proxy}/v1`);
		}
		log('the proxy fails over between free lanes and picks up new ones itself');
	} catch (error) {
		// `execFile`'s message starts with the whole command line, which carries
		// the service's own key. This log is visible in logcat and in the app's
		// log panel, so the key is struck out the way install.ts does it.
		const said = ((error as Error).message.split('\n')[0] ?? '').replaceAll(key, '***');
		log(`could not register the free provider: ${said}`);
		return false;
	}
	return true;
}
