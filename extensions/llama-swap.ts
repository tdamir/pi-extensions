/**
 * Llama-Swap Provider Extension
 *
 * Registers llama-swap as an OpenAI-compatible provider.
 * Dynamically discovers models from the llama-swap API at startup.
 * Captures llama.cpp's raw `usage` and `timings` SSE fields (dropped by the
 * built-in parser) and stores them as `llama-swap-usage` custom entries in
 * the session record.
 *
 * Server URL is configured in settings.json under `llamaSwap.baseUrl`.
 * If no URL is configured, the provider is not registered.
 *
 * Usage:
 *   pi -e ./llama-swap
 *
 * Or place in ~/.pi/agent/extensions/ for auto-discovery (hot-reloads on /reload).
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { getAgentDir, getPackageDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getApiProvider } from "@earendil-works/pi-ai/compat";
import { Box, Text } from "@earendil-works/pi-tui";

// =============================================================================
// Configuration
// =============================================================================

/** Returns the configured llama-swap base URL, or undefined if not set. */
function resolveBaseUrl(): string | undefined {
  try {
    const agentDir = getAgentDir();
    const settingsPath = join(agentDir, "settings.json");
    if (!existsSync(settingsPath)) return undefined;

    const raw = JSON.parse(readFileSync(settingsPath, "utf-8"));
    const url = raw.llamaSwap?.baseUrl as string | undefined;
    if (url) {
      // Normalize: ensure trailing /v1
      const base = url.replace(/\/+$/, "");
      return base.endsWith("/v1") ? base : `${base}/v1`;
    }
  } catch {
    // ignore
  }
  return undefined;
}

function readSettings(): Record<string, unknown> {
  const agentDir = getAgentDir();
  const settingsPath = join(agentDir, "settings.json");
  if (!existsSync(settingsPath)) return {};
  return JSON.parse(readFileSync(settingsPath, "utf-8"));
}

function writeSettings(raw: Record<string, unknown>) {
  const agentDir = getAgentDir();
  const settingsPath = join(agentDir, "settings.json");
  writeFileSync(settingsPath, JSON.stringify(raw, null, 2) + "\n", "utf-8");
}

function normalizeUrl(url: string): string {
  const base = url.replace(/\/+$/, "");
  return base.endsWith("/v1") ? base : `${base}/v1`;
}

function setLlamaSwapUrl(url: string) {
  const raw = readSettings();
  const normalized = normalizeUrl(url);
  raw.llamaSwap = { baseUrl: normalized };
  writeSettings(raw);
  return normalized;
}

// =============================================================================
// Model Discovery
// =============================================================================

/** Infer reasoning support from the model ID. */
function inferReasoning(id: string): boolean {
  return /-think|\.think|_think|Think/i.test(id);
}

/** Pi thinking levels. */
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/**
 * llama-swap encodes a fixed reasoning effort as a `:{level}` suffix on the
 * model ID (e.g. `qwen3-coder:medium`). The suffix must be kept in the ID
 * (the server needs it), and the thinking level is pinned to it.
 */
const REASONING_SUFFIX_RE = /:(off|minimal|low|medium|high|xhigh|max)$/;

function parseReasoningSuffix(id: string): ThinkingLevel | undefined {
  const match = REASONING_SUFFIX_RE.exec(id);
  return match ? (match[1] as ThinkingLevel) : undefined;
}

/** Infer input types from the model's capabilities and architecture. */
function inferInputTypes(
  capabilities: { vision?: boolean } | undefined,
  architecture: { input_modalities?: string[] } | undefined,
): ("text" | "image")[] {
  if (capabilities?.vision) return ["text", "image"];
  const mods = architecture?.input_modalities ?? [];
  if (mods.some((m) => m.includes("image"))) return ["text", "image"];
  return ["text"];
}

