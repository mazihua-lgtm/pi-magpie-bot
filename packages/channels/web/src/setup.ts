/**
 * The page a first run sees when there is no model to talk to.
 *
 * Without it the process prints the reason into a log and exits, and anyone
 * who started this from a Docker Compose file gets a container that restarts
 * forever with the answer buried in `docker compose logs`.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

export interface SetupPageOptions {
	/** What is wrong, in one line, in the user's words. */
	title: string;
	/** The reason, as far as this product can tell. */
	reason: string;
	/** Commands that fix it, in order. */
	steps: Array<{ command: string; note?: string }>;
	/** Where to read more. */
	docsUrl?: string;
	host?: string;
	port?: number;
	/**
	 * The vendors the page offers by name. With these and `onKey` the page also
	 * takes a key in a text box, which is the whole point: the person most likely
	 * to see this page is the one who does not want to open a terminal.
	 */
	presets?: Array<{
		id: string;
		name: string;
		/** Where to get a key from this vendor; shown as a link under the box. */
		signup?: string;
		/** True when that link earns the project something: the page says so. */
		sponsored?: boolean;
	}>;
	/**
	 * The page may be reachable from other machines (a cloud deploy). Whoever
	 * saves a key here decides whose account the chats are sent through, so with
	 * a password set the page asks for it, and without one the caller should
	 * not offer the key box at all.
	 */
	password?: string;
	/** Saves a key, or throws with the reason it could not be saved. */
	onKey?: (input: { preset: string; key: string }) => Promise<string | undefined>;
}

/** What a key posted to the page is allowed to look like. */
export interface KeyForm {
	preset: string;
	key: string;
	password?: string;
}

/** Everything a model or a user typed goes through this before it is markup. */
function escape(text: string): string {
	return text.replace(/[&<>"']/g, (character) => {
		switch (character) {
			case '&':
				return '&amp;';
			case '<':
				return '&lt;';
			case '>':
				return '&gt;';
			case '"':
				return '&quot;';
			default:
				return '&#39;';
		}
	});
}

export function setupPage(options: SetupPageOptions): string {
	const steps = options.steps
		.map(
			(step) =>
				`<li><code>${escape(step.command)}</code>${step.note ? `<p>${escape(step.note)}</p>` : ''}</li>`,
		)
		.join('');
	const docs = options.docsUrl
		? `<p class="docs">说明在这里：<a href="${escape(options.docsUrl)}" rel="noreferrer">${escape(options.docsUrl)}</a></p>`
		: '';
	return `<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>还差一步</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; font: 16px/1.7 system-ui, -apple-system, "PingFang SC", sans-serif; display: grid; place-items: center; min-height: 100dvh; }
  main { width: min(42rem, 88vw); padding: 24px; }
  h1 { font-size: 22px; margin: 0 0 8px; }
  .reason { opacity: .75; margin: 0 0 20px; }
  ol { padding-left: 20px; }
  li { margin-bottom: 14px; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 14px; background: #8882; padding: 6px 8px; border-radius: 6px; display: inline-block; word-break: break-all; }
  p { margin: 6px 0 0; }
  .docs { opacity: .6; font-size: 14px; margin-top: 24px; }
  a { color: inherit; }
  form { margin: 0 0 24px; padding: 16px; border: 1px solid #8884; border-radius: 12px; }
  label { display: block; margin-bottom: 12px; font-size: 14px; opacity: .8; }
  select, input, button { box-sizing: border-box; font: inherit; width: 100%; margin-top: 6px; padding: 9px 10px; border-radius: 8px; border: 1px solid #8886; background: transparent; color: inherit; }
  button { border: 0; background: #3b82f6; color: #fff; font-weight: 600; }
  .signup { font-size: 14px; margin: 0 0 12px; }
  details { margin-top: 8px; }
  summary { cursor: pointer; opacity: .7; font-size: 14px; }
  #says { font-size: 14px; min-height: 1.5em; opacity: .8; }
</style>
<main>
  <h1>${escape(options.title)}</h1>
  <p class="reason">${escape(options.reason)}</p>
  ${keyForm(options)}
  ${hasForm(options) ? `<details><summary>习惯用终端？也可以按命令做</summary><ol>${steps}</ol></details>` : `<ol>${steps}</ol>`}
  ${docs}
</main>
</html>`;
}

