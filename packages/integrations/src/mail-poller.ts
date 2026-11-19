import { type MailConfig, type MailSummary, unreadMail } from './imap.ts';

/** What the poller hands to the bot for each new message. */
export interface NewMail {
	/** The Message-ID header: the same email is admitted once, even across restarts. */
	messageId: string;
	from: string;
	subject: string;
	date: Date | undefined;
}

export interface MailPollerOptions {
	config: MailConfig;
	/** Default 5 minutes. */
	intervalMs?: number;
	/** Called once per new message. Returns true if the bot accepted it. */
	deliver: (mail: NewMail) => boolean;
	now?: () => number;
	/** Injected by tests. */
	list?: (config: MailConfig) => Promise<MailSummary[]>;
	log?: (message: string, error?: unknown) => void;
}

export const DEFAULT_MAIL_INTERVAL_MS = 5 * 60_000;

/**
 * Polls INBOX for unread mail every few minutes and hands new messages to
 * `deliver`. The first poll only sets a baseline: mail that arrived before the
 * bot started is not announced, so a backlog cannot flood the chat. Dedupe
 * across polls and restarts is the bot's inbox, keyed by Message-ID.
 */
export class MailPoller {
	private lastPollAt: number | undefined;
	private readonly baseline: Date;
	private running = false;
	private readonly intervalMs: number;
	private readonly now: () => number;
	private readonly list: (config: MailConfig) => Promise<MailSummary[]>;
	private readonly log: (message: string, error?: unknown) => void;

	constructor(private readonly options: MailPollerOptions) {
		this.intervalMs = options.intervalMs ?? DEFAULT_MAIL_INTERVAL_MS;
		this.now = options.now ?? Date.now;
		this.list = options.list ?? ((config) => unreadMail(config));
		this.log = options.log ?? ((message, error) => console.error(message, error ?? ''));
		this.baseline = new Date(this.now());
	}

	/** Runs a poll if one is due. Never throws: a mail failure must not stop the bot's pass. */
	async poll(): Promise<number> {
		const at = this.now();
		if (this.running) return 0;
		if (this.lastPollAt !== undefined && at - this.lastPollAt < this.intervalMs) return 0;
		this.running = true;
		this.lastPollAt = at;
		try {
			const unread = await this.list(this.options.config);
			let delivered = 0;
			for (const mail of unread) {
				if (!mail.date || mail.date.getTime() < this.baseline.getTime()) continue;
				const accepted = this.options.deliver({ messageId: mail.messageId, from: mail.from, subject: mail.subject, date: mail.date });
				if (accepted) delivered++;
			}
			return delivered;
		} catch (error) {
			this.log('[mail] poll failed', error);
			return 0;
		} finally {
			this.running = false;
		}
	}
}
