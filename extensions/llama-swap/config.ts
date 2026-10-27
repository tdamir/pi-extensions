/**
 * Server configuration, read from `llamaSwap.servers` in settings.json.
 *
 * Each entry is registered as a provider named after the server:
 *   - `servers.gx10: "http://gx10.local:9292"` → provider `gx10`
 *
 * Also provides the `/llama-swap-url` command for managing the entries.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface SwapServer {
  /** Name in `llamaSwap.servers`. */
  name: string;
  /** Normalized base URL (with trailing /v1). */
  url: string;
  /** pi provider id: the (sanitized) server name. */
  providerId: string;
}

/** Sanitize a server name into a pi provider id. */
export function providerIdFor(name: string): string {
  return name.replace(/[^a-zA-Z0-9-]/g, "-");
}

export function normalizeUrl(url: string): string {
  const base = url.replace(/\/+$/, "");
  return base.endsWith("/v1") ? base : `${base}/v1`;
}

function settingsPath(): string {
  return join(getAgentDir(), "settings.json");
}

function readSettings(): Record<string, unknown> {
  const path = settingsPath();
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf-8"));
}

function writeSettings(raw: Record<string, unknown>): void {
  writeFileSync(settingsPath(), JSON.stringify(raw, null, 2) + "\n", "utf-8");
}

function readLlamaSwapConfig(): { servers?: Record<string, unknown> } {
  const raw = readSettings();
  const config = (raw.llamaSwap as Record<string, unknown> | undefined) ?? {};
  // One-time cleanup: drop the legacy `baseUrl` key (superseded by `servers`).
  if (config.baseUrl !== undefined) {
    delete config.baseUrl;
    raw.llamaSwap = config;
    writeSettings(raw);
  }
  return { servers: config.servers as Record<string, unknown> | undefined };
}

/**
 * Collect all configured llama-swap servers. Duplicate URLs are registered
 * only once (the first entry wins).
 */
export function resolveServers(): SwapServer[] {
  const { servers } = readLlamaSwapConfig();
  const result: SwapServer[] = [];
  const seen = new Set<string>();

  const add = (name: string, url: string) => {
    const normalized = normalizeUrl(url);
    if (seen.has(normalized)) return;
    seen.add(normalized);
    result.push({ name, url: normalized, providerId: providerIdFor(name) });
  };

  for (const [name, value] of Object.entries(servers ?? {})) {
    if (typeof value === "string" && value) add(name, value);
  }
  return result;
}

/** Add (or replace) a server in `llamaSwap.servers`. Returns the stored URL. */
export function setServer(name: string, url: string): string {
  const raw = readSettings();
  const config: Record<string, unknown> = (raw.llamaSwap as Record<string, unknown> | undefined) ?? {};
  const servers = (config.servers as Record<string, string> | undefined) ?? {};
  servers[name] = normalizeUrl(url);
  config.servers = servers;
  raw.llamaSwap = config;
  writeSettings(raw);
  return servers[name];
}

/** Remove a server from `llamaSwap.servers`. Returns false if not found. */
export function removeServer(name: string): boolean {
  const raw = readSettings();
  const config = (raw.llamaSwap as Record<string, unknown> | undefined) ?? {};
  const servers = (config.servers as Record<string, string> | undefined) ?? {};
  if (!(name in servers)) return false;
  delete servers[name];
  if (Object.keys(servers).length > 0) config.servers = servers;
  else delete config.servers;
  raw.llamaSwap = config;
  writeSettings(raw);
  return true;
}

/**
 * Command: /llama-swap-url — manage the configured servers.
 *   /llama-swap-url                  — list servers and add one (prompt)
 *   /llama-swap-url add <name> <url> — add a server
 *   /llama-swap-url remove <name>    — remove a server
 */
export function registerSetUrlCommand(pi: ExtensionAPI): void {
  pi.registerCommand("llama-swap-url", {
    description: "Manage llama-swap servers (no args: add a server; 'add <name> <url>'; 'remove <name>')",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);

      if (parts[0] === "add" && parts.length === 3) {
        const normalized = setServer(parts[1], parts[2]);
        ctx.ui.notify(
          `llama-swap server "${parts[1]}" (provider ${providerIdFor(parts[1])}) set to: ${normalized}`,
          "info",
        );
        ctx.ui.notify("Run /reload to apply.", "info");
        return;
      }

      if (parts[0] === "remove" && parts.length === 2) {
        if (removeServer(parts[1])) {
          ctx.ui.notify(`llama-swap server "${parts[1]}" removed.`, "info");
          ctx.ui.notify("Run /reload to apply.", "info");
        } else {
          ctx.ui.notify(`No server named "${parts[1]}" in llamaSwap.servers.`, "error");
        }
        return;
      }

      if (parts.length > 0) {
        ctx.ui.notify("Usage: /llama-swap-url | add <name> <url> | remove <name>", "error");
        return;
      }

      const servers = resolveServers();
      const current =
        servers.length > 0 ? servers.map((s) => `${s.providerId} = ${s.url}`).join(", ") : "(none configured)";
      const name = (await ctx.ui.input(`Configured: ${current}\nEnter server name (empty to cancel):`))?.trim();
      if (!name) {
        ctx.ui.notify("No changes.", "info");
        return;
      }

      const url = await ctx.ui.input(`Enter base URL for "${name}" (without /v1, e.g. http://localhost:8080):`);
      if (!url) {
        ctx.ui.notify(`No URL entered; "${name}" unchanged.`, "info");
        return;
      }

      const normalized = setServer(name, url);
      ctx.ui.notify(
        `llama-swap server "${name}" (provider ${providerIdFor(name)}) set to: ${normalized}`,
        "info",
      );
      ctx.ui.notify("Run /reload to apply the new URL.", "info");
    },
  });
}
