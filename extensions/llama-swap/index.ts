/**
 * Llama-Swap Provider Extension
 *
 * Registers llama-swap as an OpenAI-compatible provider.
 * Dynamically discovers models from the llama-swap API at startup.
 * Captures the raw SSE telemetry dropped by the built-in parser — llama.cpp's
 * `usage` and `timings`, vLLM's `usage` and `metrics`, and tensorfold's
 * `tensorfold`/`speculative`/`exact_mode` diagnostics — and stores them as
 * `llama-swap-usage` custom entries in the session record.
 *
 * /swap-stats toggles a panel with aggregate stats (token throughput, rates,
 * draft acceptance) computed from the llama-swap-usage entries in the
 * session log, so it works across reloads and resumed sessions.
 *
 * Servers are configured in settings.json under `llamaSwap.servers`; each
 * entry is registered as a provider named after the server:
 *   - `servers.gx10: "http://gx10.local:9292"` → provider `gx10`
 * If no servers are configured, no provider is registered.
 *
 * /llama-swap-url manages the configured servers:
 *   /llama-swap-url                  — add a server (prompt for name and URL)
 *   /llama-swap-url add <name> <url> — add a server
 *   /llama-swap-url remove <name>    — remove a server
 *
 * Module layout:
 *   config.ts     — settings.json servers + /llama-swap-url
 *   models.ts     — /models discovery and model mapping
 *   sse.ts        — SSE tee + raw telemetry tap
 *   capture.ts    — response-id → telemetry record registry
 *   engines/      — one metric parser per engine (llama.cpp, vLLM, tensorfold)
 *   format.ts     — summary/breakdown formatting
 *   stats.ts      — aggregation + /swap-stats
 *   export.ts     — HTML export + /export-with-stats
 *
 * Usage:
 *   pi -e ./llama-swap
 *
 * Or place in ~/.pi/agent/extensions/ for auto-discovery (hot-reloads on /reload).
 */

import { getApiProvider } from "@earendil-works/pi-ai/compat";
import { Box, Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { forgetCapture, waitForCapture } from "./capture";
import { registerSetUrlCommand, resolveServers } from "./config";
import { registerExportCommand } from "./export";
import { formatDiagnosticsLines, formatUsageSummary } from "./format";
import { debugLog } from "./log";
import { discoverModels } from "./models";
import { teedFetch } from "./sse";
import { registerSwapStatsCommand } from "./stats";
import type { LlamaSwapUsageRecord } from "./types";

export default async function (pi: ExtensionAPI) {
  registerSetUrlCommand(pi);
  registerExportCommand(pi);
  registerSwapStatsCommand(pi);

  const servers = resolveServers();
  if (servers.length === 0) {
    debugLog("[llama-swap] No servers configured (llamaSwap.servers in settings.json). Providers not registered.");
    return;
  }

  // Built-in openai-completions stream implementation, shared by all servers.
  const openai = getApiProvider("openai-completions");
  if (!openai) {
    console.error("[llama-swap] openai-completions API provider not found in pi-ai registry. Providers not registered.");
    return;
  }

  // Discover and register each server independently, so one unreachable
  // server does not prevent the others from being registered.
  const providerIds = new Set<string>();
  const results = await Promise.allSettled(
    servers.map(async (server) => {
      const models = await discoverModels(server.url);

      // Wrapped with a teed fetch that taps the raw SSE stream for the
      // engine-specific usage/timings fields.
      pi.registerProvider(server.providerId, {
        baseUrl: server.url,
        apiKey: "none", // llama-swap is a local service, no auth needed
        api: "openai-completions",
        models,
        streamSimple: (model, context, options) => {
          const baseFetch = options?.fetch ?? globalThis.fetch;
          return openai.streamSimple(model, context, { ...options, fetch: teedFetch(baseFetch) });
        },
      });

      providerIds.add(server.providerId);
      debugLog(`[llama-swap] Registered "${server.providerId}" (${models.length} models) from ${server.url}`);
    }),
  );

  results.forEach((result, i) => {
    if (result.status === "rejected") {
      console.error(
        `[llama-swap] Failed to discover models from ${servers[i].url}/models:`,
        result.reason instanceof Error ? result.reason.message : String(result.reason),
      );
    }
  });

  if (providerIds.size === 0) {
    console.error("[llama-swap] No servers responded. Providers will not be available. Is llama-swap running?");
    return;
  }

  // Persist captured usage/timings into the session record, correlated via
  // the chat completion id that pi stores as `responseId` on the message.
  // Uses turn_end (not message_end) so the custom entry is appended AFTER
  // the assistant message entry is already persisted, keeping the record
  // attached directly below its message in the session file.
  pi.on("turn_end", async (event) => {
    const message = event.message;
    if (message.role !== "assistant") return;
    if (!providerIds.has(message.provider)) return;
    if (!message.responseId) return;

    const record = await waitForCapture(message.responseId);
    forgetCapture(message.responseId);
    if (!record) return;

    record.server = message.provider;
    pi.appendEntry("llama-swap-usage", record);
  });

  pi.registerEntryRenderer("llama-swap-usage", (entry, { expanded }, theme) => {
    const record = entry.data as LlamaSwapUsageRecord | undefined;
    if (!record) return undefined;

    const box = new Box(0, 0);
    const serverTag = record.server ? ` [${record.server}]` : "";
    box.addChild(new Text(theme.fg("dim", `\u26A1 llama-swap${serverTag} ${formatUsageSummary(record)}`)));
    if (expanded) {
      for (const line of formatDiagnosticsLines(record)) {
        box.addChild(new Text(theme.fg("dim", line)));
      }
      box.addChild(new Text(theme.fg("dim", JSON.stringify(record, null, 2))));
    }
    return box;
  });
}
