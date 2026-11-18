import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { ImageContent, Message, Models, TextContent } from '@earendil-works/pi-ai';
import { CodingTools } from '@earendil-works/pi-durable/tools';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { Harness, createRegistry } from '@earendil-works/pi-durable';
import type { AgentChange, ContextView, Conversation, ConversationId, UserInput } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import {
	Approvals,
	attachmentsOf,
	Chats,
	claimDataDir,
	Inbox,
	Outbox,
	Owners,
	Schedules,
	Settings,
	Targets,
	openHostDb,
	type Attachment,
	type DataDirLock,
	type HostDb,
	type IncomingEvent,
	type OutgoingKind,
} from '@pi-magpie-bot/events';
import { type GatewayConfig, gatewayConfig, openModels } from '@pi-magpie-bot/gateway';
import { MemoryStore } from '@pi-magpie-bot/memory';
import { createApprovalExtension } from './approval-extension.ts';
import { createChatExtension } from './chat-extension.ts';
import { createMemoryExtension } from './memory-extension.ts';
import { isNoReply, livePartial, type LivePartial } from './messages.ts';
import { DEFAULT_SYSTEM_PROMPT } from './prompt.ts';
import { createWebExtension } from './web-extension.ts';

/** What kind of message a send is, for a channel that shows some kinds its own way. */
export interface SendMeta {
	kind?: OutgoingKind;
}

/** One chat platform, reduced to the two things a bot needs from it. */
export interface Channel {
	readonly id: string;
	send(target: string, text: string, meta?: SendMeta): Promise<void>;
}

/**
 * What happens inside the bot that a live surface may want to show as it
 * happens. `conversation` is the host conversation id (`conversationIdFor`).
 */
export type BotEvent =
	| { type: 'status'; conversation: string; busy: boolean }
	| { type: 'partial'; conversation: string; partial: LivePartial }
	| { type: 'approval'; conversation: string; id: string; action: string; expiresAt: number }
	| { type: 'approval_done'; conversation: string; id: string; status: 'allowed' | 'denied' | 'expired' }
	/** A run ended with an answer; `input` is what it answered. */
	| { type: 'answered'; conversation: string; input: string; text: string };

/** One model as a chooser shows it. */
export interface ModelChoice {
	id: string;
	name: string;
	reasoning: boolean;
	vision: boolean;
}

/** The settings key the default model is kept under. */
const DEFAULT_MODEL_KEY = 'default-model';
/** How often at most a partial answer goes out: about ten times a second. */
const PARTIAL_EVERY_MS = 100;

/** Listeners of one kind of thing, each kept from breaking the others. */
class Listeners<T> {
	private readonly set = new Set<(value: T) => void>();

	add(listener: (value: T) => void): () => void {
		this.set.add(listener);
		return () => this.set.delete(listener);
	}

	emit(value: T): void {
		for (const listener of this.set) {
			try {
				listener(value);
			} catch (error) {
				console.error('[bot] an event listener threw', error);
			}
		}
	}
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
	/** Injected by tests, so a hanging channel need not take thirty seconds. */
	sendTimeoutMs?: number;
	/** Injected by tests, so a hung run need not take five minutes. */
	runTimeoutMs?: number;
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
	/** Pictures sent with it. */
	images?: Attachment[];
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
	private readonly harness: Harness;
	/** The model a conversation uses unless its chat picked another; changeable, and kept in settings. */
	private modelId: string;
	private readonly models: Models;
	private readonly chats: Chats;
	private readonly events: Listeners<BotEvent>;
	/** The partial answer of each conversation answering right now. */
	private readonly partials = new Map<string, LivePartial>();
	/** The durable conversation of each run in progress, for `stop`. */
	private readonly active = new Map<string, Conversation>();
	/** Conversations the user stopped: their run ends without the "no answer" notice. */
	private readonly stopped = new Set<string>();
	/** Owners whose memory was already moved to the shared scope this process. */
	private readonly scoped = new Set<string>();
	private readonly systemPrompt: string;
	private timers: NodeJS.Timeout[] = [];
	private closed = false;
	/** Held while this process owns the data directory. */
	private readonly lock: DataDirLock;
	/** How long one run may take before it is abandoned and the loop moves on. */
	private readonly runTimeoutMs: number;
	/** How long one channel may take to accept a message before it counts as failed. */
	private readonly sendTimeoutMs: number;
	/** Per-pass single-file flags, replacing the old per-interval closure. */
	private readonly busy: Record<'work' | 'delivery', boolean> = { work: false, delivery: false };
	/** The debounced wake, armed by `start()` once. */
	private wakeTimer: NodeJS.Timeout | undefined;
	private onWake: (() => void) | undefined;
	/** How long arriving work waits before the passes run. */
	private readonly wakeDebounceMs = 50;
	/** The one-armed timer for the next due reminder, rearmed after each firing. */
	private scheduleTimer: NodeJS.Timeout | undefined;

