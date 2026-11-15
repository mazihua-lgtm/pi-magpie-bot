import { defineExtension, defineTool, type Extension } from '@earendil-works/pi-durable';
import { num, obj, opt, str } from '@earendil-works/pi-schema';
import type { Outbox, Schedules, Targets } from '@pi-magpie-bot/events';

/** A tool's answer, as the transcript stores it. */
const reply = (text: string, isError = false) => ({
	output: [{ type: 'text' as const, text }],
	...(isError ? { isError: true } : {}),
});

export interface ChatExtensionOptions {
	outbox: Outbox;
	schedules: Schedules;
	targets: Targets;
	/** Injected so tests can fire "in 5 minutes" without waiting five minutes. */
	now?: () => number;
}

/**
 * The outbound half: say something now, or be woken later and say it then.
 * A run's final answer is delivered by the bot itself; these tools are for
 * anything the agent wants to send outside its own answer.
 */
export function createChatExtension(options: ChatExtensionOptions): Extension {
	const now = options.now ?? Date.now;

	return defineExtension({
		name: 'chat',
		tools: [
			defineTool({
				name: 'send_message',
				description:
					'Send the user a message in this chat right now, without waiting for your answer to finish. Use it on a long job: say you started, then keep working.',
				parameters: obj({ text: str() }),
				async execute(args, api) {
					const chat = options.targets.getByAgent(api.conversationId);
					if (!chat) return reply('this conversation has no chat to send to', true);
					options.outbox.enqueue({ conversation: chat.conversation, channel: chat.channel, target: chat.target, text: args.text });
					return reply('sent');
				},
			}),
			defineTool({
				name: 'set_reminder',
				description:
					'Be woken at a time and told to act, even if the user has long closed the chat. Use it for "remind me", "check this tomorrow", and anything recurring.',
				parameters: obj({
					text: str({ description: 'What you should be told when it fires, in your own words.' }),
					inMinutes: opt(num({ description: 'Minutes from now. Give this or `at`.' })),
					at: opt(str({ description: 'An ISO 8601 time with a timezone, e.g. "2026-11-17T07:00:00+08:00".' })),
					everyMinutes: opt(num({ description: 'Repeat every this many minutes. Omit for a one-off.' })),
				}),
				async execute(args, api) {
					const chat = options.targets.getByAgent(api.conversationId);
					if (!chat) return reply('this conversation has no chat to remind', true);

					const at = args.at ? Date.parse(args.at) : args.inMinutes != null ? now() + args.inMinutes * 60_000 : undefined;
					if (at === undefined || Number.isNaN(at)) return reply('give either inMinutes or an ISO time in at', true);
					if (at <= now()) return reply('that time has already passed', true);

					const id = options.schedules.add({
						conversation: chat.conversation,
						channel: chat.channel,
						target: chat.target,
						text: args.text,
						at,
						everyMs: args.everyMinutes != null ? args.everyMinutes * 60_000 : undefined,
					});
					return reply(`scheduled ${id} for ${new Date(at).toISOString()}`);
				},
			}),
			defineTool({
				name: 'list_reminders',
				description: 'Show the reminders and recurring tasks set for this chat.',
				parameters: obj({}),
				async execute(_args, api) {
					const chat = options.targets.getByAgent(api.conversationId);
					if (!chat) return reply('this conversation has no chat', true);
					const rows = options.schedules.list(chat.conversation);
					if (rows.length === 0) return reply('none');
					return reply(
						rows
							.map(
								(row) =>
									`${row.id} at ${new Date(row.next_run_at).toISOString()}${row.every_ms ? ` every ${row.every_ms / 60_000}m` : ''}: ${row.text}`,
							)
							.join('\n'),
					);
				},
			}),
			defineTool({
				name: 'cancel_reminder',
				description: 'Cancel a reminder by its id, as list_reminders shows it.',
				parameters: obj({ id: str() }),
				async execute(args) {
					return reply(options.schedules.remove(args.id) ? 'cancelled' : 'no such reminder');
				},
			}),
		],
	});
}
