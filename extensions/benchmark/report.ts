/**
 * Benchmark HTML report generator
 *
 * Builds `report.html` for a benchmark working directory entirely from the
 * copied pi session file (`session-*.jsonl`) - there is no results.json:
 *
 *   1. parse the session copy and locate this run's `benchmark-run` marker
 *   2. compute stats over the run's time window (tool calls, skills,
 *      llama-swap usage) using the shared llama-swap stats helpers
 *   3. render the chat with pi's built-in HTML exporter, reused through
 *      llama-swap/export (same path as /export-with-stats: llama-swap-usage
 *      entries are rewritten to visible custom messages before export)
 *   4. inject a benchmark dashboard (run header + artifact links, stat cards,
 *      per-tool table, llama-swap panel, per-request table) into the exported
 *      page, scoped with bench-* classes so template updates can't collide
 *
 * Regenerate any time with /benchmark-report [workDir].
 */

import { existsSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { toExportableSessionLines, loadExportFromFile } from "../llama-swap/export";
import { pickEngine, tensorfoldPayload } from "../llama-swap/engines";
import { collectToolStats, collectUsageRecords, computeStats } from "../llama-swap/stats";

/** The durable benchmark-run marker persisted via pi.appendEntry(). */
interface BenchmarkRunData {
	status: "running" | "done";
	workDir: string;
	modelLabel: string;
	startedAt: string;
	endedAt?: string;
	durationMs?: number;
	outcome?: string;
	contextWindow?: number;
	summaryPath?: string;
	reportPath?: string;
	sessionCopyPath?: string;
}

/** Loose shape of a jsonl session entry (the typed SessionEntry union is not worth re-declaring here). */
interface JsonlEntry {
	type?: string;
	customType?: string;
	timestamp?: string;
	message?: {
		role?: string;
		content?: unknown;
		usage?: {
			input?: number;
			output?: number;
			cacheRead?: number;
			cacheWrite?: number;
			reasoning?: number;
			totalTokens?: number;
			cost?: { total?: number };
		};
	};
	data?: unknown;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function esc(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function fmtInt(n: number): string {
	return Number.isFinite(n) ? Math.round(n).toLocaleString("en-US") : "?";
}

function fmtMs(ms: number): string {
	if (!Number.isFinite(ms) || ms <= 0) return "0ms";
	if (ms < 1000) return `${Math.round(ms)}ms`;
	const s = ms / 1000;
	if (s < 60) return `${s.toFixed(1)}s`;
	const m = Math.floor(s / 60);
	const rs = Math.round(s % 60);
	if (m < 60) return rs > 0 ? `${m}m ${rs}s` : `${m}m`;
	const h = Math.floor(m / 60);
	const rm = m % 60;
	return rm > 0 ? `${h}h ${rm}m` : `${h}h`;
}

function fmtNum(n: number, digits = 1): string {
	return Number.isFinite(n) ? n.toLocaleString("en-US", { maximumFractionDigits: digits }) : "?";
}

function fmtPct(fraction: number): string {
	return Number.isFinite(fraction) ? `${(fraction * 100).toFixed(1)}%` : "?";
}

function fmtTime(iso: string | number | undefined): string {
	if (iso === undefined) return "";
	const d = new Date(iso);
	return Number.isFinite(d.getTime()) ? d.toLocaleString() : String(iso);
}

function entryTime(e: JsonlEntry): number {
	const at = e.timestamp ? Date.parse(e.timestamp) : NaN;
	return Number.isFinite(at) ? at : NaN;
}

// ---------------------------------------------------------------------------
// Dashboard pieces
// ---------------------------------------------------------------------------

function card(label: string, value: string, sub?: string, tone?: "ok" | "bad" | "warn"): string {
	const cls = tone ? ` bench-value-${tone}` : "";
	return `<div class="bench-card"><div class="bench-card-label">${esc(label)}</div><div class="bench-card-value${cls}">${esc(value)}</div>${
		sub ? `<div class="bench-card-sub">${esc(sub)}</div>` : ""
	}</div>`;
}

function outcomeTone(outcome: string): "ok" | "bad" | "warn" {
	if (outcome === "completed") return "ok";
	if (outcome.startsWith("aborted")) return "warn";
	return "bad";
}

const TOOL_ICONS: Record<string, string> = {
	bash: "💻",
	read: "📖",
	write: "📝",
	edit: "✏️",
	find: "🔍",
	grep: "🔎",
	screenshot: "📸",
	analyze_image: "👁",
};

function toolIcon(name: string): string {
	return TOOL_ICONS[name] ?? "🔧";
}

/** Everything the run-scoped stats need, computed from the session entries. */
interface RunStats {
	toolStats: ReturnType<typeof collectToolStats>;
	llamaSwap: ReturnType<typeof computeStats>;
	usageRecords: ReturnType<typeof collectUsageRecords>;
	assistantCount: number;
	userCount: number;
	lastContextTokens?: number;
	cost: number;
	/** Summed assistant-message usage over the run window (pi semantics: input is the uncached part). */
	sumInput: number;
	sumOutput: number;
	sumReasoning: number;
	sumCacheRead: number;
	sumCacheWrite: number;
	/** Last entry/record activity time in the run window - fallback for endedAt/duration on copies made before the done marker existed. */
	lastActivityMs?: number;
}

function dashboardHtml(
	run: BenchmarkRunData | undefined,
	stats: RunStats,
	workDir: string,
	sessionCopyName: string,
	sessionName: string | undefined,
): string {
	const outcome = run?.outcome ?? "completed";
	const tone = outcomeTone(outcome);
	const badge = tone === "ok" ? "bench-ok" : tone === "warn" ? "bench-warn" : "bench-bad";
	// Duration/ended come from the done marker; session copies written before it
	// existed (or while still running) fall back to last entry activity.
	const startedMs = run ? Date.parse(run.startedAt) : NaN;
	const derived = run?.durationMs === undefined && Number.isFinite(startedMs) && stats.lastActivityMs !== undefined;
	const durationMs = run?.durationMs ?? (derived ? (stats.lastActivityMs as number) - startedMs : undefined);
	const endedLabel = run?.endedAt ?? (derived ? new Date(stats.lastActivityMs as number).toISOString() : undefined);
	const t = stats.toolStats;
	const ls = stats.llamaSwap;

	const links: Array<[string, string]> = [
		["task.md", "task.md"],
		["summary.md", "summary.md"],
		[sessionCopyName, sessionCopyName],
		["final/ ↗", "final/"],
		["workspace/ ↗", "workspace/"],
	];
	const linksHtml = `<div class="bench-links">${links
		.map(([label, href]) => `<a href="${esc(href)}">${esc(label)}</a>`)
		.join("")}</div>`;

	const cards: string[] = [];
	cards.push(card("Outcome", outcome, run ? `${fmtTime(run.startedAt)} → ${fmtTime(endedLabel)}` : undefined, tone));
	cards.push(
		card(
			"Duration",
			durationMs !== undefined ? fmtMs(durationMs) + (derived ? " *" : "") : "?",
			`${stats.userCount} user · ${stats.assistantCount} assistant · ${t.calls} tool calls` + (derived ? " · * estimated from entries" : ""),
		),
	);
	cards.push(
		card("Tool calls", fmtInt(t.calls), t.errors > 0 ? `${t.errors} failed · ${fmtMs(t.totalMs)} exec` : `${fmtMs(t.totalMs)} exec`, t.errors > 0 ? "warn" : "ok"),
	);
	cards.push(card("LLM requests", fmtInt(ls.requests), ls.engines.size > 0 ? `engine: ${[...ls.engines].join(", ")}` : undefined));
	cards.push(
		card(
			"Output tokens",
			fmtInt(stats.sumOutput),
			`incl. ${fmtInt(stats.sumReasoning)} reasoning` + (ls.predictedMs > 0 ? ` · ${fmtNum(ls.predictedN / (ls.predictedMs / 1000))} tok/s` : ""),
		),
	);
	cards.push(card("Input tokens (uncached)", fmtInt(stats.sumInput), `prompt total ${fmtInt(stats.sumInput + stats.sumCacheRead)}`));
	cards.push(card("Cached input reads", fmtInt(stats.sumCacheRead)));
	// pi only reports cacheWrite for providers that bill it (e.g. Anthropic);
	// OpenAI-compatible backends (llama-swap) leave it at 0.
	cards.push(card("Cache writes", fmtInt(stats.sumCacheWrite), stats.sumCacheWrite === 0 ? "not reported by this provider" : undefined));
	if (ls.ttftCount > 0) cards.push(card("Avg time-to-first-token", fmtMs(ls.ttftMs / ls.ttftCount), `${fmtInt(ls.ttftCount)} requests`));
	const promptTotal = stats.sumInput + stats.sumCacheRead;
	const cacheHit = promptTotal > 0 ? stats.sumCacheRead / promptTotal : 0;
	cards.push(card("Cache hit rate", fmtPct(cacheHit), undefined, cacheHit > 0.5 ? "ok" : undefined));
	if (ls.draftN > 0) {
		cards.push(card("Draft acceptance", fmtPct(ls.draftAccepted / ls.draftN), `${fmtInt(ls.draftAccepted)}/${fmtInt(ls.draftN)} accepted`));
	}
	if (stats.lastContextTokens !== undefined) {
		const cw = run?.contextWindow;
		cards.push(
			card(
				"Context usage",
				cw ? `${((stats.lastContextTokens / cw) * 100).toFixed(1)}%` : fmtInt(stats.lastContextTokens),
				cw ? `${fmtInt(stats.lastContextTokens)} / ${fmtInt(cw)} tokens` : "tokens after last turn",
			),
		);
	}
	if (stats.cost > 0) cards.push(card("Cost", `$${stats.cost.toFixed(4)}`));

	const toolRows = [...t.perTool.entries()].sort((a, b) => b[1].calls - a[1].calls);
	const maxMs = Math.max(1, ...toolRows.map(([, v]) => v.totalMs));
	const toolTable = toolRows.length
		? `<table class="bench-table"><thead><tr><th>tool</th><th>calls</th><th>err</th><th>total</th><th>max</th><th>share</th></tr></thead><tbody>${toolRows
				.map(
					([name, v]) => `<tr>
<td>${toolIcon(name)} ${esc(name)}</td>
<td>${fmtInt(v.calls)}</td>
<td${v.errors ? ' class="bench-warn"' : ""}>${fmtInt(v.errors)}</td>
<td>${fmtMs(v.totalMs)}</td>
<td>${fmtMs(v.maxMs)}</td>
<td><div class="bench-bar" style="width:${Math.max(2, Math.round((v.totalMs / maxMs) * 100))}%"></div></td>
</tr>`,
				)
				.join("")}</tbody></table>`
		: `<p class="bench-dim">No tool calls.</p>`;
	const skills = [...t.skills.entries()].sort((a, b) => b[1] - a[1]);
	const skillsHtml = skills.length
		? `<div class="bench-chips">${skills.map(([n, c]) => `<span class="bench-chip">📚 ${esc(n)} <span class="bench-dim">×${c}</span></span>`).join(" ")}</div>`
		: "";

	const kvRows: Array<[string, string]> = [];
	kvRows.push(["Requests", `${fmtInt(ls.requests)}${ls.tfRequests ? ` (tf ${fmtInt(ls.tfRequests)}, exact ${fmtInt(ls.exactRequests)})` : ""}`]);
	if (ls.engines.size > 0) kvRows.push(["Engines", [...ls.engines].join(", ")]);
	if (ls.promptMs > 0) kvRows.push(["Prompt eval", `${fmtMs(ls.promptMs)} (${fmtInt(ls.promptN)} tok)`]);
	if (ls.predictedMs > 0) kvRows.push(["Predicted", `${fmtMs(ls.predictedMs)} (${fmtInt(ls.predictedN)} tok)`]);
	if (ls.specRounds > 0) kvRows.push(["Spec rounds", fmtInt(ls.specRounds)]);
	const kvHtml = `<div class="bench-kv">${kvRows.map(([k, v]) => `<div class="bench-kv-k">${esc(k)}</div><div class="bench-kv-v">${esc(v)}</div>`).join("")}</div>`;

	const reqTable = stats.usageRecords.length
		? `<details class="bench-requests"><summary>${fmtInt(stats.usageRecords.length)} LLM requests</summary><div class="bench-scrollx"><table class="bench-table"><thead><tr><th>#</th><th>time</th><th>model</th><th>engine</th><th>prompt</th><th>compl.</th><th>cached</th><th>tok/s</th><th>TTFT</th><th>rounds</th><th>accept</th></tr></thead><tbody>${stats.usageRecords
				.map((rec, idx) => {
					const tfp = tensorfoldPayload(rec.record);
					const tf = tfp?.diagnostics ?? {};
					const spec = tfp?.speculative ?? {};
					const usage = rec.record.usage ?? {};
					const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
					const acceptRate = spec.drafted ? (spec.accepted ?? 0) / spec.drafted : undefined;
					return `<tr>
<td class="bench-dim">${idx + 1}</td>
<td class="bench-dim">${esc(fmtTime(Number.isFinite(rec.ts) ? rec.ts : (rec.record as { capturedAt?: number }).capturedAt))}</td>
<td>${esc(String((rec.record as { model?: string }).model ?? "?"))}</td>
<td>${esc(pickEngine(rec.record)?.label ?? "-")}</td>
<td>${fmtInt(usage.prompt_tokens ?? 0)}</td>
<td>${fmtInt(usage.completion_tokens ?? 0)}</td>
<td>${fmtInt(cached)}</td>
<td>${tf.tokens_per_second != null ? fmtNum(Number(tf.tokens_per_second)) : "-"}</td>
<td>${tf.time_to_first_token != null ? fmtMs(Number(tf.time_to_first_token) * 1000) : "-"}</td>
<td>${spec.rounds != null ? fmtInt(spec.rounds) : "-"}</td>
<td>${acceptRate != null ? fmtPct(acceptRate) : "-"}</td>
</tr>`;
				})
				.join("")}</tbody></table></div></details>`
		: "";

	return `<section id="bench-dashboard">
<div class="bench-head">
<div class="bench-title">⚑ ${esc(run?.modelLabel ?? "benchmark run")} <span class="bench-badge ${badge}">${esc(outcome)}</span></div>
<div class="bench-meta">${run ? `started ${esc(fmtTime(run.startedAt))} · ended ${esc(fmtTime(endedLabel))} · <strong>${esc(durationMs !== undefined ? fmtMs(durationMs) : "?")}</strong>` : "run marker not found in the session copy - showing whole-session stats"} · ${esc(workDir)}</div>
${linksHtml}
</div>
<div class="bench-cards">${cards.join("")}</div>
<div class="bench-panels">
<div class="bench-panel"><h3>🛠 Tools</h3>${toolTable}${skillsHtml}</div>
<div class="bench-panel"><h3>⚡ llama-swap</h3>${kvHtml}${reqTable}</div>
</div>
</section>`;
}

const DASHBOARD_CSS = `
#bench-dashboard{--bench-border:var(--border-color,#30363d);font-size:14px;margin:0 0 20px;padding:16px 18px;border:1px solid var(--bench-border);border-radius:12px;background:var(--bg-secondary,#161b22)}
#bench-dashboard .bench-head{margin-bottom:12px}
#bench-dashboard .bench-title{font-size:18px;font-weight:700}
#bench-dashboard .bench-badge{display:inline-block;border-radius:10px;padding:1px 9px;font-size:12px;font-weight:600;margin-left:6px;vertical-align:middle}
#bench-dashboard .bench-ok{color:#3fb950;background:rgba(63,185,80,.13);border:1px solid rgba(63,185,80,.4)}
#bench-dashboard .bench-warn{color:#d29922;background:rgba(210,153,34,.13);border:1px solid rgba(210,153,34,.4)}
#bench-dashboard .bench-bad{color:#f85149;background:rgba(248,81,73,.13);border:1px solid rgba(248,81,73,.4)}
#bench-dashboard .bench-meta{color:var(--text-muted,#8b949e);font-size:12.5px;margin-top:4px;word-break:break-all}
#bench-dashboard .bench-links{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
#bench-dashboard .bench-links a{border:1px solid var(--bench-border);border-radius:7px;padding:2px 10px;font-size:12.5px;text-decoration:none}
#bench-dashboard .bench-links a:hover{border-color:#58a6ff}
#bench-dashboard .bench-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(165px,1fr));gap:9px;margin:12px 0}
#bench-dashboard .bench-card{border:1px solid var(--bench-border);border-radius:10px;padding:9px 11px;background:var(--bg-primary,#0d1117);min-width:0}
#bench-dashboard .bench-card-label{font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted,#8b949e)}
#bench-dashboard .bench-card-value{font-size:18px;font-weight:700;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
#bench-dashboard .bench-card-value.bench-ok{color:#3fb950}
#bench-dashboard .bench-card-value.bench-warn{color:#d29922}
#bench-dashboard .bench-card-value.bench-bad{color:#f85149}
#bench-dashboard .bench-card-sub{font-size:11px;color:var(--text-muted,#8b949e);overflow-wrap:anywhere}
#bench-dashboard .bench-panels{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:12px}
#bench-dashboard .bench-panel{border:1px solid var(--bench-border);border-radius:10px;padding:10px 14px;background:var(--bg-primary,#0d1117);min-width:0}
#bench-dashboard .bench-panel h3{margin:0 0 8px;font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted,#8b949e)}
#bench-dashboard .bench-table{border-collapse:collapse;width:100%;font-size:12.5px}
#bench-dashboard .bench-table th,#bench-dashboard .bench-table td{padding:4px 8px;border-bottom:1px solid var(--bench-border);text-align:left}
#bench-dashboard .bench-table th{font-size:10.5px;text-transform:uppercase;color:var(--text-muted,#8b949e)}
#bench-dashboard .bench-table td:nth-child(n+2),#bench-dashboard .bench-table th:nth-child(n+2){text-align:right;font-variant-numeric:tabular-nums}
#bench-dashboard .bench-warn{color:#d29922}
#bench-dashboard .bench-bar{height:8px;border-radius:4px;background:linear-gradient(90deg,#1f6feb,#58a6ff);min-width:3px;margin-left:auto}
#bench-dashboard .bench-chips{margin-top:8px;display:flex;flex-wrap:wrap;gap:6px}
#bench-dashboard .bench-chip{border:1px solid var(--bench-border);border-radius:12px;padding:1px 9px;font-size:12px}
#bench-dashboard .bench-dim{color:var(--text-muted,#8b949e)}
#bench-dashboard .bench-kv{display:grid;grid-template-columns:max-content 1fr;gap:2px 12px;font-size:12.5px}
#bench-dashboard .bench-kv-k{color:var(--text-muted,#8b949e)}
#bench-dashboard .bench-kv-v{font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
#bench-dashboard .bench-requests{margin-top:8px}
#bench-dashboard .bench-scrollx{overflow-x:auto}
@media (max-width:760px){#bench-dashboard .bench-panels{grid-template-columns:1fr}}
`;

/** Insert the dashboard + its CSS into the exported HTML page. */
function injectDashboard(html: string, dashboard: string, title: string): string {
	const block = `<style>${DASHBOARD_CSS}</style>\n${dashboard}\n`;
	// Preferred anchor: top of the exporter's main content area (before the
	// JS-populated #header-container, so the exporter never touches our nodes).
	const anchor = "<main id=\"content\">";
	let out = html.includes(anchor) ? html.replace(anchor, `${anchor}\n${block}`) : "";
	if (!out) {
		// Fallback for template changes: before </body>.
		out = html.includes("</body>") ? html.replace("</body>", `${block}\n</body>`) : `${html}\n${block}`;
	}
	// Better browser-tab title when the run has a session name.
	if (title) out = out.replace(/<title>[^<]*<\/title>/, `<title>${esc(title)}</title>`);
	return out;
}

// ---------------------------------------------------------------------------
// Filesystem glue
// ---------------------------------------------------------------------------

/**
 * Generate `report.html` in a benchmark working directory from its session
 * copy. Reads `session-*.jsonl` (latest first), computes run-scoped stats,
 * exports the chat with pi's built-in HTML exporter (with llama-swap usage
 * lines), and injects the benchmark dashboard. Throws when no session copy
 * exists (the benchmark extension copies the session before calling this).
 */
export async function generateReport(workDir: string): Promise<string> {
	if (!existsSync(workDir)) throw new Error(`working directory not found: ${workDir}`);
	const copies = readdirSync(workDir)
		.filter((f) => /^session-.*\.jsonl$/.test(f))
		.sort((a, b) => statSync(join(workDir, b)).mtimeMs - statSync(join(workDir, a)).mtimeMs);
	if (copies.length === 0) throw new Error(`no session-*.jsonl copy in ${workDir} - cannot generate report`);
	const sessionCopyName = copies[0];

	const rawLines = readFileSync(join(workDir, sessionCopyName), "utf8")
		.split("\n")
		.filter((l) => l.trim());
	const entries: JsonlEntry[] = rawLines.map((l) => JSON.parse(l) as JsonlEntry);

	// The run marker for this directory (fall back to the last marker of any
	// directory - resumed sessions may point at an older copy).
	const markers: BenchmarkRunData[] = [];
	let sessionName: string | undefined;
	for (const e of entries) {
		if (e.type === "custom" && e.customType === "benchmark-run" && e.data) {
			markers.push(e.data as BenchmarkRunData);
		} else if (e.type === "session_info") {
			const d = e as { name?: string; data?: { name?: string } };
			sessionName = d.name ?? d.data?.name ?? sessionName;
		}
	}
	const matching = markers.filter((m) => {
		try {
			return resolve(m.workDir) === resolve(workDir);
		} catch {
			return false;
		}
	});
	let run = matching.length > 0 ? matching[matching.length - 1] : markers.length > 0 ? markers[markers.length - 1] : undefined;
	// Newest-first contextWindow: the done marker's value wins; if it lacks one
	// (e.g. no model selected at run end), fall back to the running marker's.
	if (run && run.contextWindow === undefined) {
		for (const m of [...(matching.length > 0 ? matching : markers)].reverse()) {
			if (m.contextWindow !== undefined) {
				run = { ...run, contextWindow: m.contextWindow };
				break;
			}
		}
	}

	// Scope stats to the run's time window when the marker is available.
	const startMs = run ? Date.parse(run.startedAt) - 5000 : -Infinity;
	const endMs = run?.endedAt ? Date.parse(run.endedAt) + 5000 : Infinity;
	const inWindow = (e: JsonlEntry): boolean => {
		const at = entryTime(e);
		if (!Number.isFinite(at)) return true; // keep undated entries (they self-scope via records)
		return at >= startMs && at <= endMs;
	};
	const windowed = entries.filter(inWindow);

	// Last activity in the window (entries + usage records) - used to estimate
	// end time/duration when the run marker lacks endedAt/durationMs.
	let lastActivityMs: number | undefined;
	for (const e of windowed) {
		const at = entryTime(e);
		if (Number.isFinite(at) && (lastActivityMs === undefined || at > lastActivityMs)) lastActivityMs = at;
	}

	const toolStats = collectToolStats(windowed as never);
	const usageRecords = collectUsageRecords(windowed as never).filter((r) => {
		const at = Number.isFinite(r.ts) ? r.ts : (r.record as { capturedAt?: number }).capturedAt ?? 0;
		if (Number.isFinite(at) && (lastActivityMs === undefined || at > lastActivityMs)) lastActivityMs = at;
		return at >= startMs && at <= endMs;
	});
	const llamaSwap = computeStats(usageRecords);

	let assistantCount = 0;
	let userCount = 0;
	let lastContextTokens: number | undefined;
	let cost = 0;
	let sumInput = 0;
	let sumOutput = 0;
	let sumReasoning = 0;
	let sumCacheRead = 0;
	let sumCacheWrite = 0;
	for (const e of windowed) {
		if (e.type !== "message" || !e.message) continue;
		if (e.message.role === "assistant") {
			assistantCount += 1;
			const u = e.message.usage;
			if (u?.totalTokens !== undefined) lastContextTokens = u.totalTokens;
			cost += u?.cost?.total ?? 0;
			sumInput += u?.input ?? 0;
			sumOutput += u?.output ?? 0;
			sumReasoning += u?.reasoning ?? 0;
			sumCacheRead += u?.cacheRead ?? 0;
			sumCacheWrite += u?.cacheWrite ?? 0;
		} else if (e.message.role === "user") {
			userCount += 1;
		}
	}

	// Chat via pi's built-in exporter, through the /export-with-stats path
	// (rewrites llama-swap-usage custom entries into visible custom messages).
	const tmpFile = join(tmpdir(), `bench-report-${process.pid}-${Date.now()}.jsonl`);
	writeFileSync(tmpFile, toExportableSessionLines(rawLines).join("\n"), "utf8");
	try {
		const exportFromFile = await loadExportFromFile();
		await exportFromFile(tmpFile, { outputPath: join(workDir, "report.html") });
	} finally {
		try {
			unlinkSync(tmpFile);
		} catch {
			// ignore
		}
	}

	const reportPath = join(workDir, "report.html");
	const html = readFileSync(reportPath, "utf8");
	const dashboard = dashboardHtml(
		run,
		{ toolStats, llamaSwap, usageRecords, assistantCount, userCount, lastContextTokens, cost, sumInput, sumOutput, sumReasoning, sumCacheRead, sumCacheWrite, lastActivityMs },
		workDir,
		sessionCopyName,
		sessionName,
	);
	writeFileSync(reportPath, injectDashboard(html, dashboard, sessionName ?? ""));
	return reportPath;
}
