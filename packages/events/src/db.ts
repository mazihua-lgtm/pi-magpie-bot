import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * The host's own tables, beside pi-durable's conversation storage. pi-durable
 * owns what the agent did; this owns what the outside world wants from it.
 */
export interface HostDb {
	db: DatabaseSync;
	close(): void;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS inbox (
	id          TEXT PRIMARY KEY,
	source      TEXT NOT NULL,
	source_key  TEXT NOT NULL,
	conversation TEXT NOT NULL,
	text        TEXT NOT NULL,
	received_at INTEGER NOT NULL,
	status      TEXT NOT NULL DEFAULT 'pending',
	UNIQUE (source, source_key)
);
CREATE INDEX IF NOT EXISTS inbox_pending ON inbox (status, received_at);

CREATE TABLE IF NOT EXISTS outbox (
	id          INTEGER PRIMARY KEY AUTOINCREMENT,
	conversation TEXT NOT NULL,
	channel     TEXT NOT NULL,
	target      TEXT NOT NULL,
	text        TEXT NOT NULL,
	created_at  INTEGER NOT NULL,
	status      TEXT NOT NULL DEFAULT 'pending',
	attempts    INTEGER NOT NULL DEFAULT 0,
	retry_at    INTEGER,
	sent_at     INTEGER,
	error       TEXT
);
CREATE INDEX IF NOT EXISTS outbox_pending ON outbox (status, id);

CREATE TABLE IF NOT EXISTS schedules (
	id          TEXT PRIMARY KEY,
	conversation TEXT NOT NULL,
	channel     TEXT NOT NULL,
	target      TEXT NOT NULL,
	text        TEXT NOT NULL,
	next_run_at INTEGER NOT NULL,
	every_ms    INTEGER,
	created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS schedules_due ON schedules (next_run_at);

CREATE TABLE IF NOT EXISTS conversations (
	id          TEXT PRIMARY KEY,
	channel     TEXT NOT NULL,
	target      TEXT NOT NULL,
	agent_conversation TEXT,
	created_at  INTEGER NOT NULL,
	updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
	key         TEXT PRIMARY KEY,
	value       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS approvals (
	id           TEXT PRIMARY KEY,
	conversation TEXT NOT NULL,
	channel      TEXT NOT NULL,
	target       TEXT NOT NULL,
	action       TEXT NOT NULL,
	created_at   INTEGER NOT NULL,
	status       TEXT NOT NULL DEFAULT 'pending',
	decided_at   INTEGER
);
CREATE INDEX IF NOT EXISTS approvals_pending ON approvals (conversation, status);
`;

export function openHostDb(path: string): HostDb {
	if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
	const db = new DatabaseSync(path);
	db.exec('PRAGMA journal_mode = WAL');
	// NORMAL, not the default FULL: one message writes seven separate commits,
	// and each FULL commit fsyncs. Under WAL the cost of NORMAL is losing the
	// last few commits in a power cut, never a corrupt file - and pi-durable,
	// which shares this process, already runs NORMAL.
	db.exec('PRAGMA synchronous = NORMAL');
	db.exec('PRAGMA busy_timeout = 5000');
	db.exec(SCHEMA);
	return { db, close: () => db.close() };
}