function hasForm(options: SetupPageOptions): boolean {
	return Boolean(options.presets?.length && options.onKey);
}

/** The key box, or nothing when this page was opened without a way to save one. */
function keyForm(options: SetupPageOptions): string {
	if (!hasForm(options)) return '';
	const choices = (options.presets ?? [])
		.map((preset) => {
			// Only a plain https link goes into the page.
			const signup = preset.signup?.startsWith('https://') ? preset.signup : '';
			return `<option value="${escape(preset.id)}" data-signup="${escape(signup)}"${preset.sponsored ? ' data-sponsored="1"' : ''}>${escape(preset.name)}</option>`;
		})
		.join('');
	return `<form id="key">
    <label>自己有 key 的话填在这里，不用开终端
      <select name="preset">${choices}</select>
    </label>
    <p id="signup" class="signup"></p>
    ${options.password ? '<label>访问密码（部署时设的 WEB_PASSWORD）<input name="password" type="password" autocomplete="current-password" required></label>' : ''}
    <label>API key
      <input name="key" type="password" autocomplete="off" spellcheck="false" required>
    </label>
    <button>保存并继续</button>
    <p id="says"></p>
  </form>
  <script>
    const picker = document.querySelector('#key select');
    const signup = document.getElementById('signup');
    function showSignup() {
      const chosen = picker.selectedOptions[0];
      const url = chosen && chosen.dataset.signup;
      signup.textContent = '';
      if (!url) return;
      signup.appendChild(document.createTextNode('还没有 key？先去注册一个：'));
      const link = document.createElement('a');
      link.href = url;
      link.target = '_blank';
      link.rel = chosen.dataset.sponsored ? 'noreferrer noopener sponsored' : 'noreferrer noopener';
      link.textContent = chosen.textContent;
      signup.appendChild(link);
      if (chosen.dataset.sponsored) signup.appendChild(document.createTextNode('（含推广链接，通过它注册本项目会有收益；你不用它也一样能用）'));
    }
    picker.addEventListener('change', showSignup);
    showSignup();
    document.getElementById('key').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.target;
      const says = document.getElementById('says');
      says.textContent = '正在保存…';
      try {
        const response = await fetch('/api/setup/key', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ preset: form.preset.value, key: form.key.value, password: form.password ? form.password.value : undefined }),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
          says.textContent = body.error || '没能保存这个 key。';
          return;
        }
        says.textContent = body.note || '好了，正在启动，等几秒刷新这一页。';
      } catch (error) {
        says.textContent = '连不上这个页面了，刷新一下再试。';
      }
    });
  </script>`;
}

export interface SetupPageHandle {
	url: string;
	/**
	 * Resolves true once the page has taken a key. The page is the last thing
	 * this process does until then, so whoever is waiting on it gets a signal
	 * back: fix what was wrong, then look again.
	 */
	fixed: Promise<boolean>;
	/** Stops serving the page, for whoever no longer needs it. */
	close: () => Promise<void>;
}

/**
 * Serves the page and keeps serving it: there is nothing else to do until the
 * gateway it needs exists, and staying up is what tells the user (and Docker)
 * that this is the state the product is in.
 */
