import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import QRCode from 'qrcode';
import type { AppBackend, AppEvent, Channel, MessageEvent, SendMeta } from '@pi-magpie-bot/brain';
import { routeApp, SMALL_BODY } from './app-routes.ts';
import { lanAddress, pairLink, PairStore } from './pairing.ts';
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
	 * The token the native app on this device sends as a bearer on every API
	 * request. When set, all `/api/*` routes (except `/api/login` and
	 * `/api/pair/exchange`) require it — either as `Authorization: Bearer` or
	 * as the `local_token` cookie, which the page itself gets on first load.
	 * This is what stops another app on the same device from calling the API.
	 */
	localToken?: string;
	/** Address to put in a pairing QR (a LAN IP or a hostname). Auto-detected if absent. */
	pairHost?: string;
	/**
	 * What was said in this session before, so a reopened tab is not an empty
	 * page. Given, the transcript is what a new connection shows.
	 */
	history?: (target: string) => Promise<Array<{ role: 'me' | 'bot'; text: string }>>;
	/**
	 * Read and write the cookie-signing secret here. Given, sessions survive a
	 * restart: without it, every restart silently signs everyone out, which on a
	 * phone means re-entering the password after every update or reboot.
	 */
	secret?: { get(): string | undefined; set(value: string): void };
	/**
	 * The native app's API (docs/app-api.md): chats, live answers, approvals,
	 * models, reminders, memory, keys. Without it only the page and its two
	 * routes exist.
	 */
	app?: AppBackend;
	onMessage: (event: MessageEvent) => void | Promise<void>;
}

interface Session {
	subscribers: Set<ServerResponse>;
	/** Messages that arrived while no tab was open. */
	buffer: string[];
	/** Streams of the app (`/api/events?v=2`): named events for every chat. */
	live: Set<ServerResponse>;
	/** `message` events that arrived while no app stream was open. */
	missed: Array<{ chat: string; text: string }>;
}

/** A session id the app chose: it becomes part of every chat's target, so no `/`. */
const OWNER = /^[A-Za-z0-9_-]{8,64}$/;

