/**
 * Shared record shapes for telemetry captured from llama-swap SSE responses.
 *
 * This file is engine-agnostic: engine-specific telemetry is stored in
 * `engineData`, keyed by engine id, and only the engine's adapter knows how
 * to interpret it (see `engines/`). Only the OpenAI-protocol `usage` shape —
 * shared by every engine — is declared here.
 */

/** OpenAI-standard token usage; every engine's final chunk carries one. */
export interface LlamaUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number; created_cache_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
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
  /**
   * Engine-specific telemetry payloads, keyed by engine id (e.g. `vllm`).
   * Written by the engine adapters during capture; consumers must go through
   * the adapter's typed accessor instead of reading this directly.
   */
  engineData?: Record<string, unknown>;
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
