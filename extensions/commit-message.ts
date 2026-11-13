/**
 * Commit message extension - suggest a commit message from the current git changes.
 *
 * Reads the working tree (status, staged and unstaged diffs, recent commit subjects
 * for style) and asks the current session model for a commit message. The suggestion
 * is shown in a scrollable popup overlay, so long messages are fully readable and can
 * be copied to the clipboard — nothing is written to the session file.
 *
 * Usage:
 *   /commit-message                 - Suggest a message for the current changes
 *   /commit-message --commit        - Suggest, then edit and commit in one step
 *   /commit-message <hint>          - Extra guidance for the suggestion
 *   /commit-message --commit <hint> - Commit with an extra hint
 *
 * In the popup: ↑↓/PgUp/PgDn/Home/End scroll, c copies the message, m commits it
 * (opens the editor first), Enter/Esc closes. With --commit the popup is skipped and
 * the editor opens directly: edit if needed, press Enter to commit, or Esc to cancel.
 * Committing stages the entire working tree first (`git add -A`), including untracked
 * files, so the commit always contains all current changes.
 */

import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { complete } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	type Focusable,
	getNativeClipboard,
	matchesKey,
	type TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

const PROMPT = `Write a git commit message for the changes below.

Rules:
- Follow the repository's existing commit style (see the recent commit subjects). Use Conventional Commits (feat:, fix:, refactor:, docs:, chore:, test:) only if the history uses them; otherwise write a plain imperative subject.
- Subject line: at most 72 characters, imperative mood ("add", "fix", "refactor" — not "added" or "adds"), no trailing period, no prefix like "This commit".
- Add a body after a blank line only when the change is substantial: explain what changed and why (not how), wrapped at 72 characters, with "-" bullets when listing several things.
- Describe what the diff actually does. Do not invent files, behavior, or intent that is not visible in the changes.
- Committing stages the entire working tree (git add -A), so describe all the changes below: staged, unstaged, and untracked files alike.

Output ONLY the commit message: no code fences, no quotes, no explanation.`;

/** Character limits for the git context, to keep the request small. */
const MAX_STATUS = 4_000;
const MAX_DIFF = 12_000;
const MAX_LOG = 1_500;
const MAX_UNTRACKED_FILE = 4_000;
const MAX_UNTRACKED_TOTAL = 12_000;
const MAX_UNTRACKED_FILES = 10;

const WIDGET_KEY = "commit-message";

interface GitContext {
	branch: string;
	status: string;
	stagedDiff: string;
	unstagedDiff: string;
	/** Contents of untracked files, which `git diff` does not show. */
	untracked: string;
	log: string;
}

/** Result of the suggestion popup: "commit" when the user asked to commit it. */
type PopupResult = "commit" | undefined;

// =============================================================================
// Scrollable suggestion popup
// =============================================================================

/**
 * Overlay showing the full suggestion: a scrollable body with a scrollbar, so long
 * messages are not truncated like widgets (which are capped at 10 lines).
 */
export class CommitMessagePopup implements Focusable {
	focused = false;

	private scrollTop = 0;
	private body: string[] = [];
	private bodyWidth = 0;
	private notice: string | undefined;
	private noticeTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly message: string;
	private readonly subtitle: string;
	private readonly done: (result: PopupResult) => void;

