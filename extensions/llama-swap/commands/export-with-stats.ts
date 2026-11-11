/**
 * Command: /export-with-stats [file] — /export that includes the
 * `llama-swap-usage` session entries.
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import type { CommandDefinition } from "./types";
import { loadExportFromFile, toExportableSessionLines } from "../export";

export const exportWithStatsCommand: CommandDefinition = {
  name: "export-with-stats",
  description: "Export session to HTML, including llama-swap usage stats",
  handler: async (args, ctx) => {
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (!sessionFile || !existsSync(sessionFile)) {
      ctx.ui.notify("No session file to export yet.", "error");
      return;
    }

    const tmpFile = join(tmpdir(), `llama-swap-export-${process.pid}-${Date.now()}.jsonl`);
    writeFileSync(
      tmpFile,
      toExportableSessionLines(readFileSync(sessionFile, "utf-8").split("\n")).join("\n"),
      "utf-8",
    );

    try {
      const exportFromFile = await loadExportFromFile();
      const outputPath = args.trim() || `pi-session-${basename(sessionFile, ".jsonl")}.html`;
      const out = await exportFromFile(tmpFile, { outputPath });
      ctx.ui.notify(`Exported to: ${out}`, "info");
    } catch (error) {
      ctx.ui.notify(
        `Export failed: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
    } finally {
      try {
        unlinkSync(tmpFile);
      } catch {
        // ignore
      }
    }
  },
};
