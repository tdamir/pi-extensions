/**
 * SSE tap: pi-ai's parser drops the raw telemetry fields, so response bodies
 * are teed — pi-ai reads one branch, this tap reads the other and extracts
 * `usage`, `timings`, `metrics`, `tensorfold`, `speculative`, `exact_mode`.
 */

import { hasTelemetry, rememberCapture } from "./capture";
import type {
  LlamaMetrics,
  LlamaSwapUsageRecord,
  LlamaTimings,
  LlamaUsage,
  SpeculativeDiagnostics,
  TensorfoldDiagnostics,
} from "./types";

/** The subset of an SSE `data:` chunk this extension cares about. */
interface StreamChunk {
  id?: string;
  model?: string;
  system_fingerprint?: string;
  usage?: LlamaUsage;
  timings?: LlamaTimings;
  metrics?: LlamaMetrics;
  tensorfold?: TensorfoldDiagnostics;
  speculative?: SpeculativeDiagnostics;
  exact_mode?: string;
}

/** Best-effort parse of a teed SSE branch to extract usage/timings. */
function tapStream(body: ReadableStream<Uint8Array>): void {
  void (async () => {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const record: LlamaSwapUsageRecord = { responseId: "", capturedAt: Date.now() };

    const handleData = (data: string) => {
      if (!data || data === "[DONE]") return;
      let chunk: StreamChunk;
      try {
        chunk = JSON.parse(data) as StreamChunk;
      } catch {
        return;
      }
      if (typeof chunk.id === "string") record.responseId = chunk.id;
      if (typeof chunk.model === "string") record.model = chunk.model;
      if (typeof chunk.system_fingerprint === "string") {
        record.systemFingerprint = chunk.system_fingerprint;
      }
      if (chunk.usage && typeof chunk.usage === "object") record.usage = chunk.usage;
      if (chunk.timings && typeof chunk.timings === "object") record.timings = chunk.timings;
      if (chunk.metrics && typeof chunk.metrics === "object") record.metrics = chunk.metrics;
      if (chunk.tensorfold && typeof chunk.tensorfold === "object") record.tensorfold = chunk.tensorfold;
      if (chunk.speculative && typeof chunk.speculative === "object") record.speculative = chunk.speculative;
      if (typeof chunk.exact_mode === "string") record.exactMode = chunk.exact_mode;
    };

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline: number;
        while ((newline = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line.startsWith("data:")) handleData(line.slice(5).trim());
        }
      }
    } catch {
      // Best-effort: the tap errors when the main stream is cancelled.
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // ignore
      }
      if (record.responseId && hasTelemetry(record)) rememberCapture(record);
    }
  })();
}

/** Wrap fetch so SSE response bodies are teed: pi-ai reads one branch, the tap reads the other. */
export function teedFetch(base: typeof globalThis.fetch): typeof globalThis.fetch {
  return (async (input, init) => {
    const response = await base(input, init);
    const contentType = response.headers.get("content-type") ?? "";
    if (!response.ok || !response.body || !contentType.includes("text/event-stream")) {
      return response;
    }
    const [main, tap] = response.body.tee();
    tapStream(tap);
    return new Response(main, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }) as typeof globalThis.fetch;
}
