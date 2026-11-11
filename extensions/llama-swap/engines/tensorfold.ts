import type { LlamaSwapUsageRecord, NormalizedTimings } from "../types";
import type { EngineAdapter } from "./types";
import { DASH, joinParts, line, secs, speculativeLine } from "./util";

/** Adapter label, also used as the summary tag (see `tags`). */
const LABEL = "tensorfold";

/**
 * tensorfold telemetry: `tensorfold` diagnostics plus `speculative` counters
 * and the `exact_mode` echo, all on the final chunk. Times are in seconds
 * here (unlike llama.cpp/vLLM, which use milliseconds).
 */
export const tensorfoldEngine: EngineAdapter = {
  id: "tensorfold",
  label: LABEL,

  detect: (record) => !!record.tensorfold,

  normalize(record): NormalizedTimings | undefined {
    const tf = record.tensorfold;
    if (!tf) return undefined;

    const u = record.usage;
    const spec = record.speculative;
    // `seconds` covers the whole request, so decode time is the remainder
    // after prefill. `tokens_per_second` is reported against that remainder
    // (e.g. 132 tok / (2.877s - 1.186s) ≈ 77.5 tok/s).
    const totalMs = (tf.seconds ?? 0) * 1000;
    const promptMs = (tf.prefill_seconds ?? 0) * 1000;
    return {
      promptMs,
      promptN: Math.max(0, (u?.prompt_tokens ?? 0) - (u?.prompt_tokens_details?.cached_tokens ?? 0)),
      predictedMs: Math.max(0, totalMs - promptMs),
      predictedN: u?.completion_tokens ?? 0,
      draftN: spec?.drafted ?? 0,
      draftAccepted: spec?.accepted ?? 0,
      ...(tf.tokens_per_second != null ? { genRate: tf.tokens_per_second } : {}),
    };
  },

  tags(record) {
    const tf = record.tensorfold;
    if (!tf) return [];
    // Tag the adapter and sampling mode first, e.g. `tensorfold/exact`.
    // `tf.engine` is tensorfold's internal engine name (`lanes`), constant
    // across requests, so it belongs in the expanded diagnostics, not here.
    return [LABEL, record.exactMode ?? tf.sampling].filter((tag): tag is string => !!tag);
  },

  diagnostics(record) {
    const tf = record.tensorfold;
    if (!tf) return [];

    const decodeSecs =
      tf.seconds != null && tf.prefill_seconds != null
        ? Math.max(0, tf.seconds - tf.prefill_seconds)
        : undefined;
    const engine = joinParts(
      LABEL,
      tf.engine ?? DASH,
      tf.drafts != null ? `drafts ${tf.drafts ? "on" : "off"}` : undefined,
      tf.min_rows != null ? `min_rows ${tf.min_rows}` : undefined,
    );
    const thinking = joinParts(
      tf.enable_thinking != null ? `thinking ${tf.enable_thinking ? "on" : "off"}` : undefined,
      tf.reasoning_effort ? `effort ${tf.reasoning_effort}` : undefined,
    );
    const sampling = joinParts(
      record.exactMode ?? tf.sampling ?? DASH,
      tf.token_sha ? `sha ${tf.token_sha}` : undefined,
    );
    const prefill = joinParts(
      `widths ${tf.prefill_widths?.length ? tf.prefill_widths.join(",") : DASH}`,
      `raised ${tf.prefill_raised?.length ? tf.prefill_raised.join(",") : DASH}`,
    );

    const lines = [
      line("engine", engine),
      line("thinking", thinking || DASH),
      line("sampling", sampling),
      line(
        "timings",
        joinParts(
          `ttft ${secs(tf.time_to_first_token)}`,
          `prefill ${secs(tf.prefill_seconds)}`,
          `decode ${secs(decodeSecs)}`,
          `total ${secs(tf.seconds)}`,
        ),
      ),
      line("throughput", tf.tokens_per_second != null ? `${tf.tokens_per_second.toFixed(1)} tok/s` : DASH),
      line("prefill", prefill),
    ];

    const spec = record.speculative;
    if (spec) {
      lines.push(
        line(
          "speculative",
          speculativeLine(
            spec.rounds,
            spec.drafted,
            spec.accepted,
            spec.acceptance_rate,
            spec.tokens_per_round,
          ),
        ),
      );
    }
    return lines;
  },
};
