import { defineExtension, type Extension, type ToolRegistration, type Wrap } from '@earendil-works/pi-durable';
import { askApproval, type ApprovalGateOptions } from './approval.ts';

/** One line for the card: what the call would actually do. */
function describe(name: string, args: unknown): string {
	const input = (args ?? {}) as Record<string, unknown>;
	const first = (key: string) => (typeof input[key] === 'string' ? (input[key] as string) : undefined);
	const path = first('path');
	switch (name) {
		case 'bash':
			return `执行命令：\n${first('command') ?? '(no command)'}`;
		case 'write':
			return `写入文件 ${path ?? '?'}（${String(first('content') ?? '').length} 字）`;
		case 'edit':
			return `修改文件 ${path ?? '?'}`;
		default:
			return `运行工具 ${name}`;
	}
}

/**
 * Tools that can change the machine ask first. They are the ones pi-durable
 * ships as `CodingTools`; this wraps them by name, so the extension installs
 * whether or not those tools do.
 */
export function createApprovalExtension(name: string, options: ApprovalGateOptions): Extension {
	const wrap = (tool: ToolRegistration): ToolRegistration => ({
		...tool,
		async execute(args, api, context) {
			const decision = await askApproval(options, api.conversationId, describe(tool.name, args));
			if (!decision.allowed) {
				return {
					output: [{ type: 'text', text: `没有执行：${decision.detail}。` }],
					isError: true,
				};
			}
			return tool.execute(args, api, context);
		},
	});

	return defineExtension({
		name,
		wraps: [wrapToolName('bash', wrap), wrapToolName('write', wrap), wrapToolName('edit', wrap)],
	});
}

function wrapToolName(tool: string, wrap: (tool: ToolRegistration) => ToolRegistration): Wrap {
	return { tool, wrap };
}
