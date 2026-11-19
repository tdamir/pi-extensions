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

/** Server-level names that mean the same thing as a pi thinking level. */
const THINKING_LEVEL_ALIASES: Record<string, ThinkingLevel> = {
  off: "off",
  none: "off",
  no: "off",
  nothink: "off",
  nothinking: "off",
  disabled: "off",
  disable: "off",
  false: "off",
  min: "minimal",
  minimal: "minimal",
  low: "low",
  med: "medium",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  extrahigh: "xhigh",
  max: "max",
  maximum: "max",
};

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
  meta?: {
    thinking?: boolean;
    thinkingLevels?: string[];
    llamaswap?: {
      thinking?: boolean;
      thinkingLevels?: string[];
    };
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

/** Read reasoning metadata from either the top level of `meta` or `meta.llamaswap`. */
function readReasoningMeta(entry: SwapModelEntry): { thinking?: boolean; levels?: string[] } {
  const llamaswap = entry.meta?.llamaswap;
  const thinking = llamaswap?.thinking ?? entry.meta?.thinking;
  const rawLevels = llamaswap?.thinkingLevels ?? entry.meta?.thinkingLevels;
  const levels = Array.isArray(rawLevels)
    ? rawLevels.filter((level): level is string => typeof level === "string" && level.trim().length > 0)
    : undefined;
  return { thinking, levels: levels?.length ? levels : undefined };
}

/** Normalize a server thinking-level name so `no_think`, `no-think`, etc. all match. */
function canonicalThinkingLevel(level: string): ThinkingLevel | undefined {
  const key = level.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  return THINKING_LEVEL_ALIASES[key] ?? THINKING_LEVELS.find((candidate) => candidate === key);
}

/**
 * Build pi's thinking-level map from the levels the server reports in `meta`.
 * The reported name is kept as the wire value (e.g. `no_think` -> `off`), and
 * levels the server did not report are marked unsupported so pi hides them.
 */
function mapThinkingLevels(levels: string[] | undefined, pin?: ThinkingLevel): Record<string, string | null> {
  const map = Object.fromEntries(THINKING_LEVELS.map((level) => [level, null])) as Record<string, string | null>;

  for (const level of levels ?? []) {
    const canonical = canonicalThinkingLevel(level);
    if (canonical && map[canonical] === null) map[canonical] = level.trim();
  }

  if (pin) {
    for (const level of THINKING_LEVELS) map[level] = level === pin ? (map[pin] ?? pin) : null;
  }

  return map;
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
  const { thinking, levels } = readReasoningMeta(entry);
  const reasoning = suffix
    ? suffix !== "off"
    : (thinking ?? (levels ? true : inferReasoning(entry.id)));
  const hasThinkingLevels = Boolean(suffix || levels);

  return {
    id: entry.id,
    name: entry.name ?? entry.id,
    reasoning,
    input: inferInputTypes(capabilities, entry.architecture),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: entry.context_length ?? 128000,
    // Reply cap, NOT the context window: prompt + max_tokens must fit in n_ctx.
    maxTokens: outputCapFor(entry.context_length ?? 128000),
    // Prefer the levels advertised in `meta` (if any), and pin the level when
    // the model ID carries a fixed-effort suffix.
    ...(hasThinkingLevels
      ? {
          thinkingLevelMap: mapThinkingLevels(levels, suffix),
          // A suffix means the effort is baked into the model ID; advertised
          // levels mean the server accepts `reasoning_effort`.
          compat: { supportsReasoningEffort: !suffix },
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
