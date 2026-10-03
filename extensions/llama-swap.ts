/**
 * Llama-Swap Provider Extension
 *
 * Registers llama-swap as an OpenAI-compatible provider.
 * Dynamically discovers models from the llama-swap API at startup.
 * Captures the raw SSE telemetry dropped by the built-in parser — llama.cpp's
 * `usage` and `timings`, and vLLM's `usage` and `metrics` — and stores them as
 * `llama-swap-usage` custom entries in the session record.
 *
 * /swap-stats toggles a panel with aggregate stats (token throughput, rates,
 * draft acceptance) computed from the llama-swap-usage entries in the
 * session log, so it works across reloads and resumed sessions.
 *
 * Servers are configured in settings.json under `llamaSwap.servers`; each
 * entry is registered as a provider named after the server:
 *   - `servers.gx10: "http://gx10.local:9292"` → provider `gx10`
 * If no servers are configured, no provider is registered.
 *
 * /llama-swap-url manages the configured servers:
 *   /llama-swap-url                  — add a server (prompt for name and URL)
 *   /llama-swap-url add <name> <url> — add a server
 *   /llama-swap-url remove <name>    — remove a server
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
import type { CustomEntry, ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { getApiProvider } from "@earendil-works/pi-ai/compat";
import { Box, Text } from "@earendil-works/pi-tui";

// =============================================================================
// Configuration
// =============================================================================

interface SwapServer {
  /** Name in `llamaSwap.servers`. */
  name: string;
  /** Normalized base URL (with trailing /v1). */
  url: string;
  /** pi provider id: the (sanitized) server name. */
  providerId: string;
}

