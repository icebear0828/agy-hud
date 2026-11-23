#!/usr/bin/env bash
# One-shot bootstrap for agy-hud. Idempotent — re-run anytime to repair settings.json.
# Downloads runtime to ~/.gemini/antigravity-cli/agy-hud-runtime/ and configures statusLine.
#
# Usage:
#   bash <(curl -fsSL https://raw.githubusercontent.com/icebear0828/agy-hud/main/scripts/bootstrap.sh)
#
# Env:
#   AGY_HUD_REPO_RAW  override the raw GitHub base URL (for forks/mirrors)
set -euo pipefail

REPO_RAW="${AGY_HUD_REPO_RAW:-https://raw.githubusercontent.com/icebear0828/agy-hud/main}"

if ! command -v node >/dev/null 2>&1; then
  echo "agy-hud bootstrap: node is required but not found in PATH" >&2
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "agy-hud bootstrap: curl is required but not found in PATH" >&2
  exit 1
fi

TMP_BOOTSTRAP="$(mktemp "${TMPDIR:-/tmp}/agy-hud-bootstrap.XXXXXX")"
trap 'rm -f "$TMP_BOOTSTRAP"' EXIT
curl -fsSL "$REPO_RAW/scripts/bootstrap.js" -o "$TMP_BOOTSTRAP"
AGY_HUD_REPO_RAW="$REPO_RAW" node "$TMP_BOOTSTRAP"
