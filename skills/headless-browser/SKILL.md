---
name: headless-browser
description: Run headless Chrome/Edge via puppeteer-core (installed with this package, or bundled in this skill's node_modules when installed standalone) to take screenshots, evaluate page JavaScript, or drive scripted UI interactions (click/type/keys/scroll). Use when you need to screenshot a local HTML file or web page, verify rendered output or WebGL scenes, inspect the DOM, collect console/page errors, or automate a browser flow without downloading a browser. DO NOT USE FOR interactive human-in-the-loop browsing (use browser-tools instead).
compatibility: Requires Google Chrome or Microsoft Edge installed (override with CHROME_PATH env var). Node.js on PATH. Windows, macOS, Linux.
---

# Headless browser (puppeteer-core)

All scripts live in `scripts/` relative to this skill directory and
`require('puppeteer-core')` — when installed as part of the pi-extensions
package it comes from the package root's `node_modules`; run them with plain
`node`. Browser is auto-detected (Chrome → Edge → chromium);
set `CHROME_PATH` to force a specific binary.

Run from anywhere, e.g. (replace `<skill-dir>` with this skill's directory):

```bash
node "<skill-dir>/scripts/shot.js" ./index.html --out shot.png --width 1440 --height 860
```

## Screenshot a page

`scripts/shot.js <url|file> [options]` — prints `saved <file>` plus any
page/console/network errors (exit code 1 if errors occurred).

- `--out f.png` (default shot.png), `--width N --height N`, `--full` (full page)
- `--waitfor "window.APP!==undefined"` — waitForFunction before the shot
- `--wait <ms>` — settle delay after load (default 1000; raise for animations/WebGL)
- `--no-webgl` — drop SwiftShader flags if not needed

WebGL works headless: the launcher adds `--use-gl=angle --use-angle=swiftshader
--enable-unsafe-swiftshader`, plus flags that disable background throttling so
`requestAnimationFrame` keeps running. For apps that render on demand (only on
invalidate), prefer calling their own frame/render hook via eval.js instead of
relying on time-based waits.

## Evaluate JavaScript

`scripts/eval.js <url|file> --js "<expr>"` — prints `RESULT: <json>` + errors.
The expression is awaited, so async code works: `--js "await fetch('/api').then(r=>r.json())"`.
Use `--jsfile probe.js` for longer probes (file must evaluate to a JSON-serializable value).
Handy for DOM assertions: `--js "getComputedStyle(document.querySelector('#x')).color"`.

## Scripted UI interaction

`scripts/interact.js <url|file> --script actions.json [--out final.png]`

actions.json is an array of steps:

```json
[
  { "waitForFunction": "window.ready===true" },
  { "click": "#login" },
  { "type": { "selector": "#user", "text": "admin" } },
  { "keys": "Enter" },
  { "waitForSelector": ".dashboard", "timeout": 5000 },
  { "clickText": "Settings" },
  { "keys": "Control+a" },
  { "scroll": { "x": 0, "y": 600 } },
  { "eval": "document.title" },
  { "screenshot": "after.png" }
]
```

Supported steps: `wait`, `waitForFunction`, `waitForSelector`, `click`
(selector), `clickText` (visible element containing text), `type`, `keys`
(puppeteer key names; `Mod+Key` for chords), `scroll`, `move`/`down`/`up`
(mouse drag), `eval`, `screenshot`. Each run ends with a final screenshot and
an error report.

## Writing custom scripts

For anything these three don't cover, write a one-off script and
`require('puppeteer-core')` (resolved from the package root's
`node_modules`) — e.g. copy a
snippet into a temp file and start with:

```js
const { launch, watchErrors } = require('<skill-dir>/scripts/lib.js');
const b = await launch({ width: 1280, height: 800 });
const page = await b.newPage();
const errs = watchErrors(page, []);
// ... page.goto / page.click / page.evaluate ...
await b.close();
```

`lib.js` exposes `launch(opts)` (viewport, SwiftShader + anti-throttling args,
`opts.executablePath`) and `watchErrors(page, bag)`.

## Tips

- Always pass `--waitfor` for apps with async init (module loaders, WASM) —
  `networkidle2` alone can fire before the app is ready.
- Screenshots of animating pages: add `--wait 2000+` so first paint/layout settles.
- File paths are auto-converted to `file:///` URLs; pass Windows paths directly.
- To verify "does the page load cleanly", check for `NO ERRORS` output from shot.js.
- Never point these scripts at authenticated sessions or private pages without user request.
