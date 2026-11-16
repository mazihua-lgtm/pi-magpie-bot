import { afterEach, describe, expect, it } from 'vitest';
import { serveSetupPage, setupPage } from '../src/setup.ts';

const servers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
	for (const server of servers.splice(0)) await server.close();
});

const serve = async (options: Parameters<typeof serveSetupPage>[0]) => {
	const handle = await serveSetupPage({ ...options, port: 0 });
	servers.push(handle);
	return handle;
};

const VENDORS = [
	{ id: 'deepseek', name: 'DeepSeek' },
	{ id: 'openai', name: 'OpenAI' },
];

describe('the first-run page', () => {
	it('says the commands that fix it, in order', () => {
		const page = setupPage({
			title: '还不能聊天',
			reason: '没有模型',
			steps: [{ command: 'magpie plugin login our-free-model', note: '在浏览器里打开它打印的地址' }],
		});
		expect(page).toContain('magpie plugin login our-free-model');
		expect(page.indexOf('magpie plugin')).toBeLessThan(page.indexOf('在浏览器里打开'));
	});

	it('never lets a command or a reason become markup', () => {
		const page = setupPage({
			title: '<script>alert(1)</script>',
			reason: '"模型" & <b>',
			steps: [{ command: 'echo "<script>"' }],
		});
		expect(page).not.toContain('<script>alert(1)</script>');
		expect(page).toContain('&lt;script&gt;');
		expect(page).toContain('&quot;模型&quot; &amp; &lt;b&gt;');
	});

	it('stays up and answers, so an orchestrated container can see why', async () => {
		const { url } = await serve({ title: '还不能聊天', reason: '没有模型', steps: [] });

		const page = await fetch(url);
		expect(page.status).toBe(200);
		expect(await page.text()).toContain('还不能聊天');

		const health = await fetch(`${url}/healthz`);
		expect(health.status).toBe(200);
		expect(await health.json()).toEqual({ ok: false, reason: 'no model' });
	});
});

describe('the key box', () => {
	const onKey = async () => undefined;

	it('links to where a key is got, and marks a link that earns the project something', () => {
		const page = setupPage({
			title: 't',
			reason: 'r',
			steps: [],
			onKey,
			presets: [
				{ id: 'a', name: 'Plain', signup: 'https://plain.example/keys' },
				{ id: 'b', name: 'Paid', signup: 'https://paid.example/?ref=x', sponsored: true },
			],
		});
		expect(page).toContain('data-signup="https://plain.example/keys"');
		expect(page).toMatch(/data-signup="https:\/\/paid\.example\/\?ref=x" data-sponsored="1"/);
		expect(page).toContain('含推广链接');
		expect(page).not.toMatch(/value="a"[^>]*data-sponsored/);
	});

	it('never puts anything but an https link into the page', () => {
		const page = setupPage({
			title: 't',
			reason: 'r',
			steps: [],
			onKey,
			presets: [{ id: 'a', name: 'Bad', signup: 'javascript:alert(1)' }],
		});
		expect(page).not.toContain('javascript:');
		expect(page).toContain('data-signup=""');
	});

	it('is left out when there is nowhere to save a key', () => {
		const page = setupPage({ title: '还不能聊天', reason: '没有模型', steps: [], presets: VENDORS });
		expect(page).not.toContain('name="key"');
	});

	it('takes a key, saves it, and lets the caller look again', async () => {
		const saved: Array<{ preset: string; key: string }> = [];
		const { url, fixed } = await serve({
			title: '还不能聊天',
			reason: '没有模型',
			steps: [],
			presets: VENDORS,
			onKey: async (input) => {
				saved.push(input);
				return undefined;
			},
		});
		expect(await (await fetch(url)).text()).toContain('name="key"');

		const response = await fetch(`${url}/api/setup/key`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ preset: 'deepseek', key: ' sk-test-123 ' }),
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true, note: '加进去了，正在启动，等几秒刷新这一页。' });
		expect(saved).toEqual([{ preset: 'deepseek', key: 'sk-test-123' }]);
		expect(await fixed).toBe(true);
	});

	it('refuses a key that was not posted as JSON from this page', async () => {
		const saved: unknown[] = [];
		const { url } = await serve({
			title: '还不能聊天',
			reason: '没有模型',
			steps: [],
			presets: VENDORS,
			onKey: async (input) => {
				saved.push(input);
				return undefined;
			},
		});
		const response = await fetch(`${url}/api/setup/key`, {
			method: 'POST',
			headers: { 'content-type': 'text/plain' },
			body: JSON.stringify({ preset: 'deepseek', key: 'sk-x' }),
		});
		expect(response.status).toBe(403);
		expect(saved).toEqual([]);
	});

	it('says what magpie said, and never the key, when a key is refused', async () => {
		const { url, fixed } = await serve({
			title: '还不能聊天',
			reason: '没有模型',
			steps: [],
			presets: VENDORS,
			onKey: async ({ key }) => {
				throw new Error(`magpie refused that key: sk-not-real (${key})`);
			},
		});

		const response = await fetch(`${url}/api/setup/key`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ preset: 'openai', key: 'sk-not-real' }),
		});

		expect(response.status).toBe(400);
		const body = (await response.json()) as { error: string };
		expect(body.error).toContain('refused');
		expect(body.error).not.toContain('sk-not-real');
		// The page is still up: a wrong key is answered, not a crash.
		expect((await fetch(url)).status).toBe(200);
		void fixed;
	});

	it('refuses a vendor it does not offer, and an empty key', async () => {
		const { url } = await serve({
			title: '还不能聊天',
			reason: '没有模型',
			steps: [],
			presets: VENDORS,
			onKey: async () => undefined,
		});
		const post = (body: unknown) =>
			fetch(`${url}/api/setup/key`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body),
			});

		expect((await post({ preset: 'nope', key: 'sk-1' })).status).toBe(400);
		expect((await post({ preset: 'deepseek', key: '   ' })).status).toBe(400);
	});

	it('asks for the password when one is set, and saves nothing without it', async () => {
		const saved: string[] = [];
		const { url } = await serve({
			title: 't',
			reason: 'r',
			steps: [],
			presets: VENDORS,
			password: 'open-sesame',
			onKey: async (input) => {
				saved.push(input.key);
				return undefined;
			},
		});
		expect(await (await fetch(url)).text()).toContain('name="password"');
		const post = (password?: string) =>
			fetch(`${url}/api/setup/key`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ preset: 'deepseek', key: 'sk-x', password }),
			});
		expect((await post()).status).toBe(401);
		expect((await post('nope')).status).toBe(401);
		expect(saved).toEqual([]);
		expect((await post('open-sesame')).status).toBe(200);
		expect(saved).toEqual(['sk-x']);
	});

	it('stops answering a password guessed wrong five times in a minute', async () => {
		const { url } = await serve({
			title: 't',
			reason: 'r',
			steps: [],
			presets: VENDORS,
			password: 'right',
			onKey: async () => undefined,
		});
		const post = (password: string) =>
			fetch(`${url}/api/setup/key`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ preset: 'deepseek', key: 'sk-x', password }),
			});
		for (let i = 0; i < 5; i += 1) expect((await post(`guess${i}`)).status).toBe(401);
		expect((await post('right')).status).toBe(429);
	});
});
