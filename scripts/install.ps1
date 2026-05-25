# One-command installer for agy-hud (Windows PowerShell).
# Equivalent of install.sh for Unix — does:
#   1. agy plugin install (or upgrade) https://github.com/icebear0828/agy-hud.git
#   2. bootstrap runtime + configure settings.json statusLine
#
# Run from a normal shell — NOT from inside an active `agy` session
# (agy rewrites settings.json from in-memory state on exit).
#
# Usage:
#   irm https://raw.githubusercontent.com/icebear0828/agy-hud/main/scripts/install.ps1 | iex
#
# Env:
#   AGY_HUD_REPO_RAW    override raw GitHub base URL (forks / mirrors)
#   AGY_HUD_REPO_URL    override git URL for `agy plugin install`
$ErrorActionPreference = 'Stop'

$RepoRaw = if ($env:AGY_HUD_REPO_RAW) { $env:AGY_HUD_REPO_RAW } else { 'https://raw.githubusercontent.com/icebear0828/agy-hud/main' }
$RepoUrl = if ($env:AGY_HUD_REPO_URL) { $env:AGY_HUD_REPO_URL } else { 'https://github.com/icebear0828/agy-hud.git' }

if (-not (Get-Command agy -ErrorAction SilentlyContinue)) {
    Write-Error "agy-hud: agy CLI not on PATH. Install it first:`n  irm https://antigravity.google/cli/install.ps1 | iex"
    exit 1
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error "agy-hud: node is required but not on PATH."
    exit 1
}

# Step 1: stage the plugin. Uninstall first so stale files don't linger.
Write-Host "==> Removing any existing agy-hud plugin install..."
try { agy plugin uninstall agy-hud 2>$null } catch {}

Write-Host "==> Installing plugin from $RepoUrl..."
agy plugin install $RepoUrl

# Step 2: download bootstrap.js to temp, run with node
Write-Host ""
Write-Host "==> Bootstrapping runtime + statusLine config..."
$BootstrapUrl = "$RepoRaw/scripts/bootstrap.js"
$TempBootstrap = Join-Path ([System.IO.Path]::GetTempPath()) "agy-hud-bootstrap-$PID.js"
try {
    Invoke-WebRequest -Uri $BootstrapUrl -OutFile $TempBootstrap -UseBasicParsing
    $env:AGY_HUD_REPO_RAW = $RepoRaw
    node $TempBootstrap
    if ($LASTEXITCODE -ne 0) { throw "bootstrap.js exited with code $LASTEXITCODE" }
} finally {
    Remove-Item $TempBootstrap -Force -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "==> agy-hud installed."
Write-Host "    Open a new agy session in your terminal to see the HUD."
Write-Host "    Repair anytime by re-running this script."
