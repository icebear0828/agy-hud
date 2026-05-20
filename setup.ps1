# agy-hud One-Click Setup Script for Windows (PowerShell)

$ErrorActionPreference = "Stop"
Write-Host "🚀 Starting agy-hud installation for Windows..." -ForegroundColor Cyan

# 1. Detect paths
$NodePath = Get-Command node -ErrorAction SilentlyContinue
$ProjectDir = Get-Location
$HudScriptPath = Join-Path $ProjectDir.Path "extensions\bin\agy-hud.js"

if (-not $NodePath) {
    Write-Error "❌ Node.js not found in PATH."
}

if (-not (Test-Path $HudScriptPath)) {
    Write-Error "❌ HUD script not found at $HudScriptPath"
}

# 2. Official Plugin Installation
Write-Host "🔌 Installing as an official agy plugin..." -ForegroundColor Yellow
agy plugin uninstall agy-hud | Out-Null
agy plugin install .

# 3. Update settings.json for statusLine
Write-Host "🔧 Updating statusLine configuration..." -ForegroundColor Yellow
node extensions/install-statusline.js

Write-Host "✅ Installation complete! Please restart Antigravity CLI." -ForegroundColor Green
