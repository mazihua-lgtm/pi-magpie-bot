import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { claimDataDir } from '../src/lock.ts';

const scratch: string[] = [];
const running: Array<() => void> = [];
const tempDir = async () => {
	const dir = await mkdtemp(join(tmpdir(), 'lock-'));
	scratch.push(dir);
	return dir;
};

/** A process that stays alive long enough to be seen as holding the lock. */
const livePid = async (): Promise<number> => {
	const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
	running.push(() => child.kill('SIGKILL'));
	await new Promise((resolve) => setTimeout(resolve, 150));
	return child.pid!;
};

afterEach(async () => {
	for (const stop of running.splice(0)) stop();
	for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('the data directory lock', () => {
	it('refuses to let a second caller into the same directory', async () => {
		const dir = await tempDir();
		const held = claimDataDir(dir);
		expect(() => claimDataDir(dir)).toThrow(/另一个助理/);
		held.release();
	});

	it('writes the pid so the refusal can name it', async () => {
		const dir = await tempDir();
		const held = claimDataDir(dir);
		const written = JSON.parse(await readFile(held.path, 'utf8')) as { pid: number };
		expect(written.pid).toBe(process.pid);
		held.release();
	});

	it('refuses a directory another live process holds', async () => {
		const dir = await tempDir();
		const pid = await livePid();
		await writeFile(join(dir, '.lock'), JSON.stringify({ pid, started: '' }));
		expect(() => claimDataDir(dir)).toThrow(/另一个助理/);
	});

	it('takes over a lock left by a process that is gone', async () => {
		const dir = await tempDir();
		// Above the pid limit on both Linux and macOS: nothing can be running there.
		await writeFile(join(dir, '.lock'), JSON.stringify({ pid: 999_999, started: '' }));
		const held = claimDataDir(dir);
		expect(held.path).toBe(join(dir, '.lock'));
		held.release();
	});

	it('removes the file on release, so the next start is clean', async () => {
		const dir = await tempDir();
		const held = claimDataDir(dir);
		held.release();
		// Idempotent: a second release must not throw.
		expect(() => held.release()).not.toThrow();
		const again = claimDataDir(dir);
		again.release();
	});
});