/** One named server-sent event. */
function event(response: ServerResponse, name: string, data: unknown): void {
	response.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
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

function json(response: ServerResponse, status: number, body: unknown): void {
	const payload = JSON.stringify(body);
	response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
	response.end(payload);
}

function html(response: ServerResponse, body: string, status = 200): void {
	response.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
	response.end(body);
}

/** A refusal that knows its status, so the request handler can answer it as itself. */
class HttpError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

async function readJson(request: IncomingMessage, limit = SMALL_BODY): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of request) {
		size += (chunk as Buffer).length;
		if (size > limit) throw new HttpError(413, '内容太大了 / body too large');
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
	/** Signs the session cookie. Persisted through `options.secret` when given. */
	private readonly secret: Buffer;
	/** Wrong passwords by remote address: a password is only a password if it cannot be guessed at speed. */
	private readonly misses = new Map<string, { count: number; until: number }>();
	/** One-time QR codes; memory-only, so a restart ends every pending pairing. */
	private readonly pairing = new PairStore();
	private server: ReturnType<typeof createServer> | undefined;
	private unsubscribe: (() => void) | undefined;
	private bound = { port: 0, url: '' };

	private readonly options: WebChannelOptions;

	constructor(options: WebChannelOptions) {
		this.options = options;
		// Reuse the secret this installation already has, so a restart does not
		// sign everyone out; a fresh one is written back for the next time.
		const saved = options.secret?.get();
		if (saved && /^[0-9a-f]{64}$/i.test(saved)) {
			this.secret = Buffer.from(saved, 'hex');
		} else {
			this.secret = randomBytes(32);
			options.secret?.set(this.secret.toString('hex'));
		}
	}

	get url(): string {
		return this.bound.url;
	}

	private token(session: string): string {
		// Mix the password into the signing key: changing WEB_PASSWORD then
		// invalidates every browser and paired phone at once, without rotating
		// the persisted secret (which would also sign out on every restart).
		const key = createHmac('sha256', this.secret).update(this.options.password ?? '').digest();
		return createHmac('sha256', key).update(session).digest('hex');
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

	/**
	 * Whether the caller holds the device-local token. Checked on every API
	 * route when `localToken` is set: the native app sends it as a bearer, the
	 * web page gets it as a cookie on first load. Routes that exist to log in
	 * or pair (login, exchange) are exempt — they are how a caller gets access.
	 */
	private localAuthorized(request: IncomingMessage, cookie: Record<string, string>): boolean {
		if (!this.options.localToken) return true;
		const header = request.headers.authorization;
		if (header?.startsWith('Bearer ')) {
			const given = header.slice(7).trim();
			const a = Buffer.from(given);
			const b = Buffer.from(this.options.localToken);
			return a.length === b.length && timingSafeEqual(a, b);
		}
		const given = cookie.local_token;
		if (given) {
			const a = Buffer.from(given);
			const b = Buffer.from(this.options.localToken);
			return a.length === b.length && timingSafeEqual(a, b);
		}
		return false;
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
				// A refusal carries its status and a sentence for the user (an
				// `AppError` from the app API, a body too large); anything else is ours.
				const status = (error as { status?: unknown }).status;
				if (typeof status === 'number' && status >= 400 && status < 600) {
					if (!response.headersSent) json(response, status, { error: (error as Error).message });
					// Unread body left on the socket: drop it rather than keep reading.
					if (status === 413) request.destroy();
					return;
				}
				console.error('[web] request failed:', error);
				if (!response.headersSent) json(response, 500, { error: '出错了 / internal error' });
			});
		});
		this.unsubscribe = this.options.app?.subscribe((owner, appEvent) => this.publish(owner, appEvent));
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
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		for (const session of this.sessions.values()) {
			for (const response of session.subscribers) response.end();
			for (const response of session.live) response.end();
		}
		this.sessions.clear();
		await new Promise<void>((resolve, reject) => {
			if (!this.server) return resolve();
			this.server.close((error) => (error ? reject(error) : resolve()));
			// A client still holding a connection open (keep-alive, an upload cut
			// short) must not keep the process from stopping.
			this.server.closeAllConnections();
		});
		this.server = undefined;
	}

	private session(request: IncomingMessage, response: ServerResponse): string {
		const cookie = cookies(request);
		const existing = cookie.sid;
		if (existing) return existing;
		const fresh = randomUUID();
		// The page gets the local token as a cookie alongside its sid, so its own
		// fetch calls carry it without the page script ever having to know it.
		const lines = [`sid=${fresh}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`];
		if (this.options.localToken) {
			lines.push(`local_token=${this.options.localToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`);
		}
		response.setHeader('set-cookie', lines);
		return fresh;
	}

	private state(session: string): Session {
		const found = this.sessions.get(session);
		if (found) return found;
		const created: Session = { subscribers: new Set(), buffer: [], live: new Set(), missed: [] };
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

		// With no password there is nothing but the Host header to stop a page on
		// the internet from reaching this server (DNS rebinding points the browser
		// at 127.0.0.1, or at a 0.0.0.0-bound container on the host). So check it
		// regardless of the listen address — checking only when bound to loopback
		// left the Docker default (0.0.0.0) wide open.
		if (!this.options.password && !isLocalHost(request.headers.host)) {
			return json(response, 421, { error: 'this page answers only on localhost; set WEB_PASSWORD to allow other hosts' });
		}
		const hasBody = request.method === 'POST' || request.method === 'PUT' || request.method === 'PATCH';
		if (hasBody && !(request.headers['content-type'] ?? '').startsWith('application/json')) {
			return json(response, 415, { error: 'send application/json' });
		}
		// Android's HttpURLConnection cannot send PATCH; it sends a POST that says so.
		const override = String(request.headers['x-http-method-override'] ?? '').toUpperCase();
		const method = request.method === 'POST' && override === 'PATCH' ? 'PATCH' : (request.method ?? 'GET');

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

		// Pairing: someone already logged in makes a one-time code; the QR carries
		// only that code, never the password. Exchanging it signs the caller's own
		// sid, so a photo of the QR alone is worth nothing.
		if (url.pathname === '/api/pair' && request.method === 'POST') {
			if (!this.authorized(request, cookie) || !this.localAuthorized(request, cookie)) return json(response, 401, { error: 'unauthorized' });
			const address = lanAddress(this.options.pairHost);
			if (!address) return json(response, 400, { error: '找不到手机能访问的局域网地址；设 PAIR_HOST 再试 / set PAIR_HOST' });
			const { code, expiresAt } = this.pairing.create();
			const port = this.bound.port;
			return json(response, 200, { code, expiresAt, address, link: pairLink(address, port, code) });
		}

		if (url.pathname === '/api/pair/qr' && request.method === 'GET') {
			if (!this.authorized(request, cookie) || !this.localAuthorized(request, cookie)) return json(response, 401, { error: 'unauthorized' });
			const code = url.searchParams.get('code') ?? '';
			if (!/^[A-Z0-9]{4,8}$/.test(code)) return json(response, 400, { error: 'bad code' });
			const address = lanAddress(this.options.pairHost);
			if (!address) return json(response, 400, { error: 'no reachable address' });
			const png = await QRCode.toBuffer(pairLink(address, this.bound.port, code), {
				type: 'png',
				width: 512,
				margin: 2,
				errorCorrectionLevel: 'M',
			});
			response.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
			response.end(png);
			return;
		}

		if (url.pathname === '/api/pair/exchange' && request.method === 'POST') {
			const who = request.socket.remoteAddress ?? '?';
			if (this.pairing.throttled(who)) return json(response, 429, { error: '试得太多次，几分钟后再来 / too many tries' });
			const body = await readJson(request);
			const code = typeof body.code === 'string' ? body.code.trim().toUpperCase() : '';
			const session = cookie.sid;
			if (!/^[A-Z0-9]{4,8}$/.test(code) || !OWNER.test(session ?? '')) {
				this.pairing.miss(who);
				return json(response, 400, { error: '配对码不对 / bad code' });
			}
			if (!this.pairing.consume(code)) {
				this.pairing.miss(who);
				return json(response, 400, { error: '配对码过期或已经用过 / code used or expired' });
			}
			this.pairing.clearMiss(who);
			// Sign the caller's own sid, exactly as /api/login would.
			response.setHeader('set-cookie', `auth=${this.token(session!)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`);
			return json(response, 200, { ok: true });
		}

		if (url.pathname === '/api/events' && request.method === 'GET') {
			if (!this.authorized(request, cookie) || !this.localAuthorized(request, cookie)) return json(response, 401, { error: 'unauthorized' });
			if (url.searchParams.get('v') === '2') {
				if (!OWNER.test(session)) return json(response, 400, { error: 'sid 只能是字母、数字、- 和 _ / bad sid' });
				return this.subscribeLive(session, response);
			}
			return await this.subscribe(session, response);
		}

		if (url.pathname === '/api/message' && request.method === 'POST') {
			if (!this.authorized(request, cookie) || !this.localAuthorized(request, cookie)) return json(response, 401, { error: 'unauthorized' });
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

		const app = this.options.app;
		if (app && url.pathname.startsWith('/api/')) {
			if (!this.authorized(request, cookie) || !this.localAuthorized(request, cookie)) return json(response, 401, { error: 'unauthorized' });
			if (!OWNER.test(session)) return json(response, 400, { error: 'sid 只能是字母、数字、- 和 _ / bad sid' });
			const handled = await routeApp({
				request,
				response,
				method,
				path: url.pathname,
				owner: session,
				app,
				readJson: (limit) => readJson(request, limit),
				json: (status, body) => json(response, status, body),
			});
			if (handled) return;
		}

		// An `/api/*` path that no route above claimed still gets the token gate.
		// Without it, a request to a nonexistent route would leak a 404 to anyone
		// on the loopback, and an attacker could probe what exists without a token.
		if (url.pathname.startsWith('/api/') && !this.localAuthorized(request, cookie)) {
			return json(response, 401, { error: 'unauthorized' });
		}

		return json(response, 404, { error: 'not found' });
	}

	/**
	 * The app's stream: named events for every chat of this owner. What was
	 * said while it was away and the transcript never holds (a reminder, a
	 * notice) is replayed first, then any card still waiting for an answer.
	 */
	private subscribeLive(session: string, response: ServerResponse): void {
		const state = this.state(session);
		response.writeHead(200, {
			'content-type': 'text/event-stream; charset=utf-8',
			'cache-control': 'no-cache, no-transform',
			connection: 'keep-alive',
		});
		response.write(': connected\n\n');
		state.live.add(response);
		const keepAlive = setInterval(() => response.write(': keep-alive\n\n'), 20_000);
		response.on('close', () => {
			clearInterval(keepAlive);
			state.live.delete(response);
		});
		for (const missed of state.missed.splice(0)) event(response, 'message', missed);
		for (const card of this.options.app?.pendingApprovals(session) ?? []) event(response, card.event, card.data);
	}

	/** An event of the app API, to every app stream of its owner. Nobody listening: it is gone, by design. */
	private publish(owner: string, appEvent: AppEvent): void {
		const state = this.sessions.get(owner);
		if (!state) return;
		for (const response of state.live) event(response, appEvent.event, appEvent.data);
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

	/**
	 * The outbox hands the answer here; a closed tab keeps it until the next one
	 * opens. A target is `<session>` (the page's one conversation) or
	 * `<session>/<chat>` (a chat of the app): both go to the session's streams.
	 */
	async send(target: string, text: string, meta?: SendMeta): Promise<void> {
		const at = target.indexOf('/');
		const owner = at < 0 ? target : target.slice(0, at);
		const chat = at < 0 ? 'default' : target.slice(at + 1);
		const state = this.state(owner);

		// The app: an approval card is its own event there (with buttons), so its
		// words would only show twice. An answer missed while away is in the
		// transcript the app loads anyway; anything else would be lost.
		if (meta?.kind !== 'approval') {
			if (state.live.size > 0) {
				for (const response of state.live) event(response, 'message', { chat, text });
			} else if (meta?.kind !== 'answer') {
				state.missed.push({ chat, text });
				if (state.missed.length > 100) state.missed.shift();
			}
		}

		// The old stream, unchanged: unnamed lines, kept while no tab is open.
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
