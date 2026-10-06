# Claude Code "Stop" hook: shows a congratulations dialog when Claude finishes a task.
#
# Wired up in .claude/settings.json. Claude Code pipes a JSON payload on stdin
# (session_id, cwd, hook_event_name, ...). The dialog runs in a separate, detached
# PowerShell process, so this hook returns immediately and never blocks Claude Code
# while the dialog is open.

$ErrorActionPreference = 'SilentlyContinue'

# Read the hook payload (also drains stdin so Claude Code isn't left waiting).
$payload = $null
try { $payload = [Console]::In.ReadToEnd() | ConvertFrom-Json } catch { }

$projectDir = if ($env:CLAUDE_PROJECT_DIR) { $env:CLAUDE_PROJECT_DIR } elseif ($payload -and $payload.cwd) { $payload.cwd } else { (Get-Location).Path }
$project = Split-Path -Leaf $projectDir
$time = Get-Date -Format 'HH:mm'

# Text only — no user-controlled content is interpolated into executable code.
$party = [char]::ConvertFromUtf32(0x1F389)  # party popper (works on Windows PowerShell 5.1)
$message = "Congratulations! $party`n`nClaude has finished your task in '$project'.`nCompleted at $time."
$title = 'Task complete'

# Dialog script for the child process. Values are passed as Base64 so quotes or
# special characters in the project name can't break out of the string.
$b64 = { param($s) [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($s)) }
$popup = @"
Add-Type -AssemblyName System.Windows.Forms
`$msg   = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('$(& $b64 $message)'))
`$title = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('$(& $b64 $title)'))
`$owner = New-Object System.Windows.Forms.Form -Property @{
  TopMost = `$true; ShowInTaskbar = `$false; Opacity = 0; FormBorderStyle = 'None'
  StartPosition = 'Manual'; Location = New-Object System.Drawing.Point(-32000, -32000); Size = New-Object System.Drawing.Size(1, 1)
}
# The process is started hidden; Windows applies that "hidden" flag to the FIRST window
# shown. Show the invisible owner first so it absorbs the flag and the dialog is visible.
`$owner.Show(); `$owner.Hide()
[void][System.Windows.Forms.MessageBox]::Show(`$owner, `$msg, `$title, 'OK', 'Information')
`$owner.Dispose()
"@

$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($popup))
Start-Process -FilePath 'powershell.exe' `
  -ArgumentList '-NoProfile', '-STA', '-WindowStyle', 'Hidden', '-EncodedCommand', $encoded `
  -WindowStyle Hidden

exit 0
