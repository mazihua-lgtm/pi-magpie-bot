import { describe, expect, it } from 'vitest';
import { Approvals, Chats, Inbox, Outbox, Owners, Schedules, Settings, Targets, attachmentsOf, openHostDb } from '../src/index.ts';

const host = () => openHostDb(':memory:');

describe('inbox', () => {
	it('accepts the same platform message once', () => {
		const db = host();
		const inbox = new Inbox(db);
		const event = { source: 'telegram:1', sourceKey: '42', conversation: 'c1', text: '你好' };
		expect(inbox.admit(event)).toBe(true);
		expect(inbox.admit(event)).toBe(false);
		expect(inbox.count()).toBe(1);
		db.close();
	});

	it('hands out one event at a time and batches the rest of the conversation', () => {
		const db = host();
		const inbox = new Inbox(db);
		inbox.admit({ source: 's', sourceKey: '1', conversation: 'c1', text: 'a' });
		inbox.admit({ source: 's', sourceKey: '2', conversation: 'c1', text: 'b' });
		inbox.admit({ source: 's', sourceKey: '3', conversation: 'c2', text: 'c' });

		const first = inbox.claim();
		expect(first?.text).toBe('a');
		expect(inbox.pendingFor('c1').map((row) => row.text)).toEqual(['b']);
		expect(inbox.pendingFor('c2').map((row) => row.text)).toEqual(['c']);
		db.close();
	});

	it('closes an interrupted run instead of running it twice', () => {
		const db = host();
		const inbox = new Inbox(db);
		inbox.admit({ source: 's', sourceKey: '1', conversation: 'c1', text: 'a' });
		inbox.claim();

		const interrupted = inbox.reclaim();
		expect(interrupted.map((row) => row.text)).toEqual(['a']);
		expect(inbox.count('running')).toBe(0);
		expect(inbox.count('pending')).toBe(0);
		expect(inbox.reclaim()).toEqual([]);
		db.close();
	});
});

describe('outbox', () => {
	it('sends once and stops offering the message', () => {
		const db = host();
		const outbox = new Outbox(db);
		const id = outbox.enqueue({ conversation: 'c1', channel: 'web', target: 't', text: 'hi' });

		const claimed = outbox.next();
		expect(claimed?.id).toBe(id);
		expect(claimed?.status).toBe('sending');
		expect(outbox.next()).toBeUndefined();

		outbox.sent(id);
		expect(outbox.pendingCount()).toBe(0);
		db.close();
	});

	it('backs off a failure and gives up after three attempts', () => {
		const db = host();
		const outbox = new Outbox(db);
		const id = outbox.enqueue({ conversation: 'c1', channel: 'web', target: 't', text: 'hi' });

		const first = outbox.next();
		expect(first?.attempts).toBe(1);
		outbox.failed(id, 'boom', 1);
		expect(outbox.next()).toBeUndefined();

		expect(outbox.next(Date.now() + 60_000)?.attempts).toBe(2);
		outbox.failed(id, 'boom', 2);
		expect(outbox.next(Date.now() + 120_000)?.attempts).toBe(3);
		outbox.failed(id, 'boom', 3);
		expect(outbox.next(Date.now() + 200_000)).toBeUndefined();
		db.close();
	});

	it('never resends a message that was mid-send when the process died', () => {
		const db = host();
		const outbox = new Outbox(db);
		outbox.enqueue({ conversation: 'c1', channel: 'web', target: 't', text: 'hi' });
		outbox.next();

		expect(outbox.releaseInFlight()).toBe(1);
		expect(outbox.next(Date.now() + 60_000)).toBeUndefined();
		db.close();
	});
});

