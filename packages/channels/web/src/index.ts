import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Channel, MessageEvent } from '@pi-magpie-bot/brain';
import { LOGIN_PAGE, PAGE } from './page.ts';
import { ICONS, MANIFEST, SERVICE_WORKER } from './pwa.ts';
export { serveSetupPage, setupPage, type SetupPageHandle, type SetupPageOptions } from './setup.ts';

export interface WebChannelOptions {
	/** Default 8787; 0 picks a free port (tests). */
	port?: number;
	/** Default 127.0.0.1: only this machine may reach it. */
	host?: string;
	/** If set, the page asks for it before anything is accepted. */
	password?: string;
	/**
	 * What was said in this session before, so a reopened tab is not an empty
	 * page. Given, the transcript is what a new connection shows.
	 */
	history?: (target: string) => Promise<Array<{ role: 'me' | 'bot'; text: string }>>;
	onMessage: (event: MessageEvent) => void | Promise<void>;
}

interface Session {
	subscribers: Set<ServerResponse>;
	/** Messages that arrived while no tab was open. */
	buffer: string[];
}

function cookies(request: IncomingMessage): Record<string, string> {
	const header = request.headers.cookie;
	if (!header) return {};
	const out: Record<string, string> = {};
	for (const part of header.split(';')) {
		const at = part.indexOf('=');
		if (at < 0) continue;
		out[part.slice(0, at).trim()] = decodeURIComponent(part.slice(at + 1).trim());
	}
	return out;
}

/** Whether a Host header names this machine itself. */
function isLocalHost(header: string | undefined): boolean {
	if (!header) return false;
	const name = header.startsWith('[') ? header.slice(0, header.indexOf(']') + 1) : header.split(':')[0];
	return name === 'localhost' || name === '127.0.0.1' || name === '[::1]';
}

function isLoopback(host: string): boolean {
	return host === 'localhost' || host === '::1' || host.startsWith('127.');
}

function json(response: ServerResponse, status: number, body: unknown): void {
	const payload = JSON.stringify(body);
	response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
	response.end(payload);
}

