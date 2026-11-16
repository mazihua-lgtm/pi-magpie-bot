import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { Message, Models } from '@earendil-works/pi-ai';
import { CodingTools } from '@earendil-works/pi-durable/tools';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { Harness, createRegistry } from '@earendil-works/pi-durable';
import type { ConversationId } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import {
	Approvals,
	Inbox,
	Outbox,
	Owners,
	Schedules,
	Settings,
	Targets,
	openHostDb,
	type HostDb,
	type IncomingEvent,
} from '@pi-magpie-bot/events';
import { type GatewayConfig, gatewayConfig, openModels } from '@pi-magpie-bot/gateway';
import { MemoryStore } from '@pi-magpie-bot/memory';
import { createApprovalExtension } from './approval-extension.ts';
import { createChatExtension } from './chat-extension.ts';
import { createMemoryExtension } from './memory-extension.ts';
import { DEFAULT_SYSTEM_PROMPT } from './prompt.ts';

/** One chat platform, reduced to the two things a bot needs from it. */
export interface Channel {
	readonly id: string;
	send(target: string, text: string): Promise<void>;
}

export interface BotOptions {
	/** Everything this agent owns: host tables, conversations, memory files. */
	dataDir: string;
	config?: GatewayConfig;
	/** Defaults to `MAGPIE_MODEL`, then a free model on the gateway, then its first model. */
	modelId?: string;
	systemPrompt?: string;
	/** Injected so tests can move time. */
	now?: () => number;
	/** Injected by tests: the whole gateway is replaced by a model catalog. */
	models?: Models;
	/**
	 * Give the agent read/write/bash on this directory. Off by default: a bot
	 * anyone can message must not be able to change the machine uninvited.
	 * Every such call asks for approval in the chat first.
	 */
	workspaceDir?: string;
}

export interface MessageEvent {
	source: string;
	/** The platform's own message id: the same id twice is one event. */
	sourceKey: string;
	/** The platform this chat lives on; must match a registered `Channel.id`. */
	channel: string;
	/** Where to reply: a chat id, a session id. */
	target: string;
	text: string;
}

const CJK = /[\u4e00-\u9fff]/;

/** The bot's own words follow the user's, so nobody gets a message they cannot read. */
function bilingual(sample: string, zh: string, en: string): string {
	return CJK.test(sample) ? zh : en;
}

/**
 * A conversation per chat, so memory and history follow the person rather
 * than the process.
 */
export function conversationIdFor(channel: string, target: string): string {
	return `c_${createHash('sha256').update(`${channel}:${target}`).digest('hex').slice(0, 16)}`;
}

/** The words of a message, leaving out tool calls and images. */
function textOf(message: Message): string {
	// What the user typed is kept as a plain string; an answer comes as parts.
	if (typeof message.content === 'string') return message.content;
	if (!Array.isArray(message.content)) return '';
	return message.content
		.filter((part): part is { type: 'text'; text: string } => part.type === 'text')
		.map((part) => part.text)
		.join('');
}

/**
 * The host half of the agent: an inbox in front of it, an outbox behind it,
 * timers beside it. pi-durable owns the run itself.
 */
export class Bot {
	private readonly host: HostDb;
	private readonly inbox: Inbox;
	private readonly outbox: Outbox;
	private readonly schedules: Schedules;
	private readonly targets: Targets;
	private readonly approvals: Approvals;
	private readonly settings: Settings;
	private readonly memory: MemoryStore;
	private readonly channels = new Map<string, Channel>();
	private readonly now: () => number;
	private timers: NodeJS.Timeout[] = [];
	private closed = false;

	private constructor(
		private readonly harness: Harness,
		host: HostDb,
		private readonly modelId: string,
		private readonly systemPrompt: string,
		dataDir: string,
		now: () => number,
	) {
		this.host = host;
		this.inbox = new Inbox(host);
		this.outbox = new Outbox(host);
		this.schedules = new Schedules(host);
		this.targets = new Targets(host);
		this.approvals = new Approvals(host);
		this.settings = new Settings(host);
		this.memory = new MemoryStore(join(dataDir, 'memory'));
		this.now = now;
	}

