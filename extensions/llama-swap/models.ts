/**
 * Model discovery: fetch `/models` from a llama-swap server and map each
 * entry to a pi ProviderModelConfig.
 */

/**
 * Output-token ceiling used for every discovered model.
 *
 * `maxTokens` is the *reply* cap sent as `max_tokens`, not the context window.
 * llama.cpp rejects a request when `prompt + max_tokens > n_ctx`, and pi-ai's
 * clamp (`contextWindow - estimate - 4096`) relies on a ~3.5 chars/token
 * estimate that routinely under-counts tool schemas and JSON/code by 20-30%.
 * Capping the reply at a fixed size leaves enough headroom that estimation
 * error is unlikely to push the request over the context window.
 *
 * Trade-off: the larger the cap, the earlier overflow can strike. A request
 * overflows once the real prompt exceeds `n_ctx - maxTokens` (the clamp only
 * trims `max_tokens` down to `n_ctx - estimate - 4096`, and the estimate can
 * under-count by 20-30%). At 128000 that boundary sits ~12% below the context
 * window, which is *before* pi's default compaction trigger
 * (`contextWindow - reserveTokens`, reserveTokens 16384). If you rely on very
 * long replies, raise the reserve so compaction fires first, e.g. in
 * settings.json:
 *   "compaction": { "modelOverrides": { "<provider>/<model>": { "reserveTokens": 131072 } } }
 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 128000;

/** Reply cap for a model: half the window, never above DEFAULT_MAX_OUTPUT_TOKENS. */
function outputCapFor(contextWindow: number): number {
  return Math.min(DEFAULT_MAX_OUTPUT_TOKENS, Math.floor(contextWindow / 2));
}

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
    // Reply cap, NOT the context window: prompt + max_tokens must fit in n_ctx.
    maxTokens: outputCapFor(entry.context_length ?? 128000),
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
