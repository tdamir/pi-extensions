/**
 * Aggregate stats over `llama-swap-usage` session entries, and the
 * `/swap-stats` panel.
 *
 * Because the data comes from the session log, the panel works across
 * reloads and resumed sessions.
 */

import type { CustomEntry, ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { normalizeTimings } from "./engines";
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
  /** Engines seen (tensorfold `engine`). */
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

    const tf = record.tensorfold;
    if (tf) {
      stats.tfRequests += 1;
      if (tf.engine) stats.engines.add(tf.engine);
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

/**
 * Command: /swap-stats — toggles a panel above the editor with aggregate
 * llama-swap stats computed from the session log (survives restarts/reloads).
 */
export function registerSwapStatsCommand(pi: ExtensionAPI): void {
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

      const groups = groupByServer(records);
      const multi = groups.size > 1;
      const tokS = (n: number, ms: number) => (ms > 0 ? (n / (ms / 1000)).toFixed(1) : undefined);

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
          const cached = stats.cachedTokens > 0 ? dim(` (${stats.cachedTokens.toLocaleString()} cached)`) : "";
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
        lines.push(
          row(
            "",
            dim(Number.isFinite(ts) ? new Date(ts).toLocaleTimeString() : "\u2014") +
              tag +
              `  ${formatUsageSummary(record)}`,
          ),
        );
      }

      visible = true;
      ctx.ui.setWidget(WIDGET_KEY, lines, { placement: "aboveEditor" });
    },
  });
}
