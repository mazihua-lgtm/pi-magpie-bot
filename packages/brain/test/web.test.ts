import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolRegistration } from '@earendil-works/pi-durable';
import { describe, expect, it } from 'vitest';
import { createWebExtension, isPrivateAddress } from '../src/web-extension.ts';
import { charsetOf, decodeEntities, parseBingResults, readableText, unwrapBingUrl } from '../src/web-parse.ts';

const fixture = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');

describe('reading a Bing results page', () => {
	it('reads the results of a real cn.bing.com page, heading links and all', () => {
		// Saved from cn.bing.com: the heading there is `<a href><h2>`, not `<h2><a>`.
		const results = parseBingResults(fixture('bing-cn.html'));
		expect(results.length).toBe(5);
		expect(results[0]).toEqual({
			title: '寿光市_百度百科',
			url: 'https://baike.baidu.com/item/%E5%AF%BF%E5%85%89%E5%B8%82/2445802',
			snippet: expect.stringContaining('寿光市，山东省辖县级市'),
		});
		expect(results[3]?.url).toBe('https://api.map.baidu.com/geocoder?address=%E5%AF%BF%E5%85%89%E5%B8%82&output=html');
		for (const result of results) {
			expect(result.url).toMatch(/^https:\/\//);
			expect(result.title).not.toMatch(/[<>]/);
			expect(result.snippet).not.toMatch(/[<>]/);
		}
	});

	it('reads the classic layout, unwraps the click tracker, skips ads, duplicates and junk links', () => {
		const results = parseBingResults(fixture('bing-classic.html'));
		expect(results).toEqual([
			{ title: '寿光天气预报 - Example Weather', url: 'https://example.com/weather?city=shouguang', snippet: '今天多云，12~20℃，东北风 3 级。' },
			{ title: '寿光 7 天天气', url: 'https://weather.example.cn/101120609.shtml', snippet: '未来一周以晴为主 …' },
		]);
	});

	it('stops at the limit, and gives nothing for a page that is not a results page', () => {
		expect(parseBingResults(fixture('bing-cn.html'), 2)).toHaveLength(2);
		expect(parseBingResults('<html><body>验证码</body></html>')).toEqual([]);
		expect(parseBingResults('')).toEqual([]);
	});

	it('leaves an ordinary link alone and a broken tracker link as it is', () => {
		expect(unwrapBingUrl('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
		expect(unwrapBingUrl('https://www.bing.com/ck/a?u=zzz')).toBe('https://www.bing.com/ck/a?u=zzz');
	});

	it('decodes the entities pages use', () => {
		expect(decodeEntities('a &amp; b &lt;c&gt; &#x4f60;&#22909; &nbsp;&hellip; &unknown;')).toBe('a & b <c> 你好  … &unknown;');
	});
});

describe('reading a page', () => {
	it('keeps the article and its title, and drops scripts, styles, menus, sidebars, footers and comments', () => {
		const page = readableText(fixture('article.html'));
		expect(page.title).toBe('寿光蔬菜博览会开幕 & 今年的新品种 - 示例新闻网');
		expect(page.text).toContain('第二十七届中国（寿光）国际蔬菜科技博览会今天开幕');
		expect(page.text).toContain('“水果黄瓜”最受欢迎，价格每斤 3.5 元');
		expect(page.text).toContain('门票：50 元');
		for (const absent of ['不该出现的脚本文字', 'color: red', '首页', '侧栏里的无关链接', '注释里的字', '请打开脚本', '版权所有']) {
			expect(page.text).not.toContain(absent);
		}
		// One paragraph per line, not one wall of text.
		expect(page.text.split('\n').length).toBeGreaterThan(4);
	});

	it('takes the whole body when there is no article', () => {
		const page = readableText('<html><head><title>T</title></head><body><div>一</div><div>二</div></body></html>');
		expect(page).toEqual({ title: 'T', text: '一\n二' });
	});

	it('finds the charset in the header first, then in the page', () => {
		expect(charsetOf('text/html; charset=GBK', new Uint8Array())).toBe('gbk');
		expect(charsetOf('text/html', new TextEncoder().encode('<meta charset="gb2312">'))).toBe('gb2312');
		expect(charsetOf(null, new Uint8Array())).toBe('utf-8');
	});
});

describe('which addresses a page may come from', () => {
	it('refuses this machine and private networks, and allows the public internet', () => {
		for (const address of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) {
			expect(isPrivateAddress(address), address).toBe(true);
		}
		for (const address of ['8.8.8.8', '223.5.5.5', '172.32.0.1', '2400:3200::1']) {
			expect(isPrivateAddress(address), address).toBe(false);
		}
	});

	it('reads the IPv4 written into an IPv6, however it is written', () => {
		// The same three addresses as above, in the hex forms a URL may carry:
		// ::ffff:7f00:1 is 127.0.0.1, ::ffff:a9fe:a9fe is 169.254.169.254.
		for (const address of [
			'::ffff:7f00:1',
			'::ffff:7F00:1',
			'0:0:0:0:0:ffff:7f00:1',
			'::ffff:a9fe:a9fe',
			'::ffff:c0a8:101',
			'::ffff:a00:1',
			'::7f00:1',
		]) {
			expect(isPrivateAddress(address), address).toBe(true);
		}
		for (const address of ['::ffff:808:808', '0:0:0:0:0:ffff:808:808', '2606:4700::1111']) {
			expect(isPrivateAddress(address), address).toBe(false);
		}
	});
});

/** A tool of the extension, run as the harness would, with a fake network behind it. */
function tool(name: string, routes: Record<string, () => Response>, addresses: Record<string, string[]> = {}) {
	const requested: string[] = [];
	const extension = createWebExtension({
		fetch: (async (input: string | URL | Request) => {
			const url = String(input);
			requested.push(url);
			const route = routes[url];
			if (!route) throw new Error(`no route for ${url}`);
			return route();
		}) as typeof fetch,
		lookup: async (hostname) => addresses[hostname] ?? ['93.184.216.34'],
	});
	const found = extension.tools?.find((entry) => entry.name === name) as ToolRegistration | undefined;
	if (!found) throw new Error(`no tool ${name}`);
	const run = async (args: Record<string, unknown>) => {
		const result = (await found.execute(args as never, {} as never, {} as never)) as { output: Array<{ text: string }>; isError?: boolean };
		return { text: result.output.map((part) => part.text).join(''), isError: Boolean(result.isError) };
	};
	return { run, requested };
}

const html = (body: string, headers: Record<string, string> = {}) => () =>
	new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', ...headers } });

describe('web_search', () => {
	it('asks cn.bing.com and lists the results', async () => {
		const url = `https://cn.bing.com/search?q=${encodeURIComponent('寿光天气')}&ensearch=0`;
		const { run, requested } = tool('web_search', { [url]: html(fixture('bing-cn.html')) });
		const result = await run({ query: '寿光天气' });
		expect(requested).toEqual([url]);
		expect(result.isError).toBe(false);
		expect(result.text).toContain('1. 寿光市_百度百科\nhttps://baike.baidu.com/item/');
		expect(result.text).toContain('5. ');
	});

	it('says plainly when the search cannot be reached or finds nothing', async () => {
		const down = tool('web_search', {});
		const failed = await down.run({ query: 'x' });
		expect(failed.isError).toBe(true);
		expect(failed.text).toContain('搜索失败');

		const empty = tool('web_search', { 'https://cn.bing.com/search?q=x&ensearch=0': html('<html></html>') });
		expect((await empty.run({ query: 'x' })).text).toContain('没有搜到');
	});
});

describe('web_fetch', () => {
	it('returns the title and the readable text', async () => {
		const { run } = tool('web_fetch', { 'https://news.example/a': html(fixture('article.html')) });
		const result = await run({ url: 'https://news.example/a' });
		expect(result.isError).toBe(false);
		expect(result.text).toMatch(/^标题：寿光蔬菜博览会开幕/);
		expect(result.text).toContain('地址：https://news.example/a');
		expect(result.text).toContain('主办方说');
		expect(result.text).not.toContain('不该出现的脚本文字');
	});

	it('cuts a long page short', async () => {
		const long = `<html><body><p>${'字'.repeat(40_000)}</p></body></html>`;
		const { run } = tool('web_fetch', { 'https://long.example/': html(long) });
		const result = await run({ url: 'https://long.example/' });
		expect(result.text.length).toBeLessThan(15_200);
		expect(result.text).toContain('已截断');
	});

	it('reads a page in GBK', async () => {
		const bytes = Buffer.from('3c68746d6c3e3c626f64793e3c703ec4e3bac33c2f703e3c2f626f64793e3c2f68746d6c3e', 'hex'); // <p>你好</p> in GBK
		const { run } = tool('web_fetch', { 'https://gbk.example/': () => new Response(bytes, { headers: { 'content-type': 'text/html; charset=gbk' } }) });
		expect((await run({ url: 'https://gbk.example/' })).text).toContain('你好');
	});

	it('refuses other schemes, this machine, private networks, and names that resolve there', async () => {
		const { run, requested } = tool('web_fetch', {}, { 'router.example': ['192.168.1.1'] });
		for (const url of ['file:///etc/passwd', 'ftp://example.com/', 'http://localhost:8787/api/chats', 'http://127.0.0.1:3425/v1/models', 'http://[::1]/', 'http://169.254.169.254/latest/meta-data', 'http://router.example/admin', 'not a url']) {
			const result = await run({ url });
			expect(result.isError, url).toBe(true);
		}
		expect(requested).toEqual([]);
	});

	it('refuses this machine written as an IPv6, and never asks for the page', async () => {
		const { run, requested } = tool('web_fetch', {});
		for (const url of ['http://[::ffff:7f00:1]:8787/api/chats', 'http://[0:0:0:0:0:ffff:7f00:1]/', 'http://[::ffff:a9fe:a9fe]/latest/meta-data', 'http://[::7f00:1]/']) {
			const result = await run({ url });
			expect(result.isError, url).toBe(true);
			expect(result.text, url).toContain('本机');
		}
		expect(requested).toEqual([]);
	});

	it('checks every redirect, so a public page cannot bounce it to this machine', async () => {
		const { run, requested } = tool('web_fetch', {
			'https://public.example/go': () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:8787/api/memory' } }),
		});
		const result = await run({ url: 'https://public.example/go' });
		expect(result.isError).toBe(true);
		expect(result.text).toContain('本机');
		expect(requested).toEqual(['https://public.example/go']);
	});

	it('follows a redirect to another public page', async () => {
		const { run } = tool('web_fetch', {
			'https://a.example/': () => new Response(null, { status: 301, headers: { location: '/b' } }),
			'https://a.example/b': html('<html><head><title>B</title></head><body><p>到了</p></body></html>'),
		});
		const result = await run({ url: 'https://a.example/' });
		expect(result.text).toContain('标题：B');
		expect(result.text).toContain('到了');
	});

	it('does not read what is not a page', async () => {
		const { run } = tool('web_fetch', { 'https://img.example/a.png': () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } }) });
		const result = await run({ url: 'https://img.example/a.png' });
		expect(result.isError).toBe(true);
		expect(result.text).toContain('image/png');
	});
});
