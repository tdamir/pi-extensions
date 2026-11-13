/**
 * Screenshot extension.
 *
 * Tools:
 * - `screenshot`    — capture the desktop (all monitors or one) or a specific window;
 *                     returns the image to the model and saves a PNG.
 * - `list_windows`  — list capturable windows (title, pid, process, size) so the
 *                     model can pick a target for `screenshot`.
 *
 * Command:
 * - `/screenshot`   — manual capture; saves to a file and notifies with the path.
 *
 * Platform backends live in `capture/<platform>/` behind the `ScreenCapturer`
 * interface (see platform.ts). Windows is implemented; Linux is stubbed.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { getCapturer } from "./platform";
import { DEFAULT_MAX_WIDTH } from "./types";
import type { CapturedImage, CaptureTarget, ScreenCapturer } from "./types";

interface ScreenshotDetails {
	target: "desktop" | "window";
	monitor?: number;
	filePath: string;
	width: number;
	height: number;
	pid?: number;
	title?: string;
}

interface ListWindowsDetails {
	windows: CaptureTarget[];
}

const ScreenshotParams = Type.Object({
	target: Type.Unsafe<"desktop" | "window">({
		type: "string",
		enum: ["desktop", "window"],
		description:
			'"desktop" captures the whole virtual desktop (all monitors combined) or one monitor via "monitor"; "window" captures a specific application window.',
	}),
	monitor: Type.Optional(
		Type.Number({
			description:
				'For target "desktop": 0-based index of a single monitor to capture. Omit to capture all monitors combined.',
		}),
	),
	windowTitle: Type.Optional(
		Type.String({
			description:
				'For target "window": case-insensitive substring of the window title. Omit if "pid" is given. Call list_windows first to find candidates.',
		}),
	),
	pid: Type.Optional(
		Type.Number({
			description: 'For target "window": process id of the window to capture (preferred over "windowTitle").',
		}),
	),
	maxWidth: Type.Optional(
		Type.Number({
			description: `Downscale the image to at most this width in pixels (default ${DEFAULT_MAX_WIDTH}). Use 0 for the original size.`,
		}),
	),
	savePath: Type.Optional(
		Type.String({ description: "Absolute path to save the PNG to. Defaults to a timestamped temp file." }),
	),
});

const ListWindowsParams = Type.Object({});

/** Tokenize command args, respecting double-quoted strings. */
function tokenize(args: string): string[] {
	const tokens: string[] = [];
	for (const match of args.matchAll(/"([^"]*)"|(\S+)/g)) {
		tokens.push(match[1] ?? match[2]);
	}
	return tokens;
}

function looksLikePath(token: string): boolean {
	return /[\\/]/.test(token) || /\.png$/i.test(token);
}

type CommandTarget =
	| { target: "desktop"; savePath?: string }
	| { target: "monitor"; monitor: number; savePath?: string }
	| { target: "window"; title: string; savePath?: string };

export function parseCommandArgs(args: string): CommandTarget {
	const tokens = tokenize(args);
	if (tokens.length === 0) return { target: "desktop" };

	const first = tokens[0].toLowerCase();
	const usage = 'Usage: /screenshot [desktop|monitor <index>|window "<title>"] [savePath]';

	if (first === "desktop") {
		const rest = tokens.slice(1);
		if (rest.length > 1) throw new Error(`Usage: /screenshot desktop [savePath]`);
		return { target: "desktop", savePath: rest[0] };
	}
	if (first === "monitor") {
		const monitor = Number(tokens[1]);
		if (!Number.isInteger(monitor) || monitor < 0) throw new Error(`Usage: /screenshot monitor <index> [savePath]`);
		const rest = tokens.slice(2);
		if (rest.length > 1) throw new Error(`Usage: /screenshot monitor <index> [savePath]`);
		return { target: "monitor", monitor, savePath: rest[0] };
	}
	if (first === "window") {
		const rest = tokens.slice(1);
		let savePath: string | undefined;
		if (rest.length > 0 && looksLikePath(rest[rest.length - 1])) {
			savePath = rest.pop();
		}
		const title = rest.join(" ");
		if (!title) throw new Error(`Usage: /screenshot window "<title>" [savePath]`);
		return { target: "window", title, savePath };
	}

	if (tokens.length === 1 && looksLikePath(tokens[0])) {
		return { target: "desktop", savePath: tokens[0] };
	}
	throw new Error(usage);
}

