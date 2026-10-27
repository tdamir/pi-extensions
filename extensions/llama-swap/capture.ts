/**
 * Capture registry: maps a chat-completion response id to the telemetry
 * record extracted from its SSE stream.
 *
 * The tap (`sse.ts`) publishes records here; `turn_end` in `index.ts` waits
 * for the matching record and persists it into the session log.
 */

import type { LlamaSwapUsageRecord } from "./types";

export interface Capture {
  record?: LlamaSwapUsageRecord;
  /** Resolves as soon as a record has been published for this id. */
  resolve: () => void;
  ready: Promise<void>;
}

/** Upper bound so abandoned/never-consumed captures cannot grow unbounded. */
const MAX_CAPTURES = 100;

const captures = new Map<string, Capture>();

/** Does the record carry any telemetry worth persisting? */
export function hasTelemetry(record: LlamaSwapUsageRecord): boolean {
  return !!(record.usage || record.timings || record.metrics || record.tensorfold || record.speculative);
}

/** Publish (or refresh) the record for a response id. */
export function rememberCapture(record: LlamaSwapUsageRecord): void {
  if (captures.size >= MAX_CAPTURES && !captures.has(record.responseId)) {
    const oldest = captures.keys().next().value;
    if (oldest) captures.delete(oldest);
  }
  let capture = captures.get(record.responseId);
  if (!capture) {
    let resolve: () => void = () => {};
    capture = { ready: new Promise<void>((r) => (resolve = r)), resolve };
    captures.set(record.responseId, capture);
  }
  capture.record = record;
  capture.resolve();
}

/** Drop a consumed capture. */
export function forgetCapture(responseId: string): void {
  captures.delete(responseId);
}

/**
 * Wait for the tap to finish parsing the stream (usually already done by the
 * time the turn ends). Returns the record if one was captured in time.
 */
export async function waitForCapture(
  responseId: string,
  timeoutMs = 2000,
): Promise<LlamaSwapUsageRecord | undefined> {
  const capture = captures.get(responseId);
  if (!capture) return undefined;
  await Promise.race([capture.ready, new Promise<void>((r) => setTimeout(r, timeoutMs))]);
  return capture.record;
}
