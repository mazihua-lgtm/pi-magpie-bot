import { mkdirSync, readFileSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
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

const sleepFor = (ms: number) => {
	// A synchronous lock has to wait synchronously; this runs once, at startup.
	const end = Date.now() + ms;
	while (Date.now() < end) {
		// Busy-wait deliberately: the caller is a synchronous open() path.
	}
};

function owner(lockDir: string): Held | undefined {
	try {
		const parsed = JSON.parse(readFileSync(join(lockDir, 'owner'), 'utf8')) as Partial<Held>;
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
	// Only ESRCH means "no such process". Anything else - EPERM for another
	// owner, or an errno a sandbox invents - means something may be there, and
	// guessing wrong hands the directory to a second writer.
	try {
		process.kill(pid, 0);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
	}
	try {
		const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
		// An empty one is a process still being set up, not a reused pid.
		if (!cmdline.trim()) return true;
		// Ours is node (or a node-based runner); anything else at that pid is a
		// coincidence after a reboot.
		return /node|tsx|bot/i.test(cmdline) || cmdline.includes('pi-magpie-bot');
	} catch {
		// No /proc (macOS) or not readable (another uid): trust the liveness check.
		return true;
	}
}

/** How old an unreadable lock must be before it is treated as debris. */
const DEBRIS_AFTER_MS = 10_000;

/**
 * Remove whatever marker is there. For the one caller that has already checked
 * the holder is not serving anyone (the bot probes its own port first): a
 * process that is alive but no longer answering would otherwise block every
 * later start, which is a worse failure than the one the lock prevents.
 */
export function clearDataDirLock(dataDir: string): void {
	const path = join(dataDir, '.lock');
	try {
		unlinkSync(join(path, 'owner'));
	} catch {
		// Nothing to remove.
	}
	try {
		rmdirSync(path);
	} catch {
		// Nothing to remove.
	}
}

/**
 * Take the lock, or throw with a sentence that says what is already running.
 *
 * The marker is a directory, because `mkdir` either happens or does not: a file
 * can be seen half-written, and reading it as empty would hand the directory to
 * a second process while the first is still starting.
 */
export function claimDataDir(dataDir: string): DataDirLock {
	const path = join(dataDir, '.lock');

	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			mkdirSync(path);
			writeFileSync(join(path, 'owner'), JSON.stringify({ pid: process.pid, started: new Date().toISOString() }));
			let released = false;
			return {
				path,
				release() {
					if (released) return;
					released = true;
					const held = owner(path);
					// Only remove our own: a later takeover must not be undone by us.
					if (!held || held.pid === process.pid) {
						try {
							unlinkSync(join(path, 'owner'));
						} catch {
							// Already gone.
						}
						try {
							rmdirSync(path);
						} catch {
							// Already gone, or someone else's now.
						}
					}
				},
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;

			// An older version of this app wrote a plain file here. It carries no
			// owner we can check, and it cannot be held by anything still running
			// that understands the lock, so it is debris by definition.
			let isDirectory = false;
			try {
				isDirectory = statSync(path).isDirectory();
			} catch {
				continue; // It vanished; try again.
			}
			if (!isDirectory) {
				try {
					unlinkSync(path);
				} catch {
					// Someone else removed it; the next attempt settles it.
				}
				continue;
			}

			// The owner file may not be written yet: the holder created the
			// directory a moment ago. Give it a real chance before deciding.
			let held = owner(path);
			for (let waited = 0; !held && waited < 500; waited += 100) {
				sleepFor(100);
				held = owner(path);
			}

			if (held && alive(held.pid)) {
				throw new Error(
					`另一个助理正在用这个数据目录（进程 ${held.pid}）。同时开两个会把正在发的消息和正在等的审批弄坏；先关掉那一个，再启动这个。`,
				);
			}
			if (!held) {
				// Unreadable and no owner appeared. Only debris if it is old enough
				// that a starting process would have written it by now.
				let age = 0;
				try {
					age = Date.now() - statSync(path).mtimeMs;
				} catch {
					continue; // It vanished; try again.
				}
				if (age < DEBRIS_AFTER_MS) {
					throw new Error(`另一个助理正在启动（${path}）。等几秒再试。`);
				}
			}
			// Stale: the process that made it is gone, or it is old debris.
			try {
				unlinkSync(join(path, 'owner'));
			} catch {
				// Nothing to remove.
			}
			try {
				rmdirSync(path);
			} catch {
				// Someone else got there first; the next attempt settles it.
			}
		}
	}
	throw new Error(`锁不住数据目录 ${dataDir}：另一个进程正在同时启动。`);
}
