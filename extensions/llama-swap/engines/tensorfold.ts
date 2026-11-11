import type { LlamaSwapUsageRecord, NormalizedTimings } from "../types";
import { enginePayload, type EngineAdapter } from "./types";
import { DASH, joinParts, line, secs, speculativeLine } from "./util";

/** Adapter label, also used as the summary tag (see `tags`). */
const LABEL = "tensorfold";

/**
 * tensorfold diagnostics (emitted on the final chunk, alongside `exact_mode`).
 * Times are in seconds here (unlike llama.cpp/vLLM, which use milliseconds).
 */
export interface TensorfoldDiagnostics {
  /** Whether the server applied a thinking/reasoning template. */
  enable_thinking?: boolean;
  /** Reasoning effort the server actually used (`null` when unset/auto). */
  reasoning_effort?: string | null;
  /** tensorfold's internal engine name (e.g. `lanes`). */
  engine?: string;
  /** Generation throughput (completion tokens per decode second). */
  tokens_per_second?: number;
  /** Total wall time for the request, prefill included. */
  seconds?: number;
  /** Prefill time in seconds. */
  prefill_seconds?: number;
  /** Prefill batch widths used by the engine (engine-specific). */
  prefill_widths?: number[];
  /** Prefill batches the engine raised (engine-specific). */
  prefill_raised?: number[];
  /** End-to-end time to first token. */
  time_to_first_token?: number;
  /** Sampling mode the server applied (e.g. `exact`). */
  sampling?: string;
  /** Whether speculative drafting was enabled. */
  drafts?: boolean;
  /** Deterministic hash of the produced token sequence (exactness check). */
  token_sha?: string;
  /** Minimum row count the engine batched at (engine-specific). */
  min_rows?: number;
  [key: string]: unknown;
}

/** tensorfold speculative-decoding counters (same final chunk as `tensorfold`). */
export interface SpeculativeDiagnostics {
  /** Speculative rounds run. */
  rounds?: number;
  /** Draft tokens proposed. */
  drafted?: number;
  /** Draft tokens accepted. */
  accepted?: number;
  /** Accepted / drafted (server-provided). */
  acceptance_rate?: number;
  /** Mean completion tokens produced per round. */
  tokens_per_round?: number;
  [key: string]: unknown;
}

/** Everything tensorfold extracts into a record, under one `engineData` key. */
export interface TensorfoldPayload {
  diagnostics?: TensorfoldDiagnostics;
  speculative?: SpeculativeDiagnostics;
  /** Sampling mode echoed by the server (e.g. `exact`). */
  exactMode?: string;
}

const ID = "tensorfold";

/** The tensorfold telemetry extracted into a record, if any. */
export function tensorfoldPayload(record: LlamaSwapUsageRecord): TensorfoldPayload | undefined {
  const payload = enginePayload<TensorfoldPayload>(record, ID);
  if (payload) return payload;
  // Session logs written before `engineData` existed stored these top-level.
  const legacy = record as {
    tensorfold?: TensorfoldDiagnostics;
    speculative?: SpeculativeDiagnostics;
    exactMode?: string;
  };
  if (legacy.tensorfold || legacy.speculative || legacy.exactMode != null) {
    return {
      diagnostics: legacy.tensorfold,
      speculative: legacy.speculative,
      exactMode: legacy.exactMode,
    };
  }
  return undefined;
}

/**
 * tensorfold telemetry: `tensorfold` diagnostics plus `speculative` counters
 * and the `exact_mode` echo, all on the final chunk. Times are in seconds
 * here (unlike llama.cpp/vLLM, which use milliseconds).
 */
export const tensorfoldEngine: EngineAdapter = {
  id: ID,
  label: LABEL,

  detect: (record) => !!tensorfoldPayload(record),

  hasTelemetry: (record) => !!tensorfoldPayload(record),

  extract(chunk) {
    const payload: TensorfoldPayload = {};
    if (chunk.tensorfold && typeof chunk.tensorfold === "object") {
      payload.diagnostics = chunk.tensorfold as TensorfoldDiagnostics;
    }
    if (chunk.speculative && typeof chunk.speculative === "object") {
      payload.speculative = chunk.speculative as SpeculativeDiagnostics;
    }
    if (typeof chunk.exact_mode === "string") payload.exactMode = chunk.exact_mode;
    return payload.diagnostics || payload.speculative || payload.exactMode != null
      ? payload
      : undefined;
  },

  normalize(record): NormalizedTimings | undefined {
    const payload = tensorfoldPayload(record);
    const tf = payload?.diagnostics;
    if (!tf) return undefined;

    const u = record.usage;
    const spec = payload?.speculative;
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
    const payload = tensorfoldPayload(record);
    if (!payload) return [];
    // Tag the adapter and sampling mode first, e.g. `tensorfold/exact`.
    // `diagnostics.engine` is tensorfold's internal engine name (`lanes`),
    // constant across requests, so it belongs in the expanded diagnostics.
    return [LABEL, payload.exactMode ?? payload.diagnostics?.sampling].filter(
      (tag): tag is string => !!tag,
    );
  },

  diagnostics(record) {
    const payload = tensorfoldPayload(record);
    const tf = payload?.diagnostics;
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
      payload?.exactMode ?? tf.sampling ?? DASH,
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

    const spec = payload?.speculative;
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
