#!/usr/bin/env node
/**
 * Render a pi-tui component without a terminal and check it against pi-tui's rules.
 *
 * CLI (component signature `(tui, theme, ...args)`):
 *   node render-harness.mjs --module ./extensions/x.ts --export MyPopup \
 *     --args '["subtitle"]' --width 80 --rows 40 --keys "down,pageDown,end"
 *
 * Library:
 *   import { fakeTui, plainTheme, render, assertWidth, sendKeys } from "./render-harness.mjs";
 *
 * Node >= 22 imports .ts directly, but only erasable syntax works: no enums,
 * namespaces, or constructor parameter properties.
 */

import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

/** Theme stub that strips styling so output can be measured and read. */
export const plainTheme = {
	fg: (_color, text) => text,
	bg: (_color, text) => text,
	bold: (text) => text,
	style: (text) => text,
	colors: {},
	appearance: "dark",
};

/** Minimal TUI stub: layout code only needs terminal size and requestRender(). */
export function fakeTui(rows = 40, columns = 120) {
	return {
		terminal: { rows, columns },
		mode: "regular",
		requestRender() {},
		setFocus() {},
		renderNow() {},
	};
}

/** Render a component and strip ANSI so width checks reflect visible columns. */
export function render(component, width) {
	return component.render(width).map((line) => line.replace(ANSI, ""));
}

/** Lines that exceed the viewport width — pi-tui requires none. */
export function assertWidth(lines, width) {
	return lines.filter((line) => visibleWidth(line) > width);
}

const KEYS = {
	up: "\x1b[A",
	down: "\x1b[B",
	right: "\x1b[C",
	left: "\x1b[D",
	home: "\x1b[H",
	end: "\x1b[F",
	pageup: "\x1b[5~",
	pagedown: "\x1b[6~",
	enter: "\r",
	esc: "\x1b",
	escape: "\x1b",
	tab: "\t",
	space: " ",
};

/** Feed a comma-separated key list ("down,pageDown,esc" or "a,b,c") to handleInput. */
export function sendKeys(component, keys) {
	for (const raw of keys.split(",")) {
		const key = raw.trim();
		if (!key) continue;
		component.handleInput?.(KEYS[key.toLowerCase()] ?? key);
	}
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function usage() {
	console.error(`Usage: node render-harness.mjs --module <file.ts> --export <Name> [options]

Options:
  --args <json array>   extra constructor args after (tui, theme) (default [])
  --width <n[,n...]>    widths to render at (default 80)
  --rows <n>            fake terminal rows (default 40)
  --keys <list>         keys to send between renders, comma separated
  --keys-after <n>      render, send keys, render again (default: after every width)
  --raw                 keep ANSI escape codes in the output
  -h, --help            this help`);
	process.exit(64);
}

function parseCli(argv) {
	const opts = { args: [], widths: [80], rows: 40, keys: undefined, raw: false };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const next = () => {
			const v = argv[++i];
			if (v === undefined) usage();
			return v;
		};
		switch (a) {
			case "--module": opts.module = resolve(next()); break;
			case "--export": opts.exportName = next(); break;
			case "--args": opts.args = JSON.parse(next()); break;
			case "--width": opts.widths = next().split(",").map(Number); break;
			case "--rows": opts.rows = Number(next()); break;
			case "--keys": opts.keys = next(); break;
			case "--raw": opts.raw = true; break;
			case "-h":
			case "--help": usage(); break;
			default: usage();
		}
	}
	if (!opts.module || !opts.exportName) usage();
	return opts;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
	const opts = parseCli(process.argv.slice(2));
	const mod = await import(pathToFileURL(opts.module).href);
	const Component = mod[opts.exportName];
	if (typeof Component !== "function") {
		console.error(`Export "${opts.exportName}" is not a constructor in ${opts.module}`);
		process.exit(65);
	}

	const tui = fakeTui(opts.rows);
	// The recording callback is appended as the last constructor argument, which
	// matches components that end in a `done(result)` callback; others ignore it.
	const doneCalls = [];
	const done = (result) => doneCalls.push(result);
	const component = new Component(tui, plainTheme, ...opts.args, done);
	let failed = false;

	for (const width of opts.widths) {
		const lines = render(component, width);
		console.log(`\n=== width ${width}, rows ${opts.rows}: ${lines.length} lines ===`);
		for (const line of opts.raw ? component.render(width) : lines) console.log(`|${line}`);
		const over = assertWidth(lines, width);
		if (over.length > 0) {
			failed = true;
			console.log(`\n!! ${over.length} line(s) exceed width ${width}`);
			for (const line of over.slice(0, 3)) console.log(`   ${JSON.stringify(line)}`);
		}
		if (opts.keys) {
			sendKeys(component, opts.keys);
			const after = render(component, width);
			console.log(`\n--- after keys "${opts.keys}": ${after.length} lines ---`);
			for (const line of after) console.log(`|${line}`);
			const overAfter = assertWidth(after, width);
			if (overAfter.length > 0) {
				failed = true;
				console.log(`!! ${overAfter.length} line(s) exceed width ${width} after keys`);
			}
		}
	}

	console.log(`\ndone() calls: ${JSON.stringify(doneCalls)}`);
	process.exit(failed ? 1 : 0);
}
