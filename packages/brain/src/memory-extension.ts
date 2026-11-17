import { defineExtension, defineTool, section, type Extension } from '@earendil-works/pi-durable';
import { obj, opt, str } from '@earendil-works/pi-schema';
import type { ConversationKey, MemoryStore } from '@pi-magpie-bot/memory';

/** A tool's answer, as the transcript stores it. */
const reply = (text: string, isError = false) => ({
	output: [{ type: 'text' as const, text }],
	...(isError ? { isError: true } : {}),
});

/**
 * Memory as tools the model reaches for, plus one prompt section that only
 * carries the index. The notes themselves stay on disk until asked for.
 *
 * `scope` says whose notes a conversation reads and writes; without it, each
 * conversation keeps its own. The bot passes one that gives every chat of the
 * same person the same notes.
 */
export function createMemoryExtension(
	store: MemoryStore,
	scope: (conversationId: number) => ConversationKey | Promise<ConversationKey> = (conversationId) => conversationId,
): Extension {
	const key = (conversationId: unknown) => scope(Number(conversationId));
	return defineExtension({
		name: 'memory',
		tools: [
			defineTool({
				name: 'memory_write',
				description:
					'Save one durable fact about the user (who they are, what they prefer, a decision they made that should hold next time). One note per fact; writing the same name again replaces it.',
				parameters: obj({
					name: str({ description: 'Short slug, e.g. "work-hours" or "prefers-short-answers".' }),
					content: str({ description: 'The fact, in full sentences.' }),
				}),
				async execute(args, api) {
					await store.writeNote(await key(api.conversationId), args.name, args.content);
					return reply(`remembered "${args.name}"`);
				},
			}),
			defineTool({
				name: 'memory_read',
				description: 'Read a saved note in full, by the name the memory index shows.',
				parameters: obj({ name: str() }),
				async execute(args, api) {
					const content = await store.readNote(await key(api.conversationId), args.name);
					return reply(content || `no note named "${args.name}"`);
				},
			}),
			defineTool({
				name: 'memory_search',
				description: 'Find notes by what they say, for when the index is not enough.',
				parameters: obj({ query: str() }),
				async execute(args, api) {
					const hits = await store.search(await key(api.conversationId), args.query);
					if (hits.length === 0) return reply('nothing found');
					return reply(hits.map((hit) => `${hit.name}\n${hit.snippet}`).join('\n\n'));
				},
			}),
		],
		sections: [
			section('memory', async (input) => {
				const owner = await key(input.conversationId);
				const [instructions, index] = await Promise.all([store.readInstructions(owner), store.readIndex(owner)]);
				const parts: string[] = [];
				if (instructions.trim()) parts.push(`What the user asked you to always do:\n${instructions.trim()}`);
				if (index.trim()) parts.push(`Your saved notes (read one with memory_read):\n${index.trim()}`);
				return parts.length > 0 ? parts.join('\n\n') : undefined;
			}),
		],
	});
}