	static async open(options: BotOptions): Promise<Bot> {
		const config = options.config ?? gatewayConfig();
		const models = options.models ?? (await openModels(config));
		const now = options.now ?? Date.now;

		const modelId = options.modelId ?? process.env.MAGPIE_MODEL ?? pickDefaultModel(models.getModels().map((model) => model.id));
		if (!options.models && !models.getModel('magpie', modelId)) {
			throw new Error(`the gateway has no model "${modelId}"`);
		}

		const host = openHostDb(join(options.dataDir, 'host.sqlite'));
		const storage = await openNodeSqliteStorage(join(options.dataDir, 'agent.sqlite'));

		const memory = new MemoryStore(join(options.dataDir, 'memory'));
		const outbox = new Outbox(host);
		const schedules = new Schedules(host);
		const targets = new Targets(host);
		const registry = createRegistry();
		registry.install(createMemoryExtension(memory));
		registry.install(createChatExtension({ outbox, schedules, targets, now }));

		const workspaceDir = options.workspaceDir;
		if (workspaceDir) {
			registry.install(CodingTools);
			registry.install(
				createApprovalExtension('approval', { approvals: new Approvals(host), outbox, targets }),
			);
		}

		const harness = await Harness.open(
			storage,
			{
				models,
				registry,
				now,
				...(workspaceDir ? { env: () => new NodeExecutionEnv({ cwd: workspaceDir }) } : {}),
			},
			BACKGROUND_CONTEXT,
		);
		const bot = new Bot(harness, host, modelId, options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT, options.dataDir, now);
		bot.recover();
		return bot;
	}

	/**
	 * What a crash leaves behind. The durable runs resume inside pi-durable on
	 * their own; here we make sure the user hears about the one message whose
	 * answer died with the process, and that nothing is sent twice.
	 */
	private recover(): void {
		const inFlight = this.outbox.releaseInFlight();
		if (inFlight > 0) console.warn(`[bot] ${inFlight} message(s) were mid-send at the crash; not retried`);

		// A card whose run died with the process has nobody waiting on it. Left open
		// it would swallow the next "好" the user types in an ordinary chat.
		this.approvals.expirePending();

		const interrupted = this.inbox.reclaim();
		for (const row of interrupted) {
			const chat = this.targets.get(row.conversation);
			if (!chat) continue;
			this.outbox.enqueue({
				conversation: row.conversation,
				channel: chat.channel,
				target: chat.target,
				text: bilingual(
					row.text,
					'刚才那条消息处理到一半中断了，我没能回上来。麻烦再说一次。',
					'I was cut off while answering that one, so nothing was said back. Could you send it again?',
				),
			});
		}
		if (interrupted.length > 0) console.warn(`[bot] ${interrupted.length} interrupted event(s) closed`);

		this.harness.resume();
	}

	/** What a channel asks before it lets a stranger through. */
	get owners(): Owners {
		return new Owners(this.settings, (process.env.ALLOWED_USERS ?? '').split(',').map((id) => id.trim()).filter(Boolean));
	}

	register(channel: Channel): this {
		this.channels.set(channel.id, channel);
		return this;
	}

	/**
	 * The webhook's job: record the message and return. False means it was a
	 * duplicate. "是"/"否" while a card is open answers the card instead of
	 * starting a turn, because the run that asked is still waiting on it.
	 */
	ingest(event: MessageEvent): boolean {
		const conversation = conversationIdFor(event.channel, event.target);
		this.targets.bind({ conversation, channel: event.channel, target: event.target });

		const answer = this.approvals.answer(conversation, event.text);
		if (answer) {
			this.approvals.decide(answer.row.id, answer.allowed ? 'allowed' : 'denied');
			this.outbox.enqueue({
				conversation,
				channel: event.channel,
				target: event.target,
				text: bilingual(
					event.text,
					answer.allowed ? '好，继续。' : '好，这件事不做了。',
					answer.allowed ? 'Approved, continuing.' : 'Understood, dropped.',
				),
			});
			return true;
		}

		const accepted: IncomingEvent = {
			source: event.source,
			sourceKey: event.sourceKey,
			conversation,
			text: event.text,
		};
		return this.inbox.admit(accepted);
	}

