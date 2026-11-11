/**
 * Human-readable formatting of captured usage records (one-line summary,
 * expanded engine breakdown) plus generic duration formatting.
 */

import { diagnosticsLines, normalizeTimings, pickEngine } from "./engines";
import type { LlamaSwapUsageRecord } from "./types";

/** One-line human-readable summary of a captured usage record. */
export function formatUsageSummary(record: LlamaSwapUsageRecord): string {
  const parts: string[] = [];

  // Engine tags first, e.g. `tensorfold/exact`.
  const tags = pickEngine(record)?.tags(record) ?? [];
  if (tags.length > 0) parts.push(tags.join("/"));

  const nt = normalizeTimings(record);
  if (nt) {
    const promptRate =
      nt.promptRate ?? (nt.promptMs > 0 && nt.promptN > 0 ? nt.promptN / (nt.promptMs / 1000) : undefined);
    if (promptRate != null && Number.isFinite(promptRate)) parts.push(`prompt ${promptRate.toFixed(0)} tok/s`);

    const genRate =
      nt.genRate ?? (nt.predictedMs > 0 && nt.predictedN > 0 ? nt.predictedN / (nt.predictedMs / 1000) : undefined);
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

/**
 * Multi-line breakdown of the record, provided by whichever engine produced
 * its telemetry. Empty when no engine recognized the record.
 */
export function formatDiagnosticsLines(record: LlamaSwapUsageRecord): string[] {
  return diagnosticsLines(record);
}

/** Format milliseconds as `1h 02m 03s` or `2m 03s`. */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, "0")}m ${String(seconds).padStart(2, "0")}s`;
  }
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}