/** Read `llamaSwap.servers` from settings.json (empty object if absent). */
function readLlamaSwapConfig(): { servers?: Record<string, unknown> } {
  const raw = readSettings();
  const config = (raw.llamaSwap as Record<string, unknown> | undefined) ?? {};
  // One-time cleanup: drop the legacy `baseUrl` key (superseded by `servers`).
  if (config.baseUrl !== undefined) {
    delete config.baseUrl;
    raw.llamaSwap = config;
    writeSettings(raw);
  }
  return { servers: config.servers as Record<string, unknown> | undefined };
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

/**
 * Collect all configured llama-swap servers. Each `llamaSwap.servers` entry
 * becomes a provider named after the server. Duplicate URLs are registered
 * only once (the first entry wins).
 */
function resolveServers(): SwapServer[] {
  const { servers } = readLlamaSwapConfig();
  const result: SwapServer[] = [];
  const seen = new Set<string>();

  const add = (name: string, url: string) => {
    const normalized = normalizeUrl(url);
    if (seen.has(normalized)) return;
    seen.add(normalized);
    const safeName = name.replace(/[^a-zA-Z0-9-]/g, "-");
    result.push({
      name,
      url: normalized,
      providerId: safeName,
    });
  };

  for (const [name, value] of Object.entries(servers ?? {})) {
    if (typeof value === "string" && value) add(name, value);
  }
  return result;
}

/** Add (or replace) a server in `llamaSwap.servers`. */
function setServer(name: string, url: string): string {
  const raw = readSettings();
  const config: Record<string, unknown> = (raw.llamaSwap as Record<string, unknown> | undefined) ?? {};
  const servers = (config.servers as Record<string, string> | undefined) ?? {};
  servers[name] = normalizeUrl(url);
  config.servers = servers;
  raw.llamaSwap = config;
  writeSettings(raw);
  return servers[name];
}

/** Remove a server from `llamaSwap.servers`. Returns false if not found. */
function removeServer(name: string): boolean {
  const raw = readSettings();
  const config = (raw.llamaSwap as Record<string, unknown> | undefined) ?? {};
  const servers = (config.servers as Record<string, string> | undefined) ?? {};
  if (!(name in servers)) return false;
  delete servers[name];
  if (Object.keys(servers).length > 0) config.servers = servers;
  else delete config.servers;
  raw.llamaSwap = config;
  writeSettings(raw);
  return true;
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
  prompt_tokens_details?: { cached_tokens?: number; created_cache_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
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

/** vLLM's per-response `metrics` object (emitted on the final usage chunk). */
interface LlamaMetrics {
  time_to_first_token_ms?: number;
  generation_time_ms?: number;
  queue_time_ms?: number;
  mean_itl_ms?: number;
  tokens_per_second?: number;
  speculative_decoding?: {
    mean_acceptance_length?: number;
    draft_acceptance_rate?: number;
    acceptance_histogram?: number[];
    num_spec_steps?: number;
    num_accepted_draft_tokens?: number;
    num_draft_tokens?: number;
    num_spec_tokens?: number;
  };
  [key: string]: unknown;
}

interface LlamaSwapUsageRecord {
  responseId: string;
  /** Provider (server) id that served the request. */
  server?: string;
  model?: string;
  systemFingerprint?: string;
  usage?: LlamaUsage;
  timings?: LlamaTimings;
  metrics?: LlamaMetrics;
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
        metrics?: LlamaMetrics;
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
      if (chunk.metrics && typeof chunk.metrics === "object") record.metrics = chunk.metrics;
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
      if (record.responseId && (record.usage || record.timings || record.metrics)) {
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

interface NormalizedTimings {
  /** Prefill/prompt time in ms (llama.cpp prompt_ms, vLLM time_to_first_token_ms). */
  promptMs: number;
  /** Prompt tokens actually prefilled (llama.cpp prompt_n, vLLM prompt_tokens minus cached). */
  promptN: number;
  /** Generation time in ms (llama.cpp predicted_ms, vLLM generation_time_ms). */
  predictedMs: number;
  /** Generated tokens (llama.cpp predicted_n, vLLM completion_tokens). */
  predictedN: number;
  /** Total speculative draft tokens. */
  draftN: number;
  /** Accepted speculative draft tokens. */
  draftAccepted: number;
  /** Explicit prompt throughput if the server reported one. */
  promptRate?: number;
  /** Explicit generation throughput if the server reported one. */
  genRate?: number;
}

/**
 * Normalize llama.cpp `timings` and vLLM `metrics` into one shape so the
 * summary line and aggregate stats work with either server.
 */
function normalizeTimings(record: LlamaSwapUsageRecord): NormalizedTimings | undefined {
  const t = record.timings;
  if (t) {
    return {
      promptMs: t.prompt_ms ?? 0,
      promptN: t.prompt_n ?? 0,
      predictedMs: t.predicted_ms ?? 0,
      predictedN: t.predicted_n ?? 0,
      draftN: t.draft_n ?? 0,
      draftAccepted: t.draft_n_accepted ?? 0,
      ...(t.prompt_per_second != null ? { promptRate: t.prompt_per_second } : {}),
      ...(t.predicted_per_second != null ? { genRate: t.predicted_per_second } : {}),
    };
  }

  const m = record.metrics;
  if (m) {
    const u = record.usage;
    const promptTokens = u?.prompt_tokens ?? 0;
    const cached = u?.prompt_tokens_details?.cached_tokens ?? 0;
    const spec = m.speculative_decoding;
    return {
      promptMs: m.time_to_first_token_ms ?? 0,
      promptN: Math.max(0, promptTokens - cached),
      predictedMs: m.generation_time_ms ?? 0,
      predictedN: u?.completion_tokens ?? 0,
      draftN: spec?.num_draft_tokens ?? 0,
      draftAccepted: spec?.num_accepted_draft_tokens ?? 0,
      ...(m.tokens_per_second != null ? { genRate: m.tokens_per_second } : {}),
    };
  }

  return undefined;
}

/** One-line human-readable summary of a captured usage record. */
function formatUsageSummary(record: LlamaSwapUsageRecord): string {
  const parts: string[] = [];
  const nt = normalizeTimings(record);
  if (nt) {
    const promptRate = nt.promptRate ?? (nt.promptMs > 0 && nt.promptN > 0 ? nt.promptN / (nt.promptMs / 1000) : undefined);
    if (promptRate != null && Number.isFinite(promptRate)) parts.push(`prompt ${promptRate.toFixed(0)} tok/s`);
    const genRate = nt.genRate ?? (nt.predictedMs > 0 && nt.predictedN > 0 ? nt.predictedN / (nt.predictedMs / 1000) : undefined);
    if (genRate != null && Number.isFinite(genRate)) parts.push(`gen ${genRate.toFixed(1)} tok/s`);
    if (nt.draftN > 0) {
      const pct = ((nt.draftAccepted / nt.draftN) * 100).toFixed(0);
      parts.push(`draft ${nt.draftAccepted}/${nt.draftN} (${pct}%)`);
    }
    const totalMs = nt.promptMs + nt.predictedMs;
    if (totalMs > 0) parts.push(`${(totalMs / 1000).toFixed(1)}s`);
  }
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
      content: `\u26A1 llama-swap${record?.server ? ` [${record.server}]` : ""} \u2014 ${record ? formatUsageSummary(record) : "no usage data"}`,
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

// =============================================================================
// Formatting helpers
// =============================================================================

/** Format milliseconds as `1h 02m 03s` or `2m 03s`. */
function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, "0")}m ${String(seconds).padStart(2, "0")}s`;
  }
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

// =============================================================================
// Command: /swap-stats — aggregate stats from llama-swap-usage session entries
// =============================================================================

interface SwapLogStats {
  requests: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  promptMs: number;
  predictedMs: number;
  promptN: number;
  predictedN: number;
  draftN: number;
  draftAccepted: number;
  firstAt: number;
  lastAt: number;
}

interface UsageRecordEntry {
  ts: number;
  record: LlamaSwapUsageRecord;
}

/**
 * Collect llama-swap-usage records from the session log. Works across
 * reloads and resumed sessions, since the data comes from the session record.
 */
function collectUsageRecords(entries: SessionEntry[]): UsageRecordEntry[] {
  return entries
    .filter((e): e is CustomEntry<LlamaSwapUsageRecord> => e.type === "custom" && e.customType === "llama-swap-usage")
    .map((e) => ({
      ts: Date.parse(e.timestamp),
      record: e.data as LlamaSwapUsageRecord | undefined,
    }))
    .filter((e): e is UsageRecordEntry => !!e.record);
}

/** Compute aggregate stats for one server's usage records. */
function computeStats(records: UsageRecordEntry[]): SwapLogStats {
  const stats: SwapLogStats = {
    requests: records.length,
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0,
    promptMs: 0,
    predictedMs: 0,
    promptN: 0,
    predictedN: 0,
    draftN: 0,
    draftAccepted: 0,
    firstAt: Infinity,
    lastAt: 0,
  };

  for (const { ts, record } of records) {
    const at = Number.isFinite(ts) ? ts : record.capturedAt;
    if (Number.isFinite(at)) {
      stats.firstAt = Math.min(stats.firstAt, at);
      stats.lastAt = Math.max(stats.lastAt, at);
    }
    const u = record.usage;
    if (u) {
      stats.promptTokens += u.prompt_tokens ?? 0;
      stats.completionTokens += u.completion_tokens ?? 0;
      stats.cachedTokens += u.prompt_tokens_details?.cached_tokens ?? 0;
    }
    const nt = normalizeTimings(record);
    if (nt) {
      stats.promptMs += nt.promptMs;
      stats.predictedMs += nt.predictedMs;
      stats.promptN += nt.promptN;
      stats.predictedN += nt.predictedN;
      stats.draftN += nt.draftN;
      stats.draftAccepted += nt.draftAccepted;
    }
  }

  return stats;
}

/**
 * Command: /swap-stats — toggles a panel above the editor with aggregate
 * llama-swap stats computed from the session log (survives restarts/reloads).
 */
function registerSwapStatsCommand(pi: ExtensionAPI) {
  let visible = false;
  const WIDGET_KEY = "llama-swap-stats";
  const hide = (ui: { setWidget: (key: string, content: string[] | undefined) => void }) => {
    if (!visible) return;
    visible = false;
    ui.setWidget(WIDGET_KEY, undefined);
  };

  pi.on("session_shutdown", (_event, ctx) => hide(ctx.ui));

  pi.registerCommand("swap-stats", {
    description: "Show aggregate llama-swap stats from the session log (toggles the panel)",
    handler: async (_args, ctx) => {
      if (visible) {
        hide(ctx.ui);
        ctx.ui.notify("llama-swap stats panel hidden.", "info");
        return;
      }

      const theme = ctx.ui.theme;
      const dim = (text: string) => theme.fg("dim", text);
      const row = (label: string, value: string) => `  ${dim(label.padEnd(10))} ${value}`;

      const records = collectUsageRecords(ctx.sessionManager.getEntries());
      if (records.length === 0) {
        ctx.ui.notify("No llama-swap usage entries in this session yet.", "info");
        return;
      }

      // Group by the provider (server) that served the request, preserving
      // first-seen order.
      const groups = new Map<string, UsageRecordEntry[]>();
      for (const entry of records) {
        const server = entry.record.server ?? "llama-swap";
        const list = groups.get(server);
        if (list) list.push(entry);
        else groups.set(server, [entry]);
      }
      const multi = groups.size > 1;

      const tokS = (n: number, ms: number) => (ms > 0 ? (n / (ms / 1000)).toFixed(1) : undefined);
      const pushServerRows = (stats: SwapLogStats) => {
        lines.push(row("Requests", String(stats.requests)));
        if (Number.isFinite(stats.firstAt) && stats.lastAt > stats.firstAt) {
          lines.push(row("Span", `${formatDuration(stats.lastAt - stats.firstAt)} (${new Date(stats.firstAt).toLocaleTimeString()} \u2192 ${new Date(stats.lastAt).toLocaleTimeString()})`));
        }
        if (stats.promptTokens > 0 || stats.completionTokens > 0) {
          const cached = stats.cachedTokens > 0 ? dim(` (${stats.cachedTokens.toLocaleString()} cached)`) : "";
          lines.push(row("Tokens", `${stats.promptTokens.toLocaleString()} in${cached} / ${stats.completionTokens.toLocaleString()} out`));
        }
        const promptRate = tokS(stats.promptN, stats.promptMs);
        if (promptRate) lines.push(row("Prompt", `\u2248 ${promptRate} tok/s`));
        const genRate = tokS(stats.predictedN, stats.predictedMs);
        if (genRate) lines.push(row("Generation", `\u2248 ${genRate} tok/s`));
        if (stats.draftN > 0) {
          const pct = ((stats.draftAccepted / stats.draftN) * 100).toFixed(0);
          lines.push(row("Draft", `${stats.draftAccepted}/${stats.draftN} accepted (${pct}%)`));
        }
        const wallMs = stats.predictedMs + stats.promptMs;
        if (wallMs > 0) lines.push(row("LLM time", `${(wallMs / 1000).toFixed(1)}s total`));
      };

      const lines: string[] = [];
      lines.push(theme.bold("llama-swap stats (session log)"));
      for (const [server, serverRecords] of groups) {
        if (multi) {
          lines.push("");
          lines.push(theme.bold(server));
        }
        pushServerRows(computeStats(serverRecords));
      }

      // Most recent requests, newest first.
      lines.push("");
      lines.push(theme.bold("recent requests"));
      for (const { ts, record } of records.slice(-5).reverse()) {
        const tag = multi ? ` [${record.server ?? "llama-swap"}]` : "";
        lines.push(row("", dim(Number.isFinite(ts) ? new Date(ts).toLocaleTimeString() : "\u2014") + tag + `  ${formatUsageSummary(record)}`));
      }

      visible = true;
      ctx.ui.setWidget(WIDGET_KEY, lines, { placement: "aboveEditor" });
    },
  });
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
    description: "Manage llama-swap servers (no args: add a server; 'add <name> <url>'; 'remove <name>')",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);

      if (parts[0] === "add" && parts.length === 3) {
        const normalized = setServer(parts[1], parts[2]);
        ctx.ui.notify(`llama-swap server "${parts[1]}" (provider ${parts[1].replace(/[^a-zA-Z0-9-]/g, "-")}) set to: ${normalized}`, "info");
        ctx.ui.notify("Run /reload to apply.", "info");
        return;
      }

      if (parts[0] === "remove" && parts.length === 2) {
        if (removeServer(parts[1])) {
          ctx.ui.notify(`llama-swap server "${parts[1]}" removed.`, "info");
          ctx.ui.notify("Run /reload to apply.", "info");
        } else {
          ctx.ui.notify(`No server named "${parts[1]}" in llamaSwap.servers.`, "error");
        }
        return;
      }

      if (parts.length > 0) {
        ctx.ui.notify("Usage: /llama-swap-url | add <name> <url> | remove <name>", "error");
        return;
      }

      const servers = resolveServers();
      const current = servers.length > 0 ? servers.map((s) => `${s.providerId} = ${s.url}`).join(", ") : "(none configured)";
      const name = (await ctx.ui.input(`Configured: ${current}\nEnter server name (empty to cancel):`))?.trim();
      if (!name) {
        ctx.ui.notify("No changes.", "info");
        return;
      }

      const url = await ctx.ui.input(`Enter base URL for "${name}" (without /v1, e.g. http://localhost:8080):`);
      if (!url) {
        ctx.ui.notify(`No URL entered; "${name}" unchanged.`, "info");
        return;
      }

      const normalized = setServer(name, url);
      ctx.ui.notify(`llama-swap server "${name}" (provider ${name.replace(/[^a-zA-Z0-9-]/g, "-")}) set to: ${normalized}`, "info");
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
  registerSwapStatsCommand(pi);

  const servers = resolveServers();
  if (servers.length === 0) {
    console.log("[llama-swap] No servers configured (llamaSwap.servers in settings.json). Providers not registered.");
    return;
  }

  // Built-in openai-completions stream implementation, shared by all servers.
  const openai = getApiProvider("openai-completions");
  if (!openai) {
    console.error("[llama-swap] openai-completions API provider not found in pi-ai registry. Providers not registered.");
    return;
  }

  // Discover and register each server independently, so one unreachable
  // server does not prevent the others from being registered.
  const providerIds = new Set<string>();
  const results = await Promise.allSettled(
    servers.map(async (server) => {
      const response = await fetch(`${server.url}/models`);
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

      // Wrapped with a teed fetch that taps the raw SSE stream for
      // llama.cpp usage/timings fields.
      pi.registerProvider(server.providerId, {
        baseUrl: server.url,
        apiKey: "none", // llama-swap is a local service, no auth needed
        api: "openai-completions",
        models,
        streamSimple: (model, context, options) => {
          const baseFetch = options?.fetch ?? globalThis.fetch;
          return openai.streamSimple(model, context, { ...options, fetch: teedFetch(baseFetch) });
        },
      });

      providerIds.add(server.providerId);
      console.log(`[llama-swap] Registered "${server.providerId}" (${models.length} models) from ${server.url}`);
    }),
  );

  results.forEach((result, i) => {
    if (result.status === "rejected") {
      console.error(
        `[llama-swap] Failed to discover models from ${servers[i].url}/models:`,
        result.reason instanceof Error ? result.reason.message : String(result.reason),
      );
    }
  });

  if (providerIds.size === 0) {
    console.error("[llama-swap] No servers responded. Providers will not be available. Is llama-swap running?");
    return;
  }

  // Persist captured usage/timings into the session record, correlated via
  // the chat completion id that pi stores as `responseId` on the message.
  // Uses turn_end (not message_end) so the custom entry is appended AFTER
  // the assistant message entry is already persisted, keeping the record
  // attached directly below its message in the session file.
  pi.on("turn_end", async (event) => {
    const message = event.message;
    if (message.role !== "assistant") return;
    if (!providerIds.has(message.provider)) return;
    if (!message.responseId) return;

    const capture = captures.get(message.responseId);
    if (!capture) return;

    // The tap usually finishes with the stream; give it a moment to land.
    await Promise.race([capture.ready, new Promise((r) => setTimeout(r, 2000))]);
    const record = capture.record;
    if (!record || (!record.usage && !record.timings && !record.metrics)) return;

    record.server = message.provider;
    captures.delete(record.responseId);
    pi.appendEntry("llama-swap-usage", record);
  });

  pi.registerEntryRenderer("llama-swap-usage", (entry, { expanded }, theme) => {
    const record = entry.data as LlamaSwapUsageRecord | undefined;
    if (!record) return undefined;

    const box = new Box(0, 0);
    const serverTag = record.server ? ` [${record.server}]` : "";
    box.addChild(new Text(theme.fg("dim", `\u26A1 llama-swap${serverTag} ${formatUsageSummary(record)}`)));
    if (expanded) {
      box.addChild(new Text(theme.fg("dim", JSON.stringify(record, null, 2))));
    }
    return box;
  });
}
