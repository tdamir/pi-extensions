/**
 * Handoff extension - transfer context to a new focused session
 *
 * Instead of compacting (which is lossy), handoff extracts what matters
 * for your next task and creates a new session with a generated prompt.
 *
 * Two modes:
 * - /handoff <goal>       Compaction-aware: sends the compaction summary plus
 *   kept entries (serialized as text) with a dedicated summarizer system prompt.
 * - /handoff full <goal>   Sends the full session with the active system prompt
 *   and tools replicated, leveraging provider-side prompt caching. Subsequent
 *   calls benefit from cache hits on the shared conversation prefix.
 *
 * Usage:
 *   /handoff now implement this for teams as well
 *   /handoff execute phase one of the plan
 *   /handoff full check other places that need this fix
 *
 * The generated prompt appears as a draft in the editor for review/editing.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { complete, type Message } from "@earendil-works/pi-ai";
import { complete as completeCompat, getModel } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { BorderedLoader, convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";

type HandoffMode = "compact" | "full";

const SYSTEM_PROMPT = `You are a context transfer assistant. Given a conversation history and the user's goal for a new thread, generate a focused prompt that:

1. Summarizes relevant context from the conversation (decisions made, approaches taken, key findings)
2. Lists any relevant files that were discussed or modified
3. Clearly states the next task based on the user's goal
4. Is self-contained - the new thread should be able to proceed without the old conversation

Format your response as a prompt the user can send to start the new thread. Be concise but include all necessary context. Do not include any preamble like "Here's the prompt" - just output the prompt itself.

Example output format:
## Context
We've been working on X. Key decisions:
- Decision 1
- Decision 2

Files involved:
- path/to/file1.ts
- path/to/file2.ts

## Task
[Clear description of what to do next based on user's goal]`;

const HANDOFF_INSTRUCTIONS = [
	"Please generate a focused handoff prompt for a new session based on our conversation.",
	"The prompt should:",
	"1. Summarize relevant context (decisions made, approaches taken, key findings)",
	"2. List any relevant files that were discussed or modified",
	"3. Clearly state the next task based on my goal",
	"4. Be self-contained so the new thread can proceed without this conversation",
	"",
	"Format as a prompt ready to send. Be concise but include all necessary context.",
	'Do not include any preamble like "Here is the prompt" - just output the prompt itself.',
	"",
	"Example output format:",
	"## Context",
	"We have been working on X. Key decisions:",
	"- Decision 1",
	"- Decision 2",
	"",
	"Files involved:",
	"- path/to/file1.ts",
	"- path/to/file2.ts",
	"",
	"## Task",
	"[Clear description of what to do next]",
].join("\n");

function entryToMessage(entry: SessionEntry): AgentMessage | undefined {
	if (entry.type === "message") {
		return entry.message;
	}
	if (entry.type === "compaction") {
		return {
			role: "compactionSummary",
			summary: entry.summary,
			tokensBefore: entry.tokensBefore,
			timestamp: new Date(entry.timestamp).getTime(),
		};
	}
	return undefined;
}

/** Compaction-aware: summary + entries from firstKeptEntryId onward. */
function getHandoffMessages(branch: SessionEntry[]): AgentMessage[] {
	let compactionIndex = -1;
	for (let i = branch.length - 1; i >= 0; i--) {
		if (branch[i].type === "compaction") {
			compactionIndex = i;
			break;
		}
	}
	if (compactionIndex < 0) {
		return branch.map(entryToMessage).filter((message) => message !== undefined);
	}

	const compaction = branch[compactionIndex];
	const firstKeptIndex =
		compaction.type === "compaction" ? branch.findIndex((entry) => entry.id === compaction.firstKeptEntryId) : -1;
	const compactedBranch = [
		compaction,
		...(firstKeptIndex >= 0 ? branch.slice(firstKeptIndex, compactionIndex) : []),
		...branch.slice(compactionIndex + 1),
	];
	return compactedBranch.map(entryToMessage).filter((message) => message !== undefined);
}

/** Full mode: only raw messages, sent verbatim for prompt-cache reuse. */
function getFullMessages(branch: SessionEntry[]): AgentMessage[] {
	return branch
		.map((entry) => (entry.type === "message" ? entry.message : undefined))
		.filter((message): message is AgentMessage => message !== undefined);
}

