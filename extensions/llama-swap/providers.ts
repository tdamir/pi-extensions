/**
 * pi provider construction for llama-swap servers.
 *
 * Each configured server becomes a pi provider whose requests flow through a
 * teed fetch (see ./sse) that taps the raw SSE stream for engine-specific
 * usage/timings telemetry. Registration itself happens in index.ts.
 */

import { getApiProvider } from "@earendil-works/pi-ai/compat";
import type { ApiProvider } from "@earendil-works/pi-ai/compat";
import type { ProviderConfig } from "@earendil-works/pi-coding-agent";

import type { SwapServer } from "./config";
import { discoverModels } from "./models";
import { teedFetch } from "./sse";

/** Shared built-in openai-completions stream implementation, loaded once. */
let openaiProvider: ApiProvider | undefined;

function getOpenAiProvider(): ApiProvider {
  if (!openaiProvider) {
    const provider = getApiProvider("openai-completions");
    if (!provider) {
      throw new Error("openai-completions API provider not found in pi-ai registry");
    }
    openaiProvider = provider as ApiProvider;
  }
  return openaiProvider;
}

/**
 * Discover the models exposed by one llama-swap server and build the pi
 * provider config for it. Throws when the server is unreachable.
 */
export async function buildProvider(server: SwapServer): Promise<{ server: SwapServer; config: ProviderConfig }> {
  const openai = getOpenAiProvider();
  const models = await discoverModels(server.url);

  const config: ProviderConfig = {
    baseUrl: server.url,
    apiKey: "none", // llama-swap is a local service, no auth needed
    api: "openai-completions",
    models,
    streamSimple: (model, context, options) => {
      const baseFetch = options?.fetch ?? globalThis.fetch;
      return openai.streamSimple(model, context, { ...options, fetch: teedFetch(baseFetch) });
    },
  };
  return { server, config };
}


