import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Memory is a directory per conversation on disk, so it outlives any process
 * and a user can read and edit it with a text editor.
 *
 * Layout under `<root>/<conversation>/`:
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

	constructor(root: string) {
		this.root = root;
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
		await writeFile(path, text, 'utf8');
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
		await this.write(join(dir, 'notes', `${slug}.md`), text);

		const index = await this.readIndex(conversationId);
		const line = `- ${slug}: ${firstLine(text)}`;
		const lines = index.split('\n').filter((existing) => existing.trim() && !existing.startsWith(`- ${slug}:`));
		lines.push(line);
		await this.write(join(dir, 'notes', 'index.md'), `${lines.join('\n')}\n`);
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

function firstLine(text: string): string {
	const line = text.trim().split('\n')[0] ?? '';
	return line.length > 100 ? `${line.slice(0, 100)}…` : line;
}
