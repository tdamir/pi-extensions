# Send keystrokes to a terminal window (Windows).
#
#   powershell -NoProfile -File send-keys.ps1 -ProcessId 12345 -Keys "ls,{ENTER}"
#   powershell -NoProfile -File send-keys.ps1 -WindowTitle "term-test-1234abcd" -Keys "{ESC}"
#
# Keys is one comma-separated string; each part is sent separately with a short
# delay so the app can react before the next part (e.g. text, then {ENTER}).
# A literal comma cannot be typed with this helper.
#
# SendKeys syntax: literal text plus {ENTER} {ESC} {TAB} {UP} {DOWN} {PGUP} {PGDN}
# {HOME} {END}, ^ for Ctrl (^u, ^d), + for Shift, % for Alt.
#
# Get the pid/title from launch-terminal.ps1 or the list_windows tool, then use
# the screenshot tool with target "window" to capture it. When several Windows
# Terminal windows share one pid, match by title instead of pid.
#
# From Git Bash, prefix with MSYS_NO_PATHCONV=1: MSYS rewrites arguments starting
# with "/" into Windows paths before PowerShell sees them.

param(
    [Parameter(Mandatory = $true)][string]$Keys,
    [int]$ProcessId = 0,
    [string]$WindowTitle = "",
    [int]$SettleMs = 900,
    [int]$DelayMs = 600
)

Add-Type -AssemblyName System.Windows.Forms

$shell = New-Object -ComObject WScript.Shell
if ($ProcessId -gt 0) {
    if (-not $shell.AppActivate($ProcessId)) {
        Write-Error "Could not activate window with pid $ProcessId"
        exit 1
    }
} elseif ($WindowTitle -ne "") {
    if (-not $shell.AppActivate($WindowTitle)) {
        Write-Error "Could not activate window titled '$WindowTitle'"
        exit 1
    }
} else {
    Write-Error "Pass -ProcessId or -WindowTitle"
    exit 1
}

Start-Sleep -Milliseconds $SettleMs

$parts = $Keys -split ','
foreach ($part in $parts) {
    [System.Windows.Forms.SendKeys]::SendWait($part)
    Start-Sleep -Milliseconds $DelayMs
}

Write-Output "sent $($parts.Count) key sequence(s)"
