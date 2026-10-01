/**
 * Context size extension - report the current context usage of the session.
 *
 * Registers:
 * - `context_size` tool - the agent can call it to find out how full the
 *   context is (used tokens, context window, usage percentage, free tokens).
 * - `/context-size` command - prints the same information as a notification.
 */

import type { ContextUsage, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const PARAMETERS = Type.Object({});

function formatNumber(n: number): string {
	return n.toLocaleString("en-US");
}

function describeUsage(usage: ContextUsage): string {
	if (usage.tokens === null) {
		return [
			"Context usage: unknown (available after the next LLM response)",
			`Context window: ${formatNumber(usage.contextWindow)} tokens`,
		]
			.filter(Boolean)
			.join("\n");
	}

	const percent = usage.percent ?? (usage.tokens / usage.contextWindow) * 100;
	const free = Math.max(0, usage.contextWindow - usage.tokens);

	return [
		`Context usage: ${formatNumber(usage.tokens)} / ${formatNumber(usage.contextWindow)} tokens (${percent.toFixed(1)}%)`,
		`Free: ${formatNumber(free)} tokens`,
	]
		.filter(Boolean)
		.join("\n");
}

export default function contextSizeExtension(pi: ExtensionAPI) {
	const report = (ctx: ExtensionContext): string => {
		const usage = ctx.getContextUsage();
		if (!usage) {
			return "Context usage: unknown (no active model)";
		}
		return describeUsage(usage);
	};

	pi.registerTool({
		name: "context_size",
		label: "Context Size",
		description:
			"Returns the current context size of this session: used tokens, the active model's context window, the usage percentage, and remaining free tokens. Call it when the user asks how much context is in use, how full the context is, or how much room is left before compaction.",
		parameters: PARAMETERS,
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			return {
				content: [{ type: "text", text: report(ctx) }],
				details: {},
			};
		},
	});

	pi.registerCommand("context-size", {
		description: "Show the current context usage of this session",
		handler: async (_args, ctx) => {
			ctx.ui.notify(report(ctx), "info");
		},
	});
}
