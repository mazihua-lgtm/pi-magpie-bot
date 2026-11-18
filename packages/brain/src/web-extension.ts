import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { defineExtension, defineTool, type Extension } from '@earendil-works/pi-durable';
import { obj, str } from '@earendil-works/pi-schema';
import { charsetOf, parseBingResults, readableText } from './web-parse.ts';

/** A tool's answer, as the transcript stores it. */
const reply = (text: string, isError = false) => ({
	output: [{ type: 'text' as const, text }],
	...(isError ? { isError: true } : {}),
});

/** A phone browser's, so the search page answers as it would to a person. */
const USER_AGENT =
	'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';

/** How much of a page goes back to the model. */
const MAX_TEXT = 15_000;
/** How much of a response is read at all: a page is not a download. */
const MAX_BYTES = 3 * 1024 * 1024;

export interface WebExtensionOptions {
	/** Injected by tests; the real one is the global fetch. */
	fetch?: typeof fetch;
	/** Injected by tests, so no name is really resolved. */
	lookup?: (hostname: string) => Promise<string[]>;
	timeoutMs?: number;
}

/** This machine, its network, and the cloud metadata endpoints, in IPv4. */
function isPrivateV4(ip: string): boolean {
	const [a = 0, b = 0] = ip.split('.').map(Number);
	return (
		a === 0 ||
		a === 10 ||
		a === 127 ||
		(a === 100 && b >= 64 && b <= 127) ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168) ||
		(a === 198 && (b === 18 || b === 19)) ||
		a >= 224
	);
}

/**
 * The IPv4 an IPv6 address carries, when it carries one: `::ffff:127.0.0.1`,
 * `::ffff:7f00:1` and `0:0:0:0:0:ffff:7f00:1` are the same address written
 * three ways, and a check that only reads the dotted one lets the rest through.
 */
function embeddedV4(ip: string): string | undefined {
	const [head = '', tail] = ip.split('::');
	const parts = (text: string) => (text === '' ? [] : text.split(':'));
	let left = parts(head);
	let right = tail === undefined ? [] : parts(tail);
	// A trailing dotted quad is two 16-bit groups written as four numbers.
	const last = (tail === undefined ? left : right).at(-1) ?? '';
	if (last.includes('.')) {
		const bytes = last.split('.').map(Number);
		if (bytes.length !== 4 || bytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) return undefined;
		const pair = [((bytes[0]! << 8) | bytes[1]!).toString(16), ((bytes[2]! << 8) | bytes[3]!).toString(16)];
		if (tail === undefined) left = [...left.slice(0, -1), ...pair];
		else right = [...right.slice(0, -1), ...pair];
	}
	const fill = 8 - left.length - right.length;
	if (fill < 0 || (tail === undefined && fill !== 0)) return undefined;
	const words = [...left, ...(Array<string>(fill).fill('0') as string[]), ...right].map((part) =>
		/^[0-9a-f]{1,4}$/.test(part) ? Number.parseInt(part, 16) : Number.NaN,
	);
	if (words.length !== 8 || words.some((word) => Number.isNaN(word))) return undefined;
	// `::a.b.c.d` and `::ffff:a.b.c.d` are IPv4 in disguise; anything else is not.
	const leading = words.slice(0, 5).every((word) => word === 0);
	if (!leading || (words[5] !== 0 && words[5] !== 0xffff)) return undefined;
	return [words[6]! >> 8, words[6]! & 255, words[7]! >> 8, words[7]! & 255].join('.');
}

/**
 * Addresses a page fetched for the model must never be: this machine, its
 * network, and the cloud metadata endpoints. A model told to "open" one could
 * otherwise read the gateway, the router's admin page, or the bot's own API.
 */
export function isPrivateAddress(address: string): boolean {
	const ip = address.replace(/^\[|\]$/g, '').toLowerCase();
	if (isIP(ip) === 4) return isPrivateV4(ip);
	if (isIP(ip) !== 6) return false;
	const v4 = embeddedV4(ip);
	if (v4) return isPrivateV4(v4);
	// ::, ::1, fe80::/10 and fc00::/7 with the IPv4 forms already taken out.
	return ip === '::' || ip === '::1' || /^(fe[89ab]|f[cd])/.test(ip);
}

/** Why this address may not be fetched, or undefined when it may. */
async function refusal(url: URL, lookup: (hostname: string) => Promise<string[]>): Promise<string | undefined> {
	if (url.protocol !== 'http:' && url.protocol !== 'https:') return '只能打开 http 或 https 网页';
	const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
	if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
		return '不能打开本机或内网地址';
	}
	if (isIP(host)) return isPrivateAddress(host) ? '不能打开本机或内网地址' : undefined;
	let addresses: string[];
	try {
		addresses = await lookup(host);
	} catch {
		return `找不到这个网站：${host}`;
	}
	if (addresses.length === 0) return `找不到这个网站：${host}`;
	return addresses.some(isPrivateAddress) ? '这个网址指向本机或内网，不能打开' : undefined;
}

