import { randomUUID } from 'node:crypto';
import type { Attachment, ChatChange, ChatRow, ScheduleRow, TitleState } from '@pi-magpie-bot/events';
import { type Bot, conversationIdFor, type ModelChoice } from './bot.ts';
import { appMessages, type AppMessage, type LivePartial } from './messages.ts';

/**
 * The native app's view of the bot: several chats per phone, live partial
 * answers, approvals as buttons, the model chooser, reminders, memory and
 * model keys. The web channel serves it over HTTP (docs/app-api.md); nothing
 * here knows about HTTP beyond the status an error should carry.
 */

export interface AppChat {
	id: string;
	title: string;
	createdAt: number;
	updatedAt: number;
	pinned: boolean;
	model: string | null;
	thinking: boolean;
	busy: boolean;
}

export interface AppSchedule {
	id: string;
	chat: string;
	text: string;
	nextRunAt: number;
	everyMs: number | null;
}

export interface AppVendor {
	preset: string;
	name: string;
	signupUrl?: string;
}

/** A live event for one owner's stream, by its SSE event name. */
export type AppEvent =
	| { event: 'status'; data: { chat: string; busy: boolean } }
	| { event: 'partial'; data: { chat: string } & LivePartial }
	| { event: 'approval'; data: { chat: string; id: string; action: string; expiresAt: number } }
	| { event: 'approval_done'; data: { chat: string; id: string; status: 'allowed' | 'denied' | 'expired' } }
	| { event: 'chat'; data: AppChat };

export interface ChatPatch {
	title?: unknown;
	pinned?: unknown;
	model?: unknown;
	thinking?: unknown;
}

export interface OutgoingInput {
	text?: unknown;
	images?: unknown;
}

/** What the HTTP side calls. Every `owner` is the phone's session id. */
export interface AppBackend {
	chats(owner: string): AppChat[];
	createChat(owner: string, title?: unknown): AppChat;
	updateChat(owner: string, id: string, patch: ChatPatch): AppChat;
	deleteChat(owner: string, id: string): Promise<void>;
	messages(owner: string, id: string): Promise<{ messages: AppMessage[]; busy: boolean; partial?: LivePartial }>;
	/** `id` "new" makes the chat first. */
	send(owner: string, id: string, input: OutgoingInput): AppChat;
	stop(owner: string, id: string): Promise<void>;
	decide(owner: string, approval: string, allow: unknown): void;
	/** Cards still waiting, as events, for a stream that just connected. */
	pendingApprovals(owner: string): AppEvent[];
	models(): { models: ModelChoice[]; default: string };
	setDefaultModel(model: unknown): void;
	schedules(owner: string): AppSchedule[];
	addSchedule(owner: string, input: { chat?: unknown; text?: unknown; at?: unknown; everyMs?: unknown }): AppSchedule;
	removeSchedule(owner: string, id: string): void;
	memory(owner: string): Promise<Array<{ name: string; content: string }>>;
	writeMemory(owner: string, name: string, content: unknown): Promise<void>;
	deleteMemory(owner: string, name: string): Promise<void>;
	vendors(): AppVendor[];
	/** Saves a key; the answer is a sentence for the user. Call `restart` once the answer is out. */
	saveProvider(preset: unknown, key: unknown): Promise<string>;
	restart(): void;
	subscribe(listener: (owner: string, event: AppEvent) => void): () => void;
}

/** A refusal with the HTTP status it should go out as. The message is for the user, Chinese first. */
export class AppError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

export interface AppServiceOptions {
	/** The channel the app speaks through; its targets are `<owner>` and `<owner>/<chat>`. */
	channel?: string;
	vendors?: AppVendor[];
	/** Adds a model key (`magpie provider add`); absent where this machine cannot. */
	saveProvider?: (input: { preset: string; key: string }) => Promise<string>;
	/** Called after a key was saved and the answer sent: the process restarts to load the new models. */
	restart?: () => void;
	/** Names a chat after its first answer. Defaults to asking the default model. */
	titler?: (input: string, answer: string) => Promise<string>;
}

const CHAT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const IMAGE_TYPES = /^image\/(png|jpe?g|webp|gif)$/;
const MAX_IMAGES = 6;
const MAX_TEXT = 20_000;
const MAX_TITLE = 60;
/** How long a card waits, as `askApproval` counts it. */
const APPROVAL_MS = 5 * 60_000;
const YEAR_MS = 365 * 24 * 60 * 60_000;

