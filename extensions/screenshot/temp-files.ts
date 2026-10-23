import { mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** PNGs older than this are swept on the first capture of a process. */
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

let tempDir: string | undefined;
let swept = false;

/** Best-effort sweep of old screenshots; never throws. */
function sweepOldScreenshots(dir: string): void {
	try {
		const cutoff = Date.now() - RETENTION_MS;
		for (const entry of readdirSync(dir)) {
			if (!entry.endsWith(".png")) continue;
			try {
				if (statSync(path.join(dir, entry)).mtimeMs < cutoff) unlinkSync(path.join(dir, entry));
			} catch {
				// ignore individual file errors
			}
		}
	} catch {
		// ignore directory errors
	}
}

/** Directory screenshots go to unless the caller provides an explicit savePath. */
export function screenshotTempDir(): string {
	if (tempDir === undefined) {
		tempDir = path.join(tmpdir(), "pi-screenshots");
		mkdirSync(tempDir, { recursive: true });
	}
	if (!swept) {
		swept = true;
		sweepOldScreenshots(tempDir);
	}
	return tempDir;
}

/** Timestamped, collision-safe path for a new screenshot. */
export function defaultSavePath(prefix: string): string {
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const rand = Math.random().toString(36).slice(2, 8);
	return path.join(screenshotTempDir(), `${prefix}-${stamp}-${rand}.png`);
}
