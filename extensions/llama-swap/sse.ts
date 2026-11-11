/**
 * SSE tap: pi-ai's parser drops the raw telemetry fields, so response bodies
 * are teed — pi-ai reads one branch, this tap reads the other. The tap itself
 * is engine-agnostic: it parses `data:` chunks and lets the engine adapters
 * (see `engines/`) pull out whatever telemetry they recognize.
 */

import { hasTelemetry, rememberCapture } from "./capture";
import { extractTelemetry } from "./engines";
import type { LlamaSwapUsageRecord } from "./types";

/** Best-effort parse of a teed SSE branch to extract usage/timings. */
function tapStream(body: ReadableStream<Uint8Array>): void {
  void (async () => {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const record: LlamaSwapUsageRecord = { responseId: "", capturedAt: Date.now() };

    const handleData = (data: string) => {
      if (!data || data === "[DONE]") return;
      let chunk: Record<string, unknown>;
      try {
        chunk = JSON.parse(data) as Record<string, unknown>;
      } catch {
        return;
      }
      extractTelemetry(chunk, record);
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
