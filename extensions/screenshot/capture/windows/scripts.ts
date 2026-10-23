/**
 * PowerShell capture scripts for Windows (embedded — the extension ships no assets).
 *
 * Design notes:
 * - All dynamic values (title, pid, path, maxWidth, monitor) are passed as ONE
 *   base64-encoded JSON blob decoded in-script via the `__PI_PARAMS__` placeholder.
 *   Nothing user-provided is ever interpolated into PowerShell or C# syntax, so
 *   there are no quoting or injection issues.
 * - Scripts print exactly one JSON document: an array (window lists) or an object
 *   with an `ok` field (capture results and failures). `[Console]::OutputEncoding`
 *   is set to UTF-8 so window titles round-trip.
 * - `[PiDpi]::SetProcessDPIAware()` runs before any bounds query so all rects are
 *   physical pixels, not scaled.
 */

export interface CaptureParams {
	/** Desktop captures: -1 = whole virtual screen, >= 0 = monitor index. */
	monitor: number;
	/** Window captures: case-insensitive title substring, "" = no title filter. */
	title: string;
	/** Window captures: process id, 0 = no pid filter. */
	pid: number;
	/** Downscale to at most this width; 0 disables resizing. */
	maxWidth: number;
	/** Where to save the PNG. */
	outPath: string;
}

/** Base prelude: UTF-8 console output (for window titles) + strict errors. */
const PRELUDE = `\
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
`;

/** Decodes the parameter blob injected at __PI_PARAMS__. */
const PARAMS = `\
$Params = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('__PI_PARAMS__')) | ConvertFrom-Json
`;

/** Per-monitor DPI awareness so bounds and rects are physical pixels. */
const DPI_AWARE = `\
Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
public static class PiDpi {
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
'@
[PiDpi]::SetProcessDPIAware() | Out-Null
`;

/** Shared output + save helpers (high-quality resize, directory creation, PNG encoding). */
const HELPERS = `\
function Out-PiJson {
    param($Object)
    ConvertTo-Json -InputObject $Object -Compress -Depth 6
}

function Test-PiUniformBitmap {
    # True when every sampled pixel is the same color. GPU-composited windows often
    # ignore PrintWindow (WM_PRINT) and yield a solid-colored bitmap instead of content.
    param([System.Drawing.Bitmap]$Bmp)
    $First = $Bmp.GetPixel(0, 0)
    $StepX = [Math]::Max(1, [int]($Bmp.Width / 16))
    $StepY = [Math]::Max(1, [int]($Bmp.Height / 16))
    for ($y = 0; $y -lt $Bmp.Height; $y += $StepY) {
        for ($x = 0; $x -lt $Bmp.Width; $x += $StepX) {
            $P = $Bmp.GetPixel($x, $y)
            if ($P.R -ne $First.R -or $P.G -ne $First.G -or $P.B -ne $First.B) { return $false }
        }
    }
    $Last = $Bmp.GetPixel($Bmp.Width - 1, $Bmp.Height - 1)
    return $Last.R -eq $First.R -and $Last.G -eq $First.G -and $Last.B -eq $First.B
}

function Save-PiScreenshot {
    param([System.Drawing.Bitmap]$Bmp, [int]$MaxWidth, [string]$Path)
    if ($MaxWidth -gt 0 -and $Bmp.Width -gt $MaxWidth) {
        $NewHeight = [Math]::Max(1, [int][Math]::Round($Bmp.Height * ($MaxWidth / [double]$Bmp.Width)))
        $Resized = New-Object System.Drawing.Bitmap($MaxWidth, $NewHeight)
        $Graphics = [System.Drawing.Graphics]::FromImage($Resized)
        $Graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $Graphics.DrawImage($Bmp, 0, 0, $MaxWidth, $NewHeight)
        $Graphics.Dispose()
        $Bmp.Dispose()
        $Bmp = $Resized
    }
    $Directory = Split-Path -Parent $Path
    if ($Directory -and -not (Test-Path -LiteralPath $Directory)) {
        New-Item -ItemType Directory -Path $Directory -Force | Out-Null
    }
    $Bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
    $Width = $Bmp.Width
    $Height = $Bmp.Height
    $Bmp.Dispose()
    @{ ok = $true; width = $Width; height = $Height }
}
`;

