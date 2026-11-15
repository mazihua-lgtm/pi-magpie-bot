import type { Channel, MessageEvent } from '@pi-magpie-bot/brain';
import type { Owners } from '@pi-magpie-bot/events';

export interface TelegramOptions {
	/** From @BotFather. */
	token: string;
	/** Where to hand each accepted message. */
	onMessage: (event: MessageEvent) => void | Promise<void>;
	/** Decides who may talk; without one, everybody may. */
	owners?: Owners;
	/** For deployments where api.telegram.org is not reachable directly. */
	apiBase?: string;
	/** Injected for tests. */
	fetch?: typeof fetch;
	/** How long one long-poll may wait, in seconds. Telegram caps this at 50. */
	pollSeconds?: number;
}

interface Update {
	update_id: number;
	message?: {
		message_id: number;
		date: number;
		text?: string;
		chat: { id: number; type: string; first_name?: string; username?: string };
		from?: { id: number; is_bot?: boolean };
	};
}

/** Telegram counts UTF-16 code units, and a chunk must not split a surrogate pair. */
function chunk(text: string, limit = 4000): string[] {
	const out: string[] = [];
	let rest = text;
	while (rest.length > limit) {
		let cut = limit;
		const code = rest.charCodeAt(cut - 1);
		if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
		out.push(rest.slice(0, cut));
		rest = rest.slice(cut);
	}
	if (rest) out.push(rest);
	return out;
}

/**
 * Long polling, so the bot works behind any router with no public address and
 * no webhook to keep alive: the process asks Telegram for new messages.
 */
export class TelegramChannel implements Channel {
	readonly id = 'telegram';
	private readonly token: string;
	private readonly apiBase: string;
	private readonly fetchImpl: typeof fetch;
	private readonly pollSeconds: number;
	private running = false;
	private offset = 0;
	private hinted = false;
	private loop: Promise<void> | undefined;

	constructor(private readonly options: TelegramOptions) {
		this.token = options.token;
		this.apiBase = (options.apiBase ?? 'https://api.telegram.org').replace(/\/$/, '');
		this.fetchImpl = options.fetch ?? fetch;
		this.pollSeconds = options.pollSeconds ?? 25;
	}

	private url(method: string): string {
		return `${this.apiBase}/bot${this.token}/${method}`;
	}

	/** Starts the poll loop; the returned promise ends when `stop()` is called. */
	start(): void {
		if (this.running) return;
		this.running = true;
		this.loop = this.poll();
	}

	async stop(): Promise<void> {
		this.running = false;
		await this.loop;
	}

	private async poll(): Promise<void> {
		while (this.running) {
			try {
				const updates = await this.getUpdates();
				for (const update of updates) {
					this.offset = Math.max(this.offset, update.update_id + 1);
					await this.handle(update);
				}
			} catch (error) {
				// A network blip is not a reason to stop being a bot.
				console.error('[telegram] poll failed:', error instanceof Error ? error.message : error);
				if (!this.hinted) {
					this.hinted = true;
					console.error(
						`[telegram] if ${this.apiBase} is blocked on this network, set TELEGRAM_API_BASE to a mirror of the Bot API`,
					);
				}
				await new Promise((resolve) => setTimeout(resolve, 3_000));
			}
		}
	}

	private async getUpdates(): Promise<Update[]> {
		const query = new URLSearchParams({
			timeout: String(this.pollSeconds),
			offset: String(this.offset),
			allowed_updates: JSON.stringify(['message']),
		});
		const response = await this.fetchImpl(`${this.url('getUpdates')}?${query}`, {
			signal: AbortSignal.timeout((this.pollSeconds + 15) * 1_000),
		});
		const body = (await response.json()) as { ok: boolean; result?: Update[]; description?: string };
		if (!body.ok) throw new Error(body.description ?? 'getUpdates failed');
		return body.result ?? [];
	}

	private async handle(update: Update): Promise<void> {
		const message = update.message;
		if (!message?.text) return;
		if (message.from?.is_bot) return;

		const chatId = String(message.chat.id);
		const owners = this.options.owners;
		if (owners) {
			const admission = owners.check(this.id, chatId);
			if (admission === 'denied') {
				await this.send(chatId, '这台机器人已经有主人了，不能再接受别人指挥。');
				return;
			}
			if (admission === 'claimed') {
				console.log(`[telegram] ${chatId} is now the owner of this bot`);
				await this.send(chatId, '好，从现在起我归你了。直接跟我说话就行，比如「10 分钟后提醒我关火」。');
			}
		}

		await this.options.onMessage({
			source: `telegram:${chatId}`,
			sourceKey: String(message.message_id),
			channel: this.id,
			target: chatId,
			text: message.text,
		});
	}

	async send(target: string, text: string): Promise<void> {
		for (const part of chunk(text)) {
			await this.sendText(target, part);
		}
	}

	private async sendText(target: string, text: string): Promise<void> {
		const response = await this.fetchImpl(this.url('sendMessage'), {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ chat_id: target, text, disable_web_page_preview: true }),
			signal: AbortSignal.timeout(20_000),
		});
		if (response.ok) return;
		const body = (await response.text()).slice(0, 300);
		throw new Error(`telegram sendMessage ${response.status}: ${body}`);
	}
}
