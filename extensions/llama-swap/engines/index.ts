/**
 * Engine registry. Records are probed in order; the first engine that
 * recognizes its telemetry owns the record. Order matters: a tensorfold
 * response also carries `usage`, and a llama.cpp response also carries
 * `timings`, so the most specific engine must come first.
 */

import type { LlamaSwapUsageRecord, NormalizedTimings } from "../types";
import { llamaCppEngine } from "./llama-cpp";
import { tensorfoldEngine } from "./tensorfold";
import type { EngineAdapter } from "./types";
import { vllmEngine } from "./vllm";

export const ENGINES: EngineAdapter[] = [llamaCppEngine, tensorfoldEngine, vllmEngine];

/** The engine that produced a record's telemetry, if any. */
export function pickEngine(record: LlamaSwapUsageRecord): EngineAdapter | undefined {
  return ENGINES.find((engine) => engine.detect(record));
}

/** Engine-independent timings for a record, if any engine recognized it. */
export function normalizeTimings(record: LlamaSwapUsageRecord): NormalizedTimings | undefined {
  return pickEngine(record)?.normalize(record);
}

/** Engine-specific diagnostic lines for the expanded usage entry. */
export function diagnosticsLines(record: LlamaSwapUsageRecord): string[] {
  return pickEngine(record)?.diagnostics(record) ?? [];
}

export type { EngineAdapter } from "./types";
