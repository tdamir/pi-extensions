import type { LlamaSwapUsageRecord, NormalizedTimings } from "../types";
import { enginePayload, type EngineAdapter } from "./types";
import { DASH, joinParts, line, msAsSecs, rate, speculativeLine } from "./util";

/**
 * llama.cpp / llama-server telemetry: the final chunk carries `timings` with
 * prefill and decode durations in milliseconds, plus draft counters.
 */
export interface LlamaTimings {
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

const ID = "llama.cpp";

/** The llama.cpp telemetry extracted into a record, if any. */
export function llamaCppTimings(record: LlamaSwapUsageRecord): LlamaTimings | undefined {
  const timings = enginePayload<LlamaTimings>(record, ID);
  if (timings) return timings;
  // Session logs written before `engineData` existed stored timings top-level.
  return (record as { timings?: LlamaTimings }).timings;
}

export const llamaCppEngine: EngineAdapter = {
  id: ID,
  label: "llama.cpp",

  detect: (record) => !!llamaCppTimings(record),

  hasTelemetry: (record) => !!llamaCppTimings(record),

  extract: (chunk) =>
    chunk.timings && typeof chunk.timings === "object" ? (chunk.timings as LlamaTimings) : undefined,

  normalize(record): NormalizedTimings | undefined {
    const t = llamaCppTimings(record);
    if (!t) return undefined;
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
  },

  tags: () => [],

  diagnostics(record) {
    const t = llamaCppTimings(record);
    if (!t) return [];

    const promptMs = t.prompt_ms ?? 0;
    const predictedMs = t.predicted_ms ?? 0;
    const lines = [
      line("engine", "llama.cpp"),
      line(
        "timings",
        joinParts(
          `prompt ${msAsSecs(promptMs)} (${t.prompt_n ?? 0} tok)`,
          `decode ${msAsSecs(predictedMs)} (${t.predicted_n ?? 0} tok)`,
          `total ${msAsSecs(promptMs + predictedMs)}`,
        ),
      ),
      line(
        "throughput",
        joinParts(`prompt ${rate(t.prompt_per_second)}`, `gen ${rate(t.predicted_per_second)}`),
      ),
      line(
        "cache",
        joinParts(`cache_n ${t.cache_n ?? DASH}`, `prompt_n ${t.prompt_n ?? DASH}`),
      ),
    ];

    if (t.draft_n) {
      lines.push(
        line(
          "speculative",
          speculativeLine(undefined, t.draft_n, t.draft_n_accepted, undefined, undefined),
        ),
      );
    }
    return lines;
  },
};