/** Map a llama-swap model entry to a pi ProviderModelConfig. */
function mapModel(
  entry: {
    id: string;
    name?: string;
    context_length?: number;
    capabilities?: Record<string, unknown>;
    architecture?: {
      input_modalities?: string[];
      modality?: string;
    };
  },
): {
  id: string;
  name: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
  thinkingLevelMap?: Record<string, string | null>;
  compat?: { supportsReasoningEffort?: boolean };
} {
  const capabilities = entry.capabilities as { vision?: boolean } | undefined;
  const architecture = entry.architecture;

  const suffix = parseReasoningSuffix(entry.id);

  return {
    id: entry.id,
    name: entry.name ?? entry.id,
    reasoning: suffix ? suffix !== "off" : inferReasoning(entry.id),
    input: inferInputTypes(capabilities, architecture),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: entry.context_length ?? 128000,
    maxTokens: entry.context_length ?? 128000,
    // Effort is baked into the model name: pin the thinking level to the
    // suffix value and hide all other levels.
    ...(suffix
      ? {
          thinkingLevelMap: Object.fromEntries(
            THINKING_LEVELS.map((level) => [level, level === suffix ? level : null]),
          ),
          compat: { supportsReasoningEffort: false },
        }
      : {}),
  };
}

// =============================================================================
// Usage & timings capture (raw llama.cpp SSE fields, dropped by pi-ai)
// =============================================================================

interface LlamaUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  [key: string]: unknown;
}

interface LlamaTimings {
  cache_n?: number;
  prompt_n?: number;
  prompt_ms?: number;
  prompt_per_token_ms?: number;
  prompt_per_second?: number;
  predicted_n?: number;
  predicted_ms?: number;
  predicted_per_token_ms?: number;
  predicted_per_second?: number;
  draft_n?: number;
  draft_n_accepted?: number;
  [key: string]: unknown;
}

interface LlamaSwapUsageRecord {
  responseId: string;
  model?: string;
  systemFingerprint?: string;
  usage?: LlamaUsage;
  timings?: LlamaTimings;
  capturedAt: number;
}

interface Capture {
  record?: LlamaSwapUsageRecord;
  resolve: () => void;
  ready: Promise<void>;
}

const captures = new Map<string, Capture>();
const MAX_CAPTURES = 100;

function rememberCapture(record: LlamaSwapUsageRecord) {
  if (captures.size >= MAX_CAPTURES) {
    const oldest = captures.keys().next().value;
    if (oldest) captures.delete(oldest);
  }
  let capture = captures.get(record.responseId);
  if (!capture) {
    let resolve: () => void = () => {};
    capture = { ready: new Promise<void>((r) => (resolve = r)), resolve };
    captures.set(record.responseId, capture);
  }
  capture.record = record;
  capture.resolve();
}

/** Best-effort parse of a teed SSE branch to extract usage/timings. */
function tapStream(body: ReadableStream<Uint8Array>): void {
  void (async () => {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const record: LlamaSwapUsageRecord = { responseId: "", capturedAt: Date.now() };

    const handleData = (data: string) => {
      if (!data || data === "[DONE]") return;
      let chunk: {
        id?: string;
        model?: string;
        system_fingerprint?: string;
        usage?: LlamaUsage;
        timings?: LlamaTimings;
      };
      try {
        chunk = JSON.parse(data);
      } catch {
        return;
      }
      if (typeof chunk.id === "string") record.responseId = chunk.id;
      if (typeof chunk.model === "string") record.model = chunk.model;
      if (typeof chunk.system_fingerprint === "string") {
        record.systemFingerprint = chunk.system_fingerprint;
      }
      if (chunk.usage && typeof chunk.usage === "object") record.usage = chunk.usage;
      if (chunk.timings && typeof chunk.timings === "object") record.timings = chunk.timings;
    };

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline: number;
        while ((newline = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line.startsWith("data:")) handleData(line.slice(5).trim());
        }
      }
    } catch {
      // Best-effort: the tap errors when the main stream is cancelled.
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // ignore
      }
      if (record.responseId && (record.usage || record.timings)) {
        rememberCapture(record);
      }
    }
  })();
}

