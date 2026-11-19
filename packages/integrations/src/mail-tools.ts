import { defineTool, type ToolRegistration } from '@earendil-works/pi-durable';
import { num, obj, opt } from '@earendil-works/pi-schema';
import { listMail, mailConfigured, readMail, type MailConfig } from './imap.ts';

const reply = (text: string, isError = false) => ({
	output: [{ type: 'text' as const, text }],
	...(isError ? { isError: true } : {}),
});

/** Read-only mail tools: list recent or unread mail, and read one message. */
export function createMailTools(config: MailConfig): ToolRegistration[] {
	const unconfigured = '邮箱没有配置：在 .env 里设置 GMAIL_IMAP_USER 和 GMAIL_IMAP_APP_PASSWORD';
	return [
		defineTool({
			name: 'mail_list',
			description: "List recent emails in the user's INBOX (newest first). Read-only. Set unread_only to 1 to list only unread mail.",
			parameters: obj({
				unread_only: opt(num({ description: '1 to list only unread mail; 0 or omitted for all recent mail.' })),
				limit: opt(num({ description: 'How many to list, up to 25. Default 10.' })),
			}),
			async execute(args) {
				if (!mailConfigured(config)) return reply(unconfigured, true);
				try {
					const limit = Math.min(Math.max(Math.floor(args.limit ?? 10), 1), 25);
					const mails = await listMail(config, { unreadOnly: args.unread_only === 1, limit });
					if (mails.length === 0) return reply(args.unread_only === 1 ? '没有未读邮件。' : '收件箱是空的。');
					return reply(
						mails
							.map((mail, i) => `${i + 1}. [${mail.unread ? '未读' : '已读'}] ${mail.subject}\n   来自：${mail.from}\n   时间：${mail.date?.toISOString() ?? '?'}\n   编号：${mail.uid}`)
							.join('\n'),
					);
				} catch (error) {
					return reply(`查邮件失败：${(error as Error).message}`, true);
				}
			},
		}),
		defineTool({
			name: 'mail_read',
			description: 'Read the text of one email from the INBOX by its uid (from mail_list). Read-only; does not mark it as read.',
			parameters: obj({ uid: num({ description: 'The uid shown by mail_list.' }) }),
			async execute(args) {
				if (!mailConfigured(config)) return reply(unconfigured, true);
				try {
					const mail = await readMail(config, Math.floor(args.uid));
					if (!mail) return reply('没有这封邮件。', true);
					return reply(`主题：${mail.subject}\n来自：${mail.from}\n时间：${mail.date?.toISOString() ?? '?'}\n\n${mail.text || '（没有正文）'}`);
				} catch (error) {
					return reply(`读邮件失败：${(error as Error).message}`, true);
				}
			},
		}),
	];
}
