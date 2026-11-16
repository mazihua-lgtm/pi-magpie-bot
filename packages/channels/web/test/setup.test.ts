import { afterEach, describe, expect, it } from 'vitest';
import { serveSetupPage, setupPage } from '../src/setup.ts';

const urls: string[] = [];
const servers: Array<{ close: (callback: () => void) => void }> = [];

afterEach(async () => {
	for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
	urls.length = 0;
});

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
		const url = await serveSetupPage({ title: '还不能聊天', reason: '没有模型', steps: [], port: 0 });
		urls.push(url);

		const page = await fetch(url);
		expect(page.status).toBe(200);
		expect(await page.text()).toContain('还不能聊天');

		const health = await fetch(`${url}/healthz`);
		expect(health.status).toBe(200);
		expect(await health.json()).toEqual({ ok: false, reason: 'no model' });
	});
});