export async function serveSetupPage(options: SetupPageOptions): Promise<SetupPageHandle> {
	const host = options.host ?? '127.0.0.1';
	const port = options.port ?? 8787;
	const page = setupPage(options);
	/** When the last wrong passwords were typed; a password has to be slow to guess. */
	const wrong: number[] = [];
	let settle: (value: boolean) => void = () => {};
	const fixed = new Promise<boolean>((resolve) => {
		settle = resolve;
	});

	const server = createServer((request: IncomingMessage, response: ServerResponse) => {
		const path = (request.url ?? '/').split('?')[0];
		if (path === '/healthz') {
			response.writeHead(200, { 'content-type': 'application/json' });
			response.end('{"ok":false,"reason":"no model"}');
			return;
		}
		if (path === '/api/setup/key' && request.method === 'POST') {
			// Whose key goes into this machine's gateway decides who reads the chats it
			// carries, so a page elsewhere on the web must not be able to post one: it
			// cannot send this content type without a CORS preflight this server never
			// grants, and it cannot present a Host that is not this machine's own.
			const local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(request.headers.host ?? '');
			const loopback = host === 'localhost' || host === '::1' || host.startsWith('127.');
			if (!(request.headers['content-type'] ?? '').startsWith('application/json') || (loopback && !local)) {
				response.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
				response.end(JSON.stringify({ error: '这个请求不是从这一页发出的。' }));
				return;
			}
			void saveKey(request, response, options, wrong).then((accepted) => {
				if (!accepted) return;
				// The chat server wants this same port, so the page gives it up.
				// The promise resolves only once the port is really free again:
				// resolving first is a race the chat server loses.
				server.close(() => settle(true));
				server.closeIdleConnections();
			});
			return;
		}
		response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
		response.end(page);
	});
	// A browser tab keeps its socket open; that socket must not be able to hold
	// the port this page is about to hand over.
	server.keepAliveTimeout = 500;
	await new Promise<void>((resolve) => server.listen(port, host, resolve));
	const address = server.address();
	const shown = typeof address === 'object' && address ? address.port : port;
	return {
		url: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${shown}`,
		fixed,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

function sameSecret(given: string, expected: string): boolean {
	const a = createHash('sha256').update(given).digest();
	const b = createHash('sha256').update(expected).digest();
	return timingSafeEqual(a, b);
}

/** Reads one key off the page and hands it over. Nothing here says the key back. */
async function saveKey(
	request: IncomingMessage,
	response: ServerResponse,
	options: SetupPageOptions,
	wrong: number[],
): Promise<boolean> {
	const say = (status: number, body: Record<string, unknown>): boolean => {
		response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
		response.end(JSON.stringify(body));
		return status === 200;
	};
	if (!options.onKey) return say(400, { error: '这一页不能收 key，请按下面的命令做。' });

	let form: Partial<KeyForm>;
	try {
		form = JSON.parse(await readBody(request)) as Partial<KeyForm>;
	} catch {
		return say(400, { error: '请求看不懂，刷新一下再试。' });
	}
	if (options.password) {
		const now = Date.now();
		wrong.splice(0, wrong.length, ...wrong.filter((at) => now - at < 60_000));
		if (wrong.length >= 5) return say(429, { error: '密码试错太多次，一分钟后再试。' });
		if (!sameSecret(typeof form.password === 'string' ? form.password : '', options.password)) {
			wrong.push(now);
			return say(401, { error: '访问密码不对。' });
		}
	}
	const preset = typeof form.preset === 'string' ? form.preset : '';
	const key = typeof form.key === 'string' ? form.key.trim() : '';
	if (!key) return say(400, { error: 'key 不能是空的。' });
	if (!options.presets?.some((entry) => entry.id === preset)) {
		return say(400, { error: '没有这个厂商，换一个或者用下面的命令。' });
	}

	try {
		const note = await options.onKey({ preset, key });
		return say(200, { ok: true, note: note ?? '加进去了，正在启动，等几秒刷新这一页。' });
	} catch (error) {
		// A failed save must not hand the key back out in its own message.
		const said = ((error instanceof Error ? error.message : String(error)).split('\n')[0] ?? '').replaceAll(key, '***');
		console.error('[setup] a key did not save:', said);
		return say(400, { error: said });
	}
}

/** A key is a few dozen bytes; anything far larger is not this form. */
async function readBody(request: IncomingMessage, limit = 8192): Promise<string> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of request) {
		const buffer = chunk as Buffer;
		size += buffer.length;
		if (size > limit) throw new Error('too large');
		chunks.push(buffer);
	}
	return Buffer.concat(chunks).toString('utf8');
}
