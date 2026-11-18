# Remove agy-hud from this machine (Windows).
$ErrorActionPreference = 'Continue'

$RuntimeBase = Join-Path $env:USERPROFILE '.gemini\antigravity-cli\agy-hud-runtime\runtime'
$Runtime = Join-Path $RuntimeBase 'uninstall.mjs'
if (-not (Test-Path $Runtime)) { $Runtime = Join-Path $RuntimeBase 'uninstall.js' }
$PluginDir = Join-Path $env:USERPROFILE '.gemini\config\plugins\agy-hud'

if ((Get-Command node -ErrorAction SilentlyContinue) -and (Test-Path $Runtime)) {
    node $Runtime
} else {
    Write-Error "agy-hud uninstall: runtime not found at $RuntimeBase - skipping settings cleanup"
}

if (Get-Command agy -ErrorAction SilentlyContinue) {
    agy plugin uninstall agy-hud
    if ($LASTEXITCODE -ne 0) {
        Write-Error "agy-hud uninstall: 'agy plugin uninstall' failed - removing plugin dir directly"
        Remove-Item $PluginDir -Recurse -Force -ErrorAction SilentlyContinue
    }
} else {
    Write-Error "agy-hud uninstall: agy CLI not on PATH - removing plugin dir directly"
    Remove-Item $PluginDir -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "agy-hud uninstall complete"
