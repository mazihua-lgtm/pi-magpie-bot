import { randomUUID } from 'node:crypto';
import type { HostDb } from './db.ts';

/** A picture sent with a message, as the model takes it: base64 and its type. */
export interface Attachment {
	data: string;
	mimeType: string;
}

export interface IncomingEvent {
	/** Which chat platform it came from. */
	source: string;
	/** The platform's own id for this message; the same id twice is one event. */
	sourceKey: string;
	/** Which conversation (pi-durable) this event belongs to. */
	conversation: string;
	text: string;
	/** Pictures that came with it; kept with the row until it is answered. */
	attachments?: Attachment[];
}

export interface InboxRow {
	id: string;
	source: string;
	source_key: string;
	conversation: string;
	text: string;
	received_at: number;
	status: 'pending' | 'running' | 'done';
	/** JSON of `Attachment[]`, or null; read it with `attachmentsOf`. */
	attachments: string | null;
}

/** The pictures of a row, or none: a row the column is unreadable in still has its words. */
export function attachmentsOf(row: Pick<InboxRow, 'attachments'>): Attachment[] {
	if (!row.attachments) return [];
	try {
		const parsed: unknown = JSON.parse(row.attachments);
		return Array.isArray(parsed)
			? parsed.filter(
					(item): item is Attachment =>
						typeof item === 'object' && item !== null && typeof item.data === 'string' && typeof item.mimeType === 'string',
				)
			: [];
	} catch {
		return [];
	}
}

/**
 * A durable inbox in front of the agent. The platform's webhook only writes
 * here and returns; the worker reads. A crash mid-run leaves the row
 * `running`, and `reclaim` puts it back exactly once.
 */
export class Inbox {
	private readonly host: HostDb;

	constructor(host: HostDb) {
		this.host = host;
	}

	/**
	 * Record a message handled immediately (an approval answer), using the same
	 * source_key uniqueness as `admit` so a redelivered "yes" cannot approve
	 * twice. The row starts `done`, so the worker never treats it as a chat turn.
	 * Returns false when this exact platform message was seen before.
	 */
	admitHandled(event: IncomingEvent): boolean {
		const result = this.host.db
			.prepare(
				`INSERT OR IGNORE INTO inbox (id, source, source_key, conversation, text, received_at, status, attachments)
				 VALUES (?, ?, ?, ?, ?, ?, 'done', NULL)`,
			)
			.run(randomUUID(), event.source, event.sourceKey, event.conversation, event.text, Date.now());
		return Number(result.changes) > 0;
	}

	/** Returns false when this exact platform message was already accepted. */
	admit(event: IncomingEvent): boolean {
		const result = this.host.db
			.prepare(
				`INSERT OR IGNORE INTO inbox (id, source, source_key, conversation, text, received_at, attachments)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				randomUUID(),
				event.source,
				event.sourceKey,
				event.conversation,
				event.text,
				Date.now(),
				event.attachments && event.attachments.length > 0 ? JSON.stringify(event.attachments) : null,
			);
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

	/** Done with it. The pictures go: they are in the conversation now, and megabytes each. */
	finish(id: string): void {
		this.host.db.prepare(`UPDATE inbox SET status = 'done', attachments = NULL WHERE id = ?`).run(id);
	}

	/**
	 * Marks a batch of rows as being answered together with their first. Left
	 * pending, a crash mid-run would close the first with "interrupted" and then
	 * answer the rest again on restart - the exact double answer this design
	 * promises not to send.
	 */
	finishMany(ids: string[]): void {
		const update = this.host.db.prepare(`UPDATE inbox SET status = 'running' WHERE id = ?`);
		for (const id of ids) update.run(id);
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
