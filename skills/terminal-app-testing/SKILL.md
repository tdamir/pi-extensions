---
name: terminal-app-testing
description: Drive terminal applications on Windows from the agent — open a new PowerShell/cmd/WSL/Windows Terminal session, send keystrokes, and screenshot the window to verify CLI or TUI output. Also covers testing pi extensions (driving slash commands through pi's RPC mode, rendering pi-tui components headlessly). Use when you need to run an interactive command that requires keystrokes, verify a terminal UI visually, screenshot a terminal window, or test a pi extension's command and UI. Window driving requires Windows; the pi RPC and render-harness scripts work on any OS.
compatibility: Windows (Windows Terminal or conhost) for launching, sending keys, and screenshots. Node.js >= 22 for the pi harness scripts. RPC mode needs a pi install (~/.pi/agent/bin/pi-launcher.js) and a configured model.
---

# Terminal app testing

Everything here drives a real terminal window: launch it, send keys, screenshot
it. The same three primitives cover plain shells, SSH sessions, and full-screen
TUIs. The pi-specific sections at the end add faster, deterministic checks for
extensions (RPC mode, component render harness).

Scripts live in `scripts/` relative to this skill directory. Run PowerShell
scripts with `powershell -NoProfile -File <script> ...`.

> **Git Bash:** prefix any call whose arguments start with `/` with
> `MSYS_NO_PATHCONV=1`, otherwise MSYS rewrites them into Windows paths
> (`/commit-message` → `C:/Program Files/Git/commit-message`).

## 1. Launch a terminal and get its window pid

```powershell
powershell -NoProfile -File "<skill-dir>/scripts/launch-terminal.ps1" -Command "ls" -Shell powershell
# → 9424 term-test-2751bf55
```

- `-Shell powershell|pwsh|cmd|wsl|bash` (default `powershell`)
- `-NewWindow` — force a separate Windows Terminal window instead of a tab
  (uses `wt -w -1 --title <marker>`, so the title is set by Windows Terminal
  rather than by the shell)
- `-TimeoutMs` — how long to wait for the window (default 20000)
- `-DryRun` — print the command line instead of launching it

The script injects a unique title marker, starts the shell with
`-NoExit`/`/k`, then polls visible windows until the marker shows up and prints
`<pid> <title>`. That pid is what `send-keys.ps1` and the `screenshot` tool need.
Windows Terminal reuses a single window and opens a tab, so matching by the
unique title (not by a new window handle) is what makes this reliable.

For `bash`/`wsl` the shell is re-entered with `--norc`: a bashrc that sets the
window title in `PROMPT_COMMAND` would otherwise overwrite the marker before it
can be found. The marker title is only used during launch, so the app replacing
it later (pi sets `π - <cwd>`) is harmless.

**Multiple Windows Terminal windows share one pid.** If you opened windows with
`-NewWindow`, `screenshot -pid` becomes ambiguous — capture by the unique title
instead (`windowTitle`), and send keys by title too. Keep the title the script
printed.

## 2. Send keystrokes

```powershell
powershell -NoProfile -File "<skill-dir>/scripts/send-keys.ps1" -ProcessId 9424 -Keys "ls,{ENTER}"
# → sent 2 key sequence(s)
```

`-Keys` is one comma-separated string; each part is sent separately with a delay
(600 ms, `-DelayMs`), so `text,{ENTER}` lands as text followed by Enter. A
literal comma cannot be typed with this helper.

SendKeys syntax: literal text plus `{ENTER}` `{ESC}` `{TAB}` `{UP}` `{DOWN}`
`{PGUP}` `{PGDN}` `{HOME}` `{END}`, `^` for Ctrl (`^u`, `^d`, `^c`), `+` for
Shift, `%` for Alt. Use `-WindowTitle` instead of `-ProcessId` if you prefer
matching the title.

## 3. Screenshot the window

Use the `screenshot` tool with `target: "window"` and the pid. Then read it with
`analyze_image` when you only need a textual answer (keeps images out of the
session). For text output, the screenshot plus `analyze_image` is usually enough;
you rarely need OCR.

## Recipes

```powershell
# PowerShell: run ls, keep the shell open
powershell -NoProfile -File launch-terminal.ps1 -Command "ls" -Shell powershell

# Dedicated window instead of a tab (Windows Terminal windows share one pid, so
# capture and send keys by the title the script printed)
powershell -NoProfile -File launch-terminal.ps1 -Command "Get-Date" -Shell pwsh -NewWindow

# cmd: dir, then send a command
powershell -NoProfile -File launch-terminal.ps1 -Command "cd /d C:\Windows" -Shell cmd
powershell -NoProfile -File send-keys.ps1 -ProcessId <pid> -Keys "dir,{ENTER}"

# Interactive CLI that prompts for input
powershell -NoProfile -File launch-terminal.ps1 -Command "python -i" -Shell cmd
powershell -NoProfile -File send-keys.ps1 -ProcessId <pid> -Keys "print(2+2),{ENTER}"

# Full-screen TUI: screenshot after it settles
powershell -NoProfile -File launch-terminal.ps1 -Command "vim C:\Windows\win.ini" -Shell cmd
# screenshot -pid <pid>, then send "{ESC},:q!,{ENTER}" to quit
```

## 4. Test pi extensions

### Drive a slash command through RPC mode

RPC mode runs the real session, so extension commands execute exactly as in the
TUI (`prompt` with `/name args` is dispatched to `registerCommand`, not to the
agent). Custom components are **not** available (`ctx.ui.custom()` returns
`undefined`), but `notify`, `setStatus`, `setWidget`, `appendEntry`, and the
dialog methods (`editor`, `confirm`, `select`, `input`) all work and are
forwarded as JSON.

```bash
node "<skill-dir>/scripts/rpc-drive.mjs" "/my-command args" \
  --cwd . -e ./extensions/my-extension.ts \
  --model "gx10/DeepSeek-V4.1-Flash-1017"
```

- polls `get_commands` until the command is registered, then sends the prompt
  (sending it immediately after spawn is a race — it can reach the session before
  extensions bind and be treated as a normal user message)
- prints every `notify`, `setStatus`, `setWidget`, `entry_appended`, and dialog
  request, and answers dialogs automatically (`--dialog accept|cancel|value:<text>`,
  `--confirm yes|no`) so `ctx.ui.editor()` flows can be tested end to end
- exit `0` = handled by the command, `2` = fell through to the agent (wrong or
  unregistered name), `3` = timeout, `4` = command never registered, `66` = bad
  invocation (e.g. missing cwd)

Flags: `--timeout 240` (model calls can be slow), `--json`, `--settle 1500`
(keep listening after the response for async work), `--pi <path>`.
`--no-session` is always used so runs do not pollute the session list; use a
scratch git repo when the command mutates state (e.g. commits).

### Render pi-tui components headlessly

```bash
node "<skill-dir>/scripts/render-harness.mjs" \
  --module ./extensions/commit-message.ts --export CommitMessagePopup \
  --args '["main • 2 changed file(s)"]' \
  --width 80 --rows 40 --keys "down,pageDown,end"
```

Imports the extension's `.ts` directly (Node >= 22 type stripping, so **erasable
syntax only**: no `enum`, no `namespace`, no constructor parameter properties).
Constructs `new Export(fakeTui, plainTheme, ...args, done)` — the trailing `done`
recording callback is appended automatically and printed at the end — renders at
each `--width`, flags lines wider than the viewport, and feeds `--keys` between
renders. For other constructor signatures, import the helpers
(`fakeTui`, `plainTheme`, `render`, `assertWidth`, `sendKeys`).

