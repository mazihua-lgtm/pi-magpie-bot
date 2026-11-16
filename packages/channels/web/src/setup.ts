/**
 * The page a first run sees when there is no model to talk to.
 *
 * Without it the process prints the reason into a log and exits, and anyone
 * who started this from a Docker Compose file gets a container that restarts
 * forever with the answer buried in `docker compose logs`.
 */
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
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 14px; background: #8882; padding: 6px 8px; border-radius: 6px; display: inline-block; }
  p { margin: 6px 0 0; }
  .docs { opacity: .6; font-size: 14px; margin-top: 24px; }
  a { color: inherit; }
</style>
<main>
  <h1>${escape(options.title)}</h1>
  <p class="reason">${escape(options.reason)}</p>
  <ol>${steps}</ol>
  ${docs}
</main>
</html>`;
}

/**
 * Serves the page and keeps serving it: there is nothing else to do until the
 * gateway it needs exists, and staying up is what tells the user (and Docker)
 * that this is the state the product is in.
 */
export async function serveSetupPage(options: SetupPageOptions): Promise<string> {
	const host = options.host ?? '127.0.0.1';
	const port = options.port ?? 8787;
	const page = setupPage(options);
	const server = createServer((request: IncomingMessage, response: ServerResponse) => {
		const path = (request.url ?? '/').split('?')[0];
		if (path === '/healthz') {
			response.writeHead(200, { 'content-type': 'application/json' });
			response.end('{"ok":false,"reason":"no model"}');
			return;
		}
		response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
		response.end(page);
	});
	await new Promise<void>((resolve) => server.listen(port, host, resolve));
	const address = server.address();
	const shown = typeof address === 'object' && address ? address.port : port;
	return `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${shown}`;
}
