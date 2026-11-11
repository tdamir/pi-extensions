/**
 * Aggregate stats over `llama-swap-usage` session entries and the shared
 * plain-text report builders used by the /swap-stats panel
 * (./commands/swap-stats.ts) and the benchmark extension's execution summary
 * files.
 *
 * Because the data comes from the session log, the panel works across
 * reloads and resumed sessions.
 */

import type { ContextUsage, CustomEntry, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { normalizeTimings, pickEngine } from "./engines";
import { formatDuration, formatUsageSummary } from "./format";
import type { LlamaSwapUsageRecord } from "./types";

export interface SwapLogStats {
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
  /** Speculative rounds run (tensorfold). */
  specRounds: number;
  /** Requests that reported tensorfold diagnostics. */
  tfRequests: number;
  /** tensorfold requests served in exact sampling mode. */
  exactRequests: number;
  /** Engines seen, by adapter label (e.g. `tensorfold`, `llama.cpp`, `vLLM`). */
  engines: Set<string>;
  /** Sum of tensorfold time-to-first-token, in ms. */
  ttftMs: number;
  /** Number of requests that reported a time-to-first-token. */
  ttftCount: number;
  firstAt: number;
  lastAt: number;
}

export interface UsageRecordEntry {
  ts: number;
  record: LlamaSwapUsageRecord;
}

/** Collect llama-swap-usage records from the session log. */
export function collectUsageRecords(entries: SessionEntry[]): UsageRecordEntry[] {
  return entries
    .filter(
      (e): e is CustomEntry<LlamaSwapUsageRecord> =>
        e.type === "custom" && e.customType === "llama-swap-usage",
    )
    .map((e) => ({
      ts: Date.parse(e.timestamp),
      record: e.data as LlamaSwapUsageRecord | undefined,
    }))
    .filter((e): e is UsageRecordEntry => !!e.record);
}

/** Compute aggregate stats for one server's usage records. */
export function computeStats(records: UsageRecordEntry[]): SwapLogStats {
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
    specRounds: 0,
    tfRequests: 0,
    exactRequests: 0,
    engines: new Set<string>(),
    ttftMs: 0,
    ttftCount: 0,
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

    // Adapter label (not tensorfold's internal `engine`, which is constant).
    const engine = pickEngine(record)?.label;
    if (engine) stats.engines.add(engine);

    const tf = record.tensorfold;
    if (tf) {
      stats.tfRequests += 1;
      if ((record.exactMode ?? tf.sampling) === "exact") stats.exactRequests += 1;
      if (tf.time_to_first_token != null) {
        stats.ttftMs += tf.time_to_first_token * 1000;
        stats.ttftCount += 1;
      }
    }

    if (record.speculative?.rounds) stats.specRounds += record.speculative.rounds;
  }

  return stats;
}

/** Group records by the provider (server) that served them, preserving order. */
function groupByServer(records: UsageRecordEntry[]): Map<string, UsageRecordEntry[]> {
  const groups = new Map<string, UsageRecordEntry[]>();
  for (const entry of records) {
    const server = entry.record.server ?? "llama-swap";
    const list = groups.get(server);
    if (list) list.push(entry);
    else groups.set(server, [entry]);
  }
  return groups;
}

/** Aggregate tool-call counters for one tool name. */
export interface ToolCallStats {
  calls: number;
  errors: number;
  totalMs: number;
  maxMs: number;
}

/** Aggregate tool-call stats over the session log's message entries. */
export interface ToolStats {
  calls: number;
  errors: number;
  /** Tool calls where the model emitted invalid JSON arguments. */
  malformedArgs: number;
  /** Sum of tool execution times reported via durationMs. */
  totalMs: number;
  /** Calls other tools made (codemode nested calls). */
  nestedCalls: number;
  nestedErrors: number;
  perTool: Map<string, ToolCallStats>;
  /**
   * Skill usage, keyed by skill (directory) name: number of successful
   * read-tool calls that loaded a file from the skill (SKILL.md itself or a
   * file under its directory). Skills are consumed by reading their SKILL.md,
   * so this is the persisted signal of "skill was used".
   */
  skills: Map<string, number>;
}

