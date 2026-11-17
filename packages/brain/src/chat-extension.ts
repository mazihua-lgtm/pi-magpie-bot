import { defineExtension, defineTool, section, type Extension } from '@earendil-works/pi-durable';
import { num, obj, opt, str } from '@earendil-works/pi-schema';
import type { Outbox, Schedules, Targets } from '@pi-magpie-bot/events';

/** A tool's answer, as the transcript stores it. */
const reply = (text: string, isError = false) => ({
	output: [{ type: 'text' as const, text }],
	...(isError ? { isError: true } : {}),
});

/** The user's own clock, in a form that keeps its offset: 2026-11-17T07:00:00+08:00. */
export function stamp(at: number): string {
	const offset = -new Date(at).getTimezoneOffset();
	const sign = offset >= 0 ? '+' : '-';
	const minutes = Math.abs(offset);
	const hours = String(Math.floor(minutes / 60)).padStart(2, '0');
	return `${new Date(at).toLocaleString('sv-SE').replace(' ', 'T')}${sign}${hours}:${String(minutes % 60).padStart(2, '0')}`;
}

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
					// A repeat of zero minutes is a reminder that fires forever in one
					// go: the scheduler would spin on `next += 0` and freeze the whole
					// process. Reject it here rather than trust the model's arithmetic.
					if (args.everyMinutes != null) {
						if (!Number.isFinite(args.everyMinutes) || args.everyMinutes < 1) {
							return reply('everyMinutes must be at least 1 (omit it for a one-off)', true);
						}
						if (args.everyMinutes > 525_600) return reply('everyMinutes is too large: at most one year', true);
					}

					const id = options.schedules.add({
						conversation: chat.conversation,
						channel: chat.channel,
						target: chat.target,
						text: args.text,
						at,
						everyMs: args.everyMinutes != null ? args.everyMinutes * 60_000 : undefined,
					});
					return reply(`scheduled ${id} for ${stamp(at)}`);
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
									`${row.id} at ${stamp(row.next_run_at)}${row.every_ms ? ` every ${row.every_ms / 60_000}m` : ''}: ${row.text}`,
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
		sections: [
			// Without a clock "tomorrow at seven" has nothing to count from.
			section('time', () => `It is now ${stamp(now())}. Read every time the user gives against this clock.`),
		],
	});
}
