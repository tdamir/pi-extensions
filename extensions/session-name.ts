/**
 * Auto-generate session names from conversation context.
 *
 * Two strategies:
 *   fresh (default) - Sends only a short excerpt (first user messages) with no cached
 *              prefix, a cheaper/cleaner request for a from-scratch name.
 *   full             - Sends the full session to leverage provider-side prompt caching.
 *              Subsequent calls benefit from cache hits on the shared conversation prefix.
 *
 * Usage:
 *   /session-name              - Generate a name (fresh short-excerpt context)
 *   /session-name full           - Generate a name (full-session context, cached)
 *   /session-name "My Name"      - Set the session name manually
 *   /session-name show           - Show the current session name
 */

import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";
import { complete } from "@earendil-works/pi-ai/compat";

const NAME_PROMPT = `Generate a concise session name (3-6 words) for this conversation.
The first user message is the main topic — base the name on it but consider the overall conversation.
Use title case. No quotes, no prefix — just the name.
If coding, mention the key action: refactor, debug, create, migrate, etc.
Respond with ONLY the name, nothing else.`;

type Strategy = "fresh" | "full";

function extractText(content: unknown): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
        .filter((p): p is { type: "text"; text: string } =>
            typeof p === "object" && p != null && "type" in p && p.type === "text" && typeof p.text === "string"
        )
        .map((p) => p.text)
        .join("\n");
}

/** Full branch as messages (for the full strategy). */
function buildMessages(branch: SessionEntry[]): Message[] {
    const messages: Message[] = [];
    for (const entry of branch) {
        if (entry?.type === "message") {
            messages.push(entry.message);
        }
    }
    return messages;
}

/** Short excerpt of the first user messages (for the fresh strategy). */
function buildConversationExcerpt(entries: SessionEntry[]): string {
    const parts: string[] = [];
    let count = 0;

    for (const entry of entries) {
        if (entry.type !== "message") continue;
        const msg = entry.message;
        if (!msg || msg.role !== "user") continue;
        if (count >= 3) break;
        count++;

        const text = extractText(msg.content).trim();
        if (text) parts.push(text);
    }

    return parts.join("\n\n");
}

function getSessionId(ctx: any): string | undefined {
    const file = ctx.sessionManager.getSessionFile();
    return file ? file.replace(/[^a-zA-Z0-9_-]/g, "") : undefined;
}

async function generateName(pi: ExtensionAPI, ctx: any, strategy: Strategy) {
    const branch = ctx.sessionManager.getBranch();

    if (strategy === "full") {
        // Full strategy: send the full session so provider-side prompt caching applies
        const messages = buildMessages(branch);
        if (messages.length === 0) {
            ctx.ui.notify("Not enough conversation to generate a name yet", "warning");
            return;
        }

        // Replicate active tools so the request matches the cached conversation prefix
        const activeToolNames = pi.getActiveTools();
        const allTools = pi.getAllTools();
        const tools = allTools
            .filter((t) => activeToolNames.includes(t.name))
            .map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));

        await generateWithModel(ctx, () => ({
            systemPrompt: ctx.getSystemPrompt(),
            messages: [
                ...messages,
                {
                    role: "user" as const,
                    content: [{ type: "text" as const, text: NAME_PROMPT }],
                    timestamp: Date.now(),
                },
            ],
            tools,
            sessionId: getSessionId(ctx),
        }));
        return;
    }

    // Fresh strategy (default): short, uncached excerpt
    const conversation = buildConversationExcerpt(branch);
    if (!conversation.trim()) {
        ctx.ui.notify("Not enough conversation to generate a name yet", "warning");
        return;
    }

    await generateWithModel(ctx, () => ({
        messages: [
            {
                role: "user" as const,
                content: [{ type: "text" as const, text: NAME_PROMPT + "\n\n" + conversation }],
                timestamp: Date.now(),
            },
        ],
    }));
}

async function generateWithModel(ctx: any, buildRequest: () => any) {
    if (ctx.hasUI) {
        ctx.ui.setStatus("session-name", "Generating name...");
    }

    // Prefer the current model; fall back to a lightweight option
    const model = ctx.model;

    if (!model) {
        ctx.ui.notify("No model available to generate a name", "error");
        if (ctx.hasUI) ctx.ui.setStatus("session-name", "");
        return;
    }

    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) {
        ctx.ui.notify(`Model error: ${auth.error}`, "warning");
        if (ctx.hasUI) ctx.ui.setStatus("session-name", "");
        return;
    }
    if (!auth.apiKey) {
        ctx.ui.notify(`No API key for ${model.provider}/${model.id}`, "warning");
        if (ctx.hasUI) ctx.ui.setStatus("session-name", "");
        return;
    }

    try {
        const response = await complete(
            model,
            buildRequest(),
            {
                apiKey: auth.apiKey,
                headers: auth.headers,
                env: auth.env,
                reasoningEffort: "none",
            },
        );

        const name = response.content
            .filter((c: any): c is { type: "text"; text: string } => c.type === "text")
            .map((c) => c.text)
            .join(" ")
            .trim()
            .replace(/^["']|["']$/g, "");

        if (name) {
            ctx.ui.setEditorText(`/name ${name}`);
            ctx.ui.notify(`Generated name: ${name} (press Enter to confirm, or edit first)`, "info");
        } else {
            ctx.ui.notify(`No name generated (model: ${model.provider}/${model.id})`, "warning");
        }
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Error generating name: ${msg}`, "error");
    } finally {
        if (ctx.hasUI) ctx.ui.setStatus("session-name", "");
    }
}

export default function (pi: ExtensionAPI) {
    pi.registerCommand("session-name", {
        description:
            "Generate session name from conversation (/session-name, /session-name full), or set manually (/session-name \"Name\", /session-name show)",
        handler: async (args, ctx) => {
            const trimmed = args?.trim();

            // "full" → generate using the full session (cached prefix)
            if (trimmed?.toLowerCase() === "full") {
                await generateName(pi, ctx, "full");
                return;
            }

            // No args → generate (fresh short-excerpt context, default)
            if (!trimmed) {
                await generateName(pi, ctx, "fresh");
                return;
            }

            // Explicit "show" → display current name
            if (trimmed.toLowerCase() === "show") {
                const current = pi.getSessionName();
                ctx.ui.notify(current ? `Session: ${current}` : "No session name set", "info");
                return;
            }

            // Any other arg → set manually
            pi.setSessionName(trimmed);
            ctx.ui.notify(`Session named: ${trimmed}`, "info");
        },
    });
}
