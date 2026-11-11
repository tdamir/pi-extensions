/**
 * Benchmark extension - run the same build task across different LLMs and compare results
 *
 * /benchmark <requirement> creates a per-model working directory under ./benchmarks/
 * (named after the currently selected model and its active thinking level, e.g.
 * llama-swap_qwen3-coder-8b@medium) and immediately kicks off the task in
 * the current interactive session. Each working directory has:
 *
 *   workspace/       - intermediate work files while building
 *   final/           - final deliverables
 *   task.md          - the requirement plus run metadata (model, timestamp)
 *   summary.md       - execution summary written when the task ends (model,
 *                      duration, outcome, and the same llama-swap stats the
 *                      /swap-stats command shows, scoped to this run)
 *   session.jsonl    - copy of the pi session file (chat transcript + all
 *                      persisted stats), the single source of truth for the
 *                      report
 *   report.html      - self-contained HTML dashboard written when the task
 *                      ends: pi's built-in session export (same as
 *                      /export-with-stats) with an injected benchmark
 *                      dashboard (stat cards, per-tool table, llama-swap
 *                      panel, per-request table), all computed from the
 *                      session copy; regenerate with /benchmark-report [dir]
 *
 * To benchmark several models, run /benchmark with the same requirement while each
 * model is selected, then compare the final/ folders.
 *
 * Benchmark sessions are marked: the session name gets a "\u2691 " prefix (visible in
 * /resume pickers), a durable custom entry is persisted into the session (rendered
 * as a card in the transcript and surviving reloads/resumes), and a footer status
 * shows the current run state ("\u2691 benchmark: <model> - running / completed").
 *
 * If the requirement is a path to an existing file, the file's content is used as
 * the requirement instead (so the same task file can be shared across model runs).
 * Any text after the file path is treated as additional instructions and appended
 * to the task (e.g. "do the task in parallel mode").
 *
 * Usage:
 *   /benchmark build a python CLI that converts csv to json
 *   /benchmark tasks/csv-to-cli.md
 *   /benchmark @tasks/csv-to-cli.md
 *   /benchmark @tasks/csv-to-cli.md do the task in parallel mode
 *   /benchmark @tasks/csv-to-cli.md -- prefer node, keep dependencies minimal
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { formatDuration } from "../llama-swap/format";
import {
	buildSessionInfoReport,
	buildStatsReport,
	collectSessionInfo,
	collectToolStats,
	collectUsageRecords,
	plainPaint,
} from "../llama-swap/stats";
import { generateReport } from "./report";

const BENCHMARKS_DIR = "benchmarks";

/** A benchmark task started in this session and awaiting completion. */
interface PendingRun {
	workDir: string;
	modelLabel: string;
	startedAt: Date;
}

/** Durable marker persisted into the session via pi.appendEntry(). */
interface BenchmarkRunData {
	status: "running" | "done";
	workDir: string;
	modelLabel: string;
	startedAt: string;
	endedAt?: string;
	durationMs?: number;
	outcome?: string;
	/** Model context window (from ctx.model at run end) - the session file itself does not persist it. */
	contextWindow?: number;
	summaryPath?: string;
	reportPath?: string;
	sessionCopyPath?: string;
}

const RUN_ENTRY_TYPE = "benchmark-run";
const STATUS_KEY = "benchmark";

/** One-line footer text for the current benchmark state. */
function footerText(d: BenchmarkRunData): string {
	if (d.status === "done") {
		const dur = d.durationMs !== undefined ? formatDuration(d.durationMs) : "?";
		return `\u2691 benchmark: ${d.modelLabel} - ${d.outcome ?? "completed"} (${dur})`;
	}
	return `\u2691 benchmark: ${d.modelLabel} - running`;
}

/** provider/model id (+ thinking level) -> safe directory name, e.g. "llama-swap_qwen3-coder-8b@medium" */
function modelSlug(provider: string, id: string, thinkingLevel?: string): string {
	const clean = (s: string) => s.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
	const thinking = thinkingLevel && thinkingLevel !== "off" ? `@${thinkingLevel}` : "";
	return `${clean(provider)}_${clean(id)}${thinking}`;
}

