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
 * Run profile: by default a benchmark run is RESTRICTED so models are compared
 * on the same footing - only pi's own built-in tools stay active (read, bash,
 * powershell, edit, write, grep, find, ls - whichever were enabled), every
 * extension tool is removed, and only the `headless-browser` skill is offered
 * to the model. `--all` (alias `--unrestricted`) keeps the session's tools and
 * skills instead. The restriction is session-scoped (tools are recorded in the
 * session transcript; the skill filter is re-applied when a benchmark session
 * is resumed) and lasts until `/reload` or a new session.
 *
 * Vision mode: how the model may inspect images during the run. "embedded"
 * (default) means the model uses its own image modality - it can `read` a PNG
 * and the image goes into the transcript. "tool" additionally enables the
 * vision extension's `analyze_image` tool, which answers questions about image
 * files through a separate nested model call and keeps the image out of the
 * transcript. Select it with `--vision=embedded|tool`, or the shorthands
 * `--vision-embedded` / `--vision-tool`. The effective mode is part of the
 * working directory name (`-vision-embedded` / `-vision-tool`) and recorded in
 * task.md / summary.md / the run marker; it is shown in the footer and report.
 *
 * Request-body guard: images are re-sent with every request, and pi's token
 * accounting counts each image as ~1200 tokens regardless of its byte size, so
 * the context-window based auto-compaction never reacts to image bytes. When
 * the llama-swap engine serving the current model is TensorFold (32 MiB hard
 * request-body limit, not configurable), the extension estimates the body size
 * before each request and omits the oldest images from the request until it
 * fits a 28 MiB budget. The transcript is untouched (images stay in the session
 * file / report).
 *
 * The omitted set is sticky: a cutoff timestamp is remembered, so images stay
 * omitted across requests and only the newest images are appended after it -
 * the request prefix stays stable for the provider's prompt cache. The cutoff
 * advances in batches (drop to a low watermark when the high watermark is
 * crossed), so a cache-invalidating change happens once per batch of new
 * images, not once per image. A rejected body (400/413) is detected too: the
 * budget shrinks, the next request omits more images, and a benchmark run is
 * retried once automatically. Omitted-image counts are recorded in summary.md
 * and report.html.
 *
 * Usage:
 *   /benchmark build a python CLI that converts csv to json
 *   /benchmark tasks/csv-to-cli.md
 *   /benchmark @tasks/csv-to-cli.md
 *   /benchmark @tasks/csv-to-cli.md do the task in parallel mode
 *   /benchmark @tasks/csv-to-cli.md -- prefer node, keep dependencies minimal
 *   /benchmark --vision-tool @tasks/csv-to-cli.md
 *   /benchmark --vision-embedded @tasks/csv-to-cli.md
 *   /benchmark --vision=tool tasks/csv-to-cli.md
 *   /benchmark --all @tasks/csv-to-cli.md
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
import {
	BODY_GUARD_RETRY_BUDGET_BYTES,
	BODY_LIMIT_ERROR_RE,
	BODY_LIMIT_RECOVERY_PROMPT,
	type BodyGuardState,
	createBodyGuardState,
	detectEngine,
	pruneImagesForBudget,
	resetBodyGuardState,
	runEndedWithBodyLimitError,
} from "./body-guard";

const BENCHMARKS_DIR = "benchmarks";

/** A benchmark task started in this session and awaiting completion. */
interface PendingRun {
	workDir: string;
	modelLabel: string;
	vision: VisionMode;
	profile: BenchmarkProfile;
	removedTools: string[];
	nativeImagesBlocked: boolean;
	startedAt: Date;
	/** Unique images omitted from requests by the request-body guard during this run. */
	prunedImages: number;
	/** Batch prune steps (cutoff advances) during this run. */
	pruneEvents: number;
	/** Body-limit rejections recovered by retrying the run once. */
	bodyLimitRecoveries: number;
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
	/** Whether the analyze_image tool was active for this run (captured at start). */
	vision?: VisionMode;
	/** Tool/skill profile of the run: restricted (built-in tools + headless-browser skill) or all. */
	profile?: BenchmarkProfile;
	/** Tools this run removed from the session (restored by a later --all run in the same session). */
	removedTools?: string[];
	/** True when native image input was blocked so the model behaves like a text-only model (vision=tool). */
	nativeImagesBlocked?: boolean;
	/** Unique images the request-body guard omitted from requests during the run (they stay in the transcript). */
	prunedImages?: number;
	/** Batch prune steps (cutoff advances) during the run. */
	pruneEvents?: number;
	/** Body-limit rejections recovered by retrying the run once. */
	bodyLimitRecoveries?: number;
	summaryPath?: string;
	reportPath?: string;
	sessionCopyPath?: string;
}

