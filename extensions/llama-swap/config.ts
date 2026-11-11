/**
 * Server configuration, read from `llamaSwap.servers` in settings.json.
 *
 * Each entry is registered as a provider named after the server:
 *   - `servers.gx10: "http://gx10.local:9292"` → provider `gx10`
 * (registration happens in index.ts via ./providers).
 *
 * Also provides the storage used by the /llama-swap-url command
 * (./commands/llama-swap-url.ts).
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

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

/** Add (or replace) a server in `llamaSwap.servers`. Returns the stored URL. */