/** Path matches `<...>/skills/<name>/...` (skill directory segment). */
const SKILL_DIR_PATH_RE = /(^|[/\\])skills[/\\]([^/\\]+)[\\/]/i;
/** Path is `<...>/SKILL.md`. */
const SKILL_FILE_RE = /(^|[/\\])SKILL\.md$/i;

/**
 * Skill name for a read-tool path, or undefined when the path is not part of
 * a skill. Matches files under a `skills/<name>/` directory, or any SKILL.md
 * (skill root marker) by its parent directory name.
 */
export function skillFromPath(path: string): string | undefined {
  const dir = path.match(SKILL_DIR_PATH_RE);
  if (dir) return dir[2];
  if (SKILL_FILE_RE.test(path)) {
    const parts = path.split(/[/\\]/);
    return parts.length >= 2 ? parts[parts.length - 2] : undefined;
  }
  return undefined;
}

/**
 * Collect tool-call stats from the session log's message entries: call and
 * error counts per tool (from toolResult messages), execution times
 * (durationMs), malformed-argument counts (from assistant toolCall blocks),
 * and skill usage (successful read-tool calls on SKILL.md / skill files).
 * Pass sinceMs to restrict to a time window (e.g. one benchmark run).
 */
export function collectToolStats(entries: SessionEntry[], sinceMs?: number): ToolStats {
  const stats: ToolStats = {
    calls: 0,
    errors: 0,
    malformedArgs: 0,
    totalMs: 0,
    nestedCalls: 0,
    nestedErrors: 0,
    perTool: new Map(),
    skills: new Map(),
  };

  // First pass: tool results, indexed by call id so skill reads can be
  // counted only when the read actually succeeded.
  const resultErrorByCallId = new Map<string, boolean>();
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    if (sinceMs != null) {
      const at = Date.parse(entry.timestamp);
      if (Number.isFinite(at) && at < sinceMs) continue;
    }
    const message = entry.message;
    if (message.role === "toolResult") resultErrorByCallId.set(message.toolCallId, message.isError);
  }

  for (const entry of entries) {
    if (entry.type !== "message") continue;
    if (sinceMs != null) {
      const at = Date.parse(entry.timestamp);
      if (Number.isFinite(at) && at < sinceMs) continue;
    }
    const message = entry.message;
    if (message.role === "assistant") {
      for (const part of message.content) {
        if (part.type !== "toolCall") continue;
        if (part.argumentsError) stats.malformedArgs += 1;
        if (part.name === "read") {
          const path = (part.arguments as { path?: unknown } | undefined)?.path;
          const skill = typeof path === "string" ? skillFromPath(path) : undefined;
          // Count only reads that returned a successful result.
          if (skill && resultErrorByCallId.get(part.id) === false) {
            stats.skills.set(skill, (stats.skills.get(skill) ?? 0) + 1);
          }
        }
      }
    } else if (message.role === "toolResult") {
      let tool = stats.perTool.get(message.toolName);
      if (!tool) {
        tool = { calls: 0, errors: 0, totalMs: 0, maxMs: 0 };
        stats.perTool.set(message.toolName, tool);
      }
      stats.calls += 1;
      tool.calls += 1;
      if (message.isError) {
        stats.errors += 1;
        tool.errors += 1;
      }
      const ms = message.durationMs ?? 0;
      if (ms > 0) {
        stats.totalMs += ms;
        tool.totalMs += ms;
        if (ms > tool.maxMs) tool.maxMs = ms;
      }
      const nested = message.nestedCalls?.calls;
      if (nested) {
        for (const nc of nested) {
          stats.nestedCalls += 1;
          if (nc.status === "error") stats.nestedErrors += 1;
        }
      }
    }
  }

  return stats;
}

