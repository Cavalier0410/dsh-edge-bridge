# Launches Edge (or Chrome) with the CDP port open, using a dedicated profile.
# The dedicated profile is required: Chromium 136+ ignores --remote-debugging-port
# when the default user-data-dir is used.
#
#   .\scripts\start-edge.ps1
#   .\scripts\start-edge.ps1 -Port 9222 -ProfileDir "D:\browser-profiles\edge" -Restore
param(
  [int]$Port = 9222,
  [string]$ProfileDir = "$env:LOCALAPPDATA\dsh-edge-bridge\profile",
  [switch]$Restore,
  [string]$EdgePath = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
)

if (-not (Test-Path $EdgePath)) {
  $alt = "C:\Program Files\Microsoft\Edge\Application\msedge.exe"
  if (Test-Path $alt) { $EdgePath = $alt } else { throw "Edge not found at $EdgePath" }
}

New-Item -ItemType Directory -Force -Path $ProfileDir | Out-Null

$args = @(
  "--remote-debugging-port=$Port",
  "--user-data-dir=$ProfileDir",
  "--no-first-run",
  "--no-default-browser-check"
)
if ($Restore) { $args += "--restore-last-session" }

Start-Process -FilePath $EdgePath -ArgumentList $args

for ($i = 0; $i -lt 50; $i++) {
  Start-Sleep -Milliseconds 300
  try {
    $v = Invoke-RestMethod "http://127.0.0.1:$Port/json/version" -TimeoutSec 1
    Write-Host "CDP ready: $($v.Browser) on port $Port"
    Write-Host "profile:   $ProfileDir"
    exit 0
  } catch {}
}

Write-Warning "CDP did not come up on port $Port — is another instance using this profile?"
exit 1