Why this catches real bugs: pi-tui requires every rendered line to fit the
viewport width (`visibleWidth`, `truncateToWidth`, `wrapTextWithAnsi`); widget
string arrays are capped at **10 lines** by pi, while a scrollable
`ctx.ui.custom()` overlay is not.

### Drive a pi extension in the real TUI

Needed for overlays, focus, and mouse behavior. Launch pi through the same
launcher, then send keys and screenshot:

```powershell
powershell -NoProfile -File launch-terminal.ps1 -Shell cmd `
  -Command "cd /d D:\repo && pi -e .\extensions\my-extension.ts --model gx10/DeepSeek-V4.1-Flash-1017"
# → <pid> term-test-xxxx  (pi replaces the title with "π - <cwd>" shortly after)
powershell -NoProfile -File send-keys.ps1 -ProcessId <pid> -Keys "/my-command,{ENTER}"
```

Then `screenshot` with the pid. `{ESC}` closes an overlay, `^u` clears the
editor, `^d` exits pi, `exit{ENTER}` closes the tab.

## Pitfalls

- **Activation delay:** `AppActivate` needs ~0.5–1 s before `SendKeys`, or keys go
  to the previously focused window. Both scripts handle this; raise `-SettleMs`
  if a busy machine misses keystrokes.
- **Model/app startup latency:** after launching pi, wait for the UI to render
  before sending keys; llama-swap may load a model for tens of seconds. Screenshot
  and re-screenshot rather than assuming a fixed wait.
- **Unique titles:** the launch script's marker is what makes window lookup
  deterministic. Apps that overwrite the title (pi sets `π - <cwd>`) are fine —
  the marker is only needed during launch.
- **Do not reuse the user's own terminal tab.** Close the tab you opened
  (`exit{ENTER}`) and verify with `list_windows` that their window is back.
- **Screenshots of the desktop vs window:** prefer `target: "window"` with the
  pid; it avoids capturing unrelated windows and keeps the payload small.
- For raw ANSI debugging in pi, set `PI_TUI_WRITE_LOG` (see `docs/tui.md`).
