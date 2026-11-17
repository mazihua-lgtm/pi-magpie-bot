import { afterEach, describe, expect, it } from 'vitest';
import { connect } from 'node:net';
import { WebChannel } from '../src/index.ts';

const servers: WebChannel[] = [];

const start = async (options: { password?: string; secret?: { get(): string | undefined; set(value: string): void }; history?: (target: string) => Promise<Array<{ role: 'me' | 'bot'; text: string }>> } = {}) => {
	const messages: { target: string; text: string }[] = [];
	const channel = new WebChannel({
		port: 0,
		...options,
		onMessage: (event) => {
			messages.push({ target: event.target, text: event.text });
		},
	});
	const { url } = await channel.start();
	servers.push(channel);
	return { channel, url, messages };
};

afterEach(async () => {
	for (const server of servers.splice(0)) await server.stop();
});

describe('web channel', () => {
	it('takes a message and hands it to the bot', async () => {
		const { url, messages } = await start();
		const response = await fetch(`${url}/api/message`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ text: '你好' }),
		});

		expect(response.status).toBe(202);
		expect(messages).toHaveLength(1);
		expect(messages[0]?.text).toBe('你好');
	});

	it('refuses an empty message', async () => {
		const { url } = await start();
		const response = await fetch(`${url}/api/message`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ text: '   ' }),
		});
		expect(response.status).toBe(400);
	});

	it('keeps the answers for a tab that is not open yet', async () => {
		const { channel, url } = await start();
		const page = await fetch(`${url}/`);
		expect(page.status).toBe(200);
		expect(await page.text()).toContain('我的助理');

		// No cookie means a fresh session; find the one the server minted.
		const cookie = page.headers.get('set-cookie')?.split(';')[0] ?? '';
		const session = cookie.slice(cookie.indexOf('=') + 1);

		await channel.send(session, '晚点才看到的话');
		const events = await fetch(`${url}/api/events`, { headers: { cookie } });
		const reader = events.body?.getReader();
		const decoder = new TextDecoder();
		let seen = '';
		// The stream opens with a comment line; the buffered answer follows.
		for (let i = 0; i < 5 && !seen.includes('晚点才看到的话'); i++) {
			const chunk = await reader?.read();
			if (!chunk?.value) break;
			seen += decoder.decode(chunk.value, { stream: true });
		}
		await reader?.cancel();
		expect(seen).toContain('晚点才看到的话');
	});

	it('shows a reopened tab what was said, from the transcript', async () => {
		const { url } = await start({
			history: async () => [
				{ role: 'me', text: '我明天去济南' },
				{ role: 'bot', text: '记下了' },
			],
		});
		const page = await fetch(`${url}/`);
		const cookie = page.headers.get('set-cookie')?.split(';')[0] ?? '';

		const events = await fetch(`${url}/api/events`, { headers: { cookie } });
		const reader = events.body?.getReader();
		const decoder = new TextDecoder();
		let seen = '';
		for (let i = 0; i < 5 && !seen.includes('记下了'); i++) {
			const chunk = await reader?.read();
			if (!chunk?.value) break;
			seen += decoder.decode(chunk.value, { stream: true });
		}
		await reader?.cancel();
		expect(seen).toContain('我明天去济南');
		expect(seen).toContain('"role":"me"');
	});

	it('keeps a notice the transcript never had', async () => {
		const { channel, url } = await start({
			history: async () => [
				{ role: 'me', text: '我明天去济南' },
				{ role: 'bot', text: '记下了' },
			],
		});
		const page = await fetch(`${url}/`);
		const cookie = page.headers.get('set-cookie')?.split(';')[0] ?? '';
		const session = cookie.slice(cookie.indexOf('=') + 1);

		// One answer the transcript already has, and one crash notice it never
		// will: the notice only lives in the outbox and the buffer.
		await channel.send(session, '记下了');
		await channel.send(session, '刚才那条消息处理到一半中断了，我没能回上来。麻烦再说一次。');

		const events = await fetch(`${url}/api/events`, { headers: { cookie } });
		const reader = events.body?.getReader();
		const decoder = new TextDecoder();
		let seen = '';
		for (let i = 0; i < 10 && !seen.includes('中断了'); i++) {
			const chunk = await reader?.read();
			if (!chunk?.value) break;
			seen += decoder.decode(chunk.value, { stream: true });
		}
		await reader?.cancel();
		expect(seen).toContain('中断了');
		expect(seen.match(/"text":"记下了"/g)).toHaveLength(1);
	});

	it('ships a chat page whose script parses', async () => {
		const { url } = await start();
		const page = await (await fetch(`${url}/`)).text();
		const script = page.slice(page.indexOf('<script>') + 8, page.lastIndexOf('</script>'));

		// The page is one long template literal, so a stray escape can turn the
		// whole script into a syntax error and leave a blank window. Parsing it
		// here is the only thing that notices.
		expect(() => new Function(script)).not.toThrow();
	});

	it('answers a junk request line instead of failing it', async () => {
		const { url } = await start();
		const { hostname, port } = new URL(url);

		// fetch cannot send a broken request line, so go at the socket. "//" is
		// what a bare `curl //` produces, and it used to become a 500 in the log.
		const reply = await new Promise<string>((resolve, reject) => {
			const socket = connect(Number(port), hostname, () => {
				socket.write('GET // HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
			});
			let data = '';
			socket.on('data', (chunk) => {
				data += chunk;
			});
			socket.on('end', () => resolve(data));
			socket.on('error', reject);
		});

		expect(reply.startsWith('HTTP/1.1 400')).toBe(true);
	});

	it('refuses a post that is not JSON', async () => {
		const { url, messages } = await start();
		const response = await fetch(`${url}/api/message`, {
			method: 'POST',
			headers: { 'content-type': 'text/plain' },
			body: JSON.stringify({ text: 'hi' }),
		});
		expect(response.status).toBe(415);
		expect(messages).toHaveLength(0);
	});

	it('refuses a request that names another host when there is no password and it listens locally', async () => {
		const { url } = await start();
		const { port } = new URL(url);
		const reply = await new Promise<string>((resolve) => {
			const socket = connect(Number(port), '127.0.0.1', () => {
				socket.write('GET / HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n');
			});
			let data = '';
			socket.on('data', (chunk) => (data += chunk));
			socket.on('close', () => resolve(data));
		});
		expect(reply.startsWith('HTTP/1.1 421')).toBe(true);
	});

	it('stops a password guesser after ten misses', async () => {
		const { url } = await start({ password: 'hunter2' });
		const guess = () =>
			fetch(`${url}/api/login`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ password: 'nope' }),
			});
		for (let i = 0; i < 10; i++) expect((await guess()).status).toBe(401);
		expect((await guess()).status).toBe(429);
	});

	it('asks for a password when one is set', async () => {
		const { url, messages } = await start({ password: 'hunter2' });

		const locked = await fetch(`${url}/api/message`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ text: 'hi' }),
		});
		expect(locked.status).toBe(401);

		const wrong = await fetch(`${url}/api/login`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ password: 'nope' }),
		});
		expect(wrong.status).toBe(401);

		const page = await fetch(`${url}/`);
		const cookie = page.headers.get('set-cookie')?.split(';')[0] ?? '';
		const good = await fetch(`${url}/api/login`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', cookie },
			body: JSON.stringify({ password: 'hunter2' }),
		});
		expect(good.status).toBe(200);
		const auth = good.headers.get('set-cookie')?.split(';')[0] ?? '';

		const accepted = await fetch(`${url}/api/message`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', cookie: `${cookie}; ${auth}` },
			body: JSON.stringify({ text: 'hi' }),
		});
		expect(accepted.status).toBe(202);
		expect(messages).toHaveLength(1);
	});
});

