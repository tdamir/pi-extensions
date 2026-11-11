/**
 * Engine registry. Records are probed in order; the first engine that
 * recognizes its telemetry owns the record. Order matters: a tensorfold
 * response also carries `usage`, and a llama.cpp response also carries
 * `timings`, so the most specific engine must come first. The OpenAI
 * fallback (shared protocol fields, bare-usage records) comes last.
 */

import type { LlamaSwapUsageRecord, LlamaUsage, NormalizedTimings } from "../types";
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
 * Engine-independent OpenAI-protocol fields — the subset of a `data:` chunk
 * every response carries regardless of engine. Written directly onto the
 * record; engine-specific telemetry goes through the adapters instead.
 */
function extractProtocol(chunk: RawSseChunk, record: LlamaSwapUsageRecord): void {
  if (typeof chunk.id === "string") record.responseId = chunk.id;
  if (typeof chunk.model === "string") record.model = chunk.model;
  if (typeof chunk.system_fingerprint === "string") {
    record.systemFingerprint = chunk.system_fingerprint;
  }
  if (chunk.usage && typeof chunk.usage === "object") {
    record.usage = chunk.usage as LlamaUsage;
  }
}

/**
 * Merge telemetry from a raw SSE `data:` chunk into the accumulating record:
 * protocol fields first, then each adapter's returned payload, stored under
 * that engine's id in `record.engineData`. The tap needs no engine knowledge
 * — adding an adapter automatically extends it.
 */
export function extractTelemetry(chunk: RawSseChunk, record: LlamaSwapUsageRecord): void {
  extractProtocol(chunk, record);
  for (const engine of ENGINES) {
    const payload = engine.extract?.(chunk);
    if (payload !== undefined) (record.engineData ??= {})[engine.id] = payload;
  }
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
export { enginePayload } from "./types";
export { llamaCppTimings } from "./llama-cpp";
export { tensorfoldPayload } from "./tensorfold";
export { vllmMetrics } from "./vllm";