async function readCapped(response: Response): Promise<Uint8Array> {
	const reader = response.body?.getReader();
	if (!reader) return new Uint8Array();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done || !value) break;
		chunks.push(value);
		size += value.length;
		if (size >= MAX_BYTES) {
			await reader.cancel().catch(() => {});
			break;
		}
	}
	const out = new Uint8Array(Math.min(size, MAX_BYTES));
	let at = 0;
	for (const chunk of chunks) {
		const room = out.length - at;
		if (room <= 0) break;
		out.set(chunk.subarray(0, room), at);
		at += Math.min(chunk.length, room);
	}
	return out;
}

function decode(bytes: Uint8Array, charset: string): string {
	try {
		return new TextDecoder(charset).decode(bytes);
	} catch {
		// A charset this Node does not know (a build without full ICU): the
		// words may come out garbled, but the page still comes back.
		return new TextDecoder('utf-8').decode(bytes);
	}
}

/**
 * Real-time web search and page reading, with no key. The search goes to
 * Bing's China site, which the phones this runs on can reach; its results page
 * is read like a person would read it.
 */
export function createWebExtension(options: WebExtensionOptions = {}): Extension {
	const fetchFn = options.fetch ?? fetch;
	const lookup = options.lookup ?? (async (hostname: string) => (await dnsLookup(hostname, { all: true })).map((entry) => entry.address));
	const timeoutMs = options.timeoutMs ?? 20_000;
	const headers = {
		'user-agent': USER_AGENT,
		accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
		'accept-language': 'zh-CN,zh;q=0.9,en;q=0.6',
	};

	return defineExtension({
		name: 'web',
		tools: [
			defineTool({
				name: 'web_search',
				description:
					'Search the web for current information: news, prices, weather, opening hours, schedules, anything that may have changed since you were trained. Returns titles, links and snippets; open a link with web_fetch for the full text.',
				parameters: obj({ query: str({ description: 'What to search for, in the words a person would type.' }) }),
				async execute(args) {
					const query = args.query.trim();
					if (!query) return reply('搜索词是空的', true);
					const url = `https://cn.bing.com/search?q=${encodeURIComponent(query)}&ensearch=0`;
					let html: string;
					try {
						const response = await fetchFn(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
						if (!response.ok) return reply(`搜索失败：搜索服务返回 ${response.status}`, true);
						const bytes = await readCapped(response);
						html = decode(bytes, charsetOf(response.headers.get('content-type'), bytes));
					} catch (error) {
						return reply(`搜索失败：连不上搜索服务（${(error as Error).message}）`, true);
					}
					const results = parseBingResults(html, 8);
					if (results.length === 0) return reply(`没有搜到「${query}」的结果（也可能是搜索页改版了，换个说法再试）`);
					return reply(results.map((result, index) => `${index + 1}. ${result.title}\n${result.url}\n${result.snippet}`).join('\n\n'));
				},
			}),
			defineTool({
				name: 'web_fetch',
				description: 'Open a web page and read its text (scripts, menus and footers left out), with its title. Only public http(s) pages.',
				parameters: obj({ url: str({ description: 'The full address, starting with http:// or https://.' }) }),
				async execute(args) {
					let url: URL;
					try {
						url = new URL(args.url.trim());
					} catch {
						return reply('这不是一个网址', true);
					}
					// Redirects are followed by hand, so every hop is checked: a public
					// page that redirects to 127.0.0.1 is the classic way around a check.
					let response: Response | undefined;
					try {
						for (let hop = 0; hop < 5; hop++) {
							const refused = await refusal(url, lookup);
							if (refused) return reply(refused, true);
							response = await fetchFn(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
							const location = response.headers.get('location');
							if (response.status >= 300 && response.status < 400 && location) {
								await response.body?.cancel().catch(() => {});
								url = new URL(location, url);
								response = undefined;
								continue;
							}
							break;
						}
					} catch (error) {
						return reply(`打不开这个网页：${(error as Error).message}`, true);
					}
					if (!response) return reply('打不开这个网页：跳转太多次', true);
					if (!response.ok) return reply(`打不开这个网页：网站返回 ${response.status}`, true);

					const type = (response.headers.get('content-type') ?? '').toLowerCase();
					const textual = type === '' || type.includes('html') || type.includes('xml') || type.startsWith('text/') || type.includes('json');
					if (!textual) {
						await response.body?.cancel().catch(() => {});
						return reply(`这不是网页（${type.split(';')[0]}），读不了`, true);
					}
					let body: string;
					try {
						const bytes = await readCapped(response);
						body = decode(bytes, charsetOf(response.headers.get('content-type'), bytes));
					} catch (error) {
						return reply(`读网页时断了：${(error as Error).message}`, true);
					}
					const page = type.includes('html') || /<html|<body/i.test(body.slice(0, 2000)) ? readableText(body) : { title: '', text: body.trim() };
					const text = page.text.length > MAX_TEXT ? `${page.text.slice(0, MAX_TEXT)}\n…（后面还有，已截断）` : page.text;
					return reply(`标题：${page.title || '（无）'}\n地址：${url.href}\n\n${text || '（这个网页没有可读的文字，可能要靠脚本才显示）'}`);
				},
			}),
		],
	});
}
