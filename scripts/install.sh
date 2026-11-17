#!/usr/bin/env bash
# One-command installer for agy-hud. Does:
#   1. agy plugin install (or upgrade) https://github.com/yuwenlong/agy-hud.git
#   2. bootstrap runtime + configure settings.json statusLine
#
# Run from a normal shell — NOT from inside an active `agy` session
# (agy rewrites settings.json from in-memory state on exit).
#
# Usage:
#   bash <(curl -fsSL https://raw.githubusercontent.com/yuwenlong/agy-hud/main/scripts/install.sh)
#
# Env:
#   AGY_HUD_REPO_RAW    override raw GitHub base URL (forks / mirrors)
#   AGY_HUD_REPO_URL    override git URL for `agy plugin install`
set -euo pipefail

REPO_RAW="${AGY_HUD_REPO_RAW:-https://raw.githubusercontent.com/yuwenlong/agy-hud/main}"
REPO_URL="${AGY_HUD_REPO_URL:-https://github.com/yuwenlong/agy-hud.git}"

if ! command -v agy >/dev/null 2>&1; then
  echo "agy-hud: agy CLI not on PATH. Install it first:" >&2
  echo "  curl -fsSL https://antigravity.google/cli/install.sh | bash" >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "agy-hud: node is required but not on PATH." >&2
  exit 1
fi
if ! command -v curl >/dev/null 2>&1; then
  echo "agy-hud: curl is required but not on PATH." >&2
  exit 1
fi

# Step 1: stage the plugin. Uninstall first so files removed in upgrades
# don't linger (agy plugin install only overwrites, never deletes).
echo "==> Removing any existing agy-hud plugin install..."
agy plugin uninstall agy-hud >/dev/null 2>&1 || true

echo "==> Installing plugin from $REPO_URL..."
agy plugin install "$REPO_URL"

# Step 2: download runtime + configure statusLine
echo
echo "==> Bootstrapping runtime + statusLine config..."
TMP_BOOTSTRAP="$(mktemp "${TMPDIR:-/tmp}/agy-hud-bootstrap-XXXXXX.js")"
trap 'rm -f "$TMP_BOOTSTRAP"' EXIT
curl -fsSL "$REPO_RAW/scripts/bootstrap.js" -o "$TMP_BOOTSTRAP"
NODE_USE_ENV_PROXY=1 AGY_HUD_REPO_RAW="$REPO_RAW" node "$TMP_BOOTSTRAP"

cat <<DONE

==> agy-hud installed.
    Open a new agy session in your terminal to see the HUD.
    Repair anytime by re-running this script.
DONE
