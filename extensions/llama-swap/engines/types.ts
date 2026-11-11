import type { LlamaSwapUsageRecord, NormalizedTimings } from "../types";

/**
 * One telemetry source (engine). Engines are probed in registry order; the
 * first `detect()` hit owns the record and provides both the normalized
 * timings and the engine-specific display lines.
 */
/** A raw parsed SSE `data:` chunk, before any engine-specific shaping. */
export type RawSseChunk = Record<string, unknown>;

export interface EngineAdapter {
  /** Stable id, e.g. `llama.cpp`. */
  id: string;
  /** Human-readable engine name shown in the expanded breakdown. */
  label: string;
  /** Does this record carry telemetry from this engine? */
  detect(record: LlamaSwapUsageRecord): boolean;
  /**
   * Pull all telemetry fields this engine recognizes out of a raw SSE chunk
   * into the accumulating record. Extraction is a union — every engine scans
   * every chunk — so unlike `detect`, ordering does not matter here. Shared
   * OpenAI-protocol fields belong to the `openai` fallback adapter.
   */
  extract?(chunk: RawSseChunk, record: LlamaSwapUsageRecord): void;
  /** Does this record carry telemetry from this engine worth persisting? */
  hasTelemetry(record: LlamaSwapUsageRecord): boolean;
  /** Normalize engine-specific fields into the shared timing shape. */
  normalize(record: LlamaSwapUsageRecord): NormalizedTimings | undefined;
  /** Short tags shown first in the one-line summary (e.g. `lanes/exact`). */
  tags(record: LlamaSwapUsageRecord): string[];
  /** Extra lines shown when a usage entry is expanded. */
  diagnostics(record: LlamaSwapUsageRecord): string[];
}
