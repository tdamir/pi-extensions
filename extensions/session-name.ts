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
 *   /session-name-model          - Pick the model used for name suggestions (saved to settings.json)
 *   /session-name-model show     - Show the configured suggestion model
 *   /session-name-model clear    - Reset to the current model
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, SessionEntry, Theme } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";
import { complete } from "@earendil-works/pi-ai/compat";
import {
    Container,
    fuzzyFilter,
    getKeybindings,
    Input,
    Spacer,
    Text,
    type Focusable,
    type SelectItem,
} from "@earendil-works/pi-tui";

const NAME_PROMPT = `Generate a concise session name (3-6 words) for this conversation.
The first user message is the main topic — base the name on it but consider the overall conversation.
Use title case. No quotes, no prefix — just the name.
If coding, mention the key action: refactor, debug, create, migrate, etc.
Respond with ONLY the name, nothing else.`;

type Strategy = "fresh" | "full";

// =============================================================================
// Searchable + scrollable model picker (fuzzy search, like the built-in /model)
// =============================================================================

class SearchableModelPicker extends Container implements Focusable {
    private searchInput: Input;
    private listContainer: Container;
    private allItems: SelectItem[];
    private filtered: SelectItem[];
    private initialIndex: number;
    private selectedIndex: number;
    private currentRef?: string;
    private theme: Theme;
    private onSelect: (value: string) => void;
    private onCancel: () => void;
    private maxVisible = 10;
    private _focused = false;

    // Focusable implementation - propagate to searchInput for IME cursor positioning
    get focused(): boolean {
        return this._focused;
    }

    set focused(value: boolean) {
        this._focused = value;
        this.searchInput.focused = value;
    }

    constructor(
        items: SelectItem[],
        theme: Theme,
        currentRef: string | undefined,
        onSelect: (value: string) => void,
        onCancel: () => void,
    ) {
        super();
        this.allItems = items;
        this.filtered = items;
        this.theme = theme;
        this.onSelect = onSelect;
        this.onCancel = onCancel;

        const current = items.findIndex((i) => i.value === currentRef);
        this.initialIndex = current >= 0 ? current : 0;
        this.selectedIndex = this.initialIndex;
        this.currentRef = currentRef;

        this.addChild(new DynamicBorder());
        this.addChild(new Text(this.theme.fg("accent", this.theme.bold("Model for /session-name suggestions")), 1, 0));
        this.addChild(new Text(this.theme.fg("dim", "Type to search (fuzzy match)"), 1, 0));
        this.addChild(new Spacer(1));
        this.searchInput = new Input();
        this.addChild(this.searchInput);
        this.addChild(new Spacer(1));
        this.listContainer = new Container();
        this.addChild(this.listContainer);
        this.addChild(new Spacer(1));
        this.addChild(new Text(this.theme.fg("dim", "↑↓ navigate • enter select • esc cancel"), 0, 0));
        this.addChild(new DynamicBorder());

        this.renderList();
    }

    handleInput(keyData: string): void {
        const kb = getKeybindings();
        if (kb.matches(keyData, "tui.select.up")) {
            if (this.filtered.length === 0) return;
            this.selectedIndex = this.selectedIndex === 0 ? this.filtered.length - 1 : this.selectedIndex - 1;
            this.renderList();
        } else if (kb.matches(keyData, "tui.select.down")) {
            if (this.filtered.length === 0) return;
            this.selectedIndex = this.selectedIndex === this.filtered.length - 1 ? 0 : this.selectedIndex + 1;
            this.renderList();
        } else if (kb.matches(keyData, "tui.select.confirm")) {
            const item = this.filtered[this.selectedIndex];
            if (item) this.onSelect(item.value);
        } else if (kb.matches(keyData, "tui.select.cancel")) {
            this.onCancel();
        } else {
            this.searchInput.handleInput(keyData);
            this.applyFilter(this.searchInput.getValue());
        }
    }

    private applyFilter(query: string): void {
        const q = query.trim();
        this.filtered = q
            ? fuzzyFilter(this.allItems, q, (item) => `${item.value} ${item.description ?? ""}`)
            : [...this.allItems];
        // Best match first when searching; restore the highlighted item when clearing
        this.selectedIndex = q ? 0 : Math.min(this.initialIndex, this.filtered.length - 1);
        this.renderList();
    }

    private renderList(): void {
        this.listContainer.clear();
        if (this.filtered.length === 0) {
            this.listContainer.addChild(new Text(this.theme.fg("muted", "  No matching options"), 0, 0));
            return;
        }

        const startIndex = Math.max(
            0,
            Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), this.filtered.length - this.maxVisible),
        );
        const endIndex = Math.min(startIndex + this.maxVisible, this.filtered.length);

        for (let i = startIndex; i < endIndex; i++) {
            const item = this.filtered[i];
            if (!item) continue;
            const isSelected = i === this.selectedIndex;
            const isCurrent = item.value === this.currentRef;
            const currentBadge = isCurrent ? this.theme.fg("success", " ✓ current") : "";
            const line = isSelected
                ? `${this.theme.fg("accent", `→ ${item.value}`)}${currentBadge}`
                : `  ${item.value}${currentBadge}`;
            this.listContainer.addChild(new Text(line, 0, 0));
            if (item.description) {
                this.listContainer.addChild(new Text(this.theme.fg("muted", `     ${item.description}`), 0, 0));
            }
        }

        if (startIndex > 0 || endIndex < this.filtered.length) {
            this.listContainer.addChild(new Text(this.theme.fg("muted", `  (${this.selectedIndex + 1}/${this.filtered.length})`), 0, 0));
        }
    }

    override invalidate(): void {
        super.invalidate();
        this.renderList();
    }
}

