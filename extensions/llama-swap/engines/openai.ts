import type { LlamaSwapUsageRecord } from "../types";
import type { EngineAdapter } from "./types";

/**
 * OpenAI-compatible fallback: some servers report nothing beyond the shared
 * protocol fields and a bare `usage`. This adapter owns those bare-usage
 * records, so it sits last in the registry — the engine-specific adapters
 * always claim a record first. Protocol fields themselves are extracted by
 * the framework (see `extractProtocol` in `./index.ts`).
 */
export const openAiEngine: EngineAdapter = {
  id: "openai",
  label: "OpenAI",

  detect: (record) => !!record.usage,

  hasTelemetry: (record) => !!record.usage,

  normalize: () => undefined,

  tags: () => [],

  diagnostics: () => [],
};
