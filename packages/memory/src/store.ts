import { cp, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Memory is a directory per scope on disk (one person, across all their chats),
 * so it outlives any process and a user can read and edit it with a text editor.
 *
 * Layout under `<root>/<scope>/`:
 *   instructions.md   what the user told the agent to always do (loaded every run)
 *   notes/index.md    one line per note (loaded every run)
 *   notes/<slug>.md   one fact each (loaded only when the agent asks)
 *   tasks/<slug>.md   progress of work not finished yet
 *
 * Only the index goes into every run: a long-lived agent accumulates notes,
 * and loading all of them would spend the context it needs for the answer.
 */
/** A conversation id: a chat key from the host, or the number pi-durable mints. */
export type ConversationKey = string | number;

export class MemoryStore {
	private readonly root: string;
	/**
	 * One write at a time per conversation. The index is read, edited and written
	 * back, and the model may issue two memory_write calls in the same round: in
	 * parallel, the second write would start from the index the first one read,
	 * and one fact would vanish from the prompt for good while its note file sat
	 * on disk looking fine.
	 */
	private readonly queues = new Map<string, Promise<unknown>>();

	constructor(root: string) {
		this.root = root;
	}

	/** Runs `work` after whatever is already queued for this conversation. */
	private serialized<T>(conversationId: ConversationKey, work: () => Promise<T>): Promise<T> {
		const key = String(conversationId);
		const before = this.queues.get(key) ?? Promise.resolve();
		// Run whether the previous one settled or threw: one failed write must not
		// wedge the queue forever.
		const run = before.then(work, work);
		const tail = run.then(
			() => undefined,
			() => undefined,
		);
		this.queues.set(key, tail);
		void tail.then(() => {
			// Only the last one clears it, so a queued write keeps its place.
			if (this.queues.get(key) === tail) this.queues.delete(key);
		});
		return run;
	}

	/** Guards the filesystem: a note name is a slug, never a path. */
	private static slug(name: string): string {
		const cleaned = name
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9\u4e00-\u9fff_-]+/g, '-')
			.replace(/^-+|-+$/g, '');
		if (!cleaned) throw new Error('a note needs a name of letters, digits, - or _');
		const slug = cleaned.slice(0, 80);
		// `index` is the file that lists the notes; a note by that name would replace it.
		return slug === 'index' ? 'index-note' : slug;
	}

	private dir(conversationId: ConversationKey): string {
		return join(this.root, String(conversationId).replace(/[^A-Za-z0-9_-]/g, '_'));
	}

	private async read(path: string): Promise<string> {
		try {
			return await readFile(path, 'utf8');
		} catch {
			return '';
		}
	}

	private async write(path: string, text: string): Promise<void> {
		await mkdir(join(path, '..'), { recursive: true });
		// Written aside and moved into place: a crash between truncate and write
		// would otherwise leave a half note, and the index lists what it reads.
		const temporary = `${path}.tmp`;
		await writeFile(temporary, text, 'utf8');
		await rename(temporary, path);
	}

	readInstructions(conversationId: ConversationKey): Promise<string> {
		return this.read(join(this.dir(conversationId), 'instructions.md'));
	}

	writeInstructions(conversationId: ConversationKey, text: string): Promise<void> {
		return this.write(join(this.dir(conversationId), 'instructions.md'), text);
	}

	readIndex(conversationId: ConversationKey): Promise<string> {
		return this.read(join(this.dir(conversationId), 'notes', 'index.md'));
	}

	readNote(conversationId: ConversationKey, name: string): Promise<string> {
		return this.read(join(this.dir(conversationId), 'notes', `${MemoryStore.slug(name)}.md`));
	}

	/** Writes the note and keeps the index one line per note, so loading it stays cheap. */
	async writeNote(conversationId: ConversationKey, name: string, text: string): Promise<void> {
		const slug = MemoryStore.slug(name);
		const dir = this.dir(conversationId);
		// Queued, because the index below is read-modify-write and two calls in the
		// same model round would otherwise overwrite each other's line.
		await this.serialized(conversationId, async () => {
			await this.write(join(dir, 'notes', `${slug}.md`), text);

			const index = await this.readIndex(conversationId);
			const line = `- ${slug}: ${firstLine(text)}`;
			const lines = index.split('\n').filter((existing) => existing.trim() && !existing.startsWith(`- ${slug}:`));
			lines.push(line);
			await this.write(join(dir, 'notes', 'index.md'), `${lines.join('\n')}\n`);
		});
	}

	/**
	 * Forget one note: its file and its line in the index. False when there was
	 * no such note.
	 */
	async deleteNote(conversationId: ConversationKey, name: string): Promise<boolean> {
		const slug = MemoryStore.slug(name);
		const dir = this.dir(conversationId);
		return await this.serialized(conversationId, async () => {
			let existed = true;
			try {
				await unlink(join(dir, 'notes', `${slug}.md`));
			} catch {
				existed = false;
			}
			const index = await this.readIndex(conversationId);
			const lines = index.split('\n').filter((line) => line.trim());
			const kept = lines.filter((line) => !line.startsWith(`- ${slug}:`));
			if (kept.length !== lines.length) {
				existed = true;
				await this.write(join(dir, 'notes', 'index.md'), kept.length > 0 ? `${kept.join('\n')}\n` : '');
			}
			return existed;
		});
	}

	/**
	 * Start `to` as a copy of `from`, once: when memory moves to a wider scope
	 * (one person instead of one chat), the notes of the old scope come along.
	 * Nothing happens when `to` already exists or `from` does not.
	 */
	async adopt(from: ConversationKey, to: ConversationKey): Promise<boolean> {
		const source = this.dir(from);
		const target = this.dir(to);
		if (source === target || (await exists(target)) || !(await exists(source))) return false;
		await cp(source, target, { recursive: true, errorOnExist: false, force: false });
		return true;
	}

	async listNotes(conversationId: ConversationKey): Promise<string[]> {
		try {
			const files = await readdir(join(this.dir(conversationId), 'notes'));
			return files.filter((file) => file.endsWith('.md') && file !== 'index.md').map((file) => file.slice(0, -3));
		} catch {
			return [];
		}
	}

	/** A substring search over notes: enough for thousands of small files, no index to keep in sync. */
	async search(conversationId: ConversationKey, query: string, limit = 10): Promise<{ name: string; snippet: string }[]> {
		const needle = query.toLowerCase();
		const hits: { name: string; snippet: string }[] = [];
		for (const name of await this.listNotes(conversationId)) {
			const text = await this.readNote(conversationId, name);
			const at = text.toLowerCase().indexOf(needle);
			if (at < 0) continue;
			hits.push({ name, snippet: text.slice(Math.max(0, at - 80), at + 160) });
			if (hits.length >= limit) break;
		}
		return hits;
	}

	readTask(conversationId: ConversationKey, name: string): Promise<string> {
		return this.read(join(this.dir(conversationId), 'tasks', `${MemoryStore.slug(name)}.md`));
	}

	writeTask(conversationId: ConversationKey, name: string, text: string): Promise<void> {
		return this.write(join(this.dir(conversationId), 'tasks', `${MemoryStore.slug(name)}.md`), text);
	}
}

async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

function firstLine(text: string): string {
	const line = text.trim().split('\n')[0] ?? '';
	return line.length > 100 ? `${line.slice(0, 100)}…` : line;
}