	private constructor(
		harness: Harness,
		host: HostDb,
		modelId: string,
		systemPrompt: string,
		dataDir: string,
		now: () => number,
		lock: DataDirLock,
		options: BotOptions,
		models: Models,
		events: Listeners<BotEvent>,
		memory: MemoryStore,
	) {
		this.harness = harness;
		this.modelId = modelId;
		this.models = models;
		this.events = events;
		this.systemPrompt = systemPrompt;
		this.lock = lock;
		this.runTimeoutMs = options.runTimeoutMs ?? 5 * 60_000;
		this.sendTimeoutMs = options.sendTimeoutMs ?? 30_000;
		this.host = host;
		this.inbox = new Inbox(host);
		this.outbox = new Outbox(host);
		this.schedules = new Schedules(host);
		this.targets = new Targets(host);
		this.approvals = new Approvals(host);
		this.settings = new Settings(host);
		this.chats = new Chats(host);
		// The same store the memory tools write through: its write queue is per
		// instance, and the app's notes screen writes too.
		this.memory = memory;
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

		// Before touching anything: recovery below assumes whatever it finds was
		// left by a crash. With a second process running it would steal that one's
		// in-flight message, approval card and running event instead.
		const lock = claimDataDir(options.dataDir);

		const host = openHostDb(join(options.dataDir, 'host.sqlite'));
		const storage = await openNodeSqliteStorage(join(options.dataDir, 'agent.sqlite'));

		// A model picked in an app outlives the process; one the gateway no longer
		// has falls back to the usual choice rather than failing every run.
		const stored = new Settings(host).get(DEFAULT_MODEL_KEY);
		const startModel = stored && models.getModel('magpie', stored) ? stored : modelId;

		const events = new Listeners<BotEvent>();
		const memory = new MemoryStore(join(options.dataDir, 'memory'));
		const outbox = new Outbox(host);
		const schedules = new Schedules(host);
		const targets = new Targets(host);
		const registry = createRegistry();
		registry.install(createWebExtension());
		// Something enqueued mid-run (a card, a `send_message`) must go out now,
		// not at the fallback tick: the run that wrote it is not a pass that ends.
		let wake = () => {};

		const workspaceDir = options.workspaceDir;
		if (workspaceDir) {
			registry.install(CodingTools);
			registry.install(
				createApprovalExtension('approval', {
					approvals: new Approvals(host),
					outbox,
					targets,
					onAsked: (card) => {
						events.emit({ type: 'approval', ...card });
						wake();
					},
					onSettled: (card) => events.emit({ type: 'approval_done', ...card }),
				}),
			);
		}

		let harness: Harness;
		try {
			harness = await Harness.open(
				storage,
				{
					models,
					registry,
					now,
					...(workspaceDir ? { env: () => new NodeExecutionEnv({ cwd: workspaceDir }) } : {}),
				},
				BACKGROUND_CONTEXT,
			);
		} catch (error) {
			// Nothing will run, so do not leave a lock blocking the next attempt.
			lock.release();
			throw error;
		}
		const bot = new Bot(harness, host, startModel, options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT, options.dataDir, now, lock, options, models, events, memory);
		// Installed after the Bot exists, so the tool can rearm the schedule timer
		// through the very bot it belongs to.
		wake = () => bot.wake();
		registry.install(
			createChatExtension({ outbox, schedules, targets, now, onSchedulesChanged: () => bot.armScheduleTimer(), onEnqueued: () => bot.wake() }),
		);
		// Memory belongs to the person, not to one chat: every chat of a phone
		// reads and writes the same notes. The scope is resolved per run.
		registry.install(
			createMemoryExtension(memory, (agentConversation) => {
				const chat = targets.getByAgent(agentConversation);
				return chat ? bot.memoryScope(chat.channel, chat.target) : agentConversation;
			}),
		);
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

		// An approval answer is handled here and never becomes a chat turn. It
		// still goes through source_key de-duplication (as a `done` inbox row):
		// a platform that redelivers the same "yes" must not approve a second,
		// later card with it. Only decide() changing a pending row earns a reply,
		// so a stale answer to an already-decided card says nothing.
		const isAnswer = !event.images || event.images.length === 0;
		const answer = isAnswer ? this.approvals.answer(conversation, event.text) : undefined;
		if (answer) {
			if (!this.inbox.admitHandled({
				source: event.source,
				sourceKey: event.sourceKey,
				conversation,
				text: event.text,
			})) return true; // already seen: swallow the redelivery
			if (this.approvals.decide(answer.row.id, answer.allowed ? 'allowed' : 'denied')) {
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
			}
			return true;
		}

		const accepted: IncomingEvent = {
			source: event.source,
			sourceKey: event.sourceKey,
			conversation,
			text: event.text,
			...(event.images && event.images.length > 0 ? { attachments: event.images } : {}),
		};
		return this.admit(accepted);
	}

