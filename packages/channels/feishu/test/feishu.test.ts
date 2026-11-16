import { describe, expect, it } from 'vitest';
import { Owners, Settings, openHostDb } from '@pi-magpie-bot/events';
import { FeishuChannel, type FeishuMessage, type FeishuTransport } from '../src/index.ts';

const fake = () => {
	const sent: Array<{ chatId: string; text: string }> = [];
	let deliver: (event: FeishuMessage) => Promise<void> = async () => {};
	let closed = false;
	const transport: FeishuTransport = {
		connect: async (handler) => {
			deliver = handler;
		},
		close: () => {
			closed = true;
		},
		sendText: async (chatId, text) => {
			sent.push({ chatId, text });
		},
	};
	return { transport, sent, deliver: (event: FeishuMessage) => deliver(event), isClosed: () => closed };
};

const text = (value: string, extra: Partial<FeishuMessage['message']> = {}, open_id = 'ou_1'): FeishuMessage => ({
	sender: { sender_type: 'user', sender_id: { open_id } },
	message: {
		message_id: 'om_1',
		chat_id: 'oc_1',
		chat_type: 'p2p',
		message_type: 'text',
		content: JSON.stringify({ text: value }),
		...extra,
	},
});

const open = async (owners?: Owners) => {
	const parts = fake();
	const got: Array<{ source: string; sourceKey: string; target: string; text: string }> = [];
	const channel = new FeishuChannel({
		appId: 'a',
		appSecret: 'b',
		owners,
		transport: parts.transport,
		onMessage: (event) => {
			got.push(event);
		},
	});
	await channel.start();
	return { ...parts, got, channel };
};

describe('feishu channel', () => {
	it('hands a private text message to the bot, keyed by the platform message id', async () => {
		const { deliver, got } = await open();
		await deliver(text('你好'));
		expect(got).toEqual([
			{ source: 'feishu:oc_1', sourceKey: 'om_1', channel: 'feishu', target: 'oc_1', text: '你好' },
		]);
	});

	it('ignores groups and other bots', async () => {
		const { deliver, got, sent } = await open();
		await deliver(text('hi', { chat_type: 'group' }));
		await deliver({ ...text('hi'), sender: { sender_type: 'app' } });
		expect(got).toHaveLength(0);
		expect(sent).toHaveLength(0);
	});

	it('says it only reads text when sent a picture, and passes nothing on', async () => {
		const { deliver, got, sent } = await open();
		await deliver(text('', { message_type: 'image', content: '{"image_key":"k"}' }));
		expect(got).toHaveLength(0);
		expect(sent).toHaveLength(1);
	});

	it('gives the bot to the first person and refuses the rest', async () => {
		const db = openHostDb(':memory:');
		const { deliver, got, sent } = await open(new Owners(new Settings(db)));
		await deliver(text('hi', {}, 'ou_1'));
		await deliver(text('hi', { message_id: 'om_2', chat_id: 'oc_2' }, 'ou_2'));
		expect(got.map((event) => event.target)).toEqual(['oc_1']);
		expect(sent.map((message) => message.chatId)).toEqual(['oc_1', 'oc_2']);
		db.close();
	});

	it('cuts a long answer into pieces without splitting a surrogate pair', async () => {
		const { channel, sent } = await open();
		await channel.send('oc_1', `${'a'.repeat(3999)}😀tail`);
		expect(sent).toHaveLength(2);
		expect(sent[0]?.text).toBe('a'.repeat(3999));
		expect(sent[1]?.text).toBe('😀tail');
	});

	it('closes the connection on stop', async () => {
		const { channel, isClosed } = await open();
		await channel.stop();
		expect(isClosed()).toBe(true);
	});
});
