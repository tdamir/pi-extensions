/**
 * Model discovery: fetch `/models` from a llama-swap server and map each
 * entry to a pi ProviderModelConfig.
 */

/** Pi thinking levels. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/**
 * llama-swap encodes a fixed reasoning effort as a `:{level}` suffix on the
 * model ID (e.g. `qwen3-coder:medium`). The suffix must be kept in the ID
 * (the server needs it), and the thinking level is pinned to it.
 */
const REASONING_SUFFIX_RE = /:(off|minimal|low|medium|high|xhigh|max)$/;

/** Shape of one entry in the llama-swap `/models` response. */
export interface SwapModelEntry {
  id: string;
  name?: string;
  object?: string;
  created?: number;
  owned_by?: string;
  context_length?: number;
  capabilities?: Record<string, unknown>;
  architecture?: {
    input_modalities?: string[];
    modality?: string;
  };
}

/** Shape of a pi provider model config produced by `mapModel`. */
export interface SwapModel {
  id: string;
  name: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
  thinkingLevelMap?: Record<string, string | null>;
  compat?: { supportsReasoningEffort?: boolean };
}

/** Infer reasoning support from the model ID. */
function inferReasoning(id: string): boolean {
  return /-think|\.think|_think|Think/i.test(id);
}

function parseReasoningSuffix(id: string): ThinkingLevel | undefined {
  const match = REASONING_SUFFIX_RE.exec(id);
  return match ? (match[1] as ThinkingLevel) : undefined;
}

/** Infer input types from the model's capabilities and architecture. */
function inferInputTypes(
  capabilities: { vision?: boolean } | undefined,
  architecture: { input_modalities?: string[] } | undefined,
): ("text" | "image")[] {
  if (capabilities?.vision) return ["text", "image"];
  const mods = architecture?.input_modalities ?? [];
  if (mods.some((m) => m.includes("image"))) return ["text", "image"];
  return ["text"];
}

/** Map a llama-swap model entry to a pi ProviderModelConfig. */
export function mapModel(entry: SwapModelEntry): SwapModel {
  const capabilities = entry.capabilities as { vision?: boolean } | undefined;
  const suffix = parseReasoningSuffix(entry.id);

  return {
    id: entry.id,
    name: entry.name ?? entry.id,
    reasoning: suffix ? suffix !== "off" : inferReasoning(entry.id),
    input: inferInputTypes(capabilities, entry.architecture),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: entry.context_length ?? 128000,
    maxTokens: entry.context_length ?? 128000,
    // Effort is baked into the model name: pin the thinking level to the
    // suffix value and hide all other levels.
    ...(suffix
      ? {
          thinkingLevelMap: Object.fromEntries(
            THINKING_LEVELS.map((level) => [level, level === suffix ? level : null]),
          ),
          compat: { supportsReasoningEffort: false },
        }
      : {}),
  };
}

/** Fetch and map all models exposed by one llama-swap server. */
export async function discoverModels(baseUrl: string): Promise<SwapModel[]> {
  const response = await fetch(`${baseUrl}/models`);
  if (!response.ok) {
    throw new Error(`llama-swap API returned ${response.status}: ${response.statusText}`);
  }
  const payload = (await response.json()) as { data?: SwapModelEntry[] };
  return (payload.data ?? []).map(mapModel);
}
