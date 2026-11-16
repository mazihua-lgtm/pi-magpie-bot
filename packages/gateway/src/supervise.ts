import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { type GatewayConfig, healthcheck } from './config.ts';
import { installMagpie } from './install.ts';

/** Where the installer put it, unless this machine says otherwise. */
export function findMagpieBinary(env: NodeJS.ProcessEnv = process.env, elsewhere: string[] = []): string | undefined {
	if (env.MAGPIE_BIN) return env.MAGPIE_BIN;
	const candidates = [join(homedir(), '.local/bin/magpie'), '/usr/local/bin/magpie', '/opt/homebrew/bin/magpie', ...elsewhere];
	return candidates.find((candidate) => existsSync(candidate));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface EnsureGatewayOptions {
	/** A magpie a user installed and runs themselves is theirs to start. */
	start?: boolean;
	timeoutMs?: number;
	binary?: string;
	/**
	 * Where a magpie of our own goes when this machine has none: the product
	 * downloads the release rather than sending the user off to install it.
	 */
	installDir?: string;
	log?: (line: string) => void;
}

/**
 * The gateway has to answer before anything else is worth doing: no models,
 * no agent. Waits on a gateway already running; starts one when asked to.
 * Returns the binary that was used, when one was found or fetched.
 */
export async function ensureGateway(
	config: GatewayConfig,
	options: EnsureGatewayOptions = {},
): Promise<{ binary?: string }> {
	const timeoutMs = options.timeoutMs ?? 30_000;
	const deadline = Date.now() + timeoutMs;
	if (await healthcheck(config)) return {};
	if (options.start === false) {
		// Someone else owns the gateway (another container, another machine): it
		// may still be booting, so wait for it rather than start a second one.
		const message = `magpie gateway is not answering at ${config.baseUrl}`;
		while (Date.now() < deadline) {
			await sleep(500);
			if (await healthcheck(config)) return {};
		}
		throw new Error(`${message} (waited ${timeoutMs}ms)`);
	}

	let binary = options.binary ?? findMagpieBinary();
	if (!binary) {
		if (!options.installDir) {
			throw new Error('magpie is not installed. Install it from https://usemagpie.ai or set MAGPIE_BIN to its path.');
		}
		binary = await installMagpie({ dir: options.installDir, log: options.log });
	}

	// A magpie of our own listens where the bot was told to look for it, so a
	// non-default MAGPIE_BASE_URL means something for the one we start too.
	const address = new URL(config.baseUrl);
	const child = spawn(binary, ['serve'], {
		detached: true,
		stdio: 'ignore',
		env: { ...process.env, MAGPIE_ADDR: `${address.hostname}:${address.port}` },
	});
	child.unref();

	while (Date.now() < deadline) {
		await sleep(500);
		if (await healthcheck(config)) return { binary };
	}
	throw new Error(`magpie gateway did not answer at ${config.baseUrl} within ${timeoutMs}ms`);
}
