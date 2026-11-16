import { describe, expect, it } from 'vitest';
import { stamp } from '../src/chat-extension.ts';

describe('the clock the model is shown', () => {
	it('keeps its offset, so a time the model writes back means the same moment', () => {
		const at = Date.UTC(2026, 10, 17, 7, 0, 0);
		const text = stamp(at);
		expect(text).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
		expect(Date.parse(text)).toBe(at);
	});
});
