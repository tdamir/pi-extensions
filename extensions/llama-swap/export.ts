/**
 * HTML export with llama-swap stats.
 *
 * The built-in exporter skips `custom` entries (from pi.appendEntry), so the
 * `llama-swap-usage` entries are invisible in /export output. This module
 * rewrites each usage entry as a `custom_message` entry (same id/parentId, so
 * the tree structure is untouched) before handing the file to the built-in
 * exporter, which renders those as visible hook messages.
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatUsageSummary } from "./format";
import type { LlamaSwapUsageRecord } from "./types";

interface SessionEntryLike {
  type?: string;
  customType?: string;
  id?: string;
  parentId?: string;
  timestamp?: string;
  data?: unknown;
  [key: string]: unknown;
}

/** Rewrite `llama-swap-usage` custom entries into exportable custom messages. */
export function toExportableSessionLines(lines: string[]): string[] {
  return lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return line;
    let entry: SessionEntryLike;
    try {
      entry = JSON.parse(trimmed) as SessionEntryLike;
    } catch {
      return line;
    }
    if (entry.type !== "custom" || entry.customType !== "llama-swap-usage") return line;

    const record = entry.data as LlamaSwapUsageRecord | undefined;
    const exportable = {
      type: "custom_message",
      id: entry.id,
      parentId: entry.parentId,
      timestamp: entry.timestamp,
      customType: "llama-swap-usage",
      content: `\u26A1 llama-swap${record?.server ? ` [${record.server}]` : ""} \u2014 ${record ? formatUsageSummary(record) : "no usage data"}`,
      display: true,
      details: record,
    };
    return JSON.stringify(exportable);
  });
}

type ExportFromFile = (input: string, options?: { outputPath?: string }) => Promise<string>;

/** Locate and load the built-in standalone HTML exporter (not exported from the package root). Used by /export-with-stats and the benchmark report. */
export async function loadExportFromFile(): Promise<ExportFromFile> {
  const pkgDir = getPackageDir();
  const candidates = [
    join(pkgDir, "dist", "core", "export-html", "index.js"),
    join(pkgDir, "src", "core", "export-html", "index.js"),
    join(pkgDir, "core", "export-html", "index.js"),
    join(pkgDir, "export-html", "index.js"),
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const mod = (await import(pathToFileURL(candidate).href)) as { exportFromFile?: ExportFromFile };
    if (typeof mod.exportFromFile === "function") return mod.exportFromFile;
  }
  throw new Error("Could not locate the pi HTML exporter (core/export-html/index.js)");
}

/** Command: /export-with-stats [file] — /export that includes llama-swap-usage entries. */
export function registerExportCommand(pi: ExtensionAPI): void {
  pi.registerCommand("export-with-stats", {
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
  });
}
