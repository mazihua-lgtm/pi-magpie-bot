import { Client, Domain, EventDispatcher, LoggerLevel, WSClient } from '@larksuiteoapi/node-sdk';
import type { Channel, MessageEvent } from '@pi-magpie-bot/brain';
import type { Owners } from '@pi-magpie-bot/events';

/** What arrives with `im.message.receive_v1`, only the parts used here. */
export interface FeishuMessage {
	sender: { sender_type: string; sender_id?: { open_id?: string } };
	message: { message_id: string; chat_id: string; chat_type: string; message_type: string; content: string };
}

/** The two things the channel needs from Feishu, so tests need no network. */
export interface FeishuTransport {
	/** Starts listening; `handler` is called once per incoming message. */
	connect(handler: (event: FeishuMessage) => Promise<void>): Promise<void>;
	close(): void;
	sendText(chatId: string, text: string): Promise<void>;
}

export interface FeishuOptions {
	/** From the Feishu (or Lark) developer console: the app's credentials. */
	appId: string;
	appSecret: string;
	/** `lark` for the international edition; Feishu in China is the default. */
	domain?: 'feishu' | 'lark';
	onMessage: (event: MessageEvent) => void | Promise<void>;
	/** Decides who may talk; without one, everybody may. */
	owners?: Owners;
	/** Injected for tests. */
	transport?: FeishuTransport;
}

/**
 * The official SDK keeps a WebSocket open to Feishu, so the bot works behind
 * any router with no public address, the same promise as Telegram polling.
 */
function sdkTransport(options: FeishuOptions): FeishuTransport {
	const domain = options.domain === 'lark' ? Domain.Lark : Domain.Feishu;
	const base = { appId: options.appId, appSecret: options.appSecret, domain, loggerLevel: LoggerLevel.warn };
	const client = new Client(base);
	// `start()` resolves even when the credentials are refused, so what it says
	// about the connection only comes from these two callbacks.
	const ws = new WSClient({
		...base,
		onReady: () => console.log('[feishu] connected'),
		onError: (error) =>
			console.error(`[feishu] could not connect: ${error.message}. Check FEISHU_APP_ID, FEISHU_APP_SECRET and that the app is published with long-connection events on.`),
	});
	return {
		async connect(handler) {
			// Feishu repeats an event that is not acknowledged within three seconds;
			// the handler only writes to the inbox, so it is acknowledged at once.
			await ws.start({
				eventDispatcher: new EventDispatcher({}).register({
					'im.message.receive_v1': async (data) => {
						await handler(data);
					},
				}),
			});
		},
		close: () => ws.close(),
		async sendText(chatId, text) {
			await client.im.v1.message.create({
				params: { receive_id_type: 'chat_id' },
				data: { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text }) },
			});
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

export class FeishuChannel implements Channel {
	readonly id = 'feishu';
	private readonly transport: FeishuTransport;

	private readonly options: FeishuOptions;

	constructor(options: FeishuOptions) {
		this.options = options;
		this.transport = options.transport ?? sdkTransport(options);
	}

	async start(): Promise<void> {
		await this.transport.connect((event) => this.handle(event));
	}

	async stop(): Promise<void> {
		this.transport.close();
	}

	private async handle(event: FeishuMessage): Promise<void> {
		const { sender, message } = event;
		if (sender.sender_type !== 'user') return;
		// Owner and allow-list are people. A group stands for everyone in it, so a
		// group is no owner, and only private chats are answered.
		if (message.chat_type !== 'p2p') return;

		let text: string | undefined;
		try {
			text = (JSON.parse(message.content) as { text?: unknown }).text as string | undefined;
		} catch {
			text = undefined;
		}
		if (message.message_type !== 'text' || typeof text !== 'string' || !text.trim()) {
			if (message.message_type !== 'text') {
				await this.send(message.chat_id, '我现在只看得懂文字消息。').catch(() => {});
			}
			return;
		}

		const person = sender.sender_id?.open_id;
		const owners = this.options.owners;
		if (owners) {
			if (!person) return;
			const admission = owners.check(this.id, person);
			if (admission === 'denied') {
				await this.send(message.chat_id, '这台机器人已经有主人了，不能再接受别人指挥。').catch(() => {});
				return;
			}
			if (admission === 'claimed') {
				console.log(`[feishu] ${person} is now the owner of this bot`);
				await this.send(message.chat_id, '好，从现在起我归你了。直接跟我说话就行，比如「10 分钟后提醒我关火」。').catch(() => {});
			}
		}

		await this.options.onMessage({
			source: `feishu:${message.chat_id}`,
			sourceKey: message.message_id,
			channel: this.id,
			target: message.chat_id,
			text,
		});
	}

	async send(target: string, text: string): Promise<void> {
		for (const part of chunk(text)) {
			await this.transport.sendText(target, part);
		}
	}
}
