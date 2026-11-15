import type { Approvals, Outbox, Targets } from '@pi-magpie-bot/events';

export interface ApprovalGateOptions {
	approvals: Approvals;
	outbox: Outbox;
	targets: Targets;
	/** How long a card waits for an answer before it counts as refused. */
	timeoutMs?: number;
	/** Poll interval; the row is the state, so a restart only loses the wait. */
	pollMs?: number;
	sleep?: (ms: number) => Promise<void>;
}

export interface ApprovalDecision {
	allowed: boolean;
	detail: string;
}

/**
 * Park a risky call until the user answers in the chat. The question is a row
 * and the answer is a message, so nothing here holds state a restart would
 * lose: the tool just asks again and finds the same row.
 */
export async function askApproval(
	options: ApprovalGateOptions,
	conversationId: string | number,
	action: string,
): Promise<ApprovalDecision> {
	const chat = options.targets.getByAgent(conversationId);
	if (!chat) return { allowed: false, detail: 'this conversation has no chat to ask' };

	const id = options.approvals.ask({
		conversation: chat.conversation,
		channel: chat.channel,
		target: chat.target,
		action,
	});
	options.outbox.enqueue({
		conversation: chat.conversation,
		channel: chat.channel,
		target: chat.target,
		text: `⚠️ 需要你同意才能继续 / needs your approval:\n${action}\n\n回复「是」执行，回「否」取消 / reply "yes" to run it, "no" to drop it（5 分钟内不回复即取消 / dropped after 5 minutes）`,
	});

	const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const deadline = Date.now() + (options.timeoutMs ?? 5 * 60_000);
	const pollMs = options.pollMs ?? 1_000;

	for (;;) {
		const row = options.approvals.get(id);
		if (!row) return { allowed: false, detail: 'the question disappeared' };
		if (row.status === 'allowed') return { allowed: true, detail: 'the user approved it' };
		if (row.status === 'denied') return { allowed: false, detail: 'the user refused it' };
		if (row.status === 'expired') return { allowed: false, detail: 'nobody answered in time' };
		if (Date.now() >= deadline) {
			options.approvals.decide(id, 'expired');
			return { allowed: false, detail: 'nobody answered in time' };
		}
		await sleep(pollMs);
	}
}
