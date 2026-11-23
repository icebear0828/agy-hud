#!/usr/bin/env bash
# One-command installer for agy-hud. Does:
#   1. Verify Node >= 22.18.0
#   2. agy plugin install (or upgrade) https://github.com/icebear0828/agy-hud.git
#   3. bootstrap runtime + configure settings.json statusLine
#
# Run from a normal shell — NOT from inside an active `agy` session
# (agy rewrites settings.json from in-memory state on exit).
#
# Usage:
#   bash <(curl -fsSL https://raw.githubusercontent.com/icebear0828/agy-hud/main/scripts/install.sh)
#
# Env:
#   AGY_HUD_REPO_RAW    override raw GitHub base URL (forks / mirrors)
#   AGY_HUD_REPO_URL    override git URL for `agy plugin install`
set -euo pipefail

REPO_RAW="${AGY_HUD_REPO_RAW:-https://raw.githubusercontent.com/icebear0828/agy-hud/main}"
REPO_URL="${AGY_HUD_REPO_URL:-https://github.com/icebear0828/agy-hud.git}"

if ! command -v agy >/dev/null 2>&1; then
  echo "agy-hud: agy CLI not on PATH. Install it first:" >&2
  echo "  curl -fsSL https://antigravity.google/cli/install.sh | bash" >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "agy-hud: node is required (>= 22.18.0) but not on PATH." >&2
  exit 1
fi
if ! node -e 'const [M,m]=process.versions.node.split(".").map(Number); if(M<22||(M===22&&m<18)){console.error("agy-hud requires Node >= 22.18.0 (found "+process.version+")"); process.exit(1);}'; then
  exit 1
fi
if ! command -v curl >/dev/null 2>&1; then
  echo "agy-hud: curl is required but not on PATH." >&2
  exit 1
fi

echo "==> Removing any existing agy-hud plugin install..."
agy plugin uninstall agy-hud >/dev/null 2>&1 || true

echo "==> Installing plugin from $REPO_URL..."
agy plugin install "$REPO_URL"

echo
echo "==> Bootstrapping runtime + statusLine config..."
PLUGIN_DIR=""
if [ -z "${AGY_HUD_REPO_RAW:-}" ] || [ -n "${AGY_HUD_REPO_URL:-}" ]; then
  for candidate in \
    "${AGY_HUD_DATA_DIR:+$AGY_HUD_DATA_DIR/plugins/agy-hud}" \
    "$HOME/.gemini/config/plugins/agy-hud" \
    "$HOME/.gemini/antigravity-cli/plugins/agy-hud" \
    "${XDG_CONFIG_HOME:-$HOME/.config}/gemini/plugins/agy-hud"; do
    if [ -n "$candidate" ] && [ -f "$candidate/scripts/bootstrap.js" ] && [ -f "$candidate/hud.mjs" ] && [ -f "$candidate/src/main.ts" ]; then
      PLUGIN_DIR="$candidate"
      break
    fi
  done
fi

if [ -n "$PLUGIN_DIR" ]; then
  NODE_USE_ENV_PROXY=1 AGY_HUD_SETUP_SOURCE_DIR="$PLUGIN_DIR" AGY_HUD_REPO_RAW="$REPO_RAW" node "$PLUGIN_DIR/scripts/bootstrap.js"
else
  TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/agy-hud-bootstrap-XXXXXX")"
  trap 'rm -rf "$TMP_DIR"' EXIT
  TMP_BOOTSTRAP="$TMP_DIR/bootstrap.mjs"
  curl -fsSL "$REPO_RAW/scripts/bootstrap.js" -o "$TMP_BOOTSTRAP"
  NODE_USE_ENV_PROXY=1 AGY_HUD_REPO_RAW="$REPO_RAW" node "$TMP_BOOTSTRAP"
fi

cat <<DONE

==> agy-hud installed.
    Open a new agy session in your terminal to see the HUD.
    Run /hud doctor or \`node ~/.gemini/antigravity-cli/agy-hud-runtime/hud.mjs doctor\` to inspect diagnostics.
    Repair anytime by re-running this script.
DONE