/** The first words of a message, as a title until the model writes a better one. */
function cut(text: string, max = 24): string {
	const line = text.replace(/\s+/g, ' ').trim();
	return line.length > max ? `${line.slice(0, max)}…` : line;
}

/** A model's answer to "name this chat", reduced to the name. */
export function cleanTitle(raw: string): string {
	const line = raw
		.split('\n')
		.map((part) => part.trim())
		.find(Boolean);
	if (!line) return '';
	return line
		.replace(/^(标题|title)\s*[:：]\s*/i, '')
		.replace(/^["'“”‘’「」《》*#\s]+|["'“”‘’「」《》*#。.！!？?\s]+$/g, '')
		.slice(0, 24)
		.trim();
}

export class AppService implements AppBackend {
	private readonly bot: Bot;
	private readonly channel: string;
	private readonly options: AppServiceOptions;
	private readonly listeners = new Set<(owner: string, event: AppEvent) => void>();
	/** Chats a title is being written for, so two answers do not ask twice. */
	private readonly naming = new Set<string>();

	constructor(bot: Bot, options: AppServiceOptions = {}) {
		this.bot = bot;
		this.channel = options.channel ?? 'web';
		this.options = options;
		bot.on((event) => {
			const where = this.locate(event.conversation);
			if (!where) return;
			switch (event.type) {
				case 'status':
					return this.emit(where.owner, { event: 'status', data: { chat: where.chat, busy: event.busy } });
				case 'partial':
					return this.emit(where.owner, { event: 'partial', data: { chat: where.chat, ...event.partial } });
				case 'approval':
					return this.emit(where.owner, {
						event: 'approval',
						data: { chat: where.chat, id: event.id, action: event.action, expiresAt: event.expiresAt },
					});
				case 'approval_done':
					return this.emit(where.owner, { event: 'approval_done', data: { chat: where.chat, id: event.id, status: event.status } });
				case 'answered':
					void this.name(event.conversation, event.input, event.text);
					return;
			}
		});
	}

	subscribe(listener: (owner: string, event: AppEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private emit(owner: string, event: AppEvent): void {
		for (const listener of this.listeners) {
			try {
				listener(owner, event);
			} catch (error) {
				console.error('[app] a listener threw', error);
			}
		}
	}

	/** Which owner and chat a host conversation is, when it is one of this channel's. */
	private locate(conversation: string): { owner: string; chat: string } | undefined {
		const bound = this.bot.tables.targets.get(conversation);
		if (!bound || bound.channel !== this.channel) return undefined;
		return this.split(bound.target);
	}

	private split(target: string): { owner: string; chat: string } {
		const at = target.indexOf('/');
		return at < 0 ? { owner: target, chat: 'default' } : { owner: target.slice(0, at), chat: target.slice(at + 1) };
	}

	private target(owner: string, chat: string): string {
		return chat === 'default' ? owner : `${owner}/${chat}`;
	}

	private conversation(owner: string, chat: string): string {
		return conversationIdFor(this.channel, this.target(owner, chat));
	}

	/**
	 * The chat's row. The conversation an older page had (target `<owner>`)
	 * becomes the chat `default` the first time it is asked for.
	 */
	private row(owner: string, chat: string, options: { create?: boolean } = {}): ChatRow | undefined {
		if (!CHAT_ID.test(chat)) return undefined;
		const { chats, targets } = this.bot.tables;
		const found = chats.get(this.channel, owner, chat);
		if (found || chat !== 'default') return found;
		const conversation = this.conversation(owner, chat);
		const legacy = targets.get(conversation);
		if (!legacy && !options.create) return undefined;
		return chats.create({
			conversation,
			channel: this.channel,
			owner,
			chat,
			title: legacy ? '之前的对话' : '新对话',
			titleState: legacy ? 'user' : 'empty',
		});
	}

	private found(owner: string, chat: string, options: { create?: boolean } = {}): ChatRow {
		const row = this.row(owner, chat, options);
		if (!row) throw new AppError(404, '没有这个对话 / no such chat');
		return row;
	}

	private view(row: ChatRow): AppChat {
		return {
			id: row.chat,
			title: row.title,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
			pinned: row.pinned === 1,
			model: row.model,
			thinking: row.thinking === 1,
			busy: this.bot.isBusy(row.conversation),
		};
	}

	chats(owner: string): AppChat[] {
		// Asked for once, so an older page's conversation joins the list.
		this.row(owner, 'default');
		return this.bot.tables.chats.list(this.channel, owner).map((row) => this.view(row));
	}

	createChat(owner: string, title?: unknown): AppChat {
		const given = typeof title === 'string' ? title.trim().slice(0, MAX_TITLE) : '';
		return this.view(this.make(owner, given || '新对话', given ? 'user' : 'empty'));
	}

	/** A new chat, said on the stream. */
	private make(owner: string, title: string, titleState: TitleState): ChatRow {
		const chat = randomUUID().replace(/-/g, '').slice(0, 12);
		const row = this.bot.tables.chats.create({ conversation: this.conversation(owner, chat), channel: this.channel, owner, chat, title, titleState });
		this.emit(owner, { event: 'chat', data: this.view(row) });
		return row;
	}

	updateChat(owner: string, id: string, patch: ChatPatch): AppChat {
		const row = this.found(owner, id);
		const change: ChatChange = {};
		if (patch.title !== undefined) {
			const title = typeof patch.title === 'string' ? patch.title.trim().slice(0, MAX_TITLE) : '';
			if (!title) throw new AppError(400, '标题不能是空的 / the title is empty');
			change.title = title;
			change.titleState = 'user';
		}
		if (patch.pinned !== undefined) {
			if (typeof patch.pinned !== 'boolean') throw new AppError(400, 'pinned 要是 true 或 false');
			change.pinned = patch.pinned;
		}
		if (patch.model !== undefined) {
			if (patch.model !== null && (typeof patch.model !== 'string' || !this.bot.modelChoices().some((model) => model.id === patch.model))) {
				throw new AppError(400, '没有这个模型 / no such model');
			}
			change.model = patch.model;
		}
		if (patch.thinking !== undefined) {
			if (typeof patch.thinking !== 'boolean') throw new AppError(400, 'thinking 要是 true 或 false');
			change.thinking = patch.thinking;
		}
		const updated = this.bot.tables.chats.update(row.conversation, change) ?? row;
		const view = this.view(updated);
		this.emit(owner, { event: 'chat', data: view });
		return view;
	}

	async deleteChat(owner: string, id: string): Promise<void> {
		const row = this.found(owner, id);
		const { chats, schedules, targets } = this.bot.tables;
		await this.bot.stop(row.conversation);
		for (const schedule of schedules.list(row.conversation)) schedules.remove(schedule.id);
		// A line the run enqueued just before it was stopped, or a reminder
		// that fired in the same moment, would otherwise still be delivered.
		this.bot.tables.outbox.dropFor(row.conversation);
		this.bot.armScheduleTimer();
		chats.remove(row.conversation);
		// The same id again would otherwise continue the deleted conversation.
		targets.forget(row.conversation);
	}

	async messages(owner: string, id: string): Promise<{ messages: AppMessage[]; busy: boolean; partial?: LivePartial }> {
		const row = this.found(owner, id);
		const context = await this.bot.context(row.conversation);
		const busy = this.bot.isBusy(row.conversation);
		const partial = this.bot.partialFor(row.conversation);
		return { messages: context ? appMessages(context) : [], busy, ...(busy && partial ? { partial } : {}) };
	}

	send(owner: string, id: string, input: OutgoingInput): AppChat {
		const text = typeof input.text === 'string' ? input.text.trim() : '';
		if (text.length > MAX_TEXT) throw new AppError(413, '这条消息太长了 / the message is too long');
		const images = this.images(input.images);
		if (!text && images.length === 0) throw new AppError(400, '消息是空的 / empty message');

		let row = id === 'new' ? undefined : this.found(owner, id, { create: true });
		const model = row?.model ?? this.bot.defaultModel;
		if (images.length > 0 && this.bot.modelChoices().some((choice) => choice.id === model && !choice.vision)) {
			throw new AppError(400, '这个模型看不了图片，换一个能看图的模型再发 / this model cannot read images');
		}
		// A new chat is named after its first message from the start.
		row ??= this.make(owner, cut(text) || '图片', 'first');

		const { chats } = this.bot.tables;
		if (row.title_state === 'empty') {
			row = chats.update(row.conversation, { title: cut(text) || '图片', titleState: 'first' }) ?? row;
			this.emit(owner, { event: 'chat', data: this.view(row) });
		}
		this.bot.ingest({
			source: `${this.channel}:${owner}`,
			sourceKey: randomUUID(),
			channel: this.channel,
			target: this.target(owner, row.chat),
			text,
			...(images.length > 0 ? { images } : {}),
		});
		return this.view(chats.byConversation(row.conversation) ?? row);
	}

	/** The pictures of a message, checked: a type the models take, and base64 that is base64. */
	private images(raw: unknown): Attachment[] {
		if (raw === undefined || raw === null) return [];
		if (!Array.isArray(raw)) throw new AppError(400, 'images 要是数组 / images must be an array');
		if (raw.length > MAX_IMAGES) throw new AppError(400, `一次最多 ${MAX_IMAGES} 张图片 / at most ${MAX_IMAGES} images`);
		return raw.map((item: unknown) => {
			const image = (item ?? {}) as { data?: unknown; mimeType?: unknown };
			let data = typeof image.data === 'string' ? image.data : '';
			// A data: URI is what a client most easily has; take the payload of it.
			const uri = /^data:([^;,]+);base64,/.exec(data);
			const mimeType = typeof image.mimeType === 'string' ? image.mimeType : (uri?.[1] ?? '');
			if (uri) data = data.slice(uri[0].length);
			data = data.replace(/\s+/g, '');
			if (!IMAGE_TYPES.test(mimeType)) throw new AppError(400, '只收 png、jpeg、webp、gif 图片 / unsupported image type');
			if (!data || data.length % 4 === 1 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new AppError(400, '图片数据坏了 / the image is not base64');
			return { data, mimeType: mimeType === 'image/jpg' ? 'image/jpeg' : mimeType };
		});
	}

	async stop(owner: string, id: string): Promise<void> {
		await this.bot.stop(this.found(owner, id).conversation);
	}

	decide(owner: string, approval: string, allow: unknown): void {
		if (typeof allow !== 'boolean') throw new AppError(400, 'allow 要是 true 或 false');
		const { approvals } = this.bot.tables;
		const row = approvals.get(approval);
		if (!row || row.channel !== this.channel || this.split(row.target).owner !== owner) {
			throw new AppError(404, '没有这个请求 / no such approval');
		}
		if (row.status !== 'pending' || !approvals.decide(row.id, allow ? 'allowed' : 'denied')) {
			throw new AppError(409, '这件事已经处理过了 / already decided');
		}
	}

	pendingApprovals(owner: string): AppEvent[] {
		return this.bot.tables.approvals
			.pending()
			.filter((row) => row.channel === this.channel && this.split(row.target).owner === owner)
			.map((row) => ({
				event: 'approval' as const,
				data: { chat: this.split(row.target).chat, id: row.id, action: row.action, expiresAt: row.created_at + APPROVAL_MS },
			}));
	}

	models(): { models: ModelChoice[]; default: string } {
		return { models: this.bot.modelChoices(), default: this.bot.defaultModel };
	}

	setDefaultModel(model: unknown): void {
		if (typeof model !== 'string' || !this.bot.modelChoices().some((choice) => choice.id === model)) {
			throw new AppError(400, '没有这个模型 / no such model');
		}
		this.bot.setDefaultModel(model);
	}

	private schedule(row: ScheduleRow): AppSchedule {
		return { id: row.id, chat: this.split(row.target).chat, text: row.text, nextRunAt: row.next_run_at, everyMs: row.every_ms };
	}

	private owned(owner: string): ScheduleRow[] {
		return this.bot.tables.schedules.list().filter((row) => row.channel === this.channel && this.split(row.target).owner === owner);
	}

	schedules(owner: string): AppSchedule[] {
		return this.owned(owner).map((row) => this.schedule(row));
	}

	addSchedule(owner: string, input: { chat?: unknown; text?: unknown; at?: unknown; everyMs?: unknown }): AppSchedule {
		const chat = typeof input.chat === 'string' ? input.chat : '';
		const row = this.found(owner, chat);
		const text = typeof input.text === 'string' ? input.text.trim() : '';
		if (!text) throw new AppError(400, '提醒的内容是空的 / empty reminder');
		if (text.length > 1_000) throw new AppError(400, '提醒的内容太长了 / the reminder is too long');
		const at = input.at;
		if (typeof at !== 'number' || !Number.isFinite(at)) throw new AppError(400, 'at 要是毫秒时间戳 / at must be epoch ms');
		if (at <= Date.now()) throw new AppError(400, '这个时间已经过去了 / that time has passed');
		const every = input.everyMs ?? null;
		// A repeat of zero would fire forever in one go (see `Schedules.fired`).
		if (every !== null && (typeof every !== 'number' || !Number.isFinite(every) || every < 60_000 || every > YEAR_MS)) {
			throw new AppError(400, '重复间隔要在一分钟到一年之间 / everyMs must be between a minute and a year');
		}
		const target = this.target(owner, row.chat);
		const { schedules, targets } = this.bot.tables;
		// The reminder is delivered through the conversation's binding.
		targets.bind({ conversation: row.conversation, channel: this.channel, target });
		const id = schedules.add({
			conversation: row.conversation,
			channel: this.channel,
			target,
			text,
			at,
			...(every !== null ? { everyMs: every } : {}),
		});
		this.bot.armScheduleTimer();
		const added = schedules.list(row.conversation).find((entry) => entry.id === id);
		if (!added) throw new AppError(500, '提醒没有存下来 / the reminder was not saved');
		return this.schedule(added);
	}

	removeSchedule(owner: string, id: string): void {
		const row = this.owned(owner).find((entry) => entry.id === id);
		if (!row) throw new AppError(404, '没有这个提醒 / no such reminder');
		this.bot.tables.schedules.remove(row.id);
		this.bot.armScheduleTimer();
	}

	async memory(owner: string): Promise<Array<{ name: string; content: string }>> {
		const scope = await this.bot.memoryScope(this.channel, owner);
		const { memory } = this.bot.tables;
		const names = (await memory.listNotes(scope)).sort();
		return await Promise.all(names.map(async (name) => ({ name, content: await memory.readNote(scope, name) })));
	}

	async writeMemory(owner: string, name: string, content: unknown): Promise<void> {
		if (typeof content !== 'string' || !content.trim()) throw new AppError(400, '内容是空的 / empty note');
		if (content.length > MAX_TEXT) throw new AppError(413, '内容太长了 / the note is too long');
		const scope = await this.bot.memoryScope(this.channel, owner);
		try {
			await this.bot.tables.memory.writeNote(scope, name, content);
		} catch (error) {
			throw new AppError(400, `名字不行：${(error as Error).message}`);
		}
	}

	async deleteMemory(owner: string, name: string): Promise<void> {
		const scope = await this.bot.memoryScope(this.channel, owner);
		let removed: boolean;
		try {
			removed = await this.bot.tables.memory.deleteNote(scope, name);
		} catch {
			removed = false;
		}
		if (!removed) throw new AppError(404, '没有这条记忆 / no such note');
	}

	vendors(): AppVendor[] {
		return this.options.vendors ?? [];
	}

	async saveProvider(preset: unknown, key: unknown): Promise<string> {
		const save = this.options.saveProvider;
		if (!save) throw new AppError(501, '这台机器上不能在这里添加模型 / keys cannot be added here');
		// A preset is one of magpie's own ids (`magpie presets`), and magpie is
		// what decides whether it knows one. The vendor list is only what the
		// first run offers: the free-allowance guide names vendors that list
		// leaves out, and holding it to that list is how a guide row ends up
		// advertising a vendor the app then refuses. The shape is still checked,
		// so nothing lands in argument position that magpie would read as a flag.
		if (typeof preset !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,40}$/.test(preset)) {
			throw new AppError(400, '没有这家厂商 / unknown vendor');
		}
		const trimmed = typeof key === 'string' ? key.trim() : '';
		if (!trimmed || trimmed.length > 500 || /\s/.test(trimmed)) throw new AppError(400, '密钥格式不对 / the key does not look right');
		try {
			return await save({ preset, key: trimmed });
		} catch (error) {
			throw new AppError(400, (error as Error).message.split('\n')[0] ?? '没加上 / not added');
		}
	}

	restart(): void {
		this.options.restart?.();
	}

	/** After the first answer, a short title written by the model replaces the first words. */
	private async name(conversation: string, input: string, answer: string): Promise<void> {
		const { chats } = this.bot.tables;
		const row = chats.byConversation(conversation);
		if (!row || row.title_state !== 'first' || this.naming.has(conversation)) return;
		this.naming.add(conversation);
		try {
			const titler =
				this.options.titler ??
				((question: string, reply: string) =>
					this.bot.complete(
						'给这段对话起一个标题：不超过 12 个字，只回标题本身，不加引号和标点。Name this chat in at most 6 words, in the language of the user; reply with the title only.',
						`用户：${question.slice(0, 600)}\n助理：${reply.slice(0, 600)}`,
					));
			const title = cleanTitle(await titler(input, answer));
			// Renamed by the user meanwhile, or deleted: theirs wins.
			const now = chats.byConversation(conversation);
			if (!now || now.title_state !== 'first') return;
			const updated = chats.update(conversation, title ? { title, titleState: 'model' } : { titleState: 'model' });
			if (updated && title) this.emit(updated.owner, { event: 'chat', data: this.view(updated) });
		} catch (error) {
			console.error('[app] could not name a chat', error);
		} finally {
			this.naming.delete(conversation);
		}
	}
}
