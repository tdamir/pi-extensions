/**
 * Command: /swap-stats — toggles a panel above the editor with aggregate
 * llama-swap stats computed from the session log (survives restarts/reloads).
 *
 * Default (compact) view merges related facts into few rows so it fits pi's
 * 10-line string-widget budget instead of rendering "... (widget truncated)".
 * `/swap-stats full` shows the complete report as a custom component, which
 * bypasses the line cap (Text components word-wrap at the terminal width).
 *
 * Report building lives in ../stats; this module only owns the panel state
 * and the command handler.
 */

import { Container, Text } from "@earendil-works/pi-tui";

import type { CommandDefinition } from "./types";
import {
  buildCompactStatsReport,
  buildStatsReport,
  collectToolStats,
  collectUsageRecords,
  type StatsPaint,
} from "../stats";

type PanelMode = "compact" | "full";

const WIDGET_KEY = "llama-swap-stats";

let visible = false;
let mode: PanelMode = "compact";

const hide = (ui: { setWidget(key: string, content?: unknown): void }) => {
  if (!visible) return;
  visible = false;
  ui.setWidget(WIDGET_KEY, undefined);
};

/** Hide the panel (used by the session_shutdown wiring in index.ts). */
export function hideStatsPanel(ui: { setWidget(key: string, content?: unknown): void }): void {
  hide(ui);
}

export const swapStatsCommand: CommandDefinition = {
  name: "swap-stats",
  description:
    "Show aggregate llama-swap stats from the session log (toggles the panel). Modes: compact (default, fits the widget) | full (all rows, no truncation)",
  handler: async (args, ctx) => {
    const arg = (args ?? "").trim().toLowerCase();
    const requested: PanelMode = arg === "full" || arg === "all" ? "full" : "compact";
    if (visible && requested === mode) {
      hide(ctx.ui);
      ctx.ui.notify("llama-swap stats panel hidden.", "info");
      return;
    }

    const records = collectUsageRecords(ctx.sessionManager.getEntries());
    const tools = collectToolStats(ctx.sessionManager.getEntries());
    if (records.length === 0 && tools.calls === 0) {
      ctx.ui.notify("No llama-swap usage entries in this session yet.", "info");
      return;
    }

    const theme = ctx.ui.theme;
    const paint: StatsPaint = {
      bold: (text) => theme.bold(text),
      dim: (text) => theme.fg("dim", text),
    };

    mode = requested;
    if (mode === "full") {
      // Custom component: not subject to the 10-line string-widget cap; the
      // Text components word-wrap long rows at the terminal width.
      const lines = buildStatsReport(records, paint, undefined, tools);
      ctx.ui.setWidget(WIDGET_KEY, () => {
        const container = new Container();
        for (const line of lines) container.addChild(new Text(line, 1, 0));
        return container;
      });
    } else {
      ctx.ui.setWidget(WIDGET_KEY, buildCompactStatsReport(records, paint, undefined, tools));
    }
    visible = true;
  },
};
