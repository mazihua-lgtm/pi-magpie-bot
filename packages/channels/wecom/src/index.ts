import { WSClient } from '@wecom/aibot-node-sdk';
import type { Channel, MessageEvent } from '@pi-magpie-bot/brain';
import type { Owners } from '@pi-magpie-bot/events';

/** One incoming message, reduced to what this channel looks at. */
export interface WecomMessage {
	msgid: string;
	/** `single` is a private chat, `group` a group. */
	chattype: string;
	userid: string;
	/** `text`, `voice` (the platform's own transcript is the text), or anything else. */
	msgtype: string;
	text?: string;
}

/** The two things the channel needs from WeCom, so tests need no network. */
export interface WecomTransport {
	connect(handler: (message: WecomMessage) => Promise<void>): void;
	close(): void;
	sendMarkdown(userid: string, text: string): Promise<void>;
}

export interface WecomOptions {
	/** From the WeCom admin console: a smart bot in long-connection mode. */
	botId: string;
	secret: string;
	onMessage: (event: MessageEvent) => void | Promise<void>;
	/** Decides who may talk; without one, everybody may. */
	owners?: Owners;
	/** Injected for tests. */
	transport?: WecomTransport;
}

/**
 * The official SDK keeps a WebSocket open to WeCom, so the bot works behind any
 * router with no public address, the same promise as Telegram polling.
 */
function sdkTransport(options: WecomOptions): WecomTransport {
	const ws = new WSClient({ botId: options.botId, secret: options.secret, maxReconnectAttempts: -1 });
	return {
		connect(handler) {
			// An EventEmitter with no 'error' listener throws; the SDK retries on its own.
			ws.on('error', (error) => console.error(`[wecom] ${error.message}`));
			ws.on('authenticated', () => console.log('[wecom] connected'));
			ws.on('message', (frame) => {
				const body = frame.body;
				if (!body) return;
				const text =
					body.msgtype === 'text' ? body.text?.content : body.msgtype === 'voice' ? body.voice?.content : undefined;
				handler({
					msgid: body.msgid,
					chattype: body.chattype,
					userid: body.from?.userid ?? '',
					msgtype: body.msgtype,
					text,
				}).catch((error: unknown) => console.error('[wecom] handling failed:', error instanceof Error ? error.message : error));
			});
			ws.connect();
		},
		close: () => ws.disconnect(),
		async sendMarkdown(userid, text) {
			await ws.sendMessage(userid, { msgtype: 'markdown', markdown: { content: text } });
		},
	};
}

/** A chunk must not split a surrogate pair. */
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

export class WecomChannel implements Channel {
	readonly id = 'wecom';
	private readonly transport: WecomTransport;

	constructor(private readonly options: WecomOptions) {
		this.transport = options.transport ?? sdkTransport(options);
	}

	start(): void {
		this.transport.connect((message) => this.handle(message));
	}

	async stop(): Promise<void> {
		this.transport.close();
	}

	private async handle(message: WecomMessage): Promise<void> {
		// Owner and allow-list are people. A group stands for everyone in it, so a
		// group is no owner, and only private chats are answered.
		if (message.chattype !== 'single' || !message.userid) return;

		const user = message.userid;
		if (message.msgtype !== 'text' && message.msgtype !== 'voice') {
			await this.send(user, '我现在只看得懂文字和语音。').catch(() => {});
			return;
		}
		const text = message.text?.trim();
		if (!text) return;

		const owners = this.options.owners;
		if (owners) {
			const admission = owners.check(this.id, user);
			if (admission === 'denied') {
				await this.send(user, '这台机器人已经有主人了，不能再接受别人指挥。').catch(() => {});
				return;
			}
			if (admission === 'claimed') {
				console.log(`[wecom] ${user} is now the owner of this bot`);
				await this.send(user, '好，从现在起我归你了。直接跟我说话就行，比如「10 分钟后提醒我关火」。').catch(() => {});
			}
		}

		await this.options.onMessage({
			source: `wecom:${user}`,
			sourceKey: message.msgid,
			channel: this.id,
			target: user,
			text,
		});
	}

	async send(target: string, text: string): Promise<void> {
		for (const part of chunk(text)) {
			await this.transport.sendMarkdown(target, part);
		}
	}
}