	/**
	 * Turn due timers into inbox events. A timer that fired while the process
	 * was down still fires, once.
	 */
	fireDueSchedules(): number {
		const due = this.schedules.due(this.now());
		for (const row of due) {
			this.inbox.admit({
				source: 'schedule',
				sourceKey: row.id + row.next_run_at,
				conversation: row.conversation,
				text: `[定时任务触发] ${row.text}`,
			});
			this.schedules.fired(row, this.now());
		}
		return due.length;
	}

	/**
	 * Work whatever is waiting, one conversation at a time. Several messages
	 * that arrived while the agent was busy become one run, so it answers once.
	 */
	async pump(): Promise<number> {
		let handled = 0;
		for (let guard = 0; guard < 100; guard++) {
			const first = this.inbox.claim();
			if (!first) break;

			const batched = this.inbox.pendingFor(first.conversation);
			const text = [first.text, ...batched.map((row) => row.text)].join('\n');
			try {
				await this.answer(first.conversation, text);
			} catch (error) {
				// A run that threw must still close its rows: left `running` they would
				// never be answered, never be retried, and never be mentioned until the
				// next restart.
				console.error('[bot] run failed:', error);
				this.tell(first.conversation, text, '这条消息处理时出了错，我没能回上来。可以再说一次。', 'Something broke while I was answering that one. Could you send it again?');
			}
			for (const row of [first, ...batched]) this.inbox.finish(row.id);
			handled += 1 + batched.length;
		}
		return handled;
	}

	/** A line from the bot itself, in the language of what it answers. */
	private tell(conversationId: string, sample: string, zh: string, en: string): void {
		const target = this.targets.get(conversationId);
		if (!target) return;
		this.outbox.enqueue({ conversation: conversationId, channel: target.channel, target: target.target, text: bilingual(sample, zh, en) });
	}

	/** One run: the durable conversation does the work, the outbox carries it out. */
	private async answer(conversationId: string, text: string): Promise<void> {
		const conversation = await this.ensureConversation(conversationId);
		const submission = await conversation.submit({ type: 'input', content: text }, BACKGROUND_CONTEXT);
		const settled = await submission.wait(BACKGROUND_CONTEXT);

		const target = this.targets.get(conversationId);
		if (!target) return;

		if (settled.status !== 'done') {
			const reason = 'reason' in settled ? String(settled.reason) : 'failed';
			// The user is told, briefly; whoever runs the bot gets the reason written down.
			console.error(`[bot] no answer: ${reason}`);
			// A model error is nearly always the free pool being used up, and saying
			// so beats "try again" to someone who cannot know that.
			const why =
				reason === 'model_error'
					? bilingual(text, '（免费池可能到量了，等一会儿再试；用自己模型的检查一下 magpie）', ' (the free pool may be used up: try again later, or check magpie if you use your own model)')
					: '';
			this.outbox.enqueue({
				conversation: conversationId,
				channel: target.channel,
				target: target.target,
				text: bilingual(
					text,
					`这次没能回答（${reason}）。可以再说一次，或者稍后让我重试。${why}`,
					`That one did not come back (${reason}). Send it again, or ask me to retry later.${why}`,
				),
			});
			return;
		}

		const answer = await this.lastAssistantText(conversationId);
		if (answer.trim()) {
			this.outbox.enqueue({ conversation: conversationId, channel: target.channel, target: target.target, text: answer });
		}
	}

	private async lastAssistantText(conversationId: string): Promise<string> {
		const conversation = await this.ensureConversation(conversationId);
		const view = await conversation.context(BACKGROUND_CONTEXT);
		const last = [...(view.messages as readonly Message[])].reverse().find((message) => message.role === 'assistant');
		return last ? textOf(last) : '';
	}

