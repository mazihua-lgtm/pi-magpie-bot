/**
 * Reading HTML with regular expressions, on purpose: the phone payload runs
 * plain Node with no native modules, and a search result list or the words of
 * an article do not need a DOM. Everything here is tolerant - a page that does
 * not look as expected gives fewer results, never a throw.
 */

export interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

const NAMED: Record<string, string> = {
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'",
	nbsp: ' ',
	ensp: ' ',
	emsp: ' ',
	thinsp: ' ',
	hellip: '…',
	mdash: '—',
	ndash: '–',
	middot: '·',
	laquo: '«',
	raquo: '»',
	ldquo: '“',
	rdquo: '”',
	lsquo: '‘',
	rsquo: '’',
	copy: '©',
	reg: '®',
	trade: '™',
	yen: '¥',
	times: '×',
};

export function decodeEntities(text: string): string {
	return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
		if (name[0] === '#') {
			const code = name[1] === 'x' || name[1] === 'X' ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
			return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
		}
		return NAMED[name.toLowerCase()] ?? whole;
	});
}

/** Markup to one line of text. */
export function inlineText(html: string): string {
	return decodeEntities(html.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

/**
 * Bing sometimes links through its own click tracker:
 * `https://www.bing.com/ck/a?...&u=a1aHR0cHM6Ly9...`, where `u` is "a1" and the
 * real address in base64url. The address is what the model should see.
 */
export function unwrapBingUrl(href: string): string {
	try {
		const url = new URL(href, 'https://cn.bing.com');
		if (!/(^|\.)bing\.com$/.test(url.hostname) || !url.pathname.startsWith('/ck/')) return url.href;
		const u = url.searchParams.get('u');
		if (!u || !u.startsWith('a1')) return url.href;
		const decoded = Buffer.from(u.slice(2).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
		return /^https?:\/\//.test(decoded) ? decoded : url.href;
	} catch {
		return href;
	}
}

const hrefOf = (tag: string): string | undefined => /\shref\s*=\s*"([^"]*)"/i.exec(tag)?.[1] ?? /\shref\s*=\s*'([^']*)'/i.exec(tag)?.[1];

/**
 * The organic results of a Bing results page (cn.bing.com and www.bing.com
 * alike): each is an `<li class="b_algo">` with a heading link and a caption.
 * The heading has come in two shapes, `<h2><a href>` and `<a href><h2>`; both
 * are read.
 */
export function parseBingResults(html: string, limit = 8): SearchResult[] {
	const results: SearchResult[] = [];
	const seen = new Set<string>();
	const blocks = html.split(/<li\b[^>]*\bclass="[^"]*\bb_algo\b[^"]*"[^>]*>/i).slice(1);
	for (const raw of blocks) {
		const block = raw.split(/<\/li>/i)[0] ?? raw;
		const heading = /<h2\b[^>]*>([\s\S]*?)<\/h2>/i.exec(block);
		if (!heading) continue;

		// A link inside the heading, else the closest one opening before it.
		let href = hrefOf(/<a\b[^>]*>/i.exec(heading[1] ?? '')?.[0] ?? '');
		if (!href) {
			const before = block.slice(0, heading.index);
			const links = before.match(/<a\b[^>]*>/gi) ?? [];
			href = hrefOf(links[links.length - 1] ?? '');
		}
		if (!href) continue;
		const url = unwrapBingUrl(decodeEntities(href));
		if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;

		const title = inlineText(heading[1] ?? '');
		if (!title) continue;
		const caption = /<div\b[^>]*\bclass="[^"]*\bb_caption\b[^"]*"[^>]*>([\s\S]*)/i.exec(block)?.[1] ?? block.slice(heading.index + heading[0].length);
		const paragraph = /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(caption)?.[1];
		const snippet = inlineText(paragraph ?? caption).slice(0, 300);

		seen.add(url);
		results.push({ title, url, snippet });
		if (results.length >= limit) break;
	}
	return results;
}

/** Tags whose content is never the page's words. */
const DROPPED = ['script', 'style', 'noscript', 'template', 'svg', 'canvas', 'iframe', 'nav', 'header', 'footer', 'aside', 'form', 'select', 'button'];

const BLOCK = /<\/?(p|div|section|article|main|br|li|ul|ol|h[1-6]|tr|table|blockquote|pre|dd|dt|dl|figure|figcaption|hr)\b[^>]*>/gi;

export interface Readable {
	title: string;
	text: string;
}

/**
 * The readable words of a page: its title, then its text with the scripts,
 * styles, menus and footers left out. An `<article>` or `<main>` that holds
 * most of the words is preferred over the whole body, which keeps sidebars out.
 */
export function readableText(html: string): Readable {
	const title = inlineText(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '');
	let body = /<body\b[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
	body = body.replace(/<!--[\s\S]*?-->/g, '');
	for (const tag of DROPPED) body = body.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi'), ' ');

	const textOf = (markup: string) =>
		decodeEntities(markup.replace(BLOCK, '\n').replace(/<[^>]*>/g, ''))
			.split('\n')
			.map((line) => line.replace(/[ \t\f\v\u00a0]+/g, ' ').trim())
			.filter(Boolean)
			.join('\n');

	const whole = textOf(body);
	for (const tag of ['article', 'main']) {
		const found = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(body)?.[1];
		if (!found) continue;
		const text = textOf(found);
		// Only when it really is the content: a tiny <main> around a search box is not.
		if (text.length >= 200 || text.length >= whole.length * 0.5) return { title, text };
	}
	return { title, text: whole };
}

/** The charset a response says it is in, from its header or its own meta tag. */
export function charsetOf(contentType: string | null, head: Uint8Array): string {
	const fromHeader = /charset\s*=\s*"?([\w-]+)/i.exec(contentType ?? '')?.[1];
	if (fromHeader) return fromHeader.toLowerCase();
	const ascii = new TextDecoder('latin1').decode(head.subarray(0, 2048));
	const fromMeta = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(ascii)?.[1];
	return (fromMeta ?? 'utf-8').toLowerCase();
}