/** Styling hooks used when rendering a report (theme colors in the TUI panel, identity for plain-text files). */
export interface StatsPaint {
  bold(text: string): string;
  dim(text: string): string;
}

/** Painter that emits plain text (no ANSI codes), for writing reports to files. */
export const plainPaint: StatsPaint = {
  bold: (text) => text,
  dim: (text) => text,
};

/** Minimal shape of pi's Usage as stored on session entries/messages. */
interface UsageLike {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: { total?: number };
}

/** Session totals mirroring pi's built-in /session command (cache-warming rows excluded). */
export interface SessionInfoTotals {
  sessionName?: string;
  sessionFile?: string;
  sessionId?: string;
  userMessages: number;
  assistantMessages: number;
  toolResults: number;
  toolCalls: number;
  totalMessages: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextUsage?: ContextUsage;
}

/**
 * Aggregate session totals from the session log, mirroring pi's internal
 * getSessionStats(): message counts, tool calls/results, token and cost
 * totals from assistant / toolResult / usage / compaction / branch-summary
 * entries, plus the current context usage. Pass sinceMs to restrict message
 * and usage entries to a time window (e.g. one benchmark run); session
 * identity fields (name/file/id) are session-scoped and always included.
 */
export function collectSessionInfo(ctx: ExtensionContext, sinceMs?: number): SessionInfoTotals {
  const sm = ctx.sessionManager;
  const info: SessionInfoTotals = {
    sessionName: sm.getSessionName() ?? undefined,
    sessionFile: sm.getSessionFile() ?? undefined,
    sessionId: sm.getSessionId(),
    userMessages: 0,
    assistantMessages: 0,
    toolResults: 0,
    toolCalls: 0,
    totalMessages: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    contextUsage: ctx.getContextUsage(),
  };

  const add = (usage: UsageLike | undefined) => {
    if (!usage) return;
    info.input += usage.input ?? 0;
    info.output += usage.output ?? 0;
    info.cacheRead += usage.cacheRead ?? 0;
    info.cacheWrite += usage.cacheWrite ?? 0;
    info.cost += usage.cost?.total ?? 0;
  };

  for (const entry of ctx.sessionManager.getEntries()) {
    if (sinceMs != null) {
      const at = Date.parse(entry.timestamp);
      if (Number.isFinite(at) && at < sinceMs) continue;
    }
    if (entry.type === "usage") {
      add(entry.usage as UsageLike);
      continue;
    }
    if (entry.type === "branch_summary" || entry.type === "compaction") {
      add(entry.usage as UsageLike | undefined);
      continue;
    }
    if (entry.type !== "message") continue;
    info.totalMessages += 1;
    const message = entry.message;
    if (message.role === "user") {
      info.userMessages += 1;
    } else if (message.role === "assistant") {
      info.assistantMessages += 1;
      if (Array.isArray(message.content)) {
        info.toolCalls += message.content.filter((c) => c.type === "toolCall").length;
      }
      add(message.usage as UsageLike | undefined);
    } else if (message.role === "toolResult") {
      info.toolResults += 1;
      add(message.usage as UsageLike | undefined);
    }
  }

  return info;
}

/**
 * Build the "session" report section mirroring pi's built-in /session output
 * (name/file/id, message counts, input/cached/uncached/output/total tokens,
 * context usage, and cost when non-zero). Cache-warming rows are omitted —
 * they are not reachable from the extension context.
 */
