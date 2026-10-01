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
 *
 * To benchmark several models, run /benchmark with the same requirement while each
 * model is selected, then compare the final/ folders.
 *
 * If the requirement is a path to an existing file, the file's content is used as
 * the requirement instead (so the same task file can be shared across model runs).
 *
 * Usage:
 *   /benchmark build a python CLI that converts csv to json
 *   /benchmark tasks/csv-to-cli.md
 *   /benchmark @tasks/csv-to-cli.md
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const BENCHMARKS_DIR = "benchmarks";

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
	pi.registerCommand("benchmark", {
		description:
			"Benchmark the current model: /benchmark <requirement or file with the requirement> - creates benchmarks/<model>/ with workspace/ and final/, then starts the task in this session",
		handler: async (args, ctx) => {
			// Support an "@"-prefixed file reference, e.g. /benchmark @tasks/csv-to-cli.md
			let requirement = (args?.trim() ?? "").replace(/^@/, "");
			if (!requirement) {
				ctx.ui.notify("Usage: /benchmark <requirement to build, or a file containing it>", "error");
				return;
			}

			// If the argument is an existing file, expand it: use the file's content as the requirement
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

## Rules

- Do NOT look up, browse, read, copy, or reuse anything else on the file system or in the working folder.
- If you need to create helper scripts or other files needed for completing the task, put them in ${workspaceDir} folder.
- Put ALL final deliverables in ${finalDir} folder.
- Do not create or modify anything outside this working directory.

## Skills
- Use browser-tools skill for debugging and testing, but do not use it to browse the web.

## Requirement

${requirement}
`,
			);

			// Name the session after the task and the model before starting the run
			pi.setSessionName(`${taskLabel(requirement, requirementSource)} - ${modelLabel}`);

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
			pi.sendUserMessage(taskContent);
		},
	});
}