	constructor(
		tui: TUI,
		theme: Theme,
		message: string,
		subtitle: string,
		done: (result: PopupResult) => void,
	) {
		this.tui = tui;
		this.theme = theme;
		this.message = message;
		this.subtitle = subtitle;
		this.done = done;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "return")) {
			this.done(undefined);
			return;
		}
		if (matchesKey(data, "up")) return this.scrollBy(-1);
		if (matchesKey(data, "down")) return this.scrollBy(1);
		if (matchesKey(data, "pageUp")) return this.scrollBy(-this.viewportHeight());
		if (matchesKey(data, "pageDown")) return this.scrollBy(this.viewportHeight());
		if (matchesKey(data, "home")) return this.scrollTo(0);
		if (matchesKey(data, "end")) return this.scrollTo(this.body.length);
		if (data === "c") {
			void this.copy();
			return;
		}
		if (data === "m") {
			this.done("commit");
		}
	}

	render(width: number): string[] {
		const theme = this.theme;
		const border = (text: string) => theme.fg("border", text);

		// Borders, padding, and the scrollbar column take 6 columns
		const contentWidth = Math.max(1, width - 6);
		this.rebuildBody(contentWidth);

		const viewport = this.viewportHeight();
		const maxScroll = Math.max(0, this.body.length - viewport);
		if (this.scrollTop > maxScroll) this.scrollTop = maxScroll;

		const lines: string[] = [];
		const innerWidth = width - 2;
		lines.push(border(`╭${"─".repeat(innerWidth)}╮`));

		const title = theme.fg("accent", theme.bold("Suggested commit message"));
		lines.push(this.row(`${title}${theme.fg("dim", `  ${this.subtitle}`)}`, width, contentWidth, " "));
		lines.push(this.row("", width, contentWidth, " "));

		const showScrollbar = this.body.length > viewport;
		const thumbSize = showScrollbar ? Math.max(1, Math.round((viewport / this.body.length) * viewport)) : 0;
		const thumbStart =
			showScrollbar && maxScroll > 0
				? Math.round((this.scrollTop / maxScroll) * Math.max(0, viewport - thumbSize))
				: 0;

		for (let i = 0; i < viewport; i++) {
			const line = this.body[this.scrollTop + i] ?? "";
			let bar = " ";
			if (showScrollbar) {
				bar =
					i >= thumbStart && i < thumbStart + thumbSize
						? theme.fg("accent", "█")
						: theme.fg("borderMuted", "│");
			}
			lines.push(this.row(theme.fg("text", line), width, contentWidth, bar));
		}

		lines.push(this.row("", width, contentWidth, " "));

		const position = showScrollbar
			? theme.fg("dim", `  ${this.scrollTop + 1}-${this.scrollTop + viewport}/${this.body.length}`)
			: "";
		const footer = this.notice
			? theme.fg("success", this.notice)
			: theme.fg("dim", "↑↓ PgUp/PgDn Home/End scroll · c copy · m commit · esc close");
		lines.push(this.row(`${footer}${position}`, width, contentWidth, " "));

		lines.push(border(`╰${"─".repeat(innerWidth)}╯`));
		return lines;
	}

	dispose(): void {
		if (this.noticeTimer) clearTimeout(this.noticeTimer);
	}

	/** Theme or layout changed: drop the wrapped body so it is rebuilt on the next render. */
	invalidate(): void {
		this.bodyWidth = 0;
	}

	private rebuildBody(width: number): void {
		if (width === this.bodyWidth) return;
		this.bodyWidth = width;
		const body: string[] = [];
		for (const line of this.message.split("\n")) {
			body.push(...wrapTextWithAnsi(line, width));
		}
		this.body = body;
	}

	private viewportHeight(): number {
		const rows = this.tui.terminal.rows;
		const maxRows = Math.max(6, Math.floor(rows * 0.85));
		// Top border, header, two spacers, footer, bottom border
		return Math.max(1, Math.min(this.body.length, maxRows - 6));
	}

	private scrollBy(delta: number): void {
		this.scrollTo(this.scrollTop + delta);
	}

	private scrollTo(scrollTop: number): void {
		const maxScroll = Math.max(0, this.body.length - this.viewportHeight());
		this.scrollTop = Math.min(maxScroll, Math.max(0, scrollTop));
		this.tui.requestRender();
	}

	private async copy(): Promise<void> {
		const clipboard = getNativeClipboard();
		try {
			if (clipboard?.setText) {
				await clipboard.setText(this.message);
			} else {
				// OSC 52 fallback: most terminals copy this to the system clipboard
				const encoded = Buffer.from(this.message, "utf-8").toString("base64");
				this.tui.terminal.write(`\x1b]52;c;${encoded}\x1b\\`);
			}
			this.flash("Copied to clipboard");
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.flash(`Copy failed: ${message}`);
		}
	}

	private flash(text: string): void {
		this.notice = text;
		if (this.noticeTimer) clearTimeout(this.noticeTimer);
		this.noticeTimer = setTimeout(() => {
			this.notice = undefined;
			this.noticeTimer = undefined;
			this.tui.requestRender();
		}, 2500);
		this.tui.requestRender();
	}

	private row(content: string, width: number, contentWidth: number, bar: string): string {
		const padded = padTo(content, contentWidth);
		const border = this.theme.fg("border", "│");
		return `${border} ${padded} ${bar} ${border}`;
	}
}

function padTo(text: string, width: number): string {
	const clipped = visibleWidth(text) > width ? truncateToWidth(text, width, "") : text;
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

// =============================================================================
// Git context
// =============================================================================

function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	const headLength = Math.floor(max * 0.7);
	const tailLength = max - headLength;
	return `${text.slice(0, headLength)}\n... [${text.length - max} characters truncated] ...\n${text.slice(-tailLength)}`;
}

/**
 * Read the contents of untracked files listed in `git status --porcelain`. Without
 * this, a change that only adds new files has no diff for the model to describe.
 */
