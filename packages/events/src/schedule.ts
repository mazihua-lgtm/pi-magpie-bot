import { randomUUID } from 'node:crypto';
import type { HostDb } from './db.ts';

export interface ScheduleInput {
	conversation: string;
	channel: string;
	target: string;
	/** What the agent should be given when this fires. */
	text: string;
	/** When it first fires, in epoch milliseconds. */
	at: number;
	/** Repeat every this many milliseconds; absent means one shot. */
	everyMs?: number;
}

export interface ScheduleRow {
	id: string;
	conversation: string;
	channel: string;
	target: string;
	text: string;
	next_run_at: number;
	every_ms: number | null;
	created_at: number;
}

/**
 * Timers that outlive the process. pi-durable sleeps cover waiting inside a
 * run; this covers "wake me at 07:00 tomorrow", when no run exists yet.
 */
export class Schedules {
	private readonly host: HostDb;

	constructor(host: HostDb) {
		this.host = host;
	}

	add(input: ScheduleInput): string {
		const id = randomUUID();
		this.host.db
			.prepare(
				`INSERT INTO schedules (id, conversation, channel, target, text, next_run_at, every_ms, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(id, input.conversation, input.channel, input.target, input.text, input.at, input.everyMs ?? null, Date.now());
		return id;
	}

	/** Everything due at or before `now`, oldest first. */
	due(now: number = Date.now()): ScheduleRow[] {
		return this.host.db
			.prepare(`SELECT * FROM schedules WHERE next_run_at <= ? ORDER BY next_run_at`)
			.all(now) as unknown as ScheduleRow[];
	}

	/** When the next timer fires, or undefined with none armed. For a precise wake-up timer. */
	nextAt(now: number = Date.now()): number | undefined {
		const row = this.host.db
			.prepare(`SELECT MIN(next_run_at) AS at FROM schedules WHERE next_run_at > ?`)
			.get(now) as { at: number | null };
		return row.at ?? undefined;
	}

	/**
	 * Move a fired schedule to its next occurrence, or drop a one-shot.
	 * Call it only after the event it produces is durably in the inbox.
	 */
	fired(row: ScheduleRow, now: number = Date.now()): void {
		// A repeat of zero or less would make the catch-up loop below spin forever
		// and freeze the whole process. Such a row can only come from a bad write,
		// so it is dropped rather than trusted.
		if (row.every_ms == null || !(row.every_ms > 0)) {
			this.host.db.prepare(`DELETE FROM schedules WHERE id = ?`).run(row.id);
			return;
		}
		let next = row.next_run_at + row.every_ms;
		// A process that was down for several periods fires once, on time, not a
		// burst. every_ms is known positive here, so this always terminates; the
		// step count is computed rather than looped to keep a long outage cheap.
		if (next <= now) {
			const missed = Math.ceil((now - next) / row.every_ms);
			next += missed * row.every_ms;
		}
		this.host.db.prepare(`UPDATE schedules SET next_run_at = ? WHERE id = ?`).run(next, row.id);
	}

	remove(id: string): boolean {
		return Number(this.host.db.prepare(`DELETE FROM schedules WHERE id = ?`).run(id).changes) > 0;
	}

	list(conversation?: string): ScheduleRow[] {
		return (
			conversation
				? this.host.db.prepare(`SELECT * FROM schedules WHERE conversation = ? ORDER BY next_run_at`).all(conversation)
				: this.host.db.prepare(`SELECT * FROM schedules ORDER BY next_run_at`).all()
		) as unknown as ScheduleRow[];
	}
}