const RUN_ENTRY_TYPE = "benchmark-run";
const STATUS_KEY = "benchmark";
const VISION_TOOL = "analyze_image";
/** The one skill a restricted benchmark run may load. */
const BENCHMARK_SKILL = "headless-browser";
/** Tools that ship with pi itself - the only ones a restricted benchmark run keeps. */
const BUILTIN_TOOLS = new Set(["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"]);

/** How the model may inspect images during a run: "embedded" = its own image modality, "tool" = the analyze_image tool. */
type VisionMode = "embedded" | "tool";
/** Tool/skill profile: "restricted" = pi built-ins + headless-browser skill only, "all" = session tools and skills. */
type BenchmarkProfile = "restricted" | "all";

/**
 * Session-scoped skill restriction. Set by /benchmark (restricted profile) and
 * cleared by /benchmark --all, /reload or a new session; the before_agent_start
 * handler filters systemPromptOptions.skills while it is true. pi has no
 * setActiveSkills() API - the skills list is only mutable per run through the
 * system prompt options.
 */
let restrictSkills = false;

/**
 * Session-scoped native-image block for vision=tool runs. When true the session
 * behaves like a text-only model: images returned by tools or attached to user
 * input are replaced by a placeholder before they enter the transcript, and
 * history images are stripped from requests. analyze_image still works because
 * it reads the file itself and sends the image in a separate nested call.
 */
let blockNativeImages = false;

/** Text that replaces an image the session is not allowed to see. */
const IMAGE_OMITTED =
	"[image omitted - this session cannot view images directly. Use analyze_image with the file path to ask a question about it.]";

// ---------------------------------------------------------------------------
// Request-body guard (TensorFold rejects request bodies over 32 MiB)
// ---------------------------------------------------------------------------

/**
 * TensorFold enforces a hard 32 MiB request-body limit (not configurable).
 * Images are re-sent with every request and pi's token accounting counts each
 * image as ~1200 tokens regardless of its byte size, so context-window based
 * auto-compaction never reacts to them. The guard (./body-guard) works on bytes
 * instead: before a request goes out it omits the oldest images from the
 * request until the estimated body fits the budget. This is non-destructive -
 * the session transcript (and the benchmark report) keeps every image. The
 * omitted set is sticky (remembered cutoff), so the request prefix stays stable
 * for the provider's prompt cache.
 *
 * The state below is session-scoped: `engine` is the engine that served the
 * most recent request for the current model, and the guard only kicks in for
 * tensorfold.
 */
const bodyGuard: BodyGuardState = createBodyGuardState();

const VISION_TOOL_VALUES = new Set(["tool", "on", "true", "yes", "enabled", "enable", "analyze"]);
const VISION_EMBEDDED_VALUES = new Set(["embedded", "off", "false", "no", "disabled", "disable", "native", "model", "builtin", "built-in"]);

/** One-line footer text for the current benchmark state. */
function footerText(d: BenchmarkRunData): string {
	const vision = d.vision ? ` \u00b7 vision=${d.vision}` : "";
	if (d.status === "done") {
		const dur = d.durationMs !== undefined ? formatDuration(d.durationMs) : "?";
		return `\u2691 benchmark: ${d.modelLabel}${vision} - ${d.outcome ?? "completed"} (${dur})`;
	}
	return `\u2691 benchmark: ${d.modelLabel}${vision} - running`;
}

/**
 * Strip leading benchmark flags from the command argument. Supported forms:
 *   --vision=tool|embedded [mode]     --vision-tool / --vision-embedded
 *   --all / --unrestricted / --full
 * Returns the remaining text (the requirement / task file) untouched.
 */