/** Wrap fetch so SSE response bodies are teed: pi-ai reads one branch, the tap reads the other. */
function teedFetch(base: typeof globalThis.fetch): typeof globalThis.fetch {
  return (async (input, init) => {
    const response = await base(input, init);
    const contentType = response.headers.get("content-type") ?? "";
    if (!response.ok || !response.body || !contentType.includes("text/event-stream")) {
      return response;
    }
    const [main, tap] = response.body.tee();
    tapStream(tap);
    return new Response(main, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }) as typeof globalThis.fetch;
}

// =============================================================================
// HTML export with usage entries
// =============================================================================

/** One-line human-readable summary of a captured usage record. */
function formatUsageSummary(record: LlamaSwapUsageRecord): string {
  const parts: string[] = [];
  const t = record.timings;
  if (t?.prompt_per_second != null) parts.push(`prompt ${t.prompt_per_second.toFixed(0)} tok/s`);
  if (t?.predicted_per_second != null) parts.push(`gen ${t.predicted_per_second.toFixed(1)} tok/s`);
  if (t?.draft_n != null && t?.draft_n_accepted != null) {
    const pct = t.draft_n > 0 ? ((t.draft_n_accepted / t.draft_n) * 100).toFixed(0) : "0";
    parts.push(`draft ${t.draft_n_accepted}/${t.draft_n} (${pct}%)`);
  }
  const totalMs = (t?.prompt_ms ?? 0) + (t?.predicted_ms ?? 0);
  if (totalMs > 0) parts.push(`${(totalMs / 1000).toFixed(1)}s`);
  const u = record.usage;
  if (u) {
    const cached = u.prompt_tokens_details?.cached_tokens
      ? ` (${u.prompt_tokens_details.cached_tokens} cached)`
      : "";
    parts.push(`${u.prompt_tokens ?? 0}\u2192${u.completion_tokens ?? 0} tok${cached}`);
  }
  return parts.length > 0 ? parts.join(" \u00B7 ") : "no usage data";
}

interface SessionEntryLike {
  type?: string;
  customType?: string;
  id?: string;
  parentId?: string;
  timestamp?: string;
  data?: unknown;
  [key: string]: unknown;
}

/**
 * The built-in HTML exporter skips `custom` entries (from pi.appendEntry),
 * so llama-swap-usage stats are invisible in /export output. Rewrite each
 * usage entry as a `custom_message` entry (same id/parentId, so the tree
 * structure is untouched). The exporter renders those as visible hook
 * messages.
 */
function toExportableSessionLines(lines: string[]): string[] {
  return lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return line;
    let entry: SessionEntryLike;
    try {
      entry = JSON.parse(trimmed) as SessionEntryLike;
    } catch {
      return line;
    }
    if (entry.type !== "custom" || entry.customType !== "llama-swap-usage") return line;

    const record = entry.data as LlamaSwapUsageRecord | undefined;
    const exportable = {
      type: "custom_message",
      id: entry.id,
      parentId: entry.parentId,
      timestamp: entry.timestamp,
      customType: "llama-swap-usage",
      content: `\u26A1 llama-swap \u2014 ${record ? formatUsageSummary(record) : "no usage data"}`,
      display: true,
      details: record,
    };
    return JSON.stringify(exportable);
  });
}

/** Locate and load the built-in standalone HTML exporter (not exported from the package root). */
async function loadExportFromFile(): Promise<
  (input: string, options?: { outputPath?: string }) => Promise<string>
> {
  const pkgDir = getPackageDir();
  const candidates = [
    join(pkgDir, "dist", "core", "export-html", "index.js"),
    join(pkgDir, "src", "core", "export-html", "index.js"),
    join(pkgDir, "core", "export-html", "index.js"),
    join(pkgDir, "export-html", "index.js"),
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const mod = await import(pathToFileURL(candidate).href) as {
      exportFromFile?: (input: string, options?: { outputPath?: string }) => Promise<string>;
    };
    if (typeof mod.exportFromFile === "function") return mod.exportFromFile;
  }
  throw new Error("Could not locate the pi HTML exporter (core/export-html/index.js)");
}

