/**
 * Raw telemetry shapes captured from llama-swap SSE responses.
 *
 * Each engine (llama.cpp, vLLM, tensorfold) reports a different subset:
 * - llama.cpp: `usage` + `timings`
 * - vLLM: `usage` + `metrics`
 * - tensorfold: `usage` + `tensorfold` + `speculative` + `exact_mode`
 */

export interface LlamaUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number; created_cache_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
  [key: string]: unknown;
}

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

/**
 * tensorfold diagnostics (emitted on the final chunk, alongside `exact_mode`).
 * Times are in seconds here (unlike llama.cpp/vLLM, which use ms).
 */
export interface TensorfoldDiagnostics {
  /** Whether the server applied a thinking/reasoning template. */
  enable_thinking?: boolean;
  /** Reasoning effort the server actually used (`null` when unset/auto). */
  reasoning_effort?: string | null;
  /** Engine that served the request (e.g. `lanes`). */
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

/** One captured response, stored as a `llama-swap-usage` session entry. */
export interface LlamaSwapUsageRecord {
  responseId: string;
  /** Provider (server) id that served the request. */
  server?: string;
  model?: string;
  systemFingerprint?: string;
  usage?: LlamaUsage;
  timings?: LlamaTimings;
  metrics?: LlamaMetrics;
  /** tensorfold diagnostics; also implies the timings source. */
  tensorfold?: TensorfoldDiagnostics;
  speculative?: SpeculativeDiagnostics;
  /** Sampling mode echoed by tensorfold (e.g. `exact`). */
  exactMode?: string;
  capturedAt: number;
}

/**
 * Engine-independent timing shape, so summaries and aggregate stats work the
 * same regardless of which server produced the telemetry.
 */
export interface NormalizedTimings {
  /** Prefill/prompt time in ms (llama.cpp prompt_ms, vLLM time_to_first_token_ms, tensorfold prefill_seconds). */
  promptMs: number;
  /** Prompt tokens actually prefilled (llama.cpp prompt_n, vLLM prompt_tokens minus cached). */
  promptN: number;
  /** Generation time in ms (llama.cpp predicted_ms, vLLM generation_time_ms, tensorfold seconds minus prefill). */
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