function parseBenchmarkFlags(argText: string): {
	vision?: VisionMode;
	profile: BenchmarkProfile;
	rest: string;
	error?: string;
} {
	let rest = argText.trimStart();
	let vision: VisionMode | undefined;
	let profile: BenchmarkProfile = "restricted";
	const flagRe = /^--(vision|vision-tool|vision-embedded|all|unrestricted|full)(?:=(\S+))?(?=\s|$)/i;
	for (;;) {
		const m = flagRe.exec(rest);
		if (!m) break;
		const flag = m[1].toLowerCase();
		let value = m[2]?.toLowerCase();
		let consumed = m[0].length;

		if (flag === "all" || flag === "unrestricted" || flag === "full") {
			if (value !== undefined) return { rest, profile, error: `--${flag} takes no value` };
			profile = "all";
			rest = rest.slice(consumed).trimStart();
			continue;
		}

		if (flag === "vision-tool" || flag === "vision-embedded") {
			if (value !== undefined) return { rest, profile, error: `--${flag} takes no value` };
			vision = flag === "vision-tool" ? "tool" : "embedded";
			rest = rest.slice(consumed).trimStart();
			continue;
		}

		// --vision requires a mode: inline (--vision=tool) or next token (--vision tool).
		if (value === undefined) {
			const afterFlag = rest.slice(consumed).trimStart();
			const next = /^(\S+)/.exec(afterFlag);
			const candidate = next?.[1].toLowerCase();
			if (next && candidate && (VISION_TOOL_VALUES.has(candidate) || VISION_EMBEDDED_VALUES.has(candidate))) {
				value = candidate;
				consumed = rest.length - afterFlag.length + next[1].length;
			}
		}

		if (value === undefined) {
			return {
				rest,
				profile,
				error: "--vision needs a mode - use --vision=tool, --vision=embedded, --vision-tool or --vision-embedded",
			};
		}
		if (VISION_TOOL_VALUES.has(value)) vision = "tool";
		else if (VISION_EMBEDDED_VALUES.has(value)) vision = "embedded";
		else {
			return {
				rest,
				profile,
				error: `Unknown vision mode \"${value}\" - use --vision=tool, --vision=embedded, --vision-tool or --vision-embedded`,
			};
		}
		rest = rest.slice(consumed).trimStart();
	}
	// Reject unknown leading options instead of silently treating them as part of
	// the requirement (e.g. the old --no-vision spelling).
	const unknown = /^--([a-z][\w-]*)(?=[\s=]|$)/i.exec(rest);
	if (unknown) {
		return {
			vision,
			profile,
			rest,
			error: `Unknown option --${unknown[1]} - supported: --vision=embedded|tool, --vision-tool, --vision-embedded, --all`,
		};
	}
	return { vision, profile, rest };
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
		const vision = d.vision ? ` \u00b7 vision=${d.vision}` : "";
		if (d.status === "done") {
			const dur = d.durationMs !== undefined ? formatDuration(d.durationMs) : "?";
			const color = d.outcome && d.outcome !== "completed" ? "error" : "success";
			box.addChild(new Text(theme.fg(color, `\u2691 benchmark ${d.modelLabel}${vision} - ${d.outcome ?? "completed"} in ${dur}`)));
		} else {
			box.addChild(new Text(theme.fg("accent", `\u2691 benchmark ${d.modelLabel}${vision} - running`)));
		}
		if (expanded) {
			if (d.vision) box.addChild(new Text(theme.fg("dim", `vision: ${d.vision}`)));
			if (d.profile) box.addChild(new Text(theme.fg("dim", `tools/skills: ${d.profile}`)));
			box.addChild(new Text(theme.fg("dim", `workdir: ${d.workDir}`)));
			if (d.summaryPath) box.addChild(new Text(theme.fg("dim", `summary: ${d.summaryPath}`)));
			if (d.reportPath) box.addChild(new Text(theme.fg("dim", `report: ${d.reportPath}`)));
			if (d.sessionCopyPath) box.addChild(new Text(theme.fg("dim", `session: ${d.sessionCopyPath}`)));
		}
		return box;
	});

	// Restrict the skills offered to the model while a restricted benchmark run is
	// in effect. pi exposes no setActiveSkills(): the run's skill list lives in
	// systemPromptOptions and is mutable from before_agent_start, so filtering it
	// here applies to every run for the rest of the session.
	pi.on("before_agent_start", async (event) => {
		if (restrictSkills) {
			event.systemPromptOptions.skills = event.systemPromptOptions.skills.filter((skill) => skill.name === BENCHMARK_SKILL);
		}
		if (blockNativeImages) {
			event.systemPromptOptions.promptGuidelines.push(
				"This session cannot view images directly: image files are not readable and any image attached to a message " +
					"or returned by a tool is replaced by a placeholder. To ask about an image, call analyze_image with the " +
					"file path and a question - it sends the image to a separate vision call and returns text.",
			);
		}
	});

	// vision=tool runs behave like a text-only session: strip images from tool
	// results (e.g. read on a PNG, screenshot) before they reach the transcript.
	pi.on("tool_result", async (event) => {
		if (!blockNativeImages || !event.content.some((c) => c.type === "image")) return;
		const content = event.content.map((c) => (c.type === "image" ? { type: "text" as const, text: IMAGE_OMITTED } : c));
		return { content };
	});

	// Same for images attached to user input.
	pi.on("input", async (event) => {
		if (!blockNativeImages || !event.images?.length) return;
		const note = `[${event.images.length} attached image(s) omitted - this session cannot view images directly. Use analyze_image with the file path instead.]`;
		return { action: "transform", text: event.text ? `${event.text}\n\n${note}` : note, images: [] };
	});

	// History images (e.g. from before the benchmark run or a resumed session)
	// are stripped from every request as well.
	pi.on("context", async (event) => {
		if (!blockNativeImages) return;
		let changed = false;
		const messages = event.messages.map((message) => {
			if (message.role !== "user" && message.role !== "toolResult") return message;
			if (!Array.isArray(message.content) || !message.content.some((c) => c.type === "image")) return message;
			changed = true;
			return {
				...message,
				content: message.content.map((c) => (c.type === "image" ? { type: "text" as const, text: IMAGE_OMITTED } : c)),
			};
		});
		return changed ? { messages } : undefined;
	});

	// Request-body guard: images are re-sent with every request and pi's token
	// estimate counts each image as ~1200 tokens regardless of its byte size, so
	// context-based auto-compaction never reacts to image bytes. TensorFold
	// rejects request bodies over 32 MiB, so omit the oldest images from the
	// request (never from the transcript) until the estimated body fits. The
	// omitted set is sticky (remembered cutoff) so the request prefix stays
	// stable for the provider's prompt cache; the cutoff only advances in
	// batches when the body crosses the high watermark again.
	pi.on("context", async (event, ctx) => {
		if (blockNativeImages) return; // vision=tool runs already strip every image
		if (!ctx.model?.input?.includes("image")) return; // images are not sent anyway
		const detected = detectEngine(ctx.sessionManager.getEntries(), ctx.model?.id);
		// Keep a previously forced engine when detection has nothing to go on
		// (a body-limit rejection proves the limit even without usage records).
		if (detected) bodyGuard.engine = detected;
		if (bodyGuard.engine !== "tensorfold") return;

		const pruned = pruneImagesForBudget(event.messages, bodyGuard.budgetBytes, bodyGuard.pruneBeforeMs);
		if (!pruned) return;

		// Remember the cutoff so the same images stay omitted on later requests.
		bodyGuard.pruneBeforeMs = pruned.pruneBeforeMs;
		if (pruned.newlyDropped > 0) {
			bodyGuard.prunedImages += pruned.newlyDropped;
			bodyGuard.pruneEvents += 1;
			if (pendingRun) {
				pendingRun.prunedImages += pruned.newlyDropped;
				pendingRun.pruneEvents += 1;
			}
			if (!bodyGuard.notified) {
				bodyGuard.notified = true;
				ctx.ui.notify(
					`TensorFold request-body guard: ${pruned.dropped} older image(s) omitted from requests to stay under the 32 MiB limit (they remain in the transcript; the omitted set stays fixed until the body grows again).`,
					"warning",
				);
			}
		}
		return { messages: pruned.messages };
	});

	// A body-limit rejection (TensorFold returns 400, pi does not retry it) ends
	// the run. Shrink the budget so the next request's cutoff advance omits
	// enough images to fit, and let agent_settled retry a benchmark run once
	// (see below).
	pi.on("message_end", async (event) => {
		const message = event.message;
		if (message.role !== "assistant" || message.stopReason !== "error") return;
		if (!message.errorMessage || !BODY_LIMIT_ERROR_RE.test(message.errorMessage)) return;
		// The rejection proves this engine enforces the limit, even when the
		// usage records do not reveal the engine yet. Shrink the budget; the
		// next request's cutoff advance omits enough images to fit it.
		bodyGuard.engine = "tensorfold";
		bodyGuard.budgetBytes = Math.min(bodyGuard.budgetBytes, BODY_GUARD_RETRY_BUDGET_BYTES);
	});

	// A 413 is also a body-limit rejection (some gateways use it instead of 400).
	pi.on("after_provider_response", async (event) => {
		if (event.status !== 413) return;
		bodyGuard.engine = "tensorfold";
		bodyGuard.budgetBytes = Math.min(bodyGuard.budgetBytes, BODY_GUARD_RETRY_BUDGET_BYTES);
	});

	// A different model may be served by a different engine; re-detect on the
	// next request instead of keeping the previous model's engine.
	pi.on("model_select", async () => {
		bodyGuard.engine = undefined;
	});

	// Restore the footer marker (and the skill/image restrictions) when a
	// benchmark session is resumed/reloaded. The tool loadout itself is restored
	// by pi from the session transcript.
	pi.on("session_start", async (_event, ctx) => {
		resetBodyGuardState(bodyGuard);
		let last: BenchmarkRunData | undefined;
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "custom" && entry.customType === RUN_ENTRY_TYPE) {
				last = entry.data as BenchmarkRunData;
			}
		}
		if (last) {
			restrictSkills = last.profile === "restricted";
			blockNativeImages = last.nativeImagesBlocked === true;
			if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, footerText(last));
		}
	});

	pi.on("agent_settled", async (event, ctx) => {
		const run = pendingRun;
		if (!run) return;

		// TensorFold's 32 MiB body limit surfaces as a 400, which pi does not
		// retry. The guard already shrank the budget, so retry the benchmark run
		// once with more images omitted from the request.
		if (!event.aborted && run.bodyLimitRecoveries === 0 && runEndedWithBodyLimitError(ctx, run.startedAt)) {
			run.bodyLimitRecoveries += 1;
			bodyGuard.engine = "tensorfold";
			bodyGuard.budgetBytes = Math.min(bodyGuard.budgetBytes, BODY_GUARD_RETRY_BUDGET_BYTES);
			ctx.ui.notify(
				"TensorFold rejected the request body as too large. Images were dropped from the request and the run is retried once.",
				"warning",
			);
			pi.sendUserMessage(BODY_LIMIT_RECOVERY_PROMPT);
			return;
		}

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
				`- **Vision:** ${
					run.vision === "tool"
						? run.nativeImagesBlocked
							? "tool (analyze_image only - native image input blocked)"
							: "tool (analyze_image available - session keeps its own image handling)"
						: "embedded (model's own image modality)"
				}`,
				`- **Tools/skills:** ${run.profile === "restricted" ? "restricted (pi built-in tools + headless-browser skill only)" : "all (session tools and skills)"}`,
				`- **Started:** ${run.startedAt.toISOString()}`,
				`- **Ended:** ${endedAt.toISOString()}`,
				`- **Duration:** ${formatDuration(endedAt.getTime() - run.startedAt.getTime())}`,
				`- **Outcome:** ${outcome}`,
				...(run.prunedImages > 0
					? [
							`- **Request-body guard:** ${run.prunedImages} image(s) omitted from requests in ${run.pruneEvents} prune step(s) to stay under TensorFold's 32 MiB limit${
								run.bodyLimitRecoveries > 0 ? ` (${run.bodyLimitRecoveries} retry after a rejected body)` : ""
							}`,
						]
					: []),
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
				vision: run.vision,
				profile: run.profile,
				removedTools: run.removedTools,
				nativeImagesBlocked: run.nativeImagesBlocked,
				prunedImages: run.prunedImages,
				pruneEvents: run.pruneEvents,
				bodyLimitRecoveries: run.bodyLimitRecoveries,
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
				vision: run.vision,
				profile: run.profile,
				removedTools: run.removedTools,
				nativeImagesBlocked: run.nativeImagesBlocked,
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
			"Benchmark the current model: /benchmark [--vision=embedded|tool] [--all] <requirement or file with the requirement> - creates benchmarks/<model>[-all]-vision-<mode>/ with workspace/ and final/, restricts the session to pi's built-in tools + the headless-browser skill, then starts the task in this session",
		getArgumentCompletions: (prefix) => {
			const options = [
				{ value: "--vision-tool", label: "--vision-tool", description: "Use the analyze_image tool (separate vision model call) for this run" },
				{ value: "--vision-embedded", label: "--vision-embedded", description: "Use only the model's own image modality for this run" },
				{ value: "--vision=tool", label: "--vision=tool", description: "Same as --vision-tool" },
				{ value: "--vision=embedded", label: "--vision=embedded", description: "Same as --vision-embedded" },
				{ value: "--all", label: "--all", description: "Keep the session's tools and skills instead of the restricted benchmark set" },
			];
			const p = prefix.toLowerCase();
			const matches = options.filter((o) => o.value.startsWith(p));
			return matches.length > 0 ? matches : null;
		},
		handler: async (args, ctx) => {
			// Leading flags select the tool/skill profile and the vision mode for
			// this run, e.g.
			//   /benchmark --vision-tool @tasks/csv-to-cli.md
			//   /benchmark --vision-embedded tasks/csv-to-cli.md
			//   /benchmark --vision=tool tasks/csv-to-cli.md
			//   /benchmark --all @tasks/csv-to-cli.md
			const parsed = parseBenchmarkFlags(args?.trim() ?? "");
			if (parsed.error) {
				ctx.ui.notify(parsed.error, "error");
				return;
			}
			// Support an "@"-prefixed file reference, e.g. /benchmark @tasks/csv-to-cli.md
			// Anything after the file path is treated as additional instructions, e.g.
			// /benchmark @tasks/csv-to-cli.md do the task in parallel mode
			let argText = parsed.rest.replace(/^@/, "");
			if (!argText) {
				ctx.ui.notify(
					"Usage: /benchmark [--vision=embedded|tool] [--all] <requirement to build, or a file containing it> [additional instructions]",
					"error",
				);
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

			// Resolve the tool profile and vision state for this run and apply them
			// BEFORE anything is recorded, so the directory name, task.md, session
			// name and run marker all describe the same configuration.
			//
			// Default (restricted): keep only pi's built-in tools and offer only the
			// headless-browser skill. Extension tools (screenshot, analyze_image,
			// context_size, ...) and every other skill are withheld so models are
			// compared on the same footing. --all keeps the session's tools/skills.
			const visionRegistered = pi.getAllTools().some((tool) => tool.name === VISION_TOOL);
			if (parsed.vision === "tool" && !visionRegistered) {
				ctx.ui.notify(
					`Cannot use the vision tool: the "${VISION_TOOL}" tool is not registered - load the vision extension first.`,
					"error",
				);
				return;
			}

			let nextTools = pi.getActiveTools();
			const beforeTools = [...nextTools];
			if (parsed.profile === "restricted") {
				nextTools = nextTools.filter((name) => BUILTIN_TOOLS.has(name));
			} else {
				// --all: keep the session's tools, and give back anything an earlier
				// benchmark run in this session removed (e.g. running --all after a
				// restricted run without /reload).
				const registered = new Set(pi.getAllTools().map((tool) => tool.name));
				let lastMarker: BenchmarkRunData | undefined;
				for (const entry of ctx.sessionManager.getEntries()) {
					if (entry.type === "custom" && entry.customType === RUN_ENTRY_TYPE) lastMarker = entry.data as BenchmarkRunData;
				}
				for (const name of lastMarker?.removedTools ?? []) {
					if (registered.has(name) && !nextTools.includes(name)) nextTools.push(name);
				}
			}
			if (parsed.vision === "tool" && !nextTools.includes(VISION_TOOL)) nextTools = [...nextTools, VISION_TOOL];
			else if (parsed.vision === "embedded") nextTools = nextTools.filter((name) => name !== VISION_TOOL);
			pi.setActiveTools(nextTools);
			const afterTools = pi.getActiveTools();
			const removedTools = beforeTools.filter((name) => !afterTools.includes(name));
			const vision: VisionMode = afterTools.includes(VISION_TOOL) ? "tool" : "embedded";
			restrictSkills = parsed.profile === "restricted";
			// vision=tool means the model must reach images only through the tool, so
			// native image input is blocked for the rest of the session. --all without
			// an explicit mode leaves the session's own behaviour alone.
			blockNativeImages = vision === "tool" && (parsed.profile === "restricted" || parsed.vision === "tool");

			// Create the per-model working directory (append timestamp if it already exists).
			// The name carries the tool/skill profile (`-all` for unrestricted runs) and
			// the vision mode (`-vision-embedded` / `-vision-tool`) so variant runs of
			// the same model sit side by side under ./benchmarks/ and never overwrite
			// each other.
			const modelLabel =
				model.provider + "/" + model.id + (ctx.thinkingLevel && ctx.thinkingLevel !== "off" ? ` @ ${ctx.thinkingLevel}` : "");
			const baseName = `${modelSlug(model.provider, model.id, ctx.thinkingLevel)}${parsed.profile === "all" ? "-all" : ""}-vision-${vision}`;
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
			const profileLabel =
				parsed.profile === "restricted"
					? "restricted (pi built-in tools + headless-browser skill only)"
					: "all (session tools and skills)";
			const skillsGuidance =
				parsed.profile === "restricted"
					? "- The headless-browser skill is the only skill available in this run - use it for debugging, testing and reviewing the work, but do not use it to browse the web."
					: "- Use headless-browser skill for debugging, testing and reviewing the work, but do not use it to browse the web.";
			const visionGuidance =
				vision === "tool"
					? "\n- This session cannot view images directly - image files are not readable and any image attached to a message or returned by a tool is replaced by a placeholder. When you need to check what an image (screenshot, rendered page) shows, use the analyze_image tool with the file path and a specific question. It sends the image to a separate vision call and returns text, so the image never enters this conversation."
					: "";
			const taskPath = join(workDir, "task.md");
			writeFileSync(
				taskPath,
				`# Benchmark Task

- **Model:** ${modelLabel}
- **Vision:** ${
				vision === "tool"
					? blockNativeImages
						? "tool (analyze_image only - native image input blocked)"
						: "tool (analyze_image available - session keeps its own image handling)"
					: "embedded (model's own image modality)"
			}
- **Tools/skills:** ${profileLabel}
- **Started:** ${now.toISOString()}
- **Working directory:** ${workDir}

## Layout

- \`workspace/\` - intermediate work files
- \`final/\` - final deliverables
- \`summary.md\` - execution summary, auto-written when the task ends
- \`session-*.jsonl\` - copy of the pi session file, auto-written when the task ends (the single source of truth for the report)
- \`report.html\` - HTML report (dashboard + chat, built from the session copy via pi's session exporter), auto-written when the task ends

## Rules

- Do NOT look up, browse, read, copy, or reuse anything else on the file system or in the working folder.
- If you need to create helper scripts or other files needed for completing the task, put them in ${workspaceDir} folder.
- Put ALL final deliverables in ${finalDir} folder.
- Do not create or modify anything outside the working folder.

## Skills and Tools
${skillsGuidance}${visionGuidance}

## Requirement

${requirement}
`,
			);

			// Name the session after the task, the model and the vision state before
			// starting the run. The leading banner marks it as a benchmark session in
			// /resume pickers.
			pi.setSessionName(
				`\u2691 ${taskLabel(requirement, requirementSource)} - ${modelLabel} [vision=${vision}${parsed.profile === "all" ? ", all tools" : ""}]`,
			);

			// Persist a durable "benchmark session" marker and show it in the footer.
			const running: BenchmarkRunData = {
				status: "running",
				workDir,
				modelLabel,
				vision,
				profile: parsed.profile,
				removedTools,
				nativeImagesBlocked: blockNativeImages,
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

			ctx.ui.notify(
				`Benchmark started (vision=${vision}${blockNativeImages ? ", native image input blocked" : ""}, ${parsed.profile === "restricted" ? "built-in tools + headless-browser skill only" : "session tools and skills"}): ${workDir}`,
				"info",
			);

			// Read back the exact task.md content and send it to the session
			let taskContent: string;
			try {
				taskContent = readFileSync(taskPath, "utf8");
			} catch (err) {
				ctx.ui.notify(`Failed to read ${taskPath}: ${err instanceof Error ? err.message : String(err)}`, "error");
				return;
			}

			// pi.sendUserMessage always triggers a turn; deliverAs queues it if the agent is busy
			pendingRun = {
				workDir,
				modelLabel,
				vision,
				profile: parsed.profile,
				removedTools,
				nativeImagesBlocked: blockNativeImages,
				startedAt: now,
				prunedImages: 0,
				pruneEvents: 0,
				bodyLimitRecoveries: 0,
			};
			pi.sendUserMessage(taskContent);
		},
	});
}
