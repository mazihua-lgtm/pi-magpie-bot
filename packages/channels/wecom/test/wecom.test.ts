import { describe, expect, it } from 'vitest';
import { Owners, Settings, openHostDb } from '@pi-magpie-bot/events';
import { WecomChannel, type WecomMessage, type WecomTransport } from '../src/index.ts';

const fake = () => {
	const sent: Array<{ userid: string; text: string }> = [];
	let deliver: (message: WecomMessage) => Promise<void> = async () => {};
	let closed = false;
	const transport: WecomTransport = {
		connect: (handler) => {
			deliver = handler;
		},
		close: () => {
			closed = true;
		},
		sendMarkdown: async (userid, text) => {
			sent.push({ userid, text });
		},
	};
	return { transport, sent, deliver: (message: WecomMessage) => deliver(message), isClosed: () => closed };
};

const text = (value: string, extra: Partial<WecomMessage> = {}): WecomMessage => ({
	msgid: 'm1',
	chattype: 'single',
	userid: 'zhangsan',
	msgtype: 'text',
	text: value,
	...extra,
});

const open = (owners?: Owners) => {
	const parts = fake();
	const got: Array<{ source: string; sourceKey: string; target: string; text: string }> = [];
	const channel = new WecomChannel({
		botId: 'a',
		secret: 'b',
		owners,
		transport: parts.transport,
		onMessage: (event) => {
			got.push(event);
		},
	});
	channel.start();
	return { ...parts, got, channel };
};

describe('wecom channel', () => {
	it('hands a private text message to the bot, keyed by the platform message id', async () => {
		const { deliver, got } = open();
		await deliver(text('你好'));
		expect(got).toEqual([{ source: 'wecom:zhangsan', sourceKey: 'm1', channel: 'wecom', target: 'zhangsan', text: '你好' }]);
	});

	it('takes what a voice message was transcribed to', async () => {
		const { deliver, got } = open();
		await deliver(text('十分钟后提醒我关火', { msgtype: 'voice' }));
		expect(got.map((event) => event.text)).toEqual(['十分钟后提醒我关火']);
	});

	it('ignores groups', async () => {
		const { deliver, got, sent } = open();
		await deliver(text('hi', { chattype: 'group' }));
		expect(got).toHaveLength(0);
		expect(sent).toHaveLength(0);
	});

	it('says it only reads text and voice when sent a picture, and passes nothing on', async () => {
		const { deliver, got, sent } = open();
		await deliver(text('', { msgtype: 'image', text: undefined }));
		expect(got).toHaveLength(0);
		expect(sent).toHaveLength(1);
	});

	it('gives the bot to the first person and refuses the rest', async () => {
		const db = openHostDb(':memory:');
		const { deliver, got, sent } = open(new Owners(new Settings(db)));
		await deliver(text('hi'));
		await deliver(text('hi', { msgid: 'm2', userid: 'lisi' }));
		expect(got.map((event) => event.target)).toEqual(['zhangsan']);
		expect(sent.map((message) => message.userid)).toEqual(['zhangsan', 'lisi']);
		db.close();
	});

	it('cuts a long answer into pieces without splitting a surrogate pair', async () => {
		const { channel, sent } = open();
		await channel.send('zhangsan', `${'a'.repeat(3999)}😀tail`);
		expect(sent.map((message) => message.text)).toEqual(['a'.repeat(3999), '😀tail']);
	});

	it('closes the connection on stop', async () => {
		const { channel, isClosed } = open();
		await channel.stop();
		expect(isClosed()).toBe(true);
	});
});
