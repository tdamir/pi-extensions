/**
 * Engine registry. Records are probed in order; the first engine that
 * recognizes its telemetry owns the record. Order matters: a tensorfold
 * response also carries `usage`, and a llama.cpp response also carries
 * `timings`, so the most specific engine must come first. The OpenAI
 * fallback (shared protocol fields, bare-usage records) comes last.
 */

import type { LlamaSwapUsageRecord, NormalizedTimings } from "../types";
import { llamaCppEngine } from "./llama-cpp";
import { openAiEngine } from "./openai";
import { tensorfoldEngine } from "./tensorfold";
import type { EngineAdapter, RawSseChunk } from "./types";
import { vllmEngine } from "./vllm";

export const ENGINES: EngineAdapter[] = [llamaCppEngine, tensorfoldEngine, vllmEngine, openAiEngine];

/** The engine that produced a record's telemetry, if any. */
export function pickEngine(record: LlamaSwapUsageRecord): EngineAdapter | undefined {
  return ENGINES.find((engine) => engine.detect(record));
}

/** Engine-independent timings for a record, if any engine recognized it. */
export function normalizeTimings(record: LlamaSwapUsageRecord): NormalizedTimings | undefined {
  return pickEngine(record)?.normalize(record);
}

/**
 * Merge telemetry from a raw SSE `data:` chunk into the accumulating record.
 * Every registered engine scans the chunk, so the tap needs no engine
 * knowledge — adding an adapter automatically extends it.
 */
export function extractTelemetry(chunk: RawSseChunk, record: LlamaSwapUsageRecord): void {
  for (const engine of ENGINES) engine.extract?.(chunk, record);
}

/** Does the record carry telemetry from any engine worth persisting? */
export function hasTelemetry(record: LlamaSwapUsageRecord): boolean {
  return ENGINES.some((engine) => engine.hasTelemetry(record));
}

/** Engine-specific diagnostic lines for the expanded usage entry. */
export function diagnosticsLines(record: LlamaSwapUsageRecord): string[] {
  return pickEngine(record)?.diagnostics(record) ?? [];
}

export type { EngineAdapter, RawSseChunk } from "./types";
