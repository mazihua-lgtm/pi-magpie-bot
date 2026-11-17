import type { HostDb } from './db.ts';

export interface Target {
	conversation: string;
	channel: string;
	target: string;
}

export interface BoundTarget extends Target {
	/** The pi-durable conversation this chat runs in, minted on first contact. */
	agentConversation?: string;
}

/**
 * Which chat each conversation answers in, so a tool that speaks on its own
 * (a reminder firing at 07:00, a follow-up) knows where to send it.
 */
export class Targets {
	private readonly host: HostDb;

	constructor(host: HostDb) {
		this.host = host;
	}

	bind(target: Target): void {
		const now = Date.now();
		this.host.db
			.prepare(
				`INSERT INTO conversations (id, channel, target, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
				 ON CONFLICT(id) DO UPDATE SET channel = excluded.channel, target = excluded.target, updated_at = excluded.updated_at`,
			)
			.run(target.conversation, target.channel, target.target, now, now);
	}

	get(conversation: string): BoundTarget | undefined {
		return this.read(`id = ?`, conversation);
	}

	/**
	 * The chat behind a pi-durable conversation, for a tool that wants to
	 * speak on its own; the tool only knows the id the runtime gave it.
	 */
	getByAgent(agentConversation: string | number): BoundTarget | undefined {
		return this.read(`agent_conversation = ?`, String(agentConversation));
	}

	private read(where: string, value: string): BoundTarget | undefined {
		const row = this.host.db
			.prepare(`SELECT id, channel, target, agent_conversation FROM conversations WHERE ${where}`)
			.get(value) as
			| { id: string; channel: string; target: string; agent_conversation: string | null }
			| undefined;
		if (!row) return undefined;
		return {
			conversation: row.id,
			channel: row.channel,
			target: row.target,
			agentConversation: row.agent_conversation ?? undefined,
		};
	}

	/**
	 * Forget a chat: the next message to the same target starts a new
	 * conversation instead of continuing the one that was deleted.
	 */
	forget(conversation: string): void {
		this.host.db.prepare(`DELETE FROM conversations WHERE id = ?`).run(conversation);
	}

	setAgentConversation(conversation: string, agentConversation: string | number): void {
		this.host.db
			.prepare(`UPDATE conversations SET agent_conversation = ?, updated_at = ? WHERE id = ?`)
			.run(String(agentConversation), Date.now(), conversation);
	}
}
