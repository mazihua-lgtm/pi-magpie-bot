import { randomUUID } from 'node:crypto';
import type { HostDb } from './db.ts';

export interface IncomingEvent {
	/** Which chat platform it came from. */
	source: string;
	/** The platform's own id for this message; the same id twice is one event. */
	sourceKey: string;
	/** Which conversation (pi-durable) this event belongs to. */
	conversation: string;
	text: string;
}

export interface InboxRow {
	id: string;
	source: string;
	source_key: string;
	conversation: string;
	text: string;
	received_at: number;
	status: 'pending' | 'running' | 'done';
}

/**
 * A durable inbox in front of the agent. The platform's webhook only writes
 * here and returns; the worker reads. A crash mid-run leaves the row
 * `running`, and `reclaim` puts it back exactly once.
 */
export class Inbox {
	constructor(private readonly host: HostDb) {}

	/** Returns false when this exact platform message was already accepted. */
	admit(event: IncomingEvent): boolean {
		const result = this.host.db
			.prepare(
				`INSERT OR IGNORE INTO inbox (id, source, source_key, conversation, text, received_at)
				 VALUES (?, ?, ?, ?, ?, ?)`,
			)
			.run(randomUUID(), event.source, event.sourceKey, event.conversation, event.text, Date.now());
		return Number(result.changes) > 0;
	}

	/** The oldest pending event, marked running so no other worker takes it. */
	claim(): InboxRow | undefined {
		const row = this.host.db
			.prepare(`SELECT * FROM inbox WHERE status = 'pending' ORDER BY received_at LIMIT 1`)
			.get() as InboxRow | undefined;
		if (!row) return undefined;
		this.host.db.prepare(`UPDATE inbox SET status = 'running' WHERE id = ?`).run(row.id);
		return { ...row, status: 'running' };
	}

	finish(id: string): void {
		this.host.db.prepare(`UPDATE inbox SET status = 'done' WHERE id = ?`).run(id);
	}

	/**
	 * After a crash: a row left `running` was being answered when the process
	 * died. Its run does resume inside pi-durable, but nothing is left that
	 * would deliver the answer, and re-running it would answer twice. So it is
	 * closed here and returned, for the host to tell the user it was cut off.
	 */
	reclaim(): InboxRow[] {
		const rows = this.host.db
			.prepare(`SELECT * FROM inbox WHERE status = 'running' ORDER BY received_at`)
			.all() as unknown as InboxRow[];
		for (const row of rows) this.finish(row.id);
		return rows;
	}

	/** Everything still waiting for one conversation, oldest first. */
	pendingFor(conversation: string): InboxRow[] {
		return this.host.db
			.prepare(`SELECT * FROM inbox WHERE conversation = ? AND status = 'pending' ORDER BY received_at`)
			.all(conversation) as unknown as InboxRow[];
	}

	count(status: InboxRow['status'] = 'pending'): number {
		const row = this.host.db.prepare(`SELECT COUNT(*) AS n FROM inbox WHERE status = ?`).get(status) as { n: number };
		return Number(row.n);
	}
}
