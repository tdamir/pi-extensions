import { spawn } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 20_000;

/** Encode a script for -EncodedCommand (base64 UTF-16LE) — immune to quoting issues. */
function encodeCommand(script: string): string {
	return Buffer.from(script, "utf16le").toString("base64");
}

export interface PowerShellOptions {
	/** Kill the script after this many milliseconds. PrintWindow can block on hung windows. */
	timeoutMs?: number;
}

/**
 * Run a Windows PowerShell script (5.1 ships with every Windows install — no
 * dependencies needed) and resolve with stdout. Rejects on non-zero exit,
 * timeout, or spawn failure; stderr is included in the error message.
 */
export function runPowerShell(script: string, options: PowerShellOptions = {}): Promise<string> {
	const { timeoutMs = DEFAULT_TIMEOUT_MS } = options;
	return new Promise((resolve, reject) => {
		const child = spawn(
			"powershell.exe",
			["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodeCommand(script)],
			{ stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
		);

		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];
		let settled = false;

		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			child.kill();
			reject(new Error(`PowerShell capture script timed out after ${timeoutMs}ms`));
		}, timeoutMs);

		child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
		child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

		child.on("error", (err) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(new Error(`Failed to start powershell.exe: ${err.message}`));
		});

		child.on("close", (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			const stdout = Buffer.concat(stdoutChunks).toString("utf8");
			const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
			if (code === 0) {
				resolve(stdout);
			} else {
				reject(new Error(`PowerShell exited with code ${code}${stderr ? `: ${stderr}` : ""}`));
			}
		});
	});
}
