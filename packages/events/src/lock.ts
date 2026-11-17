import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';

/**
 * One process per data directory.
 *
 * The host tables are a single SQLite writer, and startup "recovers" what it
 * assumes is its own mess: a message mid-send becomes `unknown` and is never
 * retried, a waiting approval card is expired, a running event is closed and
 * the user is told it was interrupted. All of that is right after a crash and
 * destructive when a second process is simply running - it would steal the
 * first one's in-flight work while that one is still using it.
 */
export interface DataDirLock {
	/** The path held, for a message that says which one. */
	readonly path: string;
	release(): void;
}

interface Held {
	pid: number;
	started: string;
}

function read(path: string): Held | undefined {
	try {
		const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<Held>;
		return typeof parsed.pid === 'number' ? { pid: parsed.pid, started: String(parsed.started ?? '') } : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Whether the pid in the lock is our kind of process. A phone that reboots
 * reuses pids, so "something is alive at that number" is not enough: it would
 * refuse to start forever after one crash. Where /proc exists the command line
 * has to look like node, and an unreadable one counts as gone.
 */
function alive(pid: number): boolean {
	if (pid === process.pid) return true;
	let running: boolean;
	try {
		process.kill(pid, 0);
		running = true;
	} catch (error) {
		// EPERM means it exists but belongs to someone else, which still counts.
		running = (error as NodeJS.ErrnoException).code === 'EPERM';
	}
	if (!running) return false;
	try {
		const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
		// Our own process is node (or a node-based runner); anything else at that
		// pid is a coincidence after a reboot.
		return /node|tsx|bot/i.test(cmdline) || cmdline.includes('pi-magpie-bot');
	} catch {
		// No /proc (macOS) or not readable (another uid): trust the liveness check.
		return true;
	}
}

/**
 * Take the lock, or throw with a sentence that says what is already running.
 * A lock left by a process that is gone is taken over rather than blocking
 * forever - a phone killed mid-run must still start again.
 */
export function claimDataDir(dataDir: string): DataDirLock {
	const path = join(dataDir, '.lock');
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const fd = openSync(path, 'wx');
			try {
				writeSync(fd, JSON.stringify({ pid: process.pid, started: new Date().toISOString() }));
			} finally {
				closeSync(fd);
			}
			let released = false;
			return {
				path,
				release() {
					if (released) return;
					released = true;
					const held = read(path);
					// Only remove our own: a takeover by a later process must not be undone.
					if (held && held.pid === process.pid) {
						try {
							unlinkSync(path);
						} catch {
							// Already gone; nothing to do.
						}
					}
				},
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
			const held = read(path);
			if (held && alive(held.pid)) {
				throw new Error(
					`另一个助理正在用这个数据目录（进程 ${held.pid}）。同时开两个会把正在发的消息和正在等的审批弄坏；先关掉那一个，再启动这个。`,
				);
			}
			// Stale: the process that wrote it is gone.
			try {
				unlinkSync(path);
			} catch {
				// Someone else removed it first; the retry will settle it.
			}
		}
	}
	throw new Error(`锁不住数据目录 ${dataDir}：另一个进程正在同时启动。`);
}
