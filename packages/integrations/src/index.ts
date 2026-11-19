import { defineExtension, type Extension } from '@earendil-works/pi-durable';
import { createMailTools } from './mail-tools.ts';
import { mailConfigFromEnv, mailConfigured, type MailConfig } from './imap.ts';

export { createMailTools } from './mail-tools.ts';
export { listMail, mailConfigFromEnv, mailConfigured, readMail, unreadMail, withInbox, type MailBody, type MailConfig, type MailSummary } from './imap.ts';
export { DEFAULT_MAIL_INTERVAL_MS, MailPoller, type MailPollerOptions, type NewMail } from './mail-poller.ts';

/**
 * The integration tools as one extension. Installed only when mail is
 * configured, so a bot without credentials shows no dead tools.
 */
export function createIntegrationExtension(options: { mail?: MailConfig } = {}): Extension {
	const mail = options.mail ?? mailConfigFromEnv();
	const tools = mailConfigured(mail) ? createMailTools(mail) : [];
	return defineExtension({ name: 'integrations', tools });
}