/** Win32 window enumeration + PrintWindow bindings, shared by listing and window capture. */
const WIN32_TYPES = `\
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class PiWin32
{
    public class WindowInfo
    {
        public IntPtr Hwnd;
        public uint Pid;
        public string Title;
        public int Width;
        public int Height;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr hWnd, int attribute, out int value, int size);

    private const int DWMWA_CLOAKED = 14;

    private static bool IsCapturable(IntPtr hWnd)
    {
        if (!IsWindowVisible(hWnd)) return false;
        int cloaked;
        DwmGetWindowAttribute(hWnd, DWMWA_CLOAKED, out cloaked, sizeof(int));
        if (cloaked != 0) return false; // cloaked UWP/virtual windows are not really on screen
        if (GetWindowTextLength(hWnd) == 0) return false;
        RECT rect;
        GetWindowRect(hWnd, out rect);
        return rect.Right - rect.Left > 0 && rect.Bottom - rect.Top > 0;
    }

    private static WindowInfo ReadWindow(IntPtr hWnd)
    {
        var title = new StringBuilder(GetWindowTextLength(hWnd) + 1);
        GetWindowText(hWnd, title, title.Capacity);
        uint pid;
        GetWindowThreadProcessId(hWnd, out pid);
        RECT rect;
        GetWindowRect(hWnd, out rect);
        return new WindowInfo { Hwnd = hWnd, Pid = pid, Title = title.ToString(), Width = rect.Right - rect.Left, Height = rect.Bottom - rect.Top };
    }

    // All visible, non-cloaked, titled top-level windows, in z-order (front first).
    public static List<WindowInfo> ListWindows()
    {
        var windows = new List<WindowInfo>();
        EnumWindows(delegate(IntPtr hWnd, IntPtr lParam)
        {
            if (IsCapturable(hWnd)) windows.Add(ReadWindow(hWnd));
            return true;
        }, IntPtr.Zero);
        return windows;
    }

    // Windows matching the given title substring (case-insensitive) and/or process id.
    public static List<WindowInfo> FindWindows(string title, int pid)
    {
        var matches = new List<WindowInfo>();
        bool hasTitle = !string.IsNullOrEmpty(title);
        if (!hasTitle && pid <= 0) return matches;
        EnumWindows(delegate(IntPtr hWnd, IntPtr lParam)
        {
            if (!IsCapturable(hWnd)) return true;
            uint windowPid;
            GetWindowThreadProcessId(hWnd, out windowPid);
            if (pid > 0 && windowPid != (uint)pid) return true;
            WindowInfo info = ReadWindow(hWnd);
            if (hasTitle && info.Title.IndexOf(title, StringComparison.OrdinalIgnoreCase) < 0) return true;
            matches.Add(info);
            return true;
        }, IntPtr.Zero);
        return matches;
    }
}
'@
`;

const LIST_WINDOWS_TEMPLATE = `\
${PRELUDE}
${DPI_AWARE}
${WIN32_TYPES}
${HELPERS}

try {
    $Windows = [PiWin32]::ListWindows()
    $ProcessNames = @{}
    try {
        Get-Process | ForEach-Object { $ProcessNames[[int]$_.Id] = $_.ProcessName }
    } catch { }

    $Result = @(
        $Windows | ForEach-Object {
            [ordered]@{
                pid = $_.Pid
                process = [string]$ProcessNames[[int]$_.Pid]
                title = $_.Title
                width = $_.Width
                height = $_.Height
            }
        }
    )
    if ($Result.Count -eq 0) {
        '[]'
    } else {
        Out-PiJson $Result
    }
} catch {
    Out-PiJson @{ ok = $false; error = $_.Exception.Message }
}
`;

const DESKTOP_CAPTURE_TEMPLATE = `\
${PRELUDE}
${PARAMS}
${DPI_AWARE}
${HELPERS}

try {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing

    if ($Params.Monitor -ge 0) {
        $Screens = [System.Windows.Forms.Screen]::AllScreens
        if ($Params.Monitor -ge $Screens.Length) {
            throw "Monitor index $($Params.Monitor) not found: only $($Screens.Length) monitor(s) available."
        }
        $Bounds = $Screens[$Params.Monitor].Bounds
    } else {
        $Bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
    }

    $Bmp = New-Object System.Drawing.Bitmap($Bounds.Width, $Bounds.Height)
    $Graphics = [System.Drawing.Graphics]::FromImage($Bmp)
    try {
        $Graphics.CopyFromScreen($Bounds.Left, $Bounds.Top, 0, 0, $Bmp.Size)
    } finally {
        $Graphics.Dispose()
    }

    $Saved = Save-PiScreenshot -Bmp $Bmp -MaxWidth $Params.MaxWidth -Path $Params.OutPath
    Out-PiJson @{
        ok = $true
        width = $Saved.width
        height = $Saved.height
        path = $Params.OutPath
    }
} catch {
    Out-PiJson @{ ok = $false; error = $_.Exception.Message }
}
`;

