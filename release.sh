#!/bin/bash

# agy-hud Official Release Script
set -e

VERSION=$(node -e "console.log(require('./package.json').version)")
REPO_URL=$(node -e "
  const r = require('./package.json').repository;
  if (!r || !r.url) { console.error('package.json missing repository.url'); process.exit(1); }
  console.log(r.url.replace(/^git\+/, '').replace(/\.git$/, ''));
")
echo "📦 Preparing release v$VERSION..."

# 1. Run tests
npm test

# 2. E2E gate: agy plugin install + bootstrap + spawn agy in PTY + assert the
#    HUD structure rendered in real session. mock unit-test green ≠ E2E green (CLAUDE.md rule).
#    Skip only with SKIP_E2E=1 for emergency hotfixes — never silently.
if [ "$SKIP_E2E" != "1" ]; then
  echo "🧪 Running E2E verify-display..."
  # Build the zip first so verify-display can serve it without recursing back
  # into release.sh.
  echo "  (pre-build zip for E2E)"
  rm -rf release_tmp
  mkdir -p release_tmp
  cp plugin.json gemini-extension.json package.json README.md README_zh.md release_tmp/
  [ -d runtime ] && cp -r runtime release_tmp/ || true
  [ -d scripts ] && cp -r scripts release_tmp/ || true
  [ -d skills ] && cp -r skills release_tmp/ || true
  cd release_tmp; rm -f ../agy-hud.zip; zip -qr ../agy-hud.zip .; cd ..
  rm -rf release_tmp

  AGY_HUD_SKIP_BUILD=1 node scripts/verify-display.js --observe-timeout-ms=30000 > /tmp/release-e2e.json 2>&1
  E2E_RC=$?
  if [ $E2E_RC -ne 0 ]; then
    echo "❌ E2E failed (exit $E2E_RC). Full report at /tmp/release-e2e.json"
    tail -40 /tmp/release-e2e.json
    exit 1
  fi
  E2E_OK=$(node -e "console.log(require('/tmp/release-e2e.json').ok)")
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
rm -rf release_tmp
mkdir -p release_tmp
# Copy only whitelisted files.
# plugin.json is the declarative plugin marker staged from the zip;
# runtime/ + scripts/ are downloaded fresh by bootstrap on each install,
# so they are bundled in the zip only as a fallback source.
cp plugin.json gemini-extension.json package.json README.md README_zh.md release_tmp/
[ -d runtime ] && cp -r runtime release_tmp/ || true
[ -d scripts ] && cp -r scripts release_tmp/ || true
[ -d skills ] && cp -r skills release_tmp/ || true

cd release_tmp
rm -f ../agy-hud.zip
zip -r ../agy-hud.zip .
cd ..
rm -rf release_tmp

# 4. Create GitHub Release
if [ "$1" == "--local" ] || [ "$SKIP_GH_RELEASE" == "true" ]; then
  echo "⚠️  Skipping GitHub Release upload (local build only)."
  exit 0
fi

echo "🚀 Uploading to GitHub..."
gh release delete "v$VERSION" --yes || true
git tag -d "v$VERSION" || true
git push origin :refs/tags/v$VERSION || true

gh release create "v$VERSION" agy-hud.zip --title "Release v$VERSION" --notes "Official agy-hud plugin release in flattened .zip format."

echo "✅ Release v$VERSION is now live!"
echo "🔗 Permanent 'Latest' Install URL:"
echo "agy plugin install $REPO_URL/releases/latest/download/agy-hud.zip"
echo "🔗 Versioned Install URL:"
echo "agy plugin install $REPO_URL/releases/download/v$VERSION/agy-hud.zip"
