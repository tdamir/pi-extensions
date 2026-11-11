/**
 * Llama-Swap Provider Extension
 *
 * This file is the registration manifest: the single place where anything is
 * wired into pi (`pi.register*`, `pi.on`). Feature modules export plain
 * definitions (commands, provider configs, handlers) with no side effects.
 *
 * Registers llama-swap as an OpenAI-compatible provider. Dynamically
 * discovers models from the llama-swap API at startup. Captures the raw SSE
 * telemetry dropped by the built-in parser — llama.cpp's `usage` and
 * `timings`, vLLM's `usage` and `metrics`, and tensorfold's
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
 * Commands:
 *   /llama-swap-url     — manage the configured servers
 *   /swap-stats         — toggle the stats panel (compact | full)
 *   /export-with-stats  — HTML export including llama-swap-usage entries
 *
 * Module layout:
 *   index.ts                      — registration manifest (this file)
 *   commands/                     — one file per command (definitions only)
 *     types.ts                      — shared CommandDefinition type
 *     llama-swap-url.ts             — /llama-swap-url
 *     swap-stats.ts                 — /swap-stats
 *     export-with-stats.ts          — /export-with-stats
 *   config.ts     — settings.json servers read/write
 *   providers.ts  — pi provider config construction (teed fetch hookup)
 *   models.ts     — /models discovery and model mapping
 *   sse.ts        — SSE tee + raw telemetry tap
 *   capture.ts    — response-id → telemetry record registry
 *   engines/      — one metric parser per engine (llama.cpp, vLLM, tensorfold)
 *   format.ts     — summary/breakdown formatting
 *   stats.ts      — aggregation + report builders (shared with benchmark)
 *   export.ts     — HTML exporter loading + session-entry rewriting
 *   types.ts      — raw telemetry shapes
 *
 * Usage:
 *   pi -e ./llama-swap
 *
 * Or place in ~/.pi/agent/extensions/ for auto-discovery (hot-reloads on /reload).
 */

import { Box, Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { forgetCapture, waitForCapture } from "./capture";
import { resolveServers } from "./config";
import { exportWithStatsCommand } from "./commands/export-with-stats";
import { llamaSwapUrlCommand } from "./commands/llama-swap-url";
import { hideStatsPanel, swapStatsCommand } from "./commands/swap-stats";
import { formatDiagnosticsLines, formatUsageSummary } from "./format";
import { debugLog } from "./log";
import { buildProvider } from "./providers";
import type { LlamaSwapUsageRecord } from "./types";

export default async function (pi: ExtensionAPI) {
  // ── Commands ────────────────────────────────────────────────────────────
  const commands = [llamaSwapUrlCommand, swapStatsCommand, exportWithStatsCommand];
  for (const command of commands) {
    pi.registerCommand(command.name, command);
  }

  // ── Event handlers ──────────────────────────────────────────────────────
  // Hide the /swap-stats panel when the session shuts down.
  pi.on("session_shutdown", (_event, ctx) => hideStatsPanel(ctx.ui));

  // ── Providers ───────────────────────────────────────────────────────────
  const servers = resolveServers();
  if (servers.length === 0) {
    debugLog("[llama-swap] No servers configured (llamaSwap.servers in settings.json). Providers not registered.");
    return;
  }

  // Discover and register each server independently, so one unreachable
  // server does not prevent the others from being registered.
  const providerIds = new Set<string>();
  const results = await Promise.allSettled(servers.map((server) => buildProvider(server)));

  results.forEach((result, i) => {
    const server = servers[i];
    if (result.status === "fulfilled") {
      pi.registerProvider(server.providerId, result.value.config);
      providerIds.add(server.providerId);
      debugLog(
        `[llama-swap] Registered "${server.providerId}" (${result.value.config.models?.length ?? 0} models) from ${server.url}`,
      );
    } else {
      console.error(
        `[llama-swap] Failed to discover models from ${server.url}/models:`,
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

  // ── Entry renderers ─────────────────────────────────────────────────────
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