function readUntrackedFiles(ctx: ExtensionContext, status: string): string {
	const paths = status
		.split("\n")
		.filter((line) => line.startsWith("?? "))
		.map((line) => line.slice(3).trim().replace(/^"(.*)"$/, "$1"))
		.slice(0, MAX_UNTRACKED_FILES);

	const sections: string[] = [];
	let budget = MAX_UNTRACKED_TOTAL;
	for (const path of paths) {
		if (budget <= 0) break;
		const absolute = isAbsolute(path) ? path : resolve(ctx.cwd, path);
		try {
			const content = readFileSync(absolute, "utf-8");
			// Skip binaries (NUL byte) and anything that is not worth sending
			if (content.includes("\0") || !content.trim()) continue;
			const excerpt = truncate(content, Math.min(MAX_UNTRACKED_FILE, budget));
			budget -= excerpt.length;
			sections.push(`--- ${path} ---\n${excerpt}`);
		} catch {
			// Directory, unreadable, or deleted between status and read: skip it
		}
	}
	return sections.join("\n\n");
}

async function collectGitContext(pi: ExtensionAPI, ctx: ExtensionContext): Promise<GitContext | undefined> {
	const root = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd: ctx.cwd });
	if (root.code !== 0) return undefined;

	const [branch, status, staged, unstaged, log] = await Promise.all([
		pi.exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: ctx.cwd }),
		pi.exec("git", ["status", "--porcelain"], { cwd: ctx.cwd }),
		pi.exec("git", ["diff", "--cached"], { cwd: ctx.cwd }),
		pi.exec("git", ["diff"], { cwd: ctx.cwd }),
		pi.exec("git", ["log", "-10", "--pretty=%s"], { cwd: ctx.cwd }),
	]);

	const stagedDiff = staged.code === 0 ? staged.stdout.trim() : "";
	const statusText = status.stdout.trim();
	return {
		branch: branch.code === 0 ? branch.stdout.trim() || "HEAD" : "HEAD",
		status: truncate(statusText, MAX_STATUS),
		stagedDiff: truncate(stagedDiff, MAX_DIFF),
		unstagedDiff: truncate(unstaged.code === 0 ? unstaged.stdout.trim() : "", MAX_DIFF),
		untracked: readUntrackedFiles(ctx, statusText),
		// An empty repository has no commits yet; `git log` exits non-zero there.
		log: truncate(log.code === 0 ? log.stdout.trim() : "", MAX_LOG),
	};
}

function buildPrompt(git: GitContext, hint: string | undefined): string {
	const parts = [PROMPT];
	if (hint) {
		parts.push("", `Additional instructions from the user: ${hint}`);
	}
	parts.push(
		"",
		"--- Repository context ---",
		`Branch: ${git.branch}`,
		"",
		"Recent commit subjects (follow this style):",
		git.log || "(no commits yet)",
		"",
		"Working tree status (git status --porcelain):",
		git.status,
		"",
		"Staged changes (git diff --cached):",
		git.stagedDiff || "(nothing staged)",
		"",
		"Unstaged changes (git diff):",
		git.unstagedDiff || "(none)",
	);
	if (git.untracked) {
		parts.push("", "Untracked files (not shown by git diff):", git.untracked);
	}
	parts.push("--- End of context ---");
	return parts.join("\n");
}

function cleanMessage(raw: string): string {
	let text = raw.trim();

	// Strip a wrapping code fence the model may have added
	const fenced = text.match(/^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n```$/);
	if (fenced?.[1]) text = fenced[1].trim();

	// Strip stray wrapping quotes/backticks
	text = text.replace(/^["'`]+/, "").replace(/["'`]+$/, "").trim();

	// Collapse runs of blank lines
	return text.replace(/\n{3,}/g, "\n\n");
}

/**
 * Ask the current session model for a commit message. Returns the message plus the
 * git context it was generated from, or undefined when there is nothing to suggest.
 */
async function generateSuggestion(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	hint: string | undefined,
): Promise<{ message: string; git: GitContext } | undefined> {
	const git = await collectGitContext(pi, ctx);
	if (!git) {
		ctx.ui.notify("Not a git repository.", "error");
		return undefined;
	}
	if (!git.status) {
		ctx.ui.notify("No uncommitted changes to describe.", "info");
		return undefined;
	}

	const model = ctx.model;
	if (!model) {
		ctx.ui.notify("No active model to generate a commit message.", "error");
		return undefined;
	}

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) {
		ctx.ui.notify(`Model error: ${auth.error}`, "warning");
		return undefined;
	}
	if (!auth.apiKey) {
		ctx.ui.notify(`No API key for ${model.provider}/${model.id}`, "warning");
		return undefined;
	}

	if (ctx.hasUI) ctx.ui.setStatus("commit-message", "Generating commit message...");

	try {
		const response = await complete(
			model,
			{
				messages: [
					{
						role: "user" as const,
						content: [{ type: "text" as const, text: buildPrompt(git, hint) }],
						timestamp: Date.now(),
					},
				],
			},
			{
				apiKey: auth.apiKey,
				headers: auth.headers,
				env: auth.env,
				reasoningEffort: "none",
			},
		);

		const message = cleanMessage(
			response.content
				.filter((c: { type: string }): c is { type: "text"; text: string } => c.type === "text")
				.map((c: { text: string }) => c.text)
				.join("\n"),
		);

		if (!message) {
			ctx.ui.notify(`No commit message generated (model: ${model.provider}/${model.id})`, "warning");
			return undefined;
		}
		return { message, git };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		ctx.ui.notify(`Error generating commit message: ${msg}`, "error");
		return undefined;
	} finally {
		if (ctx.hasUI) ctx.ui.setStatus("commit-message", undefined);
	}
}

