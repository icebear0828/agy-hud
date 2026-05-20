#!/bin/bash

# agy-hud One-Click Setup Script
# Works for Antigravity CLI

set -e

echo "🚀 Starting agy-hud installation..."

# 1. Detect paths
NODE_PATH=$(which node)
PROJECT_DIR=$(pwd)
HUD_SCRIPT="$PROJECT_DIR/extensions/bin/agy-hud.js"

if [ -z "$NODE_PATH" ]; then
  echo "❌ Error: Node.js not found in PATH."
  exit 1
fi

if [ ! -f "$HUD_SCRIPT" ]; then
  echo "❌ Error: HUD script not found at $HUD_SCRIPT"
  exit 1
fi

# 2. Official Plugin Installation
echo "🔌 Installing as an official agy plugin..."
agy plugin uninstall agy-hud >/dev/null 2>&1 || true
agy plugin install .

# 3. Update settings.json for statusLine
echo "🔧 Updating statusLine configuration..."
"$NODE_PATH" extensions/install-statusline.js

echo "✅ Installation complete!"
echo "✨ Please restart your Antigravity CLI to see the HUD."
echo "💡 You can customize colors in extensions/agy-hud.config.json"