	/** Into the inbox, and say the conversation is busy now. */
	private admit(event: IncomingEvent): boolean {
		const acceptedNow = this.inbox.admit(event);
		if (acceptedNow) {
			this.chats.touch(event.conversation, this.now());
			this.events.emit({ type: 'status', conversation: event.conversation, busy: true });
			this.wake();
		}
		return acceptedNow;
	}

	/**
	 * Turn due timers into deliveries and inbox events. A timer that fired while
	 * the process was down still fires, once.
	 *
	 * The reminder text goes to the user first, straight to the outbox: the run
	 * that follows can add words, but the point of "十分钟后提醒我关火" is the
	 * words themselves, and a model that is out of quota at that moment must not
	 * replace them with "没能回答". A one-shot row is already deleted by the time
	 * the model runs, so a failed run used to lose it for good.
	 */
	fireDueSchedules(): number {
		const due = this.schedules.due(this.now());
		for (const row of due) {
			const target = this.targets.get(row.conversation);
			if (target) {
				this.outbox.enqueue({
					conversation: row.conversation,
					channel: target.channel,
					target: target.target,
					text: `⏰ ${row.text}`,
					kind: 'reminder',
				});
			}
			this.admit({
				source: 'schedule',
				sourceKey: row.id + row.next_run_at,
				conversation: row.conversation,
				text: `[定时任务触发] ${row.text}`,
			});
			this.schedules.fired(row, this.now());
		}
		if (due.length > 0) this.armScheduleTimer();
		return due.length;
	}

	/**
	 * One precise timer for the next due reminder, instead of polling for it.
	 * Rearmed after anything changes the table, and bounded by the fallback tick
	 * anyway: a timer that never fires cannot lose a reminder, only delay it to
	 * the next tick.
	 */
	armScheduleTimer(): void {
		if (this.scheduleTimer) clearTimeout(this.scheduleTimer);
		if (this.closed) return;
		const next = this.schedules.nextAt(this.now());
		if (next === undefined) {
			this.scheduleTimer = undefined;
			return;
		}
		const delay = Math.max(50, Math.min(next - this.now(), 2_147_000_000));
		this.scheduleTimer = setTimeout(() => {
			this.scheduleTimer = undefined;
			this.fireDueSchedules();
			this.armScheduleTimer();
			void this.wakeNow();
		}, delay);
		this.scheduleTimer.unref?.();
	}

	/** Runs both passes now, honouring the single-file rule. */
	private async wakeNow(): Promise<void> {
		const single = (label: 'work' | 'delivery', job: () => Promise<unknown>) => {
			if (this.busy[label]) return;
			this.busy[label] = true;
			void job()
				.catch((error) => console.error(`[bot] ${label} failed`, error))
				.finally(() => {
					this.busy[label] = false;
				});
		};
		single('work', () => this.work());
		single('delivery', () => this.dispatch());
	}

