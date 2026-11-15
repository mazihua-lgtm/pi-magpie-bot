import { randomUUID } from 'node:crypto';
import type { HostDb } from './db.ts';

export type ApprovalStatus = 'pending' | 'allowed' | 'denied' | 'expired';

export interface ApprovalRow {
	id: string;
	conversation: string;
	channel: string;
	target: string;
	/** What will run, in the user's words: shown on the card. */
	action: string;
	created_at: number;
	status: ApprovalStatus;
	decided_at: number | null;
}

export interface ApprovalRequest {
	conversation: string;
	channel: string;
	target: string;
	action: string;
}

/** Words that answer a card. Anything else is treated as a new message. */
const YES = /^(是|好|好的|可以|行|批准|同意|允许|对|yes|y|ok|okay|go|sure)$/i;
const NO = /^(否|不|不行|不要|拒绝|取消|别|no|n|nope|stop|cancel)$/i;

/**
 * A high-risk action waits here instead of running. The row is the whole of
 * the state: the tool that asked keeps checking it, so a restart loses the
 * wait but never the question, and the answer arrives as a normal chat message.
 */
export class Approvals {
	constructor(private readonly host: HostDb) {}

	ask(request: ApprovalRequest): string {
		const id = randomUUID().slice(0, 8);
		this.host.db
			.prepare(`INSERT INTO approvals (id, conversation, channel, target, action, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
			.run(id, request.conversation, request.channel, request.target, request.action, Date.now());
		return id;
	}

	get(id: string): ApprovalRow | undefined {
		return this.host.db.prepare(`SELECT * FROM approvals WHERE id = ?`).get(id) as ApprovalRow | undefined;
	}

	pendingFor(conversation: string): ApprovalRow | undefined {
		return this.host.db
			.prepare(`SELECT * FROM approvals WHERE conversation = ? AND status = 'pending' ORDER BY created_at LIMIT 1`)
			.get(conversation) as ApprovalRow | undefined;
	}

	/** The oldest question this text answers, if it answers one at all. */
	answer(conversation: string, text: string): { row: ApprovalRow; allowed: boolean } | undefined {
		const row = this.pendingFor(conversation);
		if (!row) return undefined;
		const said = text.trim().replace(/[。.!！]+$/u, '');
		if (YES.test(said)) return { row, allowed: true };
		if (NO.test(said)) return { row, allowed: false };
		return undefined;
	}

	decide(id: string, status: 'allowed' | 'denied' | 'expired'): boolean {
		const result = this.host.db
			.prepare(`UPDATE approvals SET status = ?, decided_at = ? WHERE id = ? AND status = 'pending'`)
			.run(status, Date.now(), id);
		return Number(result.changes) > 0;
	}
}
