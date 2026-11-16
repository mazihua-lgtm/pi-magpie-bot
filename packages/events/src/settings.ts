import type { HostDb } from './db.ts';

/**
 * Small durable key-value facts about this installation. The one that matters
 * first is who owns the bot: a chat platform anyone can message must have
 * exactly one owner, or a stranger spends your credits.
 */
export class Settings {
	private readonly host: HostDb;

	constructor(host: HostDb) {
		this.host = host;
	}

	get(key: string): string | undefined {
		const row = this.host.db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as
			| { value: string }
			| undefined;
		return row?.value;
	}

	set(key: string, value: string): void {
		this.host.db
			.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
			.run(key, value);
	}
}