const WINDOW_CAPTURE_TEMPLATE = `\
${PRELUDE}
${PARAMS}
${DPI_AWARE}
${WIN32_TYPES}
${HELPERS}

try {
    Add-Type -AssemblyName System.Drawing

    $Found = [PiWin32]::FindWindows($Params.Title, [int]$Params.Pid)
    if ($Found.Count -eq 0) {
        $All = [PiWin32]::ListWindows()
        Out-PiJson @{
            ok = $false
            error = 'notfound'
            windows = @($All | ForEach-Object { [ordered]@{ pid = $_.Pid; title = $_.Title } })
        }
        return
    }
    if ($Found.Count -gt 1) {
        Out-PiJson @{
            ok = $false
            error = 'multiple'
            windows = @($Found | ForEach-Object { [ordered]@{ pid = $_.Pid; title = $_.Title; width = $_.Width; height = $_.Height } })
        }
        return
    }

    $Target = $Found[0]
    if ([PiWin32]::IsIconic($Target.Hwnd)) {
        throw "Window '$($Target.Title)' is minimized. Restore it first, then capture again."
    }

    $Rect = New-Object 'PiWin32+RECT'
    [PiWin32]::GetWindowRect($Target.Hwnd, [ref]$Rect) | Out-Null
    $Width = $Rect.Right - $Rect.Left
    $Height = $Rect.Bottom - $Rect.Top
    if ($Width -le 0 -or $Height -le 0) {
        throw "Window '$($Target.Title)' has no visible area."
    }

    $Printed = $false
    $Solid = $true
    $Bmp = $null
    foreach ($Flags in 2, 0) {
        # 2 = PW_RENDERFULLCONTENT (captures occluded windows and Chromium/Electron apps),
        # 0 = plain PrintWindow fallback for apps that reject the full-content flag.
        $Bmp = New-Object System.Drawing.Bitmap($Width, $Height)
        $Graphics = [System.Drawing.Graphics]::FromImage($Bmp)
        $Hdc = $Graphics.GetHdc()
        try {
            $Printed = [PiWin32]::PrintWindow($Target.Hwnd, $Hdc, $Flags)
        } finally {
            $Graphics.ReleaseHdc($Hdc)
            $Graphics.Dispose()
        }
        if ($Printed) {
            $Solid = Test-PiUniformBitmap -Bmp $Bmp
            if (-not $Solid) { break }
        } else {
            $Bmp.Dispose()
            $Bmp = $null
        }
    }

    $Note = $null
    if (-not $Printed -or $Solid) {
        # GPU-composited windows can ignore PrintWindow and yield blank content.
        # Last resort: copy whatever is visible on screen at the window's position.
        if ($Bmp) { $Bmp.Dispose() }
        $Bmp = New-Object System.Drawing.Bitmap($Width, $Height)
        $Graphics = [System.Drawing.Graphics]::FromImage($Bmp)
        $Graphics.CopyFromScreen($Rect.Left, $Rect.Top, 0, 0, (New-Object System.Drawing.Size($Width, $Height)))
        $Graphics.Dispose()
        $Note = 'PrintWindow produced no usable content for this window (likely GPU-composited); captured the on-screen region at the window position instead — content may be wrong if the window is occluded.'
    }

    $Saved = Save-PiScreenshot -Bmp $Bmp -MaxWidth $Params.MaxWidth -Path $Params.OutPath
    Out-PiJson @{
        ok = $true
        width = $Saved.width
        height = $Saved.height
        path = $Params.OutPath
        title = $Target.Title
        pid = $Target.Pid
        note = $Note
    }
} catch {
    Out-PiJson @{ ok = $false; error = $_.Exception.Message }
}
`;

function encodeParams(params: CaptureParams): string {
	return Buffer.from(JSON.stringify(params), "utf8").toString("base64");
}

export function buildListWindowsScript(): string {
	return LIST_WINDOWS_TEMPLATE;
}

export function buildDesktopCaptureScript(params: CaptureParams): string {
	return DESKTOP_CAPTURE_TEMPLATE.replace("__PI_PARAMS__", encodeParams(params));
}

export function buildWindowCaptureScript(params: CaptureParams): string {
	return WINDOW_CAPTURE_TEMPLATE.replace("__PI_PARAMS__", encodeParams(params));
}
