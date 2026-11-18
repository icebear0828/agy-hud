# One-command installer for agy-hud (Windows PowerShell).
# Requires Node >= 22.18.0.
# Run from a normal shell -- NOT from inside an active `agy` session.
$ErrorActionPreference = 'Stop'

$RepoRaw = if ($env:AGY_HUD_REPO_RAW) { $env:AGY_HUD_REPO_RAW } else { 'https://raw.githubusercontent.com/yuwenlong/agy-hud/main' }
$RepoUrl = if ($env:AGY_HUD_REPO_URL) { $env:AGY_HUD_REPO_URL } else { 'https://github.com/yuwenlong/agy-hud.git' }

if (-not (Get-Command agy -ErrorAction SilentlyContinue)) {
    Write-Error "agy-hud: agy CLI not on PATH. Install it first:`n  irm https://antigravity.google/cli/install.ps1 | iex"
    exit 1
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error "agy-hud: node (>= 22.18.0) is required but not on PATH."
    exit 1
}
node -e "const [M,m]=process.versions.node.split('.').map(Number); if(M<22||(M===22&&m<18)){console.error('agy-hud requires Node >= 22.18.0 (found '+process.version+')'); process.exit(1);}"
if ($LASTEXITCODE -ne 0) { exit 1 }

Write-Host "==> Removing any existing agy-hud plugin install..."
$prevErrPref = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try { agy plugin uninstall agy-hud *> $null } catch {}
$ErrorActionPreference = $prevErrPref

Write-Host "==> Installing plugin from $RepoUrl..."
agy plugin install $RepoUrl
if ($LASTEXITCODE -ne 0) { throw "agy plugin install exited with code $LASTEXITCODE" }

Write-Host ""
Write-Host "==> Bootstrapping runtime + statusLine config..."
$BootstrapUrl = "$RepoRaw/scripts/bootstrap.js"
$TempDir = Join-Path ([System.IO.Path]::GetTempPath()) "agy-hud-bootstrap-$PID"
New-Item -ItemType Directory -Force -Path $TempDir | Out-Null
$TempBootstrap = Join-Path $TempDir 'bootstrap.mjs'
try {
    Invoke-WebRequest -Uri $BootstrapUrl -OutFile $TempBootstrap -UseBasicParsing
    $env:AGY_HUD_REPO_RAW = $RepoRaw
    $env:NODE_USE_ENV_PROXY = '1'
    node $TempBootstrap
    if ($LASTEXITCODE -ne 0) { throw "bootstrap exited with code $LASTEXITCODE" }
} finally {
    Remove-Item $TempDir -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "==> agy-hud installed."
Write-Host "    Open a new agy session in your terminal to see the HUD."
Write-Host "    Run /hud doctor to inspect diagnostics."
Write-Host "    Repair anytime by re-running this script."
