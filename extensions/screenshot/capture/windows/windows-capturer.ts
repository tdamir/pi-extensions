import { readFile } from "node:fs/promises";

import { defaultSavePath } from "../../temp-files";
import type {
	CapturedImage,
	CaptureTarget,
	DesktopCaptureOptions,
	ScreenCapturer,
	WindowCaptureOptions,
} from "../../types";
import { DEFAULT_MAX_WIDTH } from "../../types";
import { runPowerShell } from "./powershell";
import {
	buildDesktopCaptureScript,
	buildListWindowsScript,
	buildWindowCaptureScript,
	type CaptureParams,
} from "./scripts";

interface PsWindowRef {
	pid: number;
	title: string;
	width?: number;
	height?: number;
}

interface PsSuccess {
	ok: true;
	width: number;
	height: number;
	path: string;
	title?: string;
	pid?: number;
	note?: string;
}

interface PsFailure {
	ok: false;
	error: string;
	windows?: PsWindowRef[];
}

type PsResult = PsSuccess | PsFailure;

function parseJsonOutput(stdout: string): unknown {
	const trimmed = stdout.trim();
	if (!trimmed) throw new Error("PowerShell produced no output.");
	try {
		return JSON.parse(trimmed);
	} catch {
		throw new Error(`PowerShell produced unexpected output: ${trimmed.slice(0, 200)}`);
	}
}

function formatWindowList(windows: PsWindowRef[] | undefined): string {
	if (!windows?.length) return "  (none)";
	return windows
		.map((w) => {
			const size = w.width ? `  ${w.width}x${w.height}` : "";
			const title = w.title.length > 60 ? `${w.title.slice(0, 57)}...` : w.title;
			return `  pid=${w.pid}${size}  "${title}"`;
		})
		.join("\n");
}

/** Turn a PowerShell failure payload into an error the model can act on. */
function toCaptureError(result: PsFailure): Error {
	if (result.error === "notfound") {
		return new Error(`No matching window found. Capturable windows:\n${formatWindowList(result.windows)}`);
	}
	if (result.error === "multiple") {
		return new Error(
			`The title matches several windows. Capture by pid or use a more specific title:\n${formatWindowList(result.windows)}`,
		);
	}
	return new Error(result.error);
}

/**
 * Windows capture backend. Zero npm dependencies: uses Windows PowerShell 5.1
 * with .NET System.Drawing (CopyFromScreen for monitors, PrintWindow for windows)
 * via P/Invoke. One short-lived powershell.exe process per operation.
 */
export class WindowsCapturer implements ScreenCapturer {
	readonly platform = "win32" as const;

	async listTargets(): Promise<CaptureTarget[]> {
		const parsed = parseJsonOutput(await runPowerShell(buildListWindowsScript()));
		if (!Array.isArray(parsed)) {
			throw toCaptureError(parsed as PsFailure);
		}
		const entries = parsed as Array<Record<string, unknown>>;
		return entries.map((entry) => ({
			pid: Number(entry.pid ?? 0),
			title: String(entry.title ?? ""),
			processName: String(entry.process ?? ""),
			width: Number(entry.width ?? 0),
			height: Number(entry.height ?? 0),
		}));
	}

	async captureDesktop(options: DesktopCaptureOptions): Promise<CapturedImage> {
		const params: CaptureParams = {
			monitor: options.monitor ?? -1,
			title: "",
			pid: 0,
			maxWidth: options.maxWidth ?? DEFAULT_MAX_WIDTH,
			outPath: options.savePath ?? defaultSavePath("desktop"),
		};
		return this.runCapture(buildDesktopCaptureScript(params), params.outPath);
	}

	async captureWindow(options: WindowCaptureOptions): Promise<CapturedImage> {
		if (!options.title && !options.pid) {
			throw new Error("Capturing a window requires 'title' or 'pid'.");
		}
		const params: CaptureParams = {
			monitor: -1,
			title: options.title ?? "",
			pid: options.pid ?? 0,
			maxWidth: options.maxWidth ?? DEFAULT_MAX_WIDTH,
			outPath: options.savePath ?? defaultSavePath("window"),
		};
		return this.runCapture(buildWindowCaptureScript(params), params.outPath);
	}

	private async runCapture(script: string, savePath: string): Promise<CapturedImage> {
		const result = parseJsonOutput(await runPowerShell(script)) as PsResult;
		if (!result.ok) throw toCaptureError(result);
		const file = await readFile(savePath);
		return {
			filePath: savePath,
			width: result.width,
			height: result.height,
			base64: file.toString("base64"),
			mimeType: "image/png",
			title: result.title,
			pid: result.pid,
			note: result.note,
		};
	}
}