describe('schedules', () => {
	it('fires a one-off once and then removes it', () => {
		const db = host();
		const schedules = new Schedules(db);
		const at = Date.now() - 1_000;
		const id = schedules.add({ conversation: 'c1', channel: 'web', target: 't', text: 'wake', at });

		const due = schedules.due(Date.now());
		expect(due.map((row) => row.id)).toEqual([id]);
		schedules.fired(due[0]!, Date.now());
		expect(schedules.due(Date.now())).toEqual([]);
		expect(schedules.list()).toEqual([]);
		db.close();
	});

	it('advances a recurring timer past the periods a restart missed', () => {
		const db = host();
		const schedules = new Schedules(db);
		const start = Date.UTC(2026, 0, 1, 0, 0, 0);
		const id = schedules.add({ conversation: 'c1', channel: 'web', target: 't', text: 'tick', at: start, everyMs: 60_000 });

		const late = start + 10 * 60_000 + 30_000;
		const due = schedules.due(late);
		expect(due.map((row) => row.id)).toEqual([id]);
		schedules.fired(due[0]!, late);

		const next = schedules.list().find((row) => row.id === id);
		expect(next?.next_run_at).toBe(start + 11 * 60_000);
		expect(schedules.due(late)).toEqual([]);
		db.close();
	});

	it('drops a bad repeat of zero instead of spinning forever', () => {
		const db = host();
		const schedules = new Schedules(db);
		const at = Date.now() - 1_000;
		const id = schedules.add({ conversation: 'c1', channel: 'web', target: 't', text: 'tick', at, everyMs: 0 });

		const due = schedules.due(Date.now());
		expect(due.map((row) => row.id)).toEqual([id]);
		// Before the guard this call never returned: `next += 0` loops forever and
		// takes the whole event loop with it.
		schedules.fired(due[0]!, Date.now());
		expect(schedules.list()).toEqual([]);
		db.close();
	});

	it('drops a negative repeat too', () => {
		const db = host();
		const schedules = new Schedules(db);
		const at = Date.now() - 1_000;
		const id = schedules.add({ conversation: 'c1', channel: 'web', target: 't', text: 'tick', at, everyMs: -60_000 });

		const due = schedules.due(Date.now());
		expect(due.map((row) => row.id)).toEqual([id]);
		schedules.fired(due[0]!, Date.now());
		expect(schedules.list()).toEqual([]);
		db.close();
	});
});

describe('approvals', () => {
	it('reads 是 and 否 as the answer to the open card', () => {
		const db = host();
		const approvals = new Approvals(db);
		const id = approvals.ask({ conversation: 'c1', channel: 'web', target: 't', action: '执行 rm -rf /tmp/x' });

		expect(approvals.answer('c1', '随便聊聊')).toBeUndefined();
		expect(approvals.answer('c1', '是')?.allowed).toBe(true);
		approvals.decide(id, 'allowed');
		expect(approvals.pendingFor('c1')).toBeUndefined();
		expect(approvals.answer('c1', '否')).toBeUndefined();
		db.close();
	});

	it('expires cards left open by a process that died', () => {
		const db = host();
		const approvals = new Approvals(db);
		const id = approvals.ask({ conversation: 'c1', channel: 'web', target: 't', action: 'x' });
		expect(approvals.expirePending()).toBe(1);
		expect(approvals.pendingFor('c1')).toBeUndefined();
		expect(approvals.decide(id, 'allowed')).toBe(false);
		db.close();
	});

	it('refuses to decide the same card twice', () => {
		const db = host();
		const approvals = new Approvals(db);
		const id = approvals.ask({ conversation: 'c1', channel: 'web', target: 't', action: 'x' });
		expect(approvals.decide(id, 'denied')).toBe(true);
		expect(approvals.decide(id, 'allowed')).toBe(false);
		db.close();
	});
});

describe('owners', () => {
	it('gives the bot to the first chat and refuses the rest', () => {
		const db = host();
		const owners = new Owners(new Settings(db));
		expect(owners.check('telegram', '111')).toBe('claimed');
		expect(owners.check('telegram', '111')).toBe('allowed');
		expect(owners.check('telegram', '999')).toBe('denied');
		db.close();
	});

	it('lets an id listed in ALLOWED_USERS in', () => {
		const db = host();
		const owners = new Owners(new Settings(db), ['999']);
		owners.check('telegram', '111');
		expect(owners.check('telegram', '999')).toBe('allowed');
		db.close();
	});

	it('does not let a stranger claim the bot first when ALLOWED_USERS is set', () => {
		const db = host();
		const owners = new Owners(new Settings(db), ['999']);
		expect(owners.check('telegram', '111')).toBe('denied');
		expect(owners.check('telegram', '999')).toBe('allowed');
		db.close();
	});
});

describe('targets', () => {
	it('finds the chat from the runtime conversation id', () => {
		const db = host();
		const targets = new Targets(db);
		targets.bind({ conversation: 'c1', channel: 'telegram', target: '42' });
		targets.setAgentConversation('c1', 7);

		expect(targets.get('c1')?.agentConversation).toBe('7');
		expect(targets.getByAgent(7)?.target).toBe('42');
		expect(targets.getByAgent(8)).toBeUndefined();
		db.close();
	});
});

describe('schedule ownership and expiry', () => {
	it('expires only the pending cards of the conversation asked about', () => {
		const db = host();
		const approvals = new Approvals(db);
		approvals.ask({ conversation: 'c1', channel: 'web', target: 't', action: 'a1' });
		approvals.ask({ conversation: 'c2', channel: 'web', target: 't', action: 'a2' });

		expect(approvals.expirePendingFor('c1')).toBe(1);
		expect(approvals.pendingFor('c1')).toBeUndefined();
		// The other conversation's card is untouched: its run is still going.
		expect(approvals.pendingFor('c2')?.action).toBe('a2');
		db.close();
	});
});

