import type { LlamaSwapUsageRecord, LlamaUsage } from "../types";
import type { EngineAdapter } from "./types";

/**
 * OpenAI-compatible fallback: every engine's telemetry rides on the shared
 * protocol fields (`id`, `model`, `system_fingerprint`, `usage`), and some
 * servers report nothing beyond a bare `usage`. This adapter owns those
 * fields, so it sits last in the registry — the engine-specific adapters
 * always claim a record first.
 */
export const openAiEngine: EngineAdapter = {
  id: "openai",
  label: "OpenAI",

  detect: (record) => !!record.usage,

  extract(chunk, record) {
    if (typeof chunk.id === "string") record.responseId = chunk.id;
    if (typeof chunk.model === "string") record.model = chunk.model;
    if (typeof chunk.system_fingerprint === "string") {
      record.systemFingerprint = chunk.system_fingerprint;
    }
    if (chunk.usage && typeof chunk.usage === "object") {
      record.usage = chunk.usage as LlamaUsage;
    }
  },

  hasTelemetry: (record) => !!record.usage,

  normalize: () => undefined,

  tags: () => [],

  diagnostics: () => [],
};