	/**
	 * Everything said in this chat, oldest first, for a surface that wants to show
	 * a reopened tab its own history instead of an empty page.
	 */
	async transcript(channel: string, target: string, limit = 50): Promise<Array<{ role: 'me' | 'bot'; text: string }>> {
		const conversation = await this.ensureConversation(conversationIdFor(channel, target));
		const view = await conversation.context(BACKGROUND_CONTEXT);
		return (view.messages as readonly Message[])
			.filter((message) => message.role === 'user' || message.role === 'assistant')
			.map((message) => ({ role: message.role === 'user' ? ('me' as const) : ('bot' as const), text: textOf(message) }))
			.filter((entry) => entry.text.trim() !== '')
			.slice(-limit);
	}

	private async ensureConversation(conversationId: string) {
		const bound = this.targets.get(conversationId);
		if (bound?.agentConversation) {
			// pi-durable ids are branded numbers; the host table keeps them as text.
			const existing = await this.harness.conversation(Number(bound.agentConversation) as ConversationId, BACKGROUND_CONTEXT);
			if (existing) return existing;
		}
		const created = await this.harness.createConversation(
			{
				ownership: { kind: 'ownerless' },
				agent: { model: { provider: 'magpie', modelId: this.modelId } },
			},
			BACKGROUND_CONTEXT,
		);
		this.targets.setAgentConversation(conversationId, created.id);
		return created;
	}

	/** Hand every pending message to its channel. A failure goes back in the queue a few times. */
	async dispatch(): Promise<number> {
		let sent = 0;
		for (let row = this.outbox.next(); row; row = this.outbox.next()) {
			const channel = this.channels.get(row.channel);
			if (!channel) {
				this.outbox.failed(row.id, `no channel registered for "${row.channel}"`, 99);
				continue;
			}
			try {
				await channel.send(row.target, row.text);
				this.outbox.sent(row.id);
				sent += 1;
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				this.outbox.failed(row.id, reason, row.attempts);
				if (row.attempts >= 3) console.error(`[bot] giving up on message ${row.id} to ${row.channel}: ${reason}`);
			}
		}
		return sent;
	}

	/** What the agent does: timers become events, events become answers. */
	async work(): Promise<void> {
		this.fireDueSchedules();
		await this.pump();
	}

	/** One pass of the whole loop: timers, work, delivery. */
	async tick(): Promise<void> {
		await this.work();
		await this.dispatch();
	}

	/**
	 * Run the loop in the background until the returned function is called.
	 *
	 * Working and delivering are two loops, not one. A run can be waiting on the
	 * user (an approval card) or can have said something on its own (`send_message`)
	 * while it is still running: both go through the outbox, and delivery that
	 * waited for the run to end would show the card only after it had timed out.
	 */
	start(intervalMs = 2_000): () => void {
		const every = (label: string, job: () => Promise<unknown>) => {
			// One worker per loop. A run can take longer than the interval, and two
			// at once would claim the same waiting messages and answer them twice —
			// the one thing this design promises not to do.
			let busy = false;
			this.timers.push(
				setInterval(() => {
					if (busy) return;
					busy = true;
					void job()
						.catch((error) => console.error(`[bot] ${label} failed`, error))
						.finally(() => {
							busy = false;
						});
				}, intervalMs),
			);
		};
		every('work', () => this.work());
		every('delivery', () => this.dispatch());
		return () => void this.close();
	}

	/** For tests and for the web UI: what is waiting right now. */
	inspect(): { pendingEvents: number; pendingMessages: number; schedules: number } {
		return {
			pendingEvents: this.inbox.count('pending'),
			pendingMessages: this.outbox.pendingCount(),
			schedules: this.schedules.list().length,
		};
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		for (const timer of this.timers.splice(0)) clearInterval(timer);
		await this.harness.close(BACKGROUND_CONTEXT);
		this.host.close();
	}
}

/** Free first: the point of the product is that a new user pays nothing. */
export function pickDefaultModel(ids: readonly string[]): string {
	const free = ids.find((id) => /(^|\/)free$|-free$/.test(id) || id.includes('/free'));
	if (free) return free;
	const first = ids[0];
	if (!first) throw new Error('the gateway offers no models: add a provider in magpie first');
	return first;
}