/** Command: /export-with-stats [file] — /export that includes llama-swap-usage entries. */
function registerExportCommand(pi: ExtensionAPI) {
  pi.registerCommand("export-with-stats", {
    description: "Export session to HTML, including llama-swap usage stats",
    handler: async (args, ctx) => {
      const sessionFile = ctx.sessionManager.getSessionFile();
      if (!sessionFile || !existsSync(sessionFile)) {
        ctx.ui.notify("No session file to export yet.", "error");
        return;
      }

      const tmpFile = join(tmpdir(), `llama-swap-export-${process.pid}-${Date.now()}.jsonl`);
      writeFileSync(tmpFile, toExportableSessionLines(readFileSync(sessionFile, "utf-8").split("\n")).join("\n"), "utf-8");

      try {
        const exportFromFile = await loadExportFromFile();
        const outputPath = args.trim() || `pi-session-${basename(sessionFile, ".jsonl")}.html`;
        const out = await exportFromFile(tmpFile, { outputPath });
        ctx.ui.notify(`Exported to: ${out}`, "info");
      } catch (error) {
        ctx.ui.notify(`Export failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      } finally {
        try {
          unlinkSync(tmpFile);
        } catch {
          // ignore
        }
      }
    },
  });
}

// =============================================================================
// Command: /llama-swap-url
// =============================================================================

function registerSetUrlCommand(pi: ExtensionAPI) {
  pi.registerCommand("llama-swap-url", {
    description: "Set the llama-swap provider base URL",
    handler: async (_args, ctx) => {
      const current = resolveBaseUrl() ?? "(not set)";
      const prompt = `Current: ${current}\nEnter new base URL (without /v1, e.g. http://localhost:8080):`;

      const input = await ctx.ui.input(prompt);
      if (!input) {
        ctx.ui.notify("URL unchanged.", "info");
        return;
      }

      const normalized = setLlamaSwapUrl(input);
      ctx.ui.notify(`llama-swap URL set to: ${normalized}`, "info");
      ctx.ui.notify("Run /reload to apply the new URL.", "info");
    },
  });
}

// =============================================================================
// Extension Entry Point (async factory for dynamic model discovery)
// =============================================================================

export default async function (pi: ExtensionAPI) {
  registerSetUrlCommand(pi);
  registerExportCommand(pi);

  const BASE_URL = resolveBaseUrl();
  if (!BASE_URL) {
    console.log("[llama-swap] No URL configured (llamaSwap.baseUrl in settings.json). Provider not registered.");
    return;
  }

  try {
    const response = await fetch(`${BASE_URL}/models`);
    if (!response.ok) {
      throw new Error(`llama-swap API returned ${response.status}: ${response.statusText}`);
    }

    const payload = (await response.json()) as {
      data: Array<{
        id: string;
        name?: string;
        object?: string;
        created?: number;
        owned_by?: string;
        capabilities?: Record<string, unknown>;
        architecture?: {
          input_modalities?: string[];
          modality?: string;
        };
        context_length?: number;
      }>;
      object?: string;
    };

    const models = payload.data.map(mapModel);

    // Built-in openai-completions stream implementation, wrapped with a teed
    // fetch that taps the raw SSE stream for llama.cpp usage/timings fields.
    const openai = getApiProvider("openai-completions");
    if (!openai) {
      throw new Error("openai-completions API provider not found in pi-ai registry");
    }

    pi.registerProvider("llama-swap", {
      baseUrl: BASE_URL,
      apiKey: "none", // llama-swap is a local service, no auth needed
      api: "openai-completions",
      models,
      streamSimple: (model, context, options) => {
        const baseFetch = options?.fetch ?? globalThis.fetch;
        return openai.streamSimple(model, context, { ...options, fetch: teedFetch(baseFetch) });
      },
    });

    // Persist captured usage/timings into the session record, correlated via
    // the chat completion id that pi stores as `responseId` on the message.
    // Uses turn_end (not message_end) so the custom entry is appended AFTER
    // the assistant message entry is already persisted, keeping the record
    // attached directly below its message in the session file.
    pi.on("turn_end", async (event) => {
      const message = event.message;
      if (message.role !== "assistant" || message.provider !== "llama-swap") return;
      if (!message.responseId) return;

      const capture = captures.get(message.responseId);
      if (!capture) return;

      // The tap usually finishes with the stream; give it a moment to land.
      await Promise.race([capture.ready, new Promise((r) => setTimeout(r, 2000))]);
      const record = capture.record;
      if (!record || (!record.usage && !record.timings)) return;

      captures.delete(record.responseId);
      pi.appendEntry("llama-swap-usage", record);
    });

    pi.registerEntryRenderer("llama-swap-usage", (entry, { expanded }, theme) => {
      const record = entry.data as LlamaSwapUsageRecord | undefined;
      if (!record) return undefined;

      const box = new Box(0, 0);
      box.addChild(new Text(theme.fg("dim", `\u26A1 llama-swap ${formatUsageSummary(record)}`)));
      if (expanded) {
        box.addChild(new Text(theme.fg("dim", JSON.stringify(record, null, 2))));
      }
      return box;
    });
  } catch (error) {
    console.error(
      `[llama-swap] Failed to discover models from ${BASE_URL}/models:`,
      error instanceof Error ? error.message : String(error),
    );
    console.error("[llama-swap] Provider will not be available. Is llama-swap running?");
  }
}
