# agy-hud One-Click Setup Script for Windows (PowerShell)

$ErrorActionPreference = "Stop"
Write-Host "🚀 Starting agy-hud installation for Windows..." -ForegroundColor Cyan

# 1. Detect paths
$NodePath = Get-Command node -ErrorAction SilentlyContinue
$ProjectDir = Get-Location
$HudScriptPath = Join-Path $ProjectDir.Path "extensions\bin\agy-hud.js"
$SettingsFile = "$env:USERPROFILE\.gemini\antigravity-cli\settings.json"

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

# 3. Update settings.json
if (Test-Path $SettingsFile) {
    Write-Host "🔧 Updating statusLine configuration..."
    $Settings = Get-Content $SettingsFile -Raw | ConvertFrom-Json
    
    # Standardize path for JSON
    $ShellNodePath = $NodePath.Source `
        -replace '^C:\\Program Files\\', 'C:\Progra~1\' `
        -replace '^C:\\Program Files \(x86\)\\', 'C:\Progra~2\'
    $EscapedHudScriptPath = $HudScriptPath -replace '\\', '\\'
    
    $Settings.statusLine = @{
        type = "command"
        command = "$ShellNodePath `"$EscapedHudScriptPath`""
    }

    $Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($SettingsFile, ($Settings | ConvertTo-Json -Depth 10), $Utf8NoBom)
} else {
    Write-Warning "⚠️ Antigravity settings.json not found."
}

Write-Host "✅ Installation complete! Please restart Antigravity CLI." -ForegroundColor Green
