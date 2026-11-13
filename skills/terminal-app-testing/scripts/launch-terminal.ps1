# Open a command in a new terminal window/tab and print its window pid.
#
#   powershell -NoProfile -File launch-terminal.ps1 -Command "ls"
#   powershell -NoProfile -File launch-terminal.ps1 -Shell cmd -Command "dir /w"
#   powershell -NoProfile -File launch-terminal.ps1 -Shell pwsh -Command "Get-Process" -NewWindow
#
# Prints one line: "<pid> <title>" of the hosting window (Windows Terminal or
# conhost), which is what `screenshot -pid <pid>` and send-keys.ps1 expect.
#
# A unique title marker is injected first so the window can be found reliably;
# the app may replace it (pi sets "π - <cwd>", for example), which is fine — the
# marker is only used to locate the window during launch.
#
# From Git Bash, prefix with MSYS_NO_PATHCONV=1 if -Command starts with "/".

param(
    [Parameter(Mandatory = $true)][string]$Command,
    [ValidateSet("powershell", "pwsh", "cmd", "wsl", "bash")]
    [string]$Shell = "powershell",
    [switch]$NewWindow,
    [switch]$DryRun,
    [int]$TimeoutMs = 20000,
    [int]$SettleMs = 800
)

Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public class WindowInfo
{
    public IntPtr Handle;
    public uint Pid;
    public string Title;
}

public class WindowFinder
{
    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);

    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    public static List<WindowInfo> List()
    {
        var result = new List<WindowInfo>();
        EnumWindows((hWnd, lParam) =>
        {
            if (!IsWindowVisible(hWnd)) return true;
            int length = GetWindowTextLength(hWnd);
            if (length == 0) return true;
            var sb = new StringBuilder(length + 1);
            GetWindowText(hWnd, sb, sb.Capacity);
            uint pid;
            GetWindowThreadProcessId(hWnd, out pid);
            result.Add(new WindowInfo { Handle = hWnd, Pid = pid, Title = sb.ToString() });
            return true;
        }, IntPtr.Zero);
        return result;
    }
}
"@

$marker = "term-test-" + [guid]::NewGuid().ToString("N").Substring(0, 8)

# $titleSetter runs first in the shell so the window can be found; it is skipped
# for -NewWindow, where `wt --title` sets the title instead.
switch ($Shell) {
    "powershell" {
        $file = "powershell.exe"
        $titleSetter = "`$Host.UI.RawUI.WindowTitle = '$marker'; "
        $shellArgs = @("-NoExit", "-Command")
        $scriptArgs = @($Command)
    }
    "pwsh" {
        $file = "pwsh.exe"
        $titleSetter = "`$Host.UI.RawUI.WindowTitle = '$marker'; "
        $shellArgs = @("-NoExit", "-Command")
        $scriptArgs = @($Command)
    }
    "cmd" {
        $file = "cmd.exe"
        $titleSetter = "title $marker& "
        $shellArgs = @("/k")
        $scriptArgs = @($Command)
    }
    "wsl" {
        $file = "wsl.exe"
        $titleSetter = "printf '\033]0;$marker\007'; "
        $shellArgs = @("--cd", "~", "bash", "-c")
        $scriptArgs = @("$titleSetter$Command; exec bash --norc")
        $titleSetter = ""
    }
    "bash" {
        $file = "bash.exe"
        $titleSetter = "printf '\033]0;$marker\007'; "
        $shellArgs = @("-c")
        $scriptArgs = @("$titleSetter$Command; exec bash --norc")
        $titleSetter = ""
    }
}

if ($NewWindow) {
    # Windows Terminal: force a dedicated window. wt sets the title itself, which
    # avoids quoting issues with title-setting code inside -Command.
    $args = @("-w", "-1", "--title", $marker, $file) + $shellArgs + $scriptArgs
    $file = "wt.exe"
} else {
    $args = $shellArgs + @("$titleSetter$($scriptArgs[0])")
}

# Start-Process joins -ArgumentList with spaces without quoting, so quote any
# argument containing spaces or quotes (e.g. a multi-part shell command).
function Quote-Arg([string]$value) {
    if ($value -match '[\s"]') {
        return '"' + ($value -replace '"', '\"') + '"'
    }
    return $value
}

$argString = ($args | ForEach-Object { Quote-Arg $_ }) -join ' '

if ($DryRun) {
    Write-Output "$file $argString"
    exit 0
}

$deadline = (Get-Date).AddMilliseconds($TimeoutMs)
$match = $null

Start-Process -FilePath $file -ArgumentList $argString | Out-Null
Start-Sleep -Milliseconds $SettleMs

while ((Get-Date) -lt $deadline) {
    # Match by unique title marker only: Windows Terminal reuses one window and
    # opens a tab, so the window handle is not new.
    $match = [WindowFinder]::List() | Where-Object { $_.Title -like "*$marker*" } | Select-Object -First 1
    if ($match) { break }
    Start-Sleep -Milliseconds 250
}

if (-not $match) {
    Write-Error "Could not find the terminal window for marker '$marker' within $TimeoutMs ms."
    exit 1
}

Write-Output "$($match.Pid) $($match.Title)"
