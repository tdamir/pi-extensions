#!/usr/bin/env node
/**
 * Drive a pi extension command through pi's RPC mode and print what it emits.
 *
 *   node rpc-drive.mjs "/my-command args" --cwd . -e ./extensions/my-extension.ts
 *
 * Sends the prompt only after the command shows up in `get_commands`, so there is
 * no startup race. Answers extension dialogs automatically so flows like
 * ctx.ui.editor() can be exercised end to end.
 *
 * Exit codes: 0 handled by the command, 2 fell through to the agent,
 * 3 timed out, 4 the command never registered.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

function usage() {
	console.error(`Usage: node rpc-drive.mjs "<message or /command args>" [options]

Options:
  --cwd <dir>            working directory for pi (default: current directory)
  -e, --extension <p>    extension file to load (repeatable)
  --model <p/m>          model to use (provider/model[:level])
  --timeout <s>          overall timeout (default 180)
  --settle <ms>          keep listening after the prompt response (default 1000)
  --dialog <policy>      editor/input/select answer: accept (default), cancel, value:<text>
  --confirm <yes|no>     answer for ctx.ui.confirm() (default yes)
  --no-wait              send the prompt immediately instead of waiting for registration
  --json                 print raw event lines instead of a readable summary
  --pi <path>            pi launcher override (default: ~/.pi/agent/bin/pi-launcher.js or pi)
  -h, --help             this help`);
	process.exit(64);
}

function parseArgs(argv) {
	const opts = {
		cwd: process.cwd(),
		extensions: [],
		model: undefined,
		timeout: 180_000,
		settle: 1_000,
		dialog: "accept",
		confirm: "yes",
		wait: true,
		json: false,
		pi: undefined,
	};
	const rest = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const next = () => {
			const v = argv[++i];
			if (v === undefined) usage();
			return v;
		};
		switch (a) {
			case "--cwd": opts.cwd = resolve(next()); break;
			case "-e":
			case "--extension": opts.extensions.push(resolve(next())); break;
			case "--model": opts.model = next(); break;
			case "--timeout": opts.timeout = Number(next()) * 1000; break;
			case "--settle": opts.settle = Number(next()); break;
			case "--dialog": opts.dialog = next(); break;
			case "--confirm": opts.confirm = next(); break;
			case "--no-wait": opts.wait = false; break;
			case "--json": opts.json = true; break;
			case "--pi": opts.pi = next(); break;
			case "-h":
			case "--help": usage(); break;
			default:
				if (a.startsWith("--")) usage();
				rest.push(a);
		}
	}
	if (rest.length === 0) usage();
	opts.message = rest.join(" ");
	return opts;
}

const opts = parseArgs(process.argv.slice(2));

if (!existsSync(opts.cwd)) {
	console.error(`--cwd does not exist: ${opts.cwd}`);
	console.error("On Windows/Git Bash, leading-slash arguments are mangled by MSYS: set");
	console.error("MSYS_NO_PATHCONV=1 and pass a Windows path (e.g. C:/Users/me/repo).");
	process.exit(66);
}

/** The command name a message targets, or undefined for a plain prompt. */
function commandName(message) {
	if (!message.startsWith("/")) return undefined;
	return message.slice(1).split(/\s+/)[0];
}

function piCommand() {
	if (opts.pi) return { file: process.execPath, args: [resolve(opts.pi)] };
	const launcher = join(homedir(), ".pi", "agent", "bin", "pi-launcher.js");
	if (existsSync(launcher)) return { file: process.execPath, args: [launcher] };
	return { file: process.platform === "win32" ? "pi.cmd" : "pi", args: [], shell: true };
}

const { file, args: launcherArgs, shell } = piCommand();
const args = [
	...launcherArgs,
	"--mode", "rpc",
	"--no-session",
	...(opts.model ? ["--model", opts.model] : []),
	...opts.extensions.flatMap((p) => ["-e", p]),
];

if (!opts.json) {
	console.log(`pi ${args.join(" ")}`);
	console.log(`cwd ${opts.cwd}\n`);
}

