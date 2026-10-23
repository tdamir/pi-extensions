# screenshot

Adds screen capture to pi:

- `screenshot` tool — captures the desktop (all monitors combined, or one monitor) or a
  specific application window. Returns the image to the model so it can see the screen,
  and saves the PNG to disk (temp directory by default, or `savePath`).
- `list_windows` tool — lists visible, capturable top-level windows (title, pid, process
  name, size) in z-order so the model can pick a target.
- `/screenshot` command — manual capture: `/screenshot [desktop|monitor <index>|window "<title>"] [savePath]`.
  Saves to a file and shows the path.

## Platform support

| Platform | Status |
| --- | --- |
| Windows | Implemented — zero dependencies (Windows PowerShell 5.1 + .NET `System.Drawing`, P/Invoke) |
| Linux | Planned — stubbed with the same interface |

### Windows implementation notes

- Desktop/monitor: `Graphics.CopyFromScreen` on the virtual screen or per-monitor bounds,
  with `SetProcessDPIAware()` so dimensions are physical pixels.
- Window: `PrintWindow` with `PW_RENDERFULLCONTENT` — works for occluded windows and
  Chromium/Electron apps. Falls back to plain `PrintWindow`, then to a screen-region copy
  for GPU-composited windows that ignore `WM_PRINT` (the tool result notes when this happens).
- Minimized windows are rejected instead of captured blank.
- Each operation runs one short-lived `powershell.exe` (script passed as `-EncodedCommand`,
  parameters as a base64 JSON blob — nothing user-provided is interpolated into script text).
- Default save location is `%TEMP%/pi-screenshots`; PNGs older than 7 days are swept
  on the first capture of a session.

## Architecture

```
screenshot/
├── index.ts                      # tools + /screenshot command (platform-agnostic)
├── types.ts                      # ScreenCapturer interface, CaptureTarget/CapturedImage, DEFAULT_MAX_WIDTH
├── platform.ts                   # getCapturer() — picks the backend by process.platform
├── temp-files.ts                 # default save location (%TEMP%/pi-screenshots)
└── capture/
    ├── windows/                  # WindowsCapturer (implemented)
    │   ├── windows-capturer.ts
    │   ├── powershell.ts         # spawn/timeout handling
    │   └── scripts.ts            # embedded PowerShell scripts
    └── linux/                    # LinuxCapturer (stub)
        └── linux-capturer.ts
```

Everything above `capture/` is platform-agnostic. Adding Linux means implementing
`ScreenCapturer` in `capture/linux/` and adding a case in `platform.ts` — planned
backends: `grim` (wlroots/Wayland), GNOME Shell screenshot D-Bus API, `scrot`/`import` +
`xdotool` (X11).

## Images and sizing

Tool results include the PNG as base64 image content. To keep model payloads reasonable,
images are downscaled to `maxWidth` (default 1600 px; `0` disables resizing). Screenshots
capture everything visible on screen — potentially sensitive content.
