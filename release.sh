#!/usr/bin/env bash
# agy-hud Official Release Script
set -euo pipefail

VERSION=$(node -e "import fs from 'node:fs'; console.log(JSON.parse(fs.readFileSync('./package.json','utf8')).version)")
REPO_URL=$(node -e "
  import fs from 'node:fs';
  const r = JSON.parse(fs.readFileSync('./package.json','utf8')).repository;
  if (!r || !r.url) { console.error('package.json missing repository.url'); process.exit(1); }
  console.log(r.url.replace(/^git\+/, '').replace(/\.git$/, ''));
")
REPO_SLUG=${REPO_URL#https://github.com/}
REPO_SLUG=${REPO_SLUG%.git}
echo "📦 Preparing release v$VERSION..."

# 1. Run typecheck, unit tests, and architecture/security verification suite
npm run typecheck
npm test
npm run verify

cleanup_tmp() {
  rm -rf release_tmp
}
trap cleanup_tmp EXIT

build_zip() {
  rm -rf release_tmp
  mkdir -p release_tmp
  cp plugin.json gemini-extension.json package.json ARCHITECTURE.md hud.mjs collector.mjs fence.mjs install.mjs README.md README_zh.md release_tmp/
  for dir in dist runtime scripts skills src; do
    [ -d "$dir" ] && cp -r "$dir" release_tmp/ || true
  done
  rm -f agy-hud.zip
  if command -v zip >/dev/null 2>&1; then
    (cd release_tmp && zip -qr ../agy-hud.zip .)
  elif command -v python3 >/dev/null 2>&1; then
    python3 - <<'PY'
import os, zipfile
with zipfile.ZipFile('agy-hud.zip', 'w', zipfile.ZIP_DEFLATED) as zf:
    for root, _, files in os.walk('release_tmp'):
        for name in sorted(files):
            full = os.path.join(root, name)
            rel = os.path.relpath(full, 'release_tmp')
            zf.write(full, rel)
PY
  else
    echo "agy-hud release.sh: neither 'zip' nor 'python3' is available" >&2
    exit 1
  fi
  rm -rf release_tmp
}

# 2. E2E gate
if [ "${SKIP_E2E:-}" != "1" ]; then
  echo "🧪 Running E2E verify-display..."
  build_zip

  AGY_HUD_SKIP_BUILD=1 node scripts/verify-display.js --observe-timeout-ms=30000 > /tmp/release-e2e.json 2>&1
  E2E_OK=$(node -e "import fs from 'node:fs'; console.log(JSON.parse(fs.readFileSync('/tmp/release-e2e.json','utf8')).ok)")
  if [ "$E2E_OK" != "true" ]; then
    echo "❌ E2E report.ok=$E2E_OK. Full report at /tmp/release-e2e.json"
    tail -40 /tmp/release-e2e.json
    exit 1
  fi
  echo "✅ E2E green: HUD rendered in real agy session"
else
  echo "⚠️  SKIP_E2E=1 set — E2E gate bypassed. Verify on real device before declaring live."
fi

# 3. Create standardized flattened .zip package
echo "🗜️  Creating flattened .zip package..."
build_zip

# 4. Create GitHub Release
if [ "${1:-}" = "--local" ] || [ "${SKIP_GH_RELEASE:-}" = "true" ]; then
  echo "⚠️  Skipping GitHub Release upload (local build only)."
  exit 0
fi

echo "🚀 Uploading to GitHub..."
gh release delete "v$VERSION" -R "$REPO_SLUG" --yes || true
git tag -d "v$VERSION" || true
git push origin :refs/tags/v$VERSION || true

gh release create "v$VERSION" agy-hud.zip -R "$REPO_SLUG" --title "Release v$VERSION" --notes "Official agy-hud plugin release v$VERSION."

echo "✅ Release v$VERSION is now live!"
echo "🔗 Permanent 'Latest' Install URL:"
echo "agy plugin install $REPO_URL/releases/latest/download/agy-hud.zip"
echo "🔗 Versioned Install URL:"
echo "agy plugin install $REPO_URL/releases/download/v$VERSION/agy-hud.zip"