const child = spawn(file, args, { cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"], shell });

let buffer = "";
let registered = undefined;
let disposition = undefined;
let settled = false;
let finished = false;

const finish = (code, note) => {
	if (finished) return;
	finished = true;
	if (note) console.log(note);
	child.kill();
	process.exit(code);
};

const timer = setTimeout(
	() => finish(3, `RESULT: timeout after ${opts.timeout / 1000}s`),
	opts.timeout,
);
timer.unref?.();

const send = (obj) => child.stdin.write(JSON.stringify(obj) + "\n");

function dialogAnswer(req) {
	const policy = opts.dialog;
	if (req.method === "confirm") {
		return { type: "extension_ui_response", id: req.id, confirmed: opts.confirm === "yes" };
	}
	if (policy === "cancel") {
		return { type: "extension_ui_response", id: req.id, cancelled: true };
	}
	if (policy.startsWith("value:")) {
		return { type: "extension_ui_response", id: req.id, value: policy.slice(6) };
	}
	// accept: take the prefill / first option / empty text
	const value = req.prefill ?? req.options?.[0] ?? req.placeholder ?? "";
	return { type: "extension_ui_response", id: req.id, value };
}

function report(event) {
	if (opts.json) {
		console.log(JSON.stringify(event));
		return;
	}
	const strip = (s) => (typeof s === "string" ? s.replace(ANSI, "") : s);
	switch (event.type) {
		case "extension_ui_request": {
			const m = event.method;
			if (m === "notify") console.log(`notify[${event.notifyType ?? "info"}] ${strip(event.message)}`);
			else if (m === "setStatus") console.log(`status ${event.statusKey}=${strip(event.statusText ?? "(cleared)")}`);
			else if (m === "setWidget") {
				const lines = (event.widgetLines ?? []).map(strip);
				console.log(`widget ${event.widgetKey} (${lines.length} lines)`);
				for (const line of lines.slice(0, 12)) console.log(`  | ${line}`);
				if (lines.length > 12) console.log(`  | ... ${lines.length - 12} more`);
			} else if (m === "editor" || m === "input" || m === "select" || m === "confirm") {
				const detail = m === "editor" ? `prefill ${JSON.stringify(strip(event.prefill ?? ""))}` :
					m === "select" ? `options ${JSON.stringify(event.options)}` :
					m === "confirm" ? `message ${JSON.stringify(strip(event.message ?? ""))}` : "";
				console.log(`dialog ${m} ${detail}`);
			}
			break;
		}
		case "entry_appended":
			console.log(`entry ${event.entry.customType} ${JSON.stringify(event.entry.data ?? null)}`);
			break;
		case "agent_start":
		case "turn_start":
			console.log(`(${event.type})`);
			break;
	}
}

child.stdout.on("data", (chunk) => {
	buffer += chunk.toString();
	const lines = buffer.split("\n");
	buffer = lines.pop() ?? "";
	for (const line of lines) {
		if (!line.trim()) continue;
		let event;
		try {
			event = JSON.parse(line);
		} catch {
			continue;
		}

		if (event.type === "response" && event.command === "get_commands") {
			if (!event.success) continue;
			const names = (event.data?.commands ?? []).map((c) => c.name);
			const wanted = commandName(opts.message);
			if (!wanted || names.includes(wanted)) {
				registered = true;
				if (!opts.json) console.log(`command ${wanted ? `/${wanted} registered` : "list ready"}`);
				send({ id: "prompt", type: "prompt", message: opts.message });
			}
			continue;
		}

		if (event.type === "response" && event.command === "prompt") {
			disposition = event.data?.disposition;
			report(event);
			settled = true;
			setTimeout(() => {
				const handled = disposition === "handled";
				finish(
					handled ? 0 : 2,
					`RESULT: ${handled ? "handled by command" : `not handled (disposition: ${disposition})`}`,
				);
			}, opts.settle);
			continue;
		}

		if (event.type === "extension_ui_request" && ["editor", "input", "select", "confirm"].includes(event.method)) {
			report(event);
			child.stdin.write(JSON.stringify(dialogAnswer(event)) + "\n");
			continue;
		}

		report(event);
	}
});

child.stderr.on("data", (chunk) => process.stderr.write(chunk));

child.on("error", (err) => {
	console.error(`Failed to start pi: ${err.message}`);
	process.exit(66);
});

child.on("exit", (code) => {
	if (!settled) finish(4, `RESULT: pi exited (code ${code}) before the prompt response`);
});

// Poll for registration instead of sleeping a fixed time: the command must exist
// before the prompt is sent, otherwise it is treated as a normal user message.
function poll() {
	if (finished || registered) return;
	send({ id: "commands", type: "get_commands" });
	setTimeout(poll, 500);
}

if (opts.wait) {
	setTimeout(poll, 800);
	setTimeout(() => {
		if (!registered && !settled) {
			finish(4, `RESULT: command ${commandName(opts.message) ?? "(none)"} was not registered within 20s`);
		}
	}, 20_000);
} else {
	setTimeout(() => send({ id: "prompt", type: "prompt", message: opts.message }), 800);
}