function timestamp(now: Date): string {
	const p = (n: number) => String(n).padStart(2, "0");
	return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

/** Short task label for the session name: file name when the requirement came from a file, else the requirement text. */
function taskLabel(requirement: string, requirementSource?: string): string {
	const base = (requirementSource ?? requirement).replace(/\s+/g, " ").trim();
	const name = base.split(/[\\/]/).pop() ?? base;
	return name.length > 40 ? name.slice(0, 37) + "..." : name;
}

export default function (pi: ExtensionAPI) {
	// The benchmark task most recently started in this session, awaiting its
	// agent_settled (i.e. the task reporting it is done, after any automatic
	// retries, auto-compaction retries, and queued continuations have finished).
	// Cleared once the execution summary has been written.
	let pendingRun: PendingRun | null = null;

	// Render benchmark markers inside the transcript as compact cards.
	pi.registerEntryRenderer(RUN_ENTRY_TYPE, (entry, { expanded }, theme) => {
		const d = entry.data as BenchmarkRunData | undefined;
		if (!d) return undefined;

		const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
		if (d.status === "done") {
			const dur = d.durationMs !== undefined ? formatDuration(d.durationMs) : "?";
			const color = d.outcome && d.outcome !== "completed" ? "error" : "success";
			box.addChild(new Text(theme.fg(color, `\u2691 benchmark ${d.modelLabel} - ${d.outcome ?? "completed"} in ${dur}`)));
		} else {
			box.addChild(new Text(theme.fg("accent", `\u2691 benchmark ${d.modelLabel} - running`)));
		}
		if (expanded) {
			box.addChild(new Text(theme.fg("dim", `workdir: ${d.workDir}`)));
			if (d.summaryPath) box.addChild(new Text(theme.fg("dim", `summary: ${d.summaryPath}`)));
			if (d.reportPath) box.addChild(new Text(theme.fg("dim", `report: ${d.reportPath}`)));
			if (d.sessionCopyPath) box.addChild(new Text(theme.fg("dim", `session: ${d.sessionCopyPath}`)));
		}
		return box;
	});

	// Restore the footer marker when a benchmark session is resumed/reloaded.
	pi.on("session_start", async (_event, ctx) => {
		let last: BenchmarkRunData | undefined;
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "custom" && entry.customType === RUN_ENTRY_TYPE) {
				last = entry.data as BenchmarkRunData;
			}
		}
		if (last && ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, footerText(last));
	});

	pi.on("agent_settled", async (event, ctx) => {
		const run = pendingRun;
		if (!run) return;
		pendingRun = null;

		try {
			const endedAt = new Date();

			// Only usage records captured after the run started, so earlier runs
			// sharing this session don't leak into this summary.
			const startMs = run.startedAt.getTime() - 5000;
			const entries = ctx.sessionManager.getEntries();
			const records = collectUsageRecords(entries).filter(
				(e) => (Number.isFinite(e.ts) ? e.ts : e.record.capturedAt) >= startMs,
			);
			const toolStats = collectToolStats(entries, startMs);

			// Final outcome from the last assistant message of this run.
			// agent_settled fires only after retries/continuations are done and
			// carries no messages, so read the persisted session entries instead.
			let outcome = "completed";
			for (let i = entries.length - 1; i >= 0; i--) {
				const e = entries[i];
				if (e.type !== "message" || e.message.role !== "assistant") continue;
				const at = Date.parse(e.timestamp);
				if (Number.isFinite(at) && at < startMs) break; // from a previous run
				if (e.message.stopReason === "aborted") outcome = "aborted";
				else if (e.message.stopReason === "error") outcome = `error${e.message.errorMessage ? `: ${e.message.errorMessage}` : ""}`;
				break;
			}
			if (event.aborted && outcome === "completed") outcome = "aborted";

			const lines = [
				"# Benchmark Execution Summary",
				"",
				`- **Model:** ${run.modelLabel}`,
				`- **Started:** ${run.startedAt.toISOString()}`,
				`- **Ended:** ${endedAt.toISOString()}`,
				`- **Duration:** ${formatDuration(endedAt.getTime() - run.startedAt.getTime())}`,
				`- **Outcome:** ${outcome}`,
				`- **Working directory:** ${run.workDir}`,
				"",
				"## Stats",
				"",
			];
			const report = buildStatsReport(records, plainPaint, "llama-swap stats (this run)", toolStats);
			if (report.length === 0) lines.push("No llama-swap usage records for this run.");
			else lines.push(...report);

			// pi's built-in /session info (messages, tokens, context, cost),
			// scoped to this run's entries.
			const sessionInfo = collectSessionInfo(ctx, startMs);
			lines.push("", "## Session", "", ...buildSessionInfoReport(sessionInfo, plainPaint, "session (this run)"));

			const summaryPath = join(run.workDir, "summary.md");
			writeFileSync(summaryPath, `${lines.join("\n")}\n`);

			// Persist the completed-run marker (visible in the transcript and footer)
			// BEFORE copying the session, so the copy contains it - the report
			// generator reads all run data (including contextWindow) from the copy.
			const sessionFile = ctx.sessionManager.getSessionFile();
			const sessionCopyPath = sessionFile && existsSync(sessionFile) ? join(run.workDir, `session-${basename(sessionFile)}`) : undefined;
			const done: BenchmarkRunData = {
				status: "done",
				workDir: run.workDir,
				modelLabel: run.modelLabel,
				startedAt: run.startedAt.toISOString(),
				endedAt: endedAt.toISOString(),
				durationMs: endedAt.getTime() - run.startedAt.getTime(),
				outcome,
				contextWindow: ctx.model?.contextWindow,
				summaryPath,
				sessionCopyPath,
			};
			pi.appendEntry(RUN_ENTRY_TYPE, done);
			if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, footerText(done));

			// Copy the pi session file so everything lives alongside the results
			// (the original may be pruned/moved later), then build the HTML report
			// from it. Non-fatal: summary.md is already on disk.
			try {
				if (sessionFile && sessionCopyPath) copyFileSync(sessionFile, sessionCopyPath);
			} catch {
				// non-fatal: report generation below still tries with an older copy if any
			}

			let reportPath: string | undefined;
			try {
				reportPath = await generateReport(run.workDir);
				done.reportPath = reportPath;
			} catch {
				reportPath = undefined;
			}

			ctx.ui.notify(`Benchmark summary written to ${summaryPath}${reportPath ? ` (report: ${reportPath})` : ""}`, "info");
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			const failed: BenchmarkRunData = {
				status: "done",
				workDir: run.workDir,
				modelLabel: run.modelLabel,
				startedAt: run.startedAt.toISOString(),
				endedAt: new Date().toISOString(),
				outcome: `error: summary write failed: ${message}`,
			};
			pi.appendEntry(RUN_ENTRY_TYPE, failed);
			if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, footerText(failed));
			ctx.ui.notify(`Failed to write benchmark summary: ${message}`, "error");
		}
	});

	// (Re)generate report.html for a benchmark working directory, e.g. after
	// re-exporting the session copy or for runs made before the report existed.
	const registerReportCommand = () =>
		pi.registerCommand("benchmark-report", {
			description:
				"Generate the HTML report for a benchmark run (from its session copy): /benchmark-report [workDir] - defaults to the current session's benchmark run, else the most recently modified run under ./benchmarks/",
			handler: async (args, ctx) => {
				const hasRunArtifacts = (dir: string): boolean =>
					existsSync(join(dir, "task.md")) && readdirSync(dir).some((f) => /^session-.*\.jsonl$/.test(f));
				let workDir = (args?.trim() ?? "").replace(/^"|"$/g, "");
				let defaultSource: string | undefined; // set when a default was auto-picked
				if (workDir) {
					workDir = resolve(ctx.cwd, workDir);
					if (!existsSync(workDir) || !readdirSync(workDir).some((f) => /^session-.*\.jsonl$/.test(f))) {
						ctx.ui.notify(`No session-*.jsonl copy in ${workDir} - cannot generate report`, "error");
						return;
					}
				} else {
					// Default 1: the current session's own benchmark run - take the
					// last persisted benchmark-run marker whose workDir has a session
					// copy (still-running runs are skipped until their copy is written).
					for (const entry of [...ctx.sessionManager.getEntries()].reverse()) {
						if (entry.type !== "custom" || entry.customType !== RUN_ENTRY_TYPE) continue;
						const d = entry.data as BenchmarkRunData | undefined;
						if (d?.workDir && existsSync(join(d.workDir, "task.md")) && hasRunArtifacts(d.workDir)) {
							workDir = d.workDir;
							defaultSource = `current session run (${d.modelLabel})`;
							break;
						}
					}
				}
				if (!workDir) {
					// Default 2: most recently modified run under ./benchmarks/.
					const base = resolve(ctx.cwd, BENCHMARKS_DIR);
					if (!existsSync(base)) {
						ctx.ui.notify(`No ${BENCHMARKS_DIR}/ folder here and this session is not a benchmark run - pass a benchmark working directory`, "error");
						return;
					}
					const candidates = readdirSync(base)
						.map((name) => join(base, name))
						.filter((p) => {
							try {
								return statSync(p).isDirectory() && hasRunArtifacts(p);
							} catch {
								return false;
							}
						})
						.sort((a, b) => {
							const at = statSync(join(a, "task.md")).mtimeMs;
							const bt = statSync(join(b, "task.md")).mtimeMs;
							return bt - at;
						});
					if (candidates.length === 0) {
						ctx.ui.notify(`No benchmark runs with a session copy under ${base}`, "error");
						return;
					}
					workDir = candidates[0];
					defaultSource = "most recent run under " + BENCHMARKS_DIR;
				}
				try {
					const out = await generateReport(workDir);
					ctx.ui.notify(`Report written to ${out}${defaultSource ? ` (${defaultSource})` : ""}`, "info");
				} catch (err) {
					ctx.ui.notify(`Failed to write report: ${err instanceof Error ? err.message : String(err)}`, "error");
				}
			},
		});
	registerReportCommand();

	pi.registerCommand("benchmark", {
		description:
			"Benchmark the current model: /benchmark <requirement or file with the requirement> - creates benchmarks/<model>/ with workspace/ and final/, then starts the task in this session",
		handler: async (args, ctx) => {
			// Support an "@"-prefixed file reference, e.g. /benchmark @tasks/csv-to-cli.md
			// Anything after the file path is treated as additional instructions, e.g.
			// /benchmark @tasks/csv-to-cli.md do the task in parallel mode
			let argText = (args?.trim() ?? "").replace(/^@/, "");
			if (!argText) {
				ctx.ui.notify("Usage: /benchmark <requirement to build, or a file containing it> [additional instructions]", "error");
				return;
			}

			// Split off a leading file path token (up to the first whitespace) from the rest
			const ws = argText.search(/\s/);
			const firstToken = ws === -1 ? argText : argText.slice(0, ws);
			let additionalInstructions = ws === -1 ? "" : argText.slice(ws + 1).trim();
			// Optional "--" separator before the instructions, e.g. @file.md -- instructions
			if (additionalInstructions.startsWith("--")) {
				additionalInstructions = additionalInstructions.replace(/^--+\s*/, "").trim();
			}

			// If the first token is an existing file, expand it: use the file's content as the requirement
			let requirement = firstToken;
			let requirementSource: string | undefined;
			const maybeFile = resolve(ctx.cwd, requirement);
			if (existsSync(maybeFile) && statSync(maybeFile).isFile()) {
				try {
					requirement = readFileSync(maybeFile, "utf8").trim();
					requirementSource = maybeFile;
					ctx.ui.notify(`Requirement loaded from ${maybeFile}`, "info");
				} catch (err) {
					ctx.ui.notify(`Failed to read ${maybeFile}: ${err instanceof Error ? err.message : String(err)}`, "error");
					return;
				}
				if (additionalInstructions) {
					requirement += `\n\n## Additional instructions\n\n${additionalInstructions}`;
				}
			} else {
				// Not a file: treat the whole argument (including any "instructions" text) as the requirement
				requirement = argText;
				additionalInstructions = "";
			}
			if (!requirement) {
				ctx.ui.notify("Requirement is empty", "error");
				return;
			}

			const model = ctx.model;
			if (!model) {
				ctx.ui.notify("No model selected - pick a model first", "error");
				return;
			}

			// Create the per-model working directory (append timestamp if it already exists)
			const modelLabel =
				model.provider + "/" + model.id + (ctx.thinkingLevel && ctx.thinkingLevel !== "off" ? ` @ ${ctx.thinkingLevel}` : "");
			const baseName = modelSlug(model.provider, model.id, ctx.thinkingLevel);
			const now = new Date();
			let workDir = resolve(ctx.cwd, BENCHMARKS_DIR, baseName);
			if (existsSync(workDir)) {
				workDir = resolve(ctx.cwd, BENCHMARKS_DIR, `${baseName}-${timestamp(now)}`);
			}
			const workspaceDir = join(workDir, "workspace");
			const finalDir = join(workDir, "final");

			try {
				mkdirSync(workspaceDir, { recursive: true });
				mkdirSync(finalDir, { recursive: true });
			} catch (err) {
				ctx.ui.notify(`Failed to create working directory: ${err instanceof Error ? err.message : String(err)}`, "error");
				return;
			}

			// Persist the task with metadata
			const taskPath = join(workDir, "task.md");
			writeFileSync(
				taskPath,
				`# Benchmark Task

- **Model:** ${modelLabel}
- **Started:** ${now.toISOString()}
- **Working directory:** ${workDir}

## Layout

- \`workspace/\` - intermediate work files
- \`final/\` - final deliverables
- \`summary.md\` - execution summary, auto-written when the task ends
- \`session-*.jsonl\` - copy of the pi session file, auto-written when the task ends (the single source of truth for the report)
- \`report.html\` - HTML report (dashboard + chat, built from the session copy via pi's session exporter), auto-written when the task ends
- \`session-*.jsonl\` - copy of the pi session file, auto-written when the task ends

## Rules

- Do NOT look up, browse, read, copy, or reuse anything else on the file system or in the working folder.
- If you need to create helper scripts or other files needed for completing the task, put them in ${workspaceDir} folder.
- Put ALL final deliverables in ${finalDir} folder.
- Do not create or modify anything outside the working folder.

## Skills
- Use headless-browser skill for debugging, testing and reviewing the work, but do not use it to browse the web.

## Requirement

${requirement}
`,
			);

			// Name the session after the task and the model before starting the run.
			// The leading banner marks it as a benchmark session in /resume pickers.
			pi.setSessionName(`\u2691 ${taskLabel(requirement, requirementSource)} - ${modelLabel}`);

			// Persist a durable "benchmark session" marker and show it in the footer.
			const running: BenchmarkRunData = {
				status: "running",
				workDir,
				modelLabel,
				startedAt: now.toISOString(),
				// Known from the selected model at start - lets the report show
				// context usage % even if the run never reaches the done marker
				// (crash/kill) or is reported while still running. The done marker
				// repeats it (final model if switched mid-run); the report prefers
				// the done value and falls back to this one.
				contextWindow: model.contextWindow,
			};
			pi.appendEntry(RUN_ENTRY_TYPE, running);
			if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, footerText(running));

			ctx.ui.notify(`Benchmark started: ${workDir}`, "info");

			// Read back the exact task.md content and send it to the session
			let taskContent: string;
			try {
				taskContent = readFileSync(taskPath, "utf8");
			} catch (err) {
				ctx.ui.notify(`Failed to read ${taskPath}: ${err instanceof Error ? err.message : String(err)}`, "error");
				return;
			}

			// pi.sendUserMessage always triggers a turn; deliverAs queues it if the agent is busy
			pendingRun = { workDir, modelLabel, startedAt: now };
			pi.sendUserMessage(taskContent);
		},
	});
}