export function buildSessionInfoReport(
  info: SessionInfoTotals,
  paint: StatsPaint,
  title = "session",
): string[] {
  const row = (label: string, value: string) => `  ${paint.dim(label.padEnd(10))} ${value}`;
  const lines: string[] = [];
  lines.push(paint.bold(title));

  if (info.sessionName) lines.push(row("Name", info.sessionName));
  if (info.sessionFile) lines.push(row("File", info.sessionFile));
  if (info.sessionId) lines.push(row("ID", info.sessionId));

  lines.push(
    row(
      "Messages",
      `${info.totalMessages} total (${info.userMessages} user, ${info.assistantMessages} assistant, ${info.toolResults} tool results) \u00B7 ${info.toolCalls} tool calls`,
    ),
  );

  // Same presentation as pi's /session: "Input" is the full prompt volume
  // (re-sent per request); with cache activity it splits into cached vs uncached.
  const promptTokens = info.input + info.cacheRead + info.cacheWrite;
  const totalTokens = promptTokens + info.output;
  lines.push(row("Input", promptTokens.toLocaleString()));
  if (promptTokens > 0 && (info.cacheRead > 0 || info.cacheWrite > 0)) {
    const hit = ((info.cacheRead / promptTokens) * 100).toFixed(1);
    lines.push(row("", `${paint.dim("Cached:")} ${info.cacheRead.toLocaleString()} ${paint.dim(`(${hit}%)`)}`));
    const written =
      info.cacheWrite > 0 ? ` ${paint.dim(`(${info.cacheWrite.toLocaleString()} written to cache)`)}` : "";
    lines.push(row("", `${paint.dim("Uncached:")} ${(info.input + info.cacheWrite).toLocaleString()}${written}`));
  }
  lines.push(row("Output", info.output.toLocaleString()));
  lines.push(row("Total", totalTokens.toLocaleString()));

  if (info.contextUsage) {
    const { tokens, contextWindow, percent } = info.contextUsage;
    lines.push(
      row(
        "Context",
        tokens == null
          ? `? / ${contextWindow.toLocaleString()} tokens`
          : `${tokens.toLocaleString()} / ${contextWindow.toLocaleString()} tokens${percent != null ? ` (${percent.toFixed(1)}%)` : ""}`,
      ),
    );
  }

  if (info.cost > 0) lines.push(row("Cost", `$${info.cost.toFixed(3)}`));

  return lines;
}

/**
 * Build the swap-stats report lines: per-server aggregate rows, an optional
 * tool-calls section, and the most recent requests. Shared between the
 * /swap-stats panel (theme paint) and the benchmark extension's execution
 * summary file (plainPaint).
 * Returns an empty array when there are no records.
 */
