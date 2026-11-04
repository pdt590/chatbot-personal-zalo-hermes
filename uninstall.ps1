# uninstall.ps1 — Hermes Zalo plugin uninstaller for Windows (PowerShell).
# Thin wrapper: verifies Node is present, then hands off to uninstall.mjs
# (stops + removes the Scheduled Task, removes the Hermes adapter).
#
#   .\uninstall.ps1                          # remove task + adapter, keep the Zalo login
#   .\uninstall.ps1 --purge                  # also delete the saved Zalo login (credentials)
#   .\uninstall.ps1 --hermes-home <path>     # remove the adapter from that Hermes profile
#
# If you get an execution-policy error, run once:
#   Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass

$ErrorActionPreference = "Stop"
$Dir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Dir

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host "X Node.js is required but not found." -ForegroundColor Red
  Write-Host "  Install Node >= 18 from https://nodejs.org, then re-run."
  exit 1
}

& node uninstall.mjs @args
exit $LASTEXITCODE
