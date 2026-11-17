import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

const hold = async (dir: string, pid: number) => {
	await mkdir(join(dir, '.lock'), { recursive: true });
	await writeFile(join(dir, '.lock', 'owner'), JSON.stringify({ pid, started: '' }));
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

	it('records the pid so the refusal can name it', async () => {
		const dir = await tempDir();
		const held = claimDataDir(dir);
		const written = JSON.parse(await readFile(join(held.path, 'owner'), 'utf8')) as { pid: number };
		expect(written.pid).toBe(process.pid);
		held.release();
	});

	it('refuses a directory another live process holds', async () => {
		const dir = await tempDir();
		await hold(dir, await livePid());
		expect(() => claimDataDir(dir)).toThrow(/另一个助理/);
	});

	it('takes over a lock left by a process that is gone', async () => {
		const dir = await tempDir();
		// Above the pid limit on both Linux and macOS: nothing can be running there.
		await hold(dir, 999_999);
		const held = claimDataDir(dir);
		expect(held.path).toBe(join(dir, '.lock'));
		held.release();
	});

	it('refuses a lock directory that is too new to be debris', async () => {
		const dir = await tempDir();
		// A directory with no owner file yet: a process is creating it right now.
		await mkdir(join(dir, '.lock'), { recursive: true });
		expect(() => claimDataDir(dir)).toThrow(/正在启动/);
	});

	it('removes the marker on release, so the next start is clean', async () => {
		const dir = await tempDir();
		const held = claimDataDir(dir);
		held.release();
		// Idempotent: a second release must not throw.
		expect(() => held.release()).not.toThrow();
		const again = claimDataDir(dir);
		again.release();
	});
});

describe('an old-format lock file', () => {
	it('is cleared rather than blocking every start', async () => {
		const dir = await tempDir();
		// What the previous version wrote: a plain file, not a directory.
		await writeFile(join(dir, '.lock'), JSON.stringify({ pid: 999_999, started: '' }));
		const held = claimDataDir(dir);
		expect(held.path).toBe(join(dir, '.lock'));
		held.release();
	});
});
