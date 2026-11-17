import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AppBackend } from '@pi-magpie-bot/brain';

/** Bodies everywhere but the message route: a title, a note, a key. */
export const SMALL_BODY = 64 * 1024;
/** The message route takes pictures. */
export const MESSAGE_BODY = 20 * 1024 * 1024;

export interface AppRequest {
	request: IncomingMessage;
	response: ServerResponse;
	/** The method as meant: a POST with `X-HTTP-Method-Override: PATCH` is a PATCH. */
	method: string;
	path: string;
	owner: string;
	app: AppBackend;
	readJson(limit: number): Promise<Record<string, unknown>>;
	json(status: number, body: unknown): void;
}

/** A path segment, decoded; undefined for one that does not decode. */
function segment(raw: string | undefined): string | undefined {
	if (raw === undefined) return undefined;
	try {
		return decodeURIComponent(raw);
	} catch {
		return undefined;
	}
}

/**
 * The native app's routes (docs/app-api.md). Returns false for a path that is
 * not one of them, so the caller can answer 404. Every refusal is thrown as an
 * error with a `status` and a sentence for the user; the caller turns it into
 * `{ error }`.
 */
export async function routeApp(req: AppRequest): Promise<boolean> {
	const { method, path, owner, app } = req;
	const answer = (status: number, body: unknown): true => {
		req.json(status, body);
		return true;
	};

	if (path === '/api/chats') {
		if (method === 'GET') return answer(200, { chats: app.chats(owner) });
		if (method === 'POST') {
			const body = await req.readJson(SMALL_BODY);
			return answer(200, { chat: app.createChat(owner, body.title) });
		}
		return false;
	}

	const chat = /^\/api\/chats\/([^/]+)(\/messages|\/stop)?$/.exec(path);
	if (chat) {
		const id = segment(chat[1]);
		if (id === undefined) return answer(400, { error: 'bad chat id' });
		const tail = chat[2];
		if (!tail && method === 'PATCH') {
			const body = await req.readJson(SMALL_BODY);
			return answer(200, { chat: app.updateChat(owner, id, body) });
		}
		if (!tail && method === 'DELETE') {
			await app.deleteChat(owner, id);
			return answer(200, { ok: true });
		}
		if (tail === '/messages' && method === 'GET') return answer(200, await app.messages(owner, id));
		if (tail === '/messages' && method === 'POST') {
			const body = await req.readJson(MESSAGE_BODY);
			return answer(202, { chat: app.send(owner, id, body) });
		}
		if (tail === '/stop' && method === 'POST') {
			await app.stop(owner, id);
			return answer(200, { ok: true });
		}
		return false;
	}

	const approval = /^\/api\/approvals\/([^/]+)$/.exec(path);
	if (approval && method === 'POST') {
		const body = await req.readJson(SMALL_BODY);
		app.decide(owner, segment(approval[1]) ?? '', body.allow);
		return answer(200, { ok: true });
	}

	if (path === '/api/models' && method === 'GET') return answer(200, app.models());
	if (path === '/api/settings/model' && method === 'PUT') {
		const body = await req.readJson(SMALL_BODY);
		app.setDefaultModel(body.model);
		return answer(200, { ok: true });
	}

	if (path === '/api/schedules') {
		if (method === 'GET') return answer(200, { schedules: app.schedules(owner) });
		if (method === 'POST') {
			const body = await req.readJson(SMALL_BODY);
			return answer(200, { schedule: app.addSchedule(owner, body) });
		}
		return false;
	}
	const schedule = /^\/api\/schedules\/([^/]+)$/.exec(path);
	if (schedule && method === 'DELETE') {
		app.removeSchedule(owner, segment(schedule[1]) ?? '');
		return answer(200, { ok: true });
	}

	if (path === '/api/memory' && method === 'GET') return answer(200, { notes: await app.memory(owner) });
	const note = /^\/api\/memory\/([^/]+)$/.exec(path);
	if (note) {
		const name = segment(note[1]);
		if (!name) return answer(400, { error: 'bad note name' });
		if (method === 'PUT') {
			const body = await req.readJson(SMALL_BODY);
			await app.writeMemory(owner, name, body.content);
			return answer(200, { ok: true });
		}
		if (method === 'DELETE') {
			await app.deleteMemory(owner, name);
			return answer(200, { ok: true });
		}
		return false;
	}

	if (path === '/api/providers') {
		if (method === 'GET') {
			return answer(200, { vendors: app.vendors().map((vendor) => ({ preset: vendor.preset, name: vendor.name, signupUrl: vendor.signupUrl ?? null })) });
		}
		if (method === 'POST') {
			const body = await req.readJson(SMALL_BODY);
			const note = await app.saveProvider(body.preset, body.key);
			// The new models load at the next start: restart once the answer is
			// out, not before, or the app never hears that it worked.
			req.response.once('finish', () => app.restart());
			return answer(200, { ok: true, note });
		}
		return false;
	}

	return false;
}
