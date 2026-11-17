import type { HostDb } from './db.ts';

export interface OutgoingMessage {
	conversation: string;
	channel: string;
	/** Where the channel should send it: a chat id, a session id. */
	target: string;
	text: string;
	/**
	 * What it is, for a surface that shows some kinds its own way: `answer` (the
	 * run's final words), `approval` (a yes/no card), `reminder`, `notice` (the
	 * bot's own line about a failure). Absent: something the agent said itself.
	 */
	kind?: OutgoingKind;
}

export type OutgoingKind = 'answer' | 'approval' | 'reminder' | 'notice';

export type OutboxStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'unknown';

export interface OutboxRow {
	id: number;
	conversation: string;
	channel: string;
	target: string;
	text: string;
	created_at: number;
	status: OutboxStatus;
	attempts: number;
	/** Earliest time a retry may run; null means now. */
	retry_at: number | null;
	sent_at: number | null;
	error: string | null;
	kind: OutgoingKind | null;
}

/** How often one message is tried before it is given up on. */
const MAX_ATTEMPTS = 3;

/**
 * What the agent wants to say, written before it is said. Message text is
 * written once and read once: nothing here calls a model.
 *
 * Delivery is at least once inside a tick and never silently dropped: a
 * failure goes back in the queue until `MAX_ATTEMPTS`, then stays `failed`
 * with the reason. A message caught mid-send by a crash becomes `unknown`
 * and is not retried, so a restart cannot answer the same thing twice.
 */
export class Outbox {
	private readonly host: HostDb;

	constructor(host: HostDb) {
		this.host = host;
	}

	enqueue(message: OutgoingMessage): number {
		const result = this.host.db
			.prepare(
				`INSERT INTO outbox (conversation, channel, target, text, created_at, kind) VALUES (?, ?, ?, ?, ?, ?)`,
			)
			.run(message.conversation, message.channel, message.target, message.text, Date.now(), message.kind ?? null);
		return Number(result.lastInsertRowid);
	}

	/** The oldest unsent message that is due, marked `sending` so a second worker cannot take it. */
	next(now = Date.now()): OutboxRow | undefined {
		const row = this.host.db
			.prepare(
				`SELECT * FROM outbox WHERE status = 'pending' AND (retry_at IS NULL OR retry_at <= ?) ORDER BY id LIMIT 1`,
			)
			.get(now) as OutboxRow | undefined;
		if (!row) return undefined;
		const attempts = row.attempts + 1;
		this.host.db.prepare(`UPDATE outbox SET status = 'sending', attempts = ? WHERE id = ?`).run(attempts, row.id);
		return { ...row, status: 'sending', attempts };
	}

	sent(id: number): void {
		this.host.db.prepare(`UPDATE outbox SET status = 'sent', sent_at = ? WHERE id = ?`).run(Date.now(), id);
	}

	/** A send that threw: back in the queue with a growing pause, until the attempts run out. */
	failed(id: number, error: string, attempts: number): void {
		const status: OutboxStatus = attempts >= MAX_ATTEMPTS ? 'failed' : 'pending';
		const retryAt = Date.now() + 5_000 * Math.max(1, attempts);
		this.host.db
			.prepare(`UPDATE outbox SET status = ?, error = ?, retry_at = ? WHERE id = ?`)
			.run(status, error, status === 'pending' ? retryAt : null, id);
	}

	/**
	 * At startup: a message still marked `sending` was cut off by the crash.
	 * Nobody can prove whether it arrived, so it is not sent again.
	 */
	releaseInFlight(): number {
		const result = this.host.db
			.prepare(`UPDATE outbox SET status = 'unknown', error = 'interrupted while sending' WHERE status = 'sending'`)
			.run();
		return Number(result.changes);
	}

	pendingCount(): number {
		const row = this.host.db.prepare(`SELECT COUNT(*) AS n FROM outbox WHERE status = 'pending'`).get() as {
			n: number;
		};
		return Number(row.n);
	}
}
