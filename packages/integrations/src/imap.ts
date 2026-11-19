import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

/**
 * IMAP access for Gmail (and any IMAP mailbox), with an app password.
 * Read-only: nothing here sets flags, moves or deletes mail.
 */
export interface MailConfig {
	host?: string;
	port?: number;
	user?: string;
	/** An app password, not the account password. Spaces are ignored. */
	password?: string;
	secure?: boolean;
}

export interface MailSummary {
	uid: number;
	messageId: string;
	from: string;
	subject: string;
	date: Date | undefined;
	unread: boolean;
}

export interface MailBody extends MailSummary {
	text: string;
}

type FetchedHeader = {
	uid: number;
	flags?: Set<string>;
	envelope?: { messageId?: string; subject?: string; date?: Date; from?: Array<{ name?: string; address?: string }> };
};

export function mailConfigured(config: MailConfig): boolean {
	return Boolean(config.user && config.password);
}

export function mailConfigFromEnv(env: NodeJS.ProcessEnv = process.env): MailConfig {
	return {
		host: env.GMAIL_IMAP_HOST || 'imap.gmail.com',
		port: Number(env.GMAIL_IMAP_PORT || 993),
		user: env.GMAIL_IMAP_USER || undefined,
		password: env.GMAIL_IMAP_APP_PASSWORD?.replace(/\s+/g, '') || undefined,
		secure: env.GMAIL_IMAP_SECURE !== 'false',
	};
}

/** Runs one read-only session against INBOX, always logging out. */
export async function withInbox<T>(config: MailConfig, work: (client: ImapFlow) => Promise<T>): Promise<T> {
	if (!mailConfigured(config)) throw new Error('邮箱没有配置：缺 GMAIL_IMAP_USER 或 GMAIL_IMAP_APP_PASSWORD');
	const client = new ImapFlow({
		host: config.host ?? 'imap.gmail.com',
		port: config.port ?? 993,
		secure: config.secure ?? true,
		auth: { user: config.user!, pass: config.password! },
		logger: false,
	});
	await client.connect();
	const lock = await client.getMailboxLock('INBOX', { readOnly: true });
	try {
		return await work(client);
	} finally {
		lock.release();
		await client.logout().catch(() => {});
	}
}

function summarize(message: FetchedHeader): MailSummary {
	const from = message.envelope?.from?.[0];
	return {
		uid: message.uid,
		messageId: message.envelope?.messageId ?? `uid-${message.uid}`,
		from: from ? (from.name ? `${from.name} <${from.address ?? ''}>` : (from.address ?? '')) : '',
		subject: message.envelope?.subject ?? '（无主题）',
		date: message.envelope?.date,
		unread: !message.flags?.has('\\Seen'),
	};
}

/** The newest `limit` messages, optionally only unread ones. Newest first. */
export async function listMail(config: MailConfig, options: { unreadOnly?: boolean; limit?: number } = {}): Promise<MailSummary[]> {
	return withInbox(config, async (client) => {
		// search() resolves to false (or undefined when no mailbox is selected) on failure.
		const found = await client.search(options.unreadOnly ? { seen: false } : { all: true }, { uid: true });
		if (!found || found.length === 0) return [];
		// Ascending UIDs: the last ones are the newest.
		const uids = found.slice(-(options.limit ?? 10));
		const out: MailSummary[] = [];
		for await (const message of client.fetch(uids, { uid: true, envelope: true, flags: true }, { uid: true })) {
			out.push(summarize(message as FetchedHeader));
		}
		return out.sort((a, b) => (b.date?.getTime() ?? 0) - (a.date?.getTime() ?? 0));
	});
}

/** Unread messages with their ids, for the poller. Read-only: flags are not changed. */
export async function unreadMail(config: MailConfig, limit = 25): Promise<MailSummary[]> {
	return listMail(config, { unreadOnly: true, limit });
}

/** One message's text, capped so one email cannot flood the context. Does not mark it read. */
export async function readMail(config: MailConfig, uid: number, maxChars = 6000): Promise<MailBody | undefined> {
	return withInbox(config, async (client) => {
		const message = await client.fetchOne(String(uid), { uid: true, envelope: true, flags: true, source: true }, { uid: true });
		// fetchOne resolves to false when the uid does not exist.
		if (!message || !message.source) return undefined;
		const parsed = await simpleParser(message.source);
		const raw = (parsed.text ?? '').replace(/\r/g, '').trim();
		const text = raw.length > maxChars ? `${raw.slice(0, maxChars)}\n…（后面还有，已截断）` : raw;
		return { ...summarize(message as FetchedHeader), text };
	});
}