// =============================================================================
// Configured suggestion model (sessionName.model in settings.json)
// =============================================================================

interface ModelRef {
    provider: string;
    id: string;
}

function readSettings(): Record<string, unknown> {
    const settingsPath = join(getAgentDir(), "settings.json");
    if (!existsSync(settingsPath)) return {};
    return JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
}

function writeSettings(raw: Record<string, unknown>) {
    const settingsPath = join(getAgentDir(), "settings.json");
    writeFileSync(settingsPath, JSON.stringify(raw, null, 2) + "\n", "utf-8");
}

function getConfiguredModelRef(): ModelRef | undefined {
    try {
        const model = (readSettings().sessionName as { model?: ModelRef } | undefined)?.model;
        if (model && typeof model.provider === "string" && typeof model.id === "string") {
            return model;
        }
    } catch {
        // ignore malformed settings
    }
    return undefined;
}

function setConfiguredModelRef(ref: ModelRef | null) {
    const raw = readSettings();
    const sessionName: Record<string, unknown> = { ...(raw.sessionName as Record<string, unknown> | undefined) };
    if (ref) {
        sessionName.model = ref;
        raw.sessionName = sessionName;
    } else {
        delete sessionName.model;
        if (Object.keys(sessionName).length > 0) {
            raw.sessionName = sessionName;
        } else {
            delete raw.sessionName;
        }
    }
    writeSettings(raw);
}

/**
 * The model to use for name suggestions: the configured sessionName.model if
 * set and still available, otherwise the current model.
 */
function resolveSuggestionModel(ctx: any) {
    const ref = getConfiguredModelRef();
    if (ref) {
        const model = ctx.modelRegistry.find(ref.provider, ref.id);
        if (model) return model;
        ctx.ui.notify(
            `Configured session-name model ${ref.provider}/${ref.id} is not available; falling back to the current model.`,
            "warning",
        );
    }
    return ctx.model;
}

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

    // Prefer the configured suggestion model (sessionName.model); fall back to the current model
    const model = resolveSuggestionModel(ctx);

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
            ctx.ui.notify(
                `Generated name: ${name} (model: ${model.provider}/${model.id} — press Enter to confirm, or edit first)`,
                "info",
            );
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

    pi.registerCommand("session-name-model", {
        description: "Choose the model used for /session-name suggestions (default: current model)",
        handler: async (args, ctx) => {
            const trimmed = (args ?? "").trim().toLowerCase();
            const configured = getConfiguredModelRef();

            if (trimmed === "show") {
                ctx.ui.notify(
                    configured
                        ? `session-name model: ${configured.provider}/${configured.id}`
                        : "session-name model: current model (default)",
                    "info",
                );
                return;
            }

            if (trimmed === "clear") {
                if (configured) {
                    setConfiguredModelRef(null);
                    ctx.ui.notify("session-name model reset to the current model.", "info");
                } else {
                    ctx.ui.notify("No custom session-name model set.", "info");
                }
                return;
            }

            if (trimmed) {
                ctx.ui.notify("Usage: /session-name-model [show | clear]", "error");
                return;
            }

            // Mirror the built-in model picker: scoped models when configured, else all available
            const models =
                ctx.scopedModels && ctx.scopedModels.length > 0
                    ? ctx.scopedModels.map((entry: any) => entry.model)
                    : ctx.modelRegistry.getAvailable();
            if (models.length === 0) {
                ctx.ui.notify("No models available.", "error");
                return;
            }

            const DEFAULT_OPTION = "(default) current model";
            const items: SelectItem[] = [
                { value: DEFAULT_OPTION, label: DEFAULT_OPTION, description: "use the current model" },
                ...models.map((m: any) => ({
                    value: `${m.provider}/${m.id}`,
                    label: `${m.provider}/${m.id}`,
                    description: m.name,
                })),
            ];

            const choice = await ctx.ui.custom<string | null>((_tui, theme, _keybindings, done) => {
                return new SearchableModelPicker(
                    items,
                    theme,
                    configured ? `${configured.provider}/${configured.id}` : undefined,
                    (v) => done(v),
                    () => done(null),
                );
            });
            if (choice === null) {
                ctx.ui.notify("Cancelled.", "info");
                return;
            }

            if (choice === DEFAULT_OPTION) {
                setConfiguredModelRef(null);
                ctx.ui.notify("/session-name will use the current model.", "info");
                return;
            }

            const slash = choice.indexOf("/");
            setConfiguredModelRef({ provider: choice.slice(0, slash), id: choice.slice(slash + 1) });
            ctx.ui.notify(`session-name model set to: ${choice}`, "info");
        },
    });
}
