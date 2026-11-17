import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/store.ts';

const store = async () => new MemoryStore(await mkdtemp(join(tmpdir(), 'memory-')));

describe('memory store', () => {
	it('keeps one index line per note and never loads the notes themselves', async () => {
		const memory = await store();
		await memory.writeNote('c1', 'work-hours', 'The user works 08:00 to 17:00 on weekdays.');
		await memory.writeNote('c1', 'work-hours', 'The user works 09:00 to 18:00.');

		const index = await memory.readIndex('c1');
		expect(index.trim().split('\n')).toHaveLength(1);
		expect(index).toContain('work-hours: The user works 09:00 to 18:00.');
		expect(await memory.readNote('c1', 'work-hours')).toContain('09:00');
	});

	it('does not let a note called index overwrite the index', async () => {
		const memory = await store();
		await memory.writeNote('c1', 'work-hours', 'The user works 09:00 to 18:00.');
		await memory.writeNote('c1', 'index', 'hello');

		const index = await memory.readIndex('c1');
		expect(index).toContain('work-hours: The user works 09:00 to 18:00.');
		expect(index).toContain('hello');
	});

	it('finds a note by what it says', async () => {
		const memory = await store();
		await memory.writeNote('c1', 'car', 'The car is a blue BYD, plate ending 88.');
		await memory.writeNote('c1', 'cat', 'The cat is called Doubao.');

		const hits = await memory.search('c1', 'byd');
		expect(hits.map((hit) => hit.name)).toEqual(['car']);
		expect(await memory.search('c1', 'nothing here')).toEqual([]);
	});

	it('cannot be talked out of its directory by a note name', async () => {
		const memory = await store();
		await memory.writeNote('c1', '../../etc/passwd', 'x');
		expect(await memory.listNotes('c1')).toEqual(['etc-passwd']);
	});

	it('keeps conversations apart, and accepts the runtime numeric id', async () => {
		const memory = await store();
		await memory.writeNote('c1', 'name', 'Zhang');
		await memory.writeNote(7, 'name', 'Li');

		expect(await memory.readNote('c1', 'name')).toBe('Zhang');
		expect(await memory.readNote(7, 'name')).toBe('Li');
	});

	it('loads instructions every run, and nothing when empty', async () => {
		const memory = await store();
		expect(await memory.readInstructions('c1')).toBe('');
		await memory.writeInstructions('c1', 'Always answer in Chinese.');
		expect(await memory.readInstructions('c1')).toBe('Always answer in Chinese.');
	});
});

describe('parallel writes', () => {
	it('keeps every note in the index when several are written at once', async () => {
		const memory = await store();
		// The model can issue these in one round with tools running in parallel.
		// The index is read-modify-write, so an unserialised run loses all but one.
		await Promise.all([
			memory.writeNote('c1', 'allergy', '花生过敏'),
			memory.writeNote('c1', 'car', '蓝色比亚迪'),
			memory.writeNote('c1', 'hours', '九点上班'),
		]);

		const index = await memory.readIndex('c1');
		for (const name of ['allergy', 'car', 'hours']) {
			expect(index).toContain(`- ${name}:`);
		}
		// The note bodies are all there too.
		expect((await memory.listNotes('c1')).sort()).toEqual(['allergy', 'car', 'hours']);
	});

	it('still works after one write throws', async () => {
		const memory = await store();
		// An empty name is rejected before the queue; the next write must go through.
		await expect(memory.writeNote('c1', '   ', 'x')).rejects.toThrow();
		await memory.writeNote('c1', 'ok', 'fine');
		expect(await memory.readNote('c1', 'ok')).toBe('fine');
	});
});
