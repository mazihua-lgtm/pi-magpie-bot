import type { Message } from '@earendil-works/pi-ai';
import type { ContextView, ConversationView, LiveState } from '@earendil-works/pi-durable';
import { toolLabel } from './tool-labels.ts';

/** One bubble of a chat, as an app shows it. */
export interface AppMessage {
	id: string;
	role: 'user' | 'assistant';
	text: string;
	thinking?: string;
	/** data: URIs. */
	images?: string[];
	tools?: Array<{ name: string; label: string }>;
	at?: number;
}

/** The answer being written, as far as it has got. */
export interface LivePartial {
	text: string;
	thinking: string;
	tools: Array<{ name: string; label: string; done: boolean }>;
}

/** What a fired reminder looks like inside the conversation (see `Bot.fireDueSchedules`). */
const REMINDER_INPUT = /^\[定时任务触发\] /gm;

/**
 * What the model answers to a reminder that needs no words of its own (see the
 * system prompt): the reminder already went out, so the answer is silence.
 */
export const NO_REPLY = 'NO_REPLY';

export const isNoReply = (text: string): boolean => text.trim().replace(/[。.!！]+$/, '') === NO_REPLY;

type Part = { type: string; text?: string; thinking?: string; name?: string; arguments?: unknown; id?: string; data?: string; mimeType?: string };

function partsOf(message: { content?: unknown }): Part[] {
	if (typeof message.content === 'string') return [{ type: 'text', text: message.content }];
	return Array.isArray(message.content) ? (message.content as Part[]) : [];
}

const joined = (a: string, b: string) => (a && b ? `${a}\n\n${b}` : a || b);

/**
 * A conversation's context as chat bubbles, oldest first. One run is one
 * assistant bubble however many tool rounds it took: its words, its thinking
 * and the tools it used, folded together. Tool results and system notes are
 * machinery and stay out; a reminder that woke the agent shows as the reminder.
 */
export function appMessages(view: Pick<ContextView, 'entries' | 'contributions'>, limit = 200): AppMessage[] {
	const out: AppMessage[] = [];
	let open: AppMessage | undefined;

	view.entries.forEach((entry, index) => {
		const messages = (view.contributions[index] ?? []) as readonly Message[];
		messages.forEach((message, part) => {
			const id = part === 0 ? String(entry.id) : `${String(entry.id)}.${part}`;
			if (message.role === 'user') {
				open = undefined;
				const parts = partsOf(message);
				const text = parts
					.filter((item) => item.type === 'text')
					.map((item) => item.text ?? '')
					.join('');
				const images = parts
					.filter((item) => item.type === 'image' && item.data && item.mimeType)
					.map((item) => `data:${item.mimeType};base64,${item.data}`);
				if (text.startsWith('[定时任务触发] ')) {
					out.push({ id, role: 'assistant', text: text.replace(REMINDER_INPUT, '⏰ '), at: message.timestamp });
					return;
				}
				if (!text.trim() && images.length === 0) return;
				out.push({ id, role: 'user', text, ...(images.length > 0 ? { images } : {}), at: message.timestamp });
				return;
			}
			if (message.role !== 'assistant') return;
			if (!open) {
				open = { id, role: 'assistant', text: '', at: message.timestamp };
				out.push(open);
			}
			const bubble = open;
			for (const item of partsOf(message)) {
				if (item.type === 'text' && item.text) bubble.text = joined(bubble.text, item.text);
				else if (item.type === 'thinking' && item.thinking) bubble.thinking = joined(bubble.thinking ?? '', item.thinking);
				else if (item.type === 'toolCall' && item.name === 'send_message') {
					// A line said on the way reached the user as words; it stays words.
					const said = (item.arguments as { text?: unknown } | undefined)?.text;
					if (typeof said === 'string' && said.trim()) bubble.text = joined(bubble.text, said);
				} else if (item.type === 'toolCall' && item.name) {
					(bubble.tools ??= []).push({ name: item.name, label: toolLabel(item.name, item.arguments) });
				}
			}
		});
	});

	for (const message of out) if (message.role === 'assistant' && isNoReply(message.text)) message.text = '';
	return out
		.filter((message) => message.role === 'user' || message.text.trim() || message.thinking || message.tools)
		.slice(-limit);
}

/**
 * What the run in progress has produced since entry `after`: the rounds it
 * already committed, then the generation still streaming. Tool calls are
 * `done` once their result is in, or once the live tool slot says so.
 */
export function livePartial(view: Pick<ConversationView, 'entries' | 'docs'>, after: number): LivePartial {
	const partial: LivePartial = { text: '', thinking: '', tools: [] };
	const byCall = new Map<string, LivePartial['tools'][number]>();
	const add = (message: { content?: unknown }) => {
		for (const item of partsOf(message)) {
			if (item.type === 'text' && item.text) partial.text = joined(partial.text, item.text);
			else if (item.type === 'thinking' && item.thinking) partial.thinking = joined(partial.thinking, item.thinking);
			else if (item.type === 'toolCall' && item.name) {
				const known = item.id ? byCall.get(item.id) : undefined;
				if (known) continue;
				const tool = { name: item.name, label: toolLabel(item.name, item.arguments), done: false };
				partial.tools.push(tool);
				if (item.id) byCall.set(item.id, tool);
			}
		}
	};

	for (const entry of view.entries) {
		if (Number(entry.id) <= after) continue;
		for (const message of entry.model ?? []) {
			if (message.role === 'assistant') add(message);
			else if (message.role === 'toolResult') {
				const tool = byCall.get(message.toolCallId);
				if (tool) tool.done = true;
			}
		}
	}

	const live = view.docs['pi.live'] as LiveState | undefined;
	if (live?.generation?.message) add(live.generation.message as { content?: unknown });
	for (const slot of live?.tools ?? []) {
		const tool = byCall.get(slot.callId);
		if (tool && slot.status === 'done') tool.done = true;
	}
	if (NO_REPLY.startsWith(partial.text.trim()) && partial.text.trim()) partial.text = '';
	return partial;
}
