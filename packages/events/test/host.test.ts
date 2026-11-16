import { describe, expect, it } from 'vitest';
import { Approvals, Inbox, Outbox, Owners, Schedules, Settings, Targets, openHostDb } from '../src/index.ts';

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
