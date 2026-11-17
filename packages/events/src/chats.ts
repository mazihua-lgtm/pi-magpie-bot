import type { HostDb } from './db.ts';

/**
 * Where a chat's title came from, so a later step knows whether it may replace it:
 * `empty` (nothing said yet), `first` (the first message, cut short), `model`
 * (written by the model after the first answer), `user` (typed by the user,
 * never replaced).
 */
export type TitleState = 'empty' | 'first' | 'model' | 'user';

export interface ChatRow {
	/** The host conversation this chat is, as `conversationIdFor` names it. */
	conversation: string;
	channel: string;
	/** Who it belongs to: on the web channel, the session id. */
	owner: string;
	/** The chat's own id within its owner. */
	chat: string;
	title: string;
	title_state: TitleState;
	pinned: number;
	/** null: the default model. */
	model: string | null;
	thinking: number;
	created_at: number;
	updated_at: number;
}

export interface ChatInput {
	conversation: string;
	channel: string;
	owner: string;
	chat: string;
	title: string;
	titleState: TitleState;
	model?: string | null;
	thinking?: boolean;
	/** Injected so a legacy chat can keep its own age. */
	at?: number;
}

export interface ChatChange {
	title?: string;
	titleState?: TitleState;
	pinned?: boolean;
	model?: string | null;
	thinking?: boolean;
}

/**
 * Several conversations per person, for a surface that shows a list of them.
 * A conversation without a row here is still a conversation (every chat
 * platform has one per chat); the row only adds what a list needs.
 */
export class Chats {
	private readonly host: HostDb;

	constructor(host: HostDb) {
		this.host = host;
	}

	create(input: ChatInput): ChatRow {
		const at = input.at ?? Date.now();
		this.host.db
			.prepare(
				`INSERT INTO chats (conversation, channel, owner, chat, title, title_state, model, thinking, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				input.conversation,
				input.channel,
				input.owner,
				input.chat,
				input.title,
				input.titleState,
				input.model ?? null,
				input.thinking ? 1 : 0,
				at,
				at,
			);
		return this.byConversation(input.conversation) as ChatRow;
	}

	get(channel: string, owner: string, chat: string): ChatRow | undefined {
		return this.host.db
			.prepare(`SELECT * FROM chats WHERE channel = ? AND owner = ? AND chat = ?`)
			.get(channel, owner, chat) as ChatRow | undefined;
	}

	byConversation(conversation: string): ChatRow | undefined {
		return this.host.db.prepare(`SELECT * FROM chats WHERE conversation = ?`).get(conversation) as ChatRow | undefined;
	}

	/** Pinned first, then the one that moved last. */
	list(channel: string, owner: string): ChatRow[] {
		return this.host.db
			.prepare(`SELECT * FROM chats WHERE channel = ? AND owner = ? ORDER BY pinned DESC, updated_at DESC, created_at DESC`)
			.all(channel, owner) as unknown as ChatRow[];
	}

	update(conversation: string, change: ChatChange): ChatRow | undefined {
		const sets: string[] = [];
		const values: Array<string | number | null> = [];
		if (change.title !== undefined) {
			sets.push('title = ?');
			values.push(change.title);
		}
		if (change.titleState !== undefined) {
			sets.push('title_state = ?');
			values.push(change.titleState);
		}
		if (change.pinned !== undefined) {
			sets.push('pinned = ?');
			values.push(change.pinned ? 1 : 0);
		}
		if (change.model !== undefined) {
			sets.push('model = ?');
			values.push(change.model);
		}
		if (change.thinking !== undefined) {
			sets.push('thinking = ?');
			values.push(change.thinking ? 1 : 0);
		}
		if (sets.length > 0) {
			this.host.db.prepare(`UPDATE chats SET ${sets.join(', ')} WHERE conversation = ?`).run(...values, conversation);
		}
		return this.byConversation(conversation);
	}

	/** Something was said in it: it moves to the top of the list. */
	touch(conversation: string, at = Date.now()): void {
		this.host.db.prepare(`UPDATE chats SET updated_at = ? WHERE conversation = ?`).run(at, conversation);
	}

	remove(conversation: string): boolean {
		return Number(this.host.db.prepare(`DELETE FROM chats WHERE conversation = ?`).run(conversation).changes) > 0;
	}
}
