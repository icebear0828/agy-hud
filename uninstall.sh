#!/usr/bin/env bash
# Remove agy-hud from this machine.
set -uo pipefail

RUNTIME_BASE="$HOME/.gemini/antigravity-cli/agy-hud-runtime/runtime"
RUNTIME_UNINSTALL="$RUNTIME_BASE/uninstall.mjs"
[ -f "$RUNTIME_UNINSTALL" ] || RUNTIME_UNINSTALL="$RUNTIME_BASE/uninstall.js"

if command -v node >/dev/null 2>&1 && [ -f "$RUNTIME_UNINSTALL" ]; then
  node "$RUNTIME_UNINSTALL"
else
  echo "agy-hud uninstall: runtime not found at $RUNTIME_BASE — skipping settings cleanup" >&2
fi

AGY_HUD_PLUGIN_DIR="${HOME}/.gemini/config/plugins/agy-hud"

if command -v agy >/dev/null 2>&1; then
  if ! agy plugin uninstall agy-hud 2>/dev/null; then
    echo "agy-hud uninstall: 'agy plugin uninstall' failed — falling back to rm" >&2
    rm -rf "$AGY_HUD_PLUGIN_DIR"
  fi
else
  echo "agy-hud uninstall: agy CLI not on PATH — removing plugin dir directly" >&2
  rm -rf "$AGY_HUD_PLUGIN_DIR"
fi

echo "agy-hud uninstall complete"