describe('installing the page on a phone', () => {
	it('serves a manifest whose icons are really there', async () => {
		const { url } = await start();
		const response = await fetch(`${url}/manifest.webmanifest`);
		expect(response.headers.get('content-type')).toContain('manifest+json');
		const manifest = (await response.json()) as { name: string; display: string; icons: Array<{ src: string; sizes: string }> };

		expect(manifest.display).toBe('standalone');
		expect(manifest.icons.map((icon) => icon.sizes)).toEqual(['192x192', '512x512']);
		for (const icon of manifest.icons) {
			const file = await fetch(`${url}${icon.src}`);
			expect(file.status).toBe(200);
			expect(file.headers.get('content-type')).toBe('image/png');
			expect((await file.arrayBuffer()).byteLength).toBeGreaterThan(2000);
		}
	});

	it('serves the service worker Android asks for, without caching anything', async () => {
		const { url } = await start();
		const response = await fetch(`${url}/sw.js`);
		expect(response.status).toBe(200);
		const source = await response.text();
		// A stale page would answer for the assistant; the handler stays empty.
		expect(source).toContain("addEventListener('fetch'");
		expect(source).not.toContain('caches');
	});

	it('links the manifest and registers the worker from the chat page', async () => {
		const { url } = await start();
		const page = await (await fetch(`${url}/`)).text();
		expect(page).toContain('rel="manifest" href="/manifest.webmanifest"');
		expect(page).toContain('apple-touch-icon');
		expect(page).toContain("navigator.serviceWorker.register('/sw.js')");
	});
});

describe('the cookie secret', () => {
	it('is reused from the store instead of signing everyone out at restart', async () => {
		let stored: string | undefined;
		const secretStore = {
			get: () => stored,
			set: (value: string) => {
				stored = value;
			},
		};
		const first = await start({ password: 'pw', secret: secretStore });
		expect(stored).toMatch(/^[0-9a-f]{64}$/);

		// A "restart": a new channel, same store. The session cookie the first
		// one minted must still be accepted by the second.
		// The browser holds sid (from the page) and auth (from logging in).
		const page = await fetch(`${first.url}/`);
		const sid = page.headers.get('set-cookie')?.split(';')[0] ?? '';
		const login = await fetch(`${first.url}/api/login`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', cookie: sid },
			body: JSON.stringify({ password: 'pw' }),
		});
		const auth = login.headers.getSetCookie().map((line) => line.split(';')[0])[0] ?? '';
		const cookie = `${sid}; ${auth}`;

		// A "restart": a new channel, same store. The session cookie the first
		// one minted must still be accepted by the second.
		const second = await start({ password: 'pw', secret: secretStore });
		const again = await fetch(`${second.url}/api/message`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', cookie },
			body: JSON.stringify({ text: '重启后还在' }),
		});
		expect(again.status).toBe(202);
	});
});