export function buildStatsReport(
  records: UsageRecordEntry[],
  paint: StatsPaint,
  title = "llama-swap stats (session log)",
  tools?: ToolStats,
): string[] {
  const hasTools = !!tools && tools.calls > 0;
  if (records.length === 0 && !hasTools) return [];

  const row = (label: string, value: string) => `  ${paint.dim(label.padEnd(10))} ${value}`;
  const tokS = (n: number, ms: number) => (ms > 0 ? (n / (ms / 1000)).toFixed(1) : undefined);
  const ms = (value: number) => (value < 1000 ? `${Math.round(value)}ms` : `${(value / 1000).toFixed(1)}s`);

  const groups = groupByServer(records);
  const multi = groups.size > 1;

  const pushServerRows = (stats: SwapLogStats) => {
    lines.push(row("Requests", String(stats.requests)));
    if (Number.isFinite(stats.firstAt) && stats.lastAt > stats.firstAt) {
      lines.push(
        row(
          "Span",
          `${formatDuration(stats.lastAt - stats.firstAt)} (${new Date(stats.firstAt).toLocaleTimeString()} \u2192 ${new Date(stats.lastAt).toLocaleTimeString()})`,
        ),
      );
    }
    if (stats.promptTokens > 0 || stats.completionTokens > 0) {
      // promptTokens/cachedTokens are summed per request: each request re-sends
      // the whole context, so they grow with (requests x context size) while
      // completionTokens stay linear. The cache % shows the billed-vs-cached split.
      const cached =
        stats.cachedTokens > 0
          ? paint.dim(
              ` (${stats.cachedTokens.toLocaleString()} cached, ${((stats.cachedTokens / stats.promptTokens) * 100).toFixed(1)}% hit)`,
            )
          : "";
      lines.push(
        row(
          "Tokens",
          `${stats.promptTokens.toLocaleString()} in${cached} / ${stats.completionTokens.toLocaleString()} out`,
        ),
      );
    }
    const promptRate = tokS(stats.promptN, stats.promptMs);
    if (promptRate) lines.push(row("Prompt", `\u2248 ${promptRate} tok/s`));
    const genRate = tokS(stats.predictedN, stats.predictedMs);
    if (genRate) lines.push(row("Generation", `\u2248 ${genRate} tok/s`));
    if (stats.ttftCount > 0) {
      lines.push(row("TTFT", `\u2248 ${(stats.ttftMs / stats.ttftCount / 1000).toFixed(2)}s avg`));
    }
    if (stats.draftN > 0) {
      const pct = ((stats.draftAccepted / stats.draftN) * 100).toFixed(0);
      const rounds =
        stats.specRounds > 0
          ? ` \u00B7 ${stats.specRounds} rounds \u00B7 ${(stats.predictedN / stats.specRounds).toFixed(1)} tok/round`
          : "";
      lines.push(row("Draft", `${stats.draftAccepted}/${stats.draftN} accepted (${pct}%)${rounds}`));
    }
    if (stats.engines.size > 0) {
      lines.push(row("Engine", [...stats.engines].join(", ")));
    }
    if (stats.exactRequests > 0) {
      lines.push(row("Exact", `${stats.exactRequests}/${stats.tfRequests} requests`));
    }
    const wallMs = stats.predictedMs + stats.promptMs;
    if (wallMs > 0) lines.push(row("LLM time", `${(wallMs / 1000).toFixed(1)}s total`));
  };

  const lines: string[] = [];
  lines.push(paint.bold(title));
  for (const [server, serverRecords] of groups) {
    if (multi) {
      lines.push("");
      lines.push(paint.bold(server));
    }
    pushServerRows(computeStats(serverRecords));
  }

  // Tool calls, from the session log's toolResult / assistant messages.
  if (tools && tools.calls > 0) {
    if (records.length > 0) lines.push("");
    lines.push(paint.bold("tool calls"));

    const totals = [`${tools.calls} calls`];
    if (tools.errors > 0) totals.push(`${tools.errors} failed (${((tools.errors / tools.calls) * 100).toFixed(1)}%)`);
    if (tools.malformedArgs > 0) totals.push(`${tools.malformedArgs} malformed args`);
    lines.push(row("Tools", totals.join(" \u00B7 ")));

    if (tools.totalMs > 0) lines.push(row("Tool time", `${ms(tools.totalMs)} total`));

    // Per-tool call counts, busiest first; collapse the tail beyond 8 tools.
    const byCalls = [...tools.perTool.entries()].sort((a, b) => b[1].calls - a[1].calls);
    const top = byCalls.slice(0, 8);
    const rest = byCalls.slice(8);
    const breakdown = top.map(
      ([name, t]) => `${name} ${t.calls}${t.errors > 0 ? paint.dim(` (${t.errors} failed)`) : ""}`,
    );
    if (rest.length > 0) breakdown.push(`+${rest.length} more (${rest.reduce((n, [, t]) => n + t.calls, 0)} calls)`);
    lines.push(row("Calls", breakdown.join(" \u00B7 ")));

    // Skills used: successful read-tool calls on SKILL.md / skill files.
    if (tools.skills.size > 0) {
      const byLoads = [...tools.skills.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      const skillParts = byLoads
        .slice(0, 6)
        .map(([name, loads]) => `${name} ${loads} ${loads === 1 ? "read" : "reads"}`);
      if (byLoads.length > 6) skillParts.push(`+${byLoads.length - 6} more`);
      lines.push(row("Skills", `${tools.skills.size} used \u00B7 ${skillParts.join(" \u00B7 ")}`));
    }

    const slowest = byCalls
      .filter(([, t]) => t.maxMs > 0)
      .sort((a, b) => b[1].maxMs - a[1].maxMs)
      .slice(0, 3);
    if (slowest.length > 0) {
      lines.push(row("Slowest", slowest.map(([name, t]) => `${name} ${ms(t.maxMs)}`).join(" \u00B7 ")));
    }

    if (tools.nestedCalls > 0) {
      lines.push(
        row(
          "Nested",
          `${tools.nestedCalls} calls${tools.nestedErrors > 0 ? ` \u00B7 ${tools.nestedErrors} failed` : ""}`,
        ),
      );
    }
  }

  // Most recent requests, newest first.
  if (records.length > 0) {
    lines.push("");
    lines.push(paint.bold("recent requests"));
    for (const { ts, record } of records.slice(-5).reverse()) {
      const tag = multi ? ` [${record.server ?? "llama-swap"}]` : "";
      lines.push(
        row(
          "",
          paint.dim(Number.isFinite(ts) ? new Date(ts).toLocaleTimeString() : "\u2014") +
            tag +
            `  ${formatUsageSummary(record)}`,
        ),
      );
    }
  }

  return lines;
}

/**
 * Build a compact one-glance report that fits the interactive widget budget
 * (pi truncates string-array widgets at 10 lines). Related facts are merged
 * per row: requests+span, tokens+LLM time, all rates, draft+engines+exact,
 * tool totals, and the single most recent request. Use buildStatsReport for
 * the full detail (rendered via a custom component, which is not line-capped).
 */
export function buildCompactStatsReport(
  records: UsageRecordEntry[],
  paint: StatsPaint,
  title = "llama-swap stats (session log)",
  tools?: ToolStats,
): string[] {
  const hasTools = !!tools && tools.calls > 0;
  if (records.length === 0 && !hasTools) return [];

  const row = (label: string, value: string) => `  ${paint.dim(label.padEnd(10))} ${value}`;
  const rate = (n: number, ms: number) => (ms > 0 ? (n / (ms / 1000)).toFixed(0) : undefined);
  const dur = (value: number) => (value < 1000 ? `${Math.round(value)}ms` : `${(value / 1000).toFixed(1)}s`);

  const lines: string[] = [];
  lines.push(paint.bold(title));

  const groups = groupByServer(records);
  const multi = groups.size > 1;
  // With several servers, collapse each to a single summary line so the
  // compact view stays within the widget's line budget.
  const MAX_SERVERS = multi ? 4 : 1;
  let shown = 0;
  for (const [server, serverRecords] of groups) {
    if (shown >= MAX_SERVERS) {
      lines.push(row("", paint.dim(`+${groups.size - shown} more server(s) \u2014 /swap-stats full`)));
      break;
    }
    shown += 1;
    const s = computeStats(serverRecords);

    if (multi) {
      const parts = [`${s.requests} req`];
      if (s.promptTokens > 0 || s.completionTokens > 0) {
        parts.push(`${s.promptTokens.toLocaleString()}\u2192${s.completionTokens.toLocaleString()} tok`);
      }
      const genRate = rate(s.predictedN, s.predictedMs);
      if (genRate) parts.push(`gen \u2248 ${genRate} tok/s`);
      if (s.draftN > 0) parts.push(`draft ${((s.draftAccepted / s.draftN) * 100).toFixed(0)}%`);
      if (s.engines.size > 0) parts.push([...s.engines].join(","));
      lines.push(row("", `${paint.bold(server.padEnd(10))} ${parts.join(" \u00B7 ")}`));
      continue;
    }

    const reqParts = [`${s.requests} requests`];
    if (Number.isFinite(s.firstAt) && s.lastAt > s.firstAt) {
      reqParts.push(`span ${formatDuration(s.lastAt - s.firstAt)}`);
    }
    lines.push(row("Requests", reqParts.join(" \u00B7 ")));

    const tokParts: string[] = [];
    if (s.promptTokens > 0 || s.completionTokens > 0) {
      const cached =
        s.cachedTokens > 0
          ? ` (${s.cachedTokens.toLocaleString()} cached, ${((s.cachedTokens / s.promptTokens) * 100).toFixed(0)}%)`
          : "";
      tokParts.push(`${s.promptTokens.toLocaleString()} in${cached} / ${s.completionTokens.toLocaleString()} out`);
    }
    const wallMs = s.promptMs + s.predictedMs;
    if (wallMs > 0) tokParts.push(`LLM time ${dur(wallMs)}`);
    if (tokParts.length > 0) lines.push(row("Tokens", tokParts.join(" \u00B7 ")));

    const speed: string[] = [];
    const promptRate = rate(s.promptN, s.promptMs);
    if (promptRate) speed.push(`prompt \u2248 ${promptRate} tok/s`);
    const genRate = rate(s.predictedN, s.predictedMs);
    if (genRate) speed.push(`gen \u2248 ${genRate} tok/s`);
    if (s.ttftCount > 0) speed.push(`TTFT \u2248 ${(s.ttftMs / s.ttftCount / 1000).toFixed(2)}s avg`);
    if (speed.length > 0) lines.push(row("Speed", speed.join(" \u00B7 ")));

    const specParts: string[] = [];
    if (s.draftN > 0) {
      const pct = ((s.draftAccepted / s.draftN) * 100).toFixed(0);
      specParts.push(`draft ${s.draftAccepted}/${s.draftN} (${pct}%)`);
      if (s.specRounds > 0) specParts.push(`${s.specRounds} rounds`);
    }
    if (s.engines.size > 0) specParts.push([...s.engines].join(","));
    if (s.exactRequests > 0) specParts.push(`exact ${s.exactRequests}/${s.tfRequests}`);
    if (specParts.length > 0) lines.push(row("Spec", specParts.join(" \u00B7 ")));
  }

  if (tools && tools.calls > 0) {
    const totals = [`${tools.calls} calls`];
    if (tools.errors > 0) totals.push(`${tools.errors} failed (${((tools.errors / tools.calls) * 100).toFixed(0)}%)`);
    if (tools.malformedArgs > 0) totals.push(`${tools.malformedArgs} malformed args`);
    if (tools.totalMs > 0) totals.push(`time ${dur(tools.totalMs)}`);
    if (tools.nestedCalls > 0) totals.push(`${tools.nestedCalls} nested`);
    lines.push(row("Tool calls", totals.join(" \u00B7 ")));

    const byCalls = [...tools.perTool.entries()].sort((a, b) => b[1].calls - a[1].calls);
    const breakdown = byCalls
      .slice(0, 6)
      .map(([name, t]) => `${name} ${t.calls}${t.errors > 0 ? ` (${t.errors} fail)` : ""}`);
    if (byCalls.length > 6) breakdown.push(`+${byCalls.length - 6} more`);
    lines.push(row("Tools", breakdown.join(" \u00B7 ")));

    if (tools.skills.size > 0) {
      const byLoads = [...tools.skills.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      const skillParts = byLoads
        .slice(0, 6)
        .map(([name, loads]) => `${name} ${loads} ${loads === 1 ? "read" : "reads"}`);
      if (byLoads.length > 6) skillParts.push(`+${byLoads.length - 6} more`);
      lines.push(row("Skills", `${tools.skills.size} used \u00B7 ${skillParts.join(" \u00B7 ")}`));
    }
  }

  if (records.length > 0) {
    const last = records[records.length - 1];
    const tag = multi && last.record.server ? `[${last.record.server}] ` : "";
    const at = Number.isFinite(last.ts) ? new Date(last.ts).toLocaleTimeString() : "\u2014";
    lines.push(row("Last", paint.dim(`${at} ${tag}`) + formatUsageSummary(last.record)));
  }

  return lines;
}