async function commit(pi: ExtensionAPI, ctx: ExtensionContext, message: string): Promise<void> {
	// Stage the entire working tree (tracked, modified, and untracked files) so the
	// suggested message — which describes all of it — matches what gets committed
	const add = await pi.exec("git", ["add", "-A"], { cwd: ctx.cwd });
	if (add.code !== 0) {
		ctx.ui.notify(`git add failed: ${(add.stderr || add.stdout).trim() || `exit code ${add.code}`}`, "error");
		return;
	}

	const result = await pi.exec("git", ["commit", "-m", message], { cwd: ctx.cwd });

	if (result.code === 0) {
		const subject = message.split("\n")[0];
		ctx.ui.notify(`Committed: ${subject}`, "info");
		return;
	}
	ctx.ui.notify(`git commit failed: ${(result.stderr || result.stdout).trim() || `exit code ${result.code}`}`, "error");
}

/** Edit the message in a multi-line editor, then commit it. */
async function editAndCommit(pi: ExtensionAPI, ctx: ExtensionContext, message: string) {
	if (!ctx.hasUI) {
		ctx.ui.notify("Committing requires interactive (TUI) mode.", "error");
		return;
	}

	const edited = await ctx.ui.editor(
		"Commit message — edit if needed, Enter stages everything and commits (Esc cancels)",
		message,
	);
	if (edited === undefined) {
		ctx.ui.notify("Commit cancelled.", "info");
		return;
	}

	const finalMessage = cleanMessage(edited);
	if (!finalMessage) {
		ctx.ui.notify("Empty commit message — nothing committed.", "warning");
		return;
	}

	await commit(pi, ctx, finalMessage);
}

export default function commitMessageExtension(pi: ExtensionAPI) {
	/** Fallback for modes without custom UI (RPC, print): show the message in a widget. */
	const showWidget = (ctx: ExtensionContext, message: string, git: GitContext) => {
		const theme = ctx.ui.theme;
		const files = git.status.split("\n").filter((line) => line.trim()).length;
		const lines = [
			`${theme.fg("accent", theme.bold("Suggested commit message"))}${theme.fg("dim", `  ${git.branch} • ${files} changed file(s)`)}`,
			"",
			...message.split("\n").map((line) => theme.fg("text", line)),
		];
		ctx.ui.setWidget(WIDGET_KEY, lines);
		ctx.ui.notify("Suggested commit message shown above the editor.", "info");
	};

	pi.registerCommand("commit-message", {
		description:
			"Suggest a commit message from the current git changes (add --commit to edit and commit it)",
		getArgumentCompletions: (prefix) => {
			const items = [
				{ value: "--commit", label: "--commit", description: "commit after generating the message" },
			];
			const q = prefix.trim();
			const filtered = items.filter((i) => i.value.startsWith(q));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			const tokens = (args ?? "").trim().split(/\s+/).filter(Boolean);
			let doCommit = false;
			const hints: string[] = [];
			for (const token of tokens) {
				if (token === "--commit" || token === "commit") doCommit = true;
				else hints.push(token);
			}
			const hint = hints.join(" ") || undefined;

			const suggestion = await generateSuggestion(pi, ctx, hint);
			if (!suggestion) return;

			const { message, git } = suggestion;
			const files = git.status.split("\n").filter((line) => line.trim()).length;
			const subtitle = `${git.branch} • ${files} changed file(s)`;

			if (doCommit) {
				await editAndCommit(pi, ctx, message);
				return;
			}

			// Custom components are TUI-only; RPC and print modes get the widget fallback
			if (ctx.mode !== "tui") {
				showWidget(ctx, message, git);
				return;
			}

			const result = await ctx.ui.custom<PopupResult>(
				(tui, theme, _keybindings, done) =>
					new CommitMessagePopup(tui, theme, message, subtitle, done),
				{ overlay: true, overlayOptions: { width: "80%", maxHeight: "90%", margin: 1 } },
			);

			if (result === "commit") {
				await editAndCommit(pi, ctx, message);
			}
		},
	});
}