	/**
	 * Work whatever is waiting, one conversation at a time.
	 *
	 * "One at a time" is per conversation, not per process: a chat whose run is
	 * waiting on an approval card (up to five minutes) must not hold every other
	 * chat's reminders and messages hostage. Each conversation's rows are claimed
	 * here, but its run is awaited separately; `work` never finishes while one is
	 * going, so the single-file promise - no run twice - is kept by the map.
	 */
	private readonly running = new Map<string, Promise<void>>();

	async pump(): Promise<number> {
		let handled = 0;
		for (let guard = 0; guard < 100; guard++) {
			const first = this.inbox.claim();
			if (!first) break;

			const batched = this.inbox.pendingFor(first.conversation);
			// The whole batch is part of this run, not just its first row: left
			// pending, a crash would close the first with "interrupted" and then
			// answer the rest again on restart.
			this.inbox.finishMany(batched.map((row) => row.id));
			const text = [first.text, ...batched.map((row) => row.text)].join('\n');
			const rows = [first, ...batched];
			const images = rows.flatMap((row) => attachmentsOf(row));

			const prior = this.running.get(first.conversation);
			const run = (prior ?? Promise.resolve())
				// Serialized behind anything already answering for this conversation.
				.then(() => this.answer(first.conversation, text, images))
				.catch((error) => {
					// Cut off by `close()`: the database is gone, and the rows left
					// `running` are what the next start recovers, as after a crash.
					if (this.closed) return;
					// A run that threw must still close its rows: left `running` they would
					// never be answered, never be retried, and never be mentioned until the
					// next restart. Its approval cards go too - the poll inside cannot
					// know the run is over.
					console.error('[bot] run failed:', error);
					this.approvals.expirePendingFor(first.conversation);
					this.tell(first.conversation, text, '这条消息处理时出了错，我没能回上来。可以再说一次。', 'Something broke while I was answering that one. Could you send it again?');
				})
				.finally(() => {
					// Only the last run of the chain clears it: an earlier one ending
					// must not make a later one look finished.
					if (this.running.get(first.conversation) === run) {
						this.running.delete(first.conversation);
						// A stop that came too late to matter must not stop the next message.
						this.stopped.delete(first.conversation);
					}
					if (this.closed) return;
					for (const row of rows) this.inbox.finish(row.id);
					if (!this.isBusy(first.conversation)) {
						this.events.emit({ type: 'status', conversation: first.conversation, busy: false });
					}
					// The conversation may have more to say (`send_message`, the outbox
					// tail of this answer) or a later message may now be claimable.
					this.wake();
				});
			this.running.set(first.conversation, run);
			// Counted when claimed, not when answered: this pass returns so the
			// next conversation's rows can go out while this one is thinking.
			handled += rows.length;
			// Keep the process honest in tests and on shutdown: the last wake in
			// `finally` picks everything left up.
			if (this.running.size >= 8) await Promise.race(this.running.values());
		}
		// Do not await the runs here: the caller (`work`) must return so delivery
		// and further wakes keep flowing. `close` drains through `harness.close`.
		return handled;
	}

	/** A line from the bot itself, in the language of what it answers. */
	private tell(conversationId: string, sample: string, zh: string, en: string): void {
		const target = this.targets.get(conversationId);
		if (!target) return;
		this.outbox.enqueue({ conversation: conversationId, channel: target.channel, target: target.target, text: bilingual(sample, zh, en), kind: 'notice' });
	}

