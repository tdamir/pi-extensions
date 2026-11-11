/**
 * Command: /llama-swap-url — manage the configured llama-swap servers.
 *   /llama-swap-url                  — list servers and add one (prompt)
 *   /llama-swap-url add <name> <url> — add a server
 *   /llama-swap-url remove <name>    — remove a server
 */

import type { CommandDefinition } from "./types";
import { providerIdFor, removeServer, resolveServers, setServer } from "../config";

export const llamaSwapUrlCommand: CommandDefinition = {
  name: "llama-swap-url",
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
};
