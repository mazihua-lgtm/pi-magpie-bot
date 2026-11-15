import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { type GatewayConfig, healthcheck } from './config.ts';

/** Where the installer put it, unless this machine says otherwise. */
export function findMagpieBinary(env: NodeJS.ProcessEnv = process.env): string | undefined {
	if (env.MAGPIE_BIN) return env.MAGPIE_BIN;
	const candidates = [join(homedir(), '.local/bin/magpie'), '/usr/local/bin/magpie', '/opt/homebrew/bin/magpie'];
	return candidates.find((candidate) => existsSync(candidate));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface EnsureGatewayOptions {
	/** A magpie a user installed and runs themselves is theirs to start. */
	start?: boolean;
	timeoutMs?: number;
	binary?: string;
}

/**
 * The gateway has to answer before anything else is worth doing: no models,
 * no agent. Waits on a gateway already running; starts one when asked to.
 */
export async function ensureGateway(config: GatewayConfig, options: EnsureGatewayOptions = {}): Promise<void> {
	const timeoutMs = options.timeoutMs ?? 30_000;
	const deadline = Date.now() + timeoutMs;
	if (await healthcheck(config)) return;
	if (options.start === false) {
		// Someone else owns the gateway (another container, another machine): it
		// may still be booting, so wait for it rather than start a second one.
		const message = `magpie gateway is not answering at ${config.baseUrl}`;
		while (Date.now() < deadline) {
			await sleep(500);
			if (await healthcheck(config)) return;
		}
		throw new Error(`${message} (waited ${timeoutMs}ms)`);
	}

	const binary = options.binary ?? findMagpieBinary();
	if (!binary) {
		throw new Error(
			'magpie is not installed. Install it from https://usemagpie.ai or set MAGPIE_BIN to its path.',
		);
	}

	const child = spawn(binary, ['serve'], { detached: true, stdio: 'ignore' });
	child.unref();

	while (Date.now() < deadline) {
		await sleep(500);
		if (await healthcheck(config)) return;
	}
	throw new Error(`magpie gateway did not answer at ${config.baseUrl} within ${timeoutMs}ms`);
}