export default function screenshotExtension(pi: ExtensionAPI) {
	// Resolved lazily (and once) so unsupported platforms only fail when a tool runs.
	let capturer: ScreenCapturer | undefined;
	function backend(): ScreenCapturer {
		capturer ??= getCapturer();
		return capturer;
	}

	pi.registerTool({
		name: "screenshot",
		label: "Screenshot",
		description:
			"Take a screenshot and return it as an image (also saved as a PNG file). " +
			'target "desktop": capture the whole virtual desktop (all monitors combined), or a single monitor via "monitor" (0-based index). ' +
			'target "window": capture a specific window by "pid" (preferred) or "windowTitle" (case-insensitive substring); ' +
			"call list_windows first to find candidates. A title matching several windows fails and lists them. " +
			`Images are downscaled to "maxWidth" (default ${DEFAULT_MAX_WIDTH} px, 0 = original size) to keep payloads small.`,
		promptSnippet: "capture desktop or window screenshots",
		promptGuidelines: [
			"When the user asks you to look at their screen, a window, or verify something visual, use the screenshot tool and inspect the returned image.",
		],
		parameters: ScreenshotParams,
		annotations: { readOnlyHint: true },
		execute: async (_toolCallId, params) => {
			if (params.target === "window" && !params.windowTitle && !params.pid) {
				throw new Error('target "window" requires "windowTitle" or "pid". Call list_windows first to find candidates.');
			}
			const cap = backend();
			const maxWidth = params.maxWidth ?? DEFAULT_MAX_WIDTH;
			const image =
				params.target === "window"
					? await cap.captureWindow({
							title: params.windowTitle,
							pid: params.pid,
							maxWidth,
							savePath: params.savePath,
						})
					: await cap.captureDesktop({
							monitor: params.monitor,
							maxWidth,
							savePath: params.savePath,
						});

			const what =
				params.target === "window"
					? `window "${image.title ?? params.windowTitle ?? ""}" (pid ${image.pid ?? params.pid ?? "?"})`
					: params.monitor !== undefined
						? `monitor ${params.monitor}`
						: "the desktop (all monitors)";
			const text =
				`Captured ${image.width}x${image.height} screenshot of ${what}. Saved to ${image.filePath}` +
				(image.note ? ` Note: ${image.note}` : "");

			const details: ScreenshotDetails = {
				target: params.target,
				filePath: image.filePath,
				width: image.width,
				height: image.height,
			};
			if (params.monitor !== undefined) details.monitor = params.monitor;
			if (image.pid !== undefined) details.pid = image.pid;
			if (image.title !== undefined) details.title = image.title;

			return {
				content: [
					{ type: "text", text },
					{ type: "image", data: image.base64, mimeType: image.mimeType },
				],
				details,
			};
		},
	});

	pi.registerTool({
		name: "list_windows",
		label: "List Windows",
		description:
			"List visible, capturable top-level windows in z-order (front first) with title, pid, process name, and size. " +
			"Use it to pick a title or pid for the screenshot tool.",
		promptSnippet: "list capturable windows for the screenshot tool",
		parameters: ListWindowsParams,
		annotations: { readOnlyHint: true },
		execute: async () => {
			const targets: CaptureTarget[] = await backend().listTargets();
			const text =
				targets.length === 0
					? "No capturable windows found."
					: targets
							.map(
								(t) =>
									`pid=${t.pid}  ${t.processName || "?"}  ${t.width}x${t.height}  "${t.title.length > 80 ? `${t.title.slice(0, 77)}...` : t.title}"`,
							)
							.join("\n");
			const details: ListWindowsDetails = { windows: targets };
			return { content: [{ type: "text", text }], details };
		},
	});

	pi.registerCommand("screenshot", {
		description: 'Take a screenshot and save it as PNG (usage: /screenshot [desktop|monitor <index>|window "<title>"] [savePath])',
		getArgumentCompletions: (prefix) => {
			const options = [
				{ value: "desktop", label: "desktop", description: "Capture all monitors" },
				{ value: "monitor ", label: "monitor", description: "Capture one monitor by index" },
				{ value: "window ", label: "window", description: 'Capture a window by title' },
			];
			const p = prefix.toLowerCase();
			const matches = options.filter((o) => o.value.trim().startsWith(p) || o.value.startsWith(prefix));
			return matches.length > 0 ? matches : null;
		},
		handler: async (args, ctx) => {
			try {
				const parsed = parseCommandArgs(args);
				const cap = backend();
				const image: CapturedImage =
					parsed.target === "window"
						? await cap.captureWindow({ title: parsed.title, savePath: parsed.savePath })
						: parsed.target === "monitor"
							? await cap.captureDesktop({ monitor: parsed.monitor, savePath: parsed.savePath })
							: await cap.captureDesktop({ savePath: parsed.savePath });
				ctx.ui.notify(`Screenshot (${image.width}x${image.height}) saved to ${image.filePath}`, "info");
			} catch (err) {
				ctx.ui.notify(`Screenshot failed: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		},
	});
}