function getSessionId(sessionFile: string | undefined): string | undefined {
	return sessionFile ? sessionFile.replace(/[^a-zA-Z0-9_-]/g, "") : undefined;
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("handoff", {
		description:
			"Transfer context to a new focused session (use 'full' as first word to send the whole session for prompt caching)",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("handoff requires interactive mode", "error");
				return;
			}

			// Parse optional "full" mode flag
			let mode: HandoffMode = "compact";
			let goal = args.trim();
			const fullMatch = goal.match(/^(?:full|--full)\s+([\s\S]+)$/i);
			if (/^(?:full|--full)$/i.test(goal)) {
				ctx.ui.notify("Usage: /handoff [full] <goal for new thread>", "error");
				return;
			}
			if (fullMatch) {
				mode = "full";
				goal = fullMatch[1].trim();
			}
			if (!goal) {
				ctx.ui.notify("Usage: /handoff [full] <goal for new thread>", "error");
				return;
			}

			const branch = ctx.sessionManager.getBranch();
			const currentSessionFile = ctx.sessionManager.getSessionFile();

			// Prepare the completion request for the requested mode (auth already verified)
			let doGenerate: (signal: AbortSignal) => Promise<string | null>;

			if (mode === "compact") {
				// Gather conversation context from current branch. If the branch was compacted,
				// include the compaction summary plus entries from firstKeptEntryId onward.
				const messages = getHandoffMessages(branch);
				if (messages.length === 0) {
					ctx.ui.notify("No conversation to hand off", "error");
					return;
				}

				if (!ctx.model) {
					ctx.ui.notify("No model selected", "error");
					return;
				}
				const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
				if (!auth.ok || !auth.apiKey) {
					ctx.ui.notify(`Model error: ${auth.ok ? `No API key for ${ctx.model.provider}` : auth.error}`, "error");
					return;
				}

				// Convert to LLM format and serialize
				const conversationText = serializeConversation(convertToLlm(messages));
				const model = ctx.model;

				doGenerate = async (signal) => {
					const userMessage: Message = {
						role: "user",
						content: [
							{
								type: "text",
							text: `## Conversation History\n\n${conversationText}\n\n## User's Goal for New Thread\n\n${goal}`,
							},
						],
						timestamp: Date.now(),
					};

					const response = await complete(
						model,
						{ systemPrompt: SYSTEM_PROMPT, messages: [userMessage] },
						{ apiKey: auth.apiKey, headers: auth.headers, signal },
					);
					if (response.stopReason === "aborted") {
						return null;
					}
					return response.content
						.filter((c): c is { type: "text"; text: string } => c.type === "text")
						.map((c) => c.text)
						.join("\n");
				};
			} else {
				// Full mode: send the whole session to leverage provider-side prompt caching.
				const messages = getFullMessages(branch);
				if (messages.length === 0) {
					ctx.ui.notify("No conversation to hand off", "error");
					return;
				}

				// Replicate active tools so the request matches the cached conversation prefix
				const activeToolNames = pi.getActiveTools();
				const allTools = pi.getAllTools();
				const tools = allTools
					.filter((t) => activeToolNames.includes(t.name))
					.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));

				// Prefer the current model; fall back to a lightweight option
				const model = ctx.model;
				if (!model) {
					ctx.ui.notify("No model available", "error");
					return;
				}
				const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
				if (!auth.ok) {
					ctx.ui.notify(`Model error: ${auth.error}`, "error");
					return;
				}
				if (!auth.apiKey) {
					ctx.ui.notify(`No API key for ${model.provider}/${model.id}`, "error");
					return;
				}

				doGenerate = async (signal) => {
					const response = await completeCompat(
						model,
						{
							systemPrompt: ctx.getSystemPrompt(),
							messages: [
								...messages,
								{
									role: "user" as const,
									content: [{ type: "text" as const, text: `${HANDOFF_INSTRUCTIONS}\n\n## User's Goal for New Thread\n\n${goal}` }],
									timestamp: Date.now(),
								},
							],
							tools,
						},
						{
							apiKey: auth.apiKey,
							headers: auth.headers,
							env: auth.env,
							reasoningEffort: "none",
							sessionId: getSessionId(currentSessionFile),
							signal,
						},
					);
					if (response.stopReason === "aborted") {
						return null;
					}
					return response.content
						.filter((c): c is { type: "text"; text: string } => c.type === "text")
						.map((c) => c.text)
						.join("\n");
				};
			}

			// Generate the handoff prompt with loader UI
			const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
				const loader = new BorderedLoader(tui, theme, `Generating handoff prompt...`);
				loader.onAbort = () => done(null);

				doGenerate(loader.signal)
					.then(done)
					.catch((err) => {
						console.error("Handoff generation failed:", err);
						done(null);
					});

				return loader;
			});

			if (result === null) {
				ctx.ui.notify("Cancelled", "info");
				return;
			}

			// Let user edit the generated prompt
			const editedPrompt = await ctx.ui.editor("Edit handoff prompt", result);

			if (editedPrompt === undefined) {
				ctx.ui.notify("Cancelled", "info");
				return;
			}

			// Create new session with parent tracking. Use the replacement-session
			// context for post-switch UI work; the original ctx is stale after a
			// successful session replacement.
			const newSessionResult = await ctx.newSession({
				parentSession: currentSessionFile,
				withSession: async (replacementCtx) => {
					replacementCtx.ui.setEditorText(editedPrompt);
					replacementCtx.ui.notify("Handoff ready. Submit when ready.", "info");
				},
			});

			if (newSessionResult.cancelled) {
				ctx.ui.notify("New session cancelled", "info");
			}
		},
	});
}
