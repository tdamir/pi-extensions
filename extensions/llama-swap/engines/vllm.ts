import type { LlamaMetrics, LlamaSwapUsageRecord, NormalizedTimings } from "../types";
import type { EngineAdapter } from "./types";
import { DASH, joinParts, line, msAsSecs, rate, speculativeLine } from "./util";

/**
 * vLLM telemetry: the final usage chunk carries a `metrics` object with
 * timings in milliseconds and speculative-decoding counters.
 */
export const vllmEngine: EngineAdapter = {
  id: "vllm",
  label: "vLLM",

  detect: (record) => !!record.metrics,

  hasTelemetry: (record) => !!record.metrics,

  extract(chunk, record) {
    if (chunk.metrics && typeof chunk.metrics === "object") {
      record.metrics = chunk.metrics as LlamaMetrics;
    }
  },

  normalize(record): NormalizedTimings | undefined {
    const m = record.metrics;
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
    const m = record.metrics;
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