function html(response: ServerResponse, body: string, status = 200): void {
	response.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
	response.end(body);
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of request) {
		size += (chunk as Buffer).length;
		if (size > 64 * 1024) throw new Error('body too large');
		chunks.push(chunk as Buffer);
	}
	if (chunks.length === 0) return {};
	try {
		const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
		return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

/**
 * A chat page served by the bot itself: the shortest way to try the agent
 * with nothing installed and no account anywhere.
 */
export class WebChannel implements Channel {
	readonly id = 'web';
	private readonly sessions = new Map<string, Session>();
	private readonly secret = randomBytes(32);
	/** Wrong passwords by remote address: a password is only a password if it cannot be guessed at speed. */
	private readonly misses = new Map<string, { count: number; until: number }>();
	private server: ReturnType<typeof createServer> | undefined;
	private bound = { port: 0, url: '' };

	constructor(private readonly options: WebChannelOptions) {}

	get url(): string {
		return this.bound.url;
	}

	private token(session: string): string {
		return createHmac('sha256', this.secret).update(session).digest('hex');
	}

	private authorized(request: IncomingMessage, cookie: Record<string, string>): boolean {
		if (!this.options.password) return true;
		const session = cookie.sid;
		const given = cookie.auth;
		if (!session || !given) return false;
		const expected = this.token(session);
		const a = Buffer.from(given);
		const b = Buffer.from(expected);
		return a.length === b.length && timingSafeEqual(a, b);
	}

	private passwordMatches(given: unknown): boolean {
		const expected = this.options.password ?? '';
		if (typeof given !== 'string') return false;
		const a = Buffer.from(given);
		const b = Buffer.from(expected);
		return a.length === b.length && timingSafeEqual(a, b);
	}

	async start(): Promise<{ port: number; url: string }> {
		const server = createServer((request, response) => {
			this.handle(request, response).catch((error: unknown) => {
				console.error('[web] request failed:', error);
				if (!response.headersSent) json(response, 500, { error: 'internal error' });
			});
		});
		this.server = server;
		const port = this.options.port ?? 8787;
		const host = this.options.host ?? '127.0.0.1';
		await new Promise<void>((resolve, reject) => {
			server.once('error', reject);
			server.listen(port, host, () => resolve());
		});
		const address = server.address();
		const actual = typeof address === 'object' && address ? address.port : port;
		this.bound = { port: actual, url: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${actual}` };
		return this.bound;
	}

	async stop(): Promise<void> {
		for (const session of this.sessions.values()) {
			for (const response of session.subscribers) response.end();
		}
		this.sessions.clear();
		await new Promise<void>((resolve, reject) => {
			if (!this.server) return resolve();
			this.server.close((error) => (error ? reject(error) : resolve()));
		});
		this.server = undefined;
	}

	private session(request: IncomingMessage, response: ServerResponse): string {
		const cookie = cookies(request);
		const existing = cookie.sid;
		if (existing) return existing;
		const fresh = randomUUID();
		response.setHeader('set-cookie', `sid=${fresh}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`);
		return fresh;
	}

	private state(session: string): Session {
		const found = this.sessions.get(session);
		if (found) return found;
		const created: Session = { subscribers: new Set(), buffer: [] };
		this.sessions.set(session, created);
		return created;
	}

	private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		let url: URL;
		try {
			url = new URL(request.url ?? '/', 'http://localhost');
		} catch {
			// A junk request line (curl with a bare "//", a scanner) is not our
			// problem, but it must not land in the log as a 500.
			return json(response, 400, { error: 'bad request' });
		}
		const cookie = cookies(request);

		// A page open on the internet can aim at 127.0.0.1 too, either by rebinding
		// its own name to it or by posting from the user's browser. With no password
		// there is nothing else to stop it, so the page answers only to this
		// machine's own names, and only to bodies a foreign page cannot send.
		if (!this.options.password && isLoopback(this.options.host ?? '127.0.0.1') && !isLocalHost(request.headers.host)) {
			return json(response, 421, { error: 'this page answers only on localhost' });
		}
		if (request.method === 'POST' && !(request.headers['content-type'] ?? '').startsWith('application/json')) {
			return json(response, 415, { error: 'send application/json' });
		}

		if (url.pathname === '/healthz') return json(response, 200, { ok: true });

		// For "add to home screen". No session, no secrets: a browser fetches these
		// before the page is even shown, and a stale-looking icon is not worth a 401.
		if (url.pathname === '/manifest.webmanifest') {
			response.writeHead(200, { 'content-type': 'application/manifest+json; charset=utf-8', 'cache-control': 'public, max-age=3600' });
			response.end(MANIFEST);
			return;
		}
		if (url.pathname === '/sw.js') {
			response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' });
			response.end(SERVICE_WORKER);
			return;
		}
		const icon = ICONS[url.pathname];
		if (icon) {
			response.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' });
			response.end(icon);
			return;
		}

		const session = this.session(request, response);

		if (url.pathname === '/') {
			if (!this.authorized(request, cookie)) return html(response, LOGIN_PAGE, 401);
			return html(response, PAGE);
		}

		if (url.pathname === '/api/login' && request.method === 'POST') {
			const who = request.socket.remoteAddress ?? '?';
			const miss = this.misses.get(who);
			if (miss && miss.count >= 10 && Date.now() < miss.until) return json(response, 429, { error: 'too many tries, wait a few minutes' });
			const body = await readJson(request);
			if (!this.passwordMatches(body.password)) {
				const fresh = miss && Date.now() < miss.until ? miss : { count: 0, until: Date.now() + 10 * 60_000 };
				fresh.count += 1;
				this.misses.set(who, fresh);
				return json(response, 401, { error: 'wrong password' });
			}
			this.misses.delete(who);
			response.setHeader(
				'set-cookie',
				`auth=${this.token(session)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`,
			);
			return json(response, 200, { ok: true });
		}

		if (url.pathname === '/api/events' && request.method === 'GET') {
			if (!this.authorized(request, cookie)) return json(response, 401, { error: 'unauthorized' });
			return await this.subscribe(session, response);
		}

		if (url.pathname === '/api/message' && request.method === 'POST') {
			if (!this.authorized(request, cookie)) return json(response, 401, { error: 'unauthorized' });
			const body = await readJson(request);
			const text = typeof body.text === 'string' ? body.text.trim() : '';
			if (!text) return json(response, 400, { error: 'empty message' });
			await this.options.onMessage({
				source: `web:${session}`,
				sourceKey: randomUUID(),
				channel: this.id,
				target: session,
				text,
			});
			return json(response, 202, { ok: true });
		}

		return json(response, 404, { error: 'not found' });
	}

	private async subscribe(session: string, response: ServerResponse): Promise<void> {
		const state = this.state(session);
		response.writeHead(200, {
			'content-type': 'text/event-stream; charset=utf-8',
			'cache-control': 'no-cache, no-transform',
			connection: 'keep-alive',
		});
		response.write(': connected\n\n');
		state.subscribers.add(response);
		const keepAlive = setInterval(() => response.write(': keep-alive\n\n'), 20_000);
		// Before anything is awaited: a tab that closes while the history loads
		// must still be forgotten.
		response.on('close', () => {
			clearInterval(keepAlive);
			state.subscribers.delete(response);
		});

		if (this.options.history) {
			// The transcript already holds what the buffer holds, and more: show it
			// rather than the buffer, so a refresh brings the whole chat back.
			const history = await this.options.history(session);
			for (const entry of history) {
				response.write(`data: ${JSON.stringify(entry)}\n\n`);
			}
			// But not all of it. A notice out of the outbox — "that one was
			// interrupted" after a crash — is never part of the conversation, so
			// it only ever exists in the buffer, and dropping that whole buffer
			// would drop the one message the user most needs to see.
			const said = new Set(history.filter((entry) => entry.role === 'bot').map((entry) => entry.text));
			for (const text of state.buffer.splice(0)) {
				if (said.has(text)) continue;
				response.write(`data: ${JSON.stringify({ text })}\n\n`);
			}
		} else {
			for (const text of state.buffer.splice(0)) {
				response.write(`data: ${JSON.stringify({ text })}\n\n`);
			}
		}
	}

	/** The outbox hands the answer here; a closed tab keeps it until the next one opens. */
	async send(target: string, text: string): Promise<void> {
		const state = this.state(target);
		if (state.subscribers.size === 0) {
			state.buffer.push(text);
			// A tab that never comes back must not make this grow without end.
			if (state.buffer.length > 100) state.buffer.shift();
			return;
		}
		for (const response of state.subscribers) {
			response.write(`data: ${JSON.stringify({ text })}\n\n`);
		}
	}
}