describe('pictures in the inbox', () => {
	it('keeps them with the row until it is answered, then lets them go', () => {
		const db = host();
		const inbox = new Inbox(db);
		const image = { data: 'AAAA', mimeType: 'image/png' };
		inbox.admit({ source: 's', sourceKey: '1', conversation: 'c1', text: '看图', attachments: [image] });
		inbox.admit({ source: 's', sourceKey: '2', conversation: 'c1', text: '没图' });

		const first = inbox.claim();
		expect(first && attachmentsOf(first)).toEqual([image]);
		expect(attachmentsOf(inbox.pendingFor('c1')[0]!)).toEqual([]);

		inbox.finish(first!.id);
		const stored = db.db.prepare(`SELECT attachments FROM inbox WHERE id = ?`).get(first!.id) as { attachments: string | null };
		expect(stored.attachments).toBeNull();
		expect(attachmentsOf({ attachments: 'not json' })).toEqual([]);
		db.close();
	});
});

describe('an older database', () => {
	it('gets the columns added since, without losing its rows', async () => {
		const { mkdtemp } = await import('node:fs/promises');
		const { tmpdir } = await import('node:os');
		const { join } = await import('node:path');
		const { DatabaseSync } = await import('node:sqlite');
		const path = join(await mkdtemp(join(tmpdir(), 'host-')), 'host.sqlite');
		const old = new DatabaseSync(path);
		old.exec(`CREATE TABLE inbox (id TEXT PRIMARY KEY, source TEXT NOT NULL, source_key TEXT NOT NULL, conversation TEXT NOT NULL, text TEXT NOT NULL, received_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', UNIQUE (source, source_key));
			CREATE TABLE outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, conversation TEXT NOT NULL, channel TEXT NOT NULL, target TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, retry_at INTEGER, sent_at INTEGER, error TEXT);
			INSERT INTO outbox (conversation, channel, target, text, created_at) VALUES ('c1', 'web', 't', '旧消息', 1);`);
		old.close();

		const db = openHostDb(path);
		const outbox = new Outbox(db);
		expect(outbox.next()).toMatchObject({ text: '旧消息', kind: null });
		outbox.enqueue({ conversation: 'c1', channel: 'web', target: 't', text: '卡片', kind: 'approval' });
		expect(outbox.next()).toMatchObject({ text: '卡片', kind: 'approval' });
		expect(new Inbox(db).admit({ source: 's', sourceKey: '1', conversation: 'c1', text: 'x', attachments: [{ data: 'AA==', mimeType: 'image/png' }] })).toBe(true);
		db.close();
		// Opening it again changes nothing.
		openHostDb(path).close();
	});
});

describe('chats', () => {
	it('lists pinned first, then the latest, and changes only what is given', () => {
		const db = host();
		const chats = new Chats(db);
		chats.create({ conversation: 'c1', channel: 'web', owner: 'o', chat: 'a', title: 'A', titleState: 'user', at: 1 });
		chats.create({ conversation: 'c2', channel: 'web', owner: 'o', chat: 'b', title: 'B', titleState: 'empty', at: 2 });
		chats.create({ conversation: 'c3', channel: 'web', owner: 'other', chat: 'a', title: 'X', titleState: 'user', at: 3 });
		expect(chats.list('web', 'o').map((row) => row.chat)).toEqual(['b', 'a']);

		chats.update('c1', { pinned: true });
		expect(chats.list('web', 'o').map((row) => row.chat)).toEqual(['a', 'b']);
		chats.touch('c2', 10);
		chats.update('c1', { pinned: false });
		expect(chats.list('web', 'o').map((row) => row.chat)).toEqual(['b', 'a']);

		expect(chats.update('c2', { model: 'm', thinking: true, title: 'B2', titleState: 'first' })).toMatchObject({
			title: 'B2',
			title_state: 'first',
			model: 'm',
			thinking: 1,
			pinned: 0,
		});
		expect(chats.update('c2', { model: null })?.model).toBeNull();
		expect(chats.get('web', 'other', 'a')?.conversation).toBe('c3');
		expect(chats.remove('c2')).toBe(true);
		expect(chats.byConversation('c2')).toBeUndefined();
		expect(() => chats.create({ conversation: 'c9', channel: 'web', owner: 'o', chat: 'a', title: 'dup', titleState: 'user' })).toThrow();
		db.close();
	});
});

describe('targets', () => {
	it('forgets a chat, so the same target starts a new conversation', () => {
		const db = host();
		const targets = new Targets(db);
		targets.bind({ conversation: 'c1', channel: 'web', target: 't' });
		targets.setAgentConversation('c1', 7);
		targets.forget('c1');
		expect(targets.get('c1')).toBeUndefined();
		expect(targets.getByAgent(7)).toBeUndefined();
		db.close();
	});
});