	/** One run: the durable conversation does the work, the outbox carries it out. */
	private async answer(conversationId: string, text: string, images: readonly Attachment[] = []): Promise<void> {
		const conversation = await this.ensureConversation(conversationId);
		await this.prepare(conversationId, conversation);
		// Stopped while it was being claimed, before there was a run to abort.
		if (this.stopped.delete(conversationId)) return;
		const content: UserInput =
			images.length > 0
				? [
						...(text ? [{ type: 'text', text } satisfies TextContent] : []),
						...images.map((image): ImageContent => ({ type: 'image', data: image.data, mimeType: image.mimeType })),
					]
				: text;

		// Watched from before the input goes in, so the partial answer counts only
		// what this run adds after the entries already there.
		const live = await this.watchRun(conversationId, conversation);
		this.active.set(conversationId, conversation);
		let settled: { status: string; reason?: unknown };
		try {
			const submission = await conversation.submit({ type: 'input', content }, BACKGROUND_CONTEXT);
			// A run that never settles would hold the one work loop forever: the busy
			// flag in `start()` would skip every later tick, so no message and no
			// reminder would ever be handled again - silently, with no error anywhere.
			let timer: NodeJS.Timeout | undefined;
			settled = await Promise.race([
				submission.wait(BACKGROUND_CONTEXT),
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => reject(new Error(`run took longer than ${this.runTimeoutMs / 60_000} minutes`)), this.runTimeoutMs);
					timer.unref?.();
				}),
			])
				.catch(async (error) => {
					console.error(`[bot] giving up on a run: ${(error as Error).message}`);
					await submission.abort(BACKGROUND_CONTEXT).catch(() => {});
					// The run is gone but any approval card it asked is still pending, and
					// the poll inside does not know. Left open, a "好" typed long after
					// would approve a call that will never run; close them with the run.
					this.approvals.expirePendingFor(conversationId);
					return { status: 'unanswered' as const, reason: 'timed_out' };
				})
				.finally(() => clearTimeout(timer));
		} finally {
			this.active.delete(conversationId);
			await live.stop();
		}

		const target = this.targets.get(conversationId);
		if (!target) return;

		// Stopped on purpose: the user knows there is no answer, and saying
		// "that one did not come back" would read as a failure.
		if (this.stopped.delete(conversationId) && settled.status !== 'done') return;

		if (settled.status !== 'done') {
			const reason = 'reason' in settled ? String(settled.reason) : 'failed';
			// A model error is nearly always the free pool being used up, and saying
			// so beats "try again" to someone who cannot know that. Anything else is
			// left as one plain sentence: a raw status word means nothing to a user.
			const why =
				reason === 'model_error'
					? bilingual(text, '（免费池可能到量了，等一会儿再试；用自己模型的检查一下 magpie）', ' (the free pool may be used up: try again later, or check magpie if you use your own model)')
					: reason === 'timed_out'
						? bilingual(text, '（等太久了，我先放下这一条）', ' (it took too long, so I put that one down)')
						: '';
			console.error(`[bot] no answer for ${conversationId}: ${reason}`);
			this.outbox.enqueue({
				conversation: conversationId,
				channel: target.channel,
				target: target.target,
				text: bilingual(
					text,
					`这次没能回答。可以再说一次，或者稍后让我重试。${why}`,
					`That one did not come back. Send it again, or ask me to retry later.${why}`,
				),
				kind: 'notice',
			});
			return;
		}

		const answer = await this.lastAssistantText(conversationId);
		if (answer.trim() && !isNoReply(answer)) {
			this.outbox.enqueue({ conversation: conversationId, channel: target.channel, target: target.target, text: answer, kind: 'answer' });
			this.chats.touch(conversationId, this.now());
			this.events.emit({ type: 'answered', conversation: conversationId, input: text, text: answer });
		}
	}

	/**
	 * Before a run: the conversation uses the model and thinking its chat asked
	 * for (or the default), and the system prompt of this version. Configured
	 * only when something differs, so an unchanged chat costs one read.
	 */
	private async prepare(conversationId: string, conversation: Conversation): Promise<void> {
		const chat = this.chats.byConversation(conversationId);
		const modelId = chat?.model && this.models.getModel('magpie', chat.model) ? chat.model : this.modelId;
		const reasoning = this.models.getModel('magpie', modelId)?.reasoning ?? false;
		// Only a chat with its own settings says anything about thinking; any other
		// conversation keeps whatever it had.
		const thinking = chat ? (chat.thinking && reasoning ? ('medium' as const) : ('off' as const)) : undefined;
		const agent = await conversation.agent(BACKGROUND_CONTEXT);
		const change: AgentChange = {
			...(agent.model?.provider !== 'magpie' || agent.model.modelId !== modelId ? { model: { provider: 'magpie', modelId } } : {}),
			...(thinking && agent.thinkingLevel !== thinking ? { thinkingLevel: thinking } : {}),
			...(agent.instructions !== this.systemPrompt ? { instructions: this.systemPrompt } : {}),
		};
		if (Object.keys(change).length > 0) await conversation.configure(change, BACKGROUND_CONTEXT);
	}

	/**
	 * Follow a run as it writes: every change to the conversation's live state
	 * becomes a partial answer, sent at most every `PARTIAL_EVERY_MS` with the
	 * newest one always last. Stopping drops the partial.
	 */
	private async watchRun(conversationId: string, conversation: Conversation): Promise<{ stop(): Promise<void> }> {
		let watch: Awaited<ReturnType<Conversation['watch']>>;
		try {
			watch = await conversation.watch(BACKGROUND_CONTEXT, { min: 100, max: 400 });
		} catch (error) {
			// A live view is a nicety: the answer still arrives without it.
			console.error('[bot] could not watch a run', error);
			return { stop: async () => {} };
		}
		const entries = watch.value.entries;
		const after = entries.length > 0 ? Number(entries[entries.length - 1]?.id) : 0;
		let lastSent = 0;
		let timer: NodeJS.Timeout | undefined;
		let latest = '';
		const send = () => {
			timer = undefined;
			const partial = this.partials.get(conversationId);
			if (!partial) return;
			lastSent = Date.now();
			this.events.emit({ type: 'partial', conversation: conversationId, partial });
		};
		watch.start(async (call) => {
			if (call.kind !== 'value') return;
			try {
				const partial = livePartial(call.value, after);
				if (!partial.text && !partial.thinking && partial.tools.length === 0) return;
				const key = JSON.stringify(partial);
				if (key === latest) return;
				latest = key;
				this.partials.set(conversationId, partial);
				const wait = PARTIAL_EVERY_MS - (Date.now() - lastSent);
				if (wait <= 0) send();
				else timer ??= setTimeout(send, wait);
			} catch (error) {
				console.error('[bot] could not read a partial answer', error);
			}
		});
		return {
			stop: async () => {
				clearTimeout(timer);
				this.partials.delete(conversationId);
				await watch.stop();
			},
		};
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
			// The silence a plain reminder is answered with (see the system prompt)
			// is for the bot's bookkeeping, never a bubble.
			.filter((entry) => entry.text.trim() !== '' && !isNoReply(entry.text))
			.slice(-limit);
	}

	/**
	 * The raw context of a conversation, for a surface that draws its own
	 * bubbles (see `appMessages`); undefined when nothing was said in it yet.
	 * Unlike `transcript` it never creates a conversation.
	 */
	async context(conversationId: string): Promise<ContextView | undefined> {
		const bound = this.targets.get(conversationId);
		if (!bound?.agentConversation) return undefined;
		const conversation = await this.harness.conversation(Number(bound.agentConversation) as ConversationId, BACKGROUND_CONTEXT);
		return conversation ? await conversation.context(BACKGROUND_CONTEXT) : undefined;
	}

	/** Answering now, or with a message waiting to be answered. */
	isBusy(conversationId: string): boolean {
		return this.running.has(conversationId) || this.inbox.pendingFor(conversationId).length > 0;
	}

	/** The answer being written in this conversation, while one is. */
	partialFor(conversationId: string): LivePartial | undefined {
		return this.partials.get(conversationId);
	}

	/**
	 * Stop answering in this conversation: the run in progress is aborted and
	 * messages still waiting for it are dropped. No "no answer" notice follows.
	 * False when there was nothing to stop.
	 */
	async stop(conversationId: string): Promise<boolean> {
		const waiting = this.inbox.pendingFor(conversationId);
		for (const row of waiting) this.inbox.finish(row.id);
		const conversation = this.active.get(conversationId);
		this.approvals.expirePendingFor(conversationId);
		if (conversation) {
			this.stopped.add(conversationId);
			await conversation.abort(BACKGROUND_CONTEXT);
			return true;
		}
		if (this.running.has(conversationId)) {
			// Claimed but not started yet: `answer` sees this and does not begin.
			this.stopped.add(conversationId);
			return true;
		}
		if (waiting.length > 0) this.events.emit({ type: 'status', conversation: conversationId, busy: false });
		return waiting.length > 0;
	}

	/** Listen to what happens inside, as it happens; returns the way to stop listening. */
	on(listener: (event: BotEvent) => void): () => void {
		return this.events.add(listener);
	}

	/** Every model the gateway offers, as a chooser shows them. */
	modelChoices(): ModelChoice[] {
		return this.models.getModels('magpie').map((model) => ({
			id: model.id,
			name: model.name || model.id,
			reasoning: Boolean(model.reasoning),
			vision: model.input.includes('image'),
		}));
	}

	/** The model conversations use unless their chat picked another. */
	get defaultModel(): string {
		return this.modelId;
	}

	/** Change the default and keep it: every conversation without a model of its own follows it from its next run. */
	setDefaultModel(modelId: string): void {
		if (!this.models.getModel('magpie', modelId)) throw new Error(`the gateway has no model "${modelId}"`);
		this.modelId = modelId;
		this.settings.set(DEFAULT_MODEL_KEY, modelId);
	}

	/**
	 * One answer to one prompt, outside any conversation: for small jobs such as
	 * naming a chat. Empty when the model failed; never throws.
	 */
	async complete(system: string, prompt: string, timeoutMs = 30_000): Promise<string> {
		const model = this.models.getModel('magpie', this.modelId);
		if (!model) return '';
		try {
			const message = await this.models.completeSimple(
				model,
				{ systemPrompt: system, messages: [{ role: 'user', content: prompt, timestamp: this.now() }] },
				{ signal: AbortSignal.timeout(timeoutMs) },
			);
			return message.stopReason === 'error' ? '' : textOf(message);
		} catch {
			return '';
		}
	}

	/**
	 * Whose memory a chat reads and writes: the person, not the chat. On the web
	 * channel a target is `<session>/<chat>`, and the session is the person; on
	 * other channels the target is the chat and the person at once. The notes an
	 * older version kept for the person's first conversation move along once.
	 */
	async memoryScope(channel: string, target: string): Promise<string> {
		const owner = channel === 'web' ? (target.split('/')[0] ?? target) : target;
		const scope = `${channel}-${owner}`;
		if (!this.scoped.has(scope)) {
			const legacy = this.targets.get(conversationIdFor(channel, owner))?.agentConversation;
			if (legacy) await this.memory.adopt(legacy, scope).catch((error) => console.error('[bot] could not move old notes', error));
			this.scoped.add(scope);
		}
		return scope;
	}

	/**
	 * The host tables, for a surface in front of this bot (the app API) that
	 * lists and changes what the bot keeps. Not for the loop's own state.
	 */
	get tables(): { chats: Chats; schedules: Schedules; targets: Targets; approvals: Approvals; memory: MemoryStore; outbox: Outbox } {
		return { chats: this.chats, schedules: this.schedules, targets: this.targets, approvals: this.approvals, memory: this.memory, outbox: this.outbox };
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
				agent: { model: { provider: 'magpie', modelId: this.modelId }, instructions: this.systemPrompt },
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
				// A send that never returns freezes every other message to every
				// channel: this loop is single-file, and the row would sit in
				// `sending` until a restart, where it is marked unknown and never
				// retried. Give it a bound and let the retry handle the rest.
				await Promise.race([
					channel.send(row.target, row.text, row.kind ? { kind: row.kind } : undefined),
					new Promise<never>((_, reject) =>
						setTimeout(() => reject(new Error(`send to ${row.channel} timed out`)), this.sendTimeoutMs).unref?.(),
					),
				]);
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
	 * Run in the background until the returned function is called.
	 *
	 * Wakeups are driven by work arriving, not by a poll: an ingest, an enqueue
	 * or a scheduled timer all call `wake()`, which runs the two passes on a
	 * short debounce. One slow timer keeps the guarantees a poll used to give -
	 * recovery after a crash, retries after failures, due reminders - without
	 * waking the phone twice a second all night. Working and delivering are two
	 * passes, not one: a run can be waiting on the user (an approval card) or can
	 * have said something on its own (`send_message`) while it is still running,
	 * and delivery that waited for the run to end would show the card only after
	 * it had timed out.
	 *
	 * @param idleMs the fallback tick, for retries, crash recovery and anything
	 *   that arrives without going through `wake()`.
	 */
	start(idleMs = 30_000): () => void {
		// A pass that starts while the same one is still running is not dropped:
		// it is queued, or a message that arrived during a run would sit undelivered
		// until the fallback tick. Single-file, but with a tail.
		const pending: Array<'work' | 'delivery'> = [];
		const run = (label: 'work' | 'delivery', job: () => Promise<unknown>) => {
			if (this.busy[label]) {
				if (!pending.includes(label)) pending.push(label);
				return;
			}
			this.busy[label] = true;
			job()
				.catch((error) => console.error(`[bot] ${label} failed`, error))
				.finally(() => {
					this.busy[label] = false;
					// A pass that outlived `close()` must not touch the closed database.
					if (this.closed) return;
					// This pass may have produced work for the other one - an answer
					// into the outbox, an event into the inbox - just after that one
					// had already been through. One more pass keeps neither finishing
					// with leftovers; the debounce folds repeats.
					if (this.inspect().pendingMessages + this.inspect().pendingEvents > 0) this.onWake?.();
					const next = pending.shift();
					if (next) this.onWake?.();
				});
		};
		const passes = {
			work: () => run('work', () => this.work()),
			delivery: () => run('delivery', () => this.dispatch()),
		};

		const wake = () => {
			// Debounced: several messages landing together run one pass over all of
			// them, which `pump` already batches per conversation.
			if (this.wakeTimer) clearTimeout(this.wakeTimer);
			this.wakeTimer = setTimeout(() => {
				this.wakeTimer = undefined;
				passes.work();
				passes.delivery();
			}, this.wakeDebounceMs);
			this.wakeTimer.unref?.();
		};
		this.onWake = wake;

		// The fallback tick: work that arrives without a wake (a retry coming due,
		// a schedule whose timer was lost, an external write to the tables).
		const tick = setInterval(() => {
			passes.work();
			passes.delivery();
		}, idleMs);
		tick.unref?.();
		this.timers.push(tick);

		// Arm the first reminder timer, and start with one pass so anything that
		// survived the last process is picked up now, not in `idleMs`.
		this.armScheduleTimer();
		passes.work();
		passes.delivery();
		return () => void this.close();
	}

	/** Anything just arrived or enqueued calls this; the passes run on a debounce. */
	wake(): void {
		this.onWake?.();
	}

	/**
	 * Small durable facts, for a surface that must outlive the process: the web
	 * channel's cookie secret lives here, so a restart does not sign everyone
	 * out. Not a general store - nothing else belongs in it yet.
	 */
	get kv(): { get(key: string): string | undefined; set(key: string, value: string): void } {
		return this.settings;
	}

	inspect(): { pendingEvents: number; pendingMessages: number; schedules: number } {
		return {
			pendingEvents: this.inbox.count('pending'),
			pendingMessages: this.outbox.pendingCount(),
			schedules: this.schedules.list().length,
		};
	}

	/** Settles when the first `close()` is done: a second caller waits for it instead of returning early. */
	private closing: Promise<void> | undefined;

	close(): Promise<void> {
		this.closing ??= this.shutdown();
		return this.closing;
	}

	private async shutdown(): Promise<void> {
		this.closed = true;
		for (const timer of this.timers.splice(0)) clearInterval(timer);
		clearTimeout(this.wakeTimer);
		clearTimeout(this.scheduleTimer);
		this.onWake = undefined;
		try {
			await this.harness.close(BACKGROUND_CONTEXT);
		} finally {
			this.host.close();
			// Released last: until the database is closed this process still owns it.
			this.lock.release();
		}
	}
}

/** Free first: the point of the product is that a new user pays nothing. */
export function pickDefaultModel(ids: readonly string[]): string {
	// The stable free model (behind a failover proxy) or a free routing group is
	// the best default: failover keeps working when one lane runs out of quota.
	const group = ids.find((id) => id === 'ofm/free' || id === 'group/free' || id === 'group/ofm-free');
	if (group) return group;
	const free = ids.find((id) => /(^|\/)free$|-free$/.test(id) || id.includes('/free'));
	if (free) return free;
	const first = ids[0];
	if (!first) throw new Error('the gateway offers no models: add a provider in magpie first');
	return first;
}
