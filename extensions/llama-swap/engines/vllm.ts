import type { LlamaSwapUsageRecord, NormalizedTimings } from "../types";
import { enginePayload, type EngineAdapter } from "./types";
import { DASH, joinParts, line, msAsSecs, rate, speculativeLine } from "./util";

/** vLLM's per-response `metrics` object (emitted on the final usage chunk). */
export interface LlamaMetrics {
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

const ID = "vllm";

/** The vLLM telemetry extracted into a record, if any. */
export function vllmMetrics(record: LlamaSwapUsageRecord): LlamaMetrics | undefined {
  const metrics = enginePayload<LlamaMetrics>(record, ID);
  if (metrics) return metrics;
  // Session logs written before `engineData` existed stored metrics top-level.
  return (record as { metrics?: LlamaMetrics }).metrics;
}

/**
 * vLLM telemetry: the final usage chunk carries a `metrics` object with
 * timings in milliseconds and speculative-decoding counters.
 */
export const vllmEngine: EngineAdapter = {
  id: ID,
  label: "vLLM",

  detect: (record) => !!vllmMetrics(record),

  hasTelemetry: (record) => !!vllmMetrics(record),

  extract: (chunk) =>
    chunk.metrics && typeof chunk.metrics === "object" ? (chunk.metrics as LlamaMetrics) : undefined,

  normalize(record): NormalizedTimings | undefined {
    const m = vllmMetrics(record);
    if (!m) return undefined;

    const u = record.usage;
    const promptTokens = u?.prompt_tokens ?? 0;
    const cached = u?.prompt_tokens_details?.cached_tokens ?? 0;
    const spec = m.speculative_decoding;
    // Derive throughput from the mean inter-token latency rather than the
    // server's `tokens_per_second`, which can be reported against a different
    // time base (e.g. including queue time).
    const genRate = m.mean_itl_ms != null && m.mean_itl_ms > 0 ? 1000 / m.mean_itl_ms : undefined;
    return {
      promptMs: m.time_to_first_token_ms ?? 0,
      promptN: Math.max(0, promptTokens - cached),
      predictedMs: m.generation_time_ms ?? 0,
      predictedN: u?.completion_tokens ?? 0,
      draftN: spec?.num_draft_tokens ?? 0,
      draftAccepted: spec?.num_accepted_draft_tokens ?? 0,
      ...(genRate != null && Number.isFinite(genRate) ? { genRate } : {}),
    };
  },

  tags: () => [],

  diagnostics(record) {
    const m = vllmMetrics(record);
    if (!m) return [];

    const spec = m.speculative_decoding;
    const genRate =
      m.mean_itl_ms != null && m.mean_itl_ms > 0 ? 1000 / m.mean_itl_ms : m.tokens_per_second;
    const lines = [
      line("engine", "vLLM"),
      line(
        "timings",
        joinParts(
          `ttft ${msAsSecs(m.time_to_first_token_ms)}`,
          `queue ${msAsSecs(m.queue_time_ms)}`,
          `gen ${msAsSecs(m.generation_time_ms)}`,
        ),
      ),
      line(
        "throughput",
        joinParts(
          rate(genRate),
          m.mean_itl_ms != null ? `mean itl ${m.mean_itl_ms.toFixed(1)} ms` : undefined,
        ),
      ),
    ];

    if (spec) {
      lines.push(
        line(
          "speculative",
          speculativeLine(
            spec.num_spec_steps,
            spec.num_draft_tokens,
            spec.num_accepted_draft_tokens,
            spec.draft_acceptance_rate,
            spec.mean_acceptance_length,
          ),
        ),
      );
    }
    return lines;
  },
};
