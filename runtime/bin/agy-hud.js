#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { getSessionState, parseAgyInput, parseAgyQuota } = require('../parser.js');
const { renderHUD } = require('../renderer.js');
const { loadConfig } = require('../config.js');
const {
  getQuota,
  getCachedTier,
  getCachedAccountEmail,
  readToken,
  readCacheSnapshot,
  mergeProviderQuota,
} = require('../quota.js');
const { hashCacheKey, getTokenHash } = require('../quota/cache.js');
const { enrichModelsWithQuotaSummary } = require('../quota/cloud.js');
const { resolveAntigravityPath } = require('../paths.js');

const DEFAULT_REPO_RAW = 'https://raw.githubusercontent.com/icebear0828/agy-hud/main';
const SELF_UPDATE_TIMEOUT_MS = 15000;
const SELF_UPDATE_MAX_REDIRECTS = 5;

function downloadToFile(url, destPath, redirectsLeft = SELF_UPDATE_MAX_REDIRECTS) {
  const http = require('http');
  const https = require('https');
  return new Promise((resolve, reject) => {
    const client = url.startsWith('http://') ? http : https;
    const req = client.get(url, { timeout: SELF_UPDATE_TIMEOUT_MS }, response => {
      const status = response.statusCode || 0;
      if (status >= 300 && status < 400 && response.headers.location && redirectsLeft > 0) {
        response.resume();
        const nextUrl = new URL(response.headers.location, url).toString();
        downloadToFile(nextUrl, destPath, redirectsLeft - 1).then(resolve, reject);
        return;
      }
      if (status !== 200) {
        response.resume();
        reject(new Error(`Failed to fetch bootstrap: ${status}`));
        return;
      }
      const fileStream = fs.createWriteStream(destPath);
      response.pipe(fileStream);
      fileStream.on('finish', () => {
        fileStream.close(err => (err ? reject(err) : resolve()));
      });
      fileStream.on('error', err => {
        response.destroy();
        reject(err);
      });
    });
    req.on('timeout', () => {
      req.destroy(new Error('Bootstrap download timed out'));
    });
    req.on('error', reject);
  });
}

async function handleSelfUpdate() {
  console.log('Checking for latest installer...');
  const repoRaw = (process.env.AGY_HUD_REPO_RAW || DEFAULT_REPO_RAW).replace(/\/+$/, '');
  const bootstrapUrl = `${repoRaw}/scripts/bootstrap.js`;
  const tempPath = path.join(os.tmpdir(), `agy-hud-bootstrap-${process.pid}-${Date.now()}.js`);

  try {
    await downloadToFile(bootstrapUrl, tempPath);

    console.log('Spawning update process in background...');
    const child = spawn(process.execPath, [tempPath, '--delay-start'], {
      detached: true,
      stdio: 'inherit',
      windowsHide: true,
    });
    child.unref();
    console.log('Update initiated. Exiting current process...');
    process.exit(0);
  } catch (err) {
    try { fs.unlinkSync(tempPath); } catch {}
    console.error(`Update failed: ${err.message}`);
    process.exit(1);
  }
}

function maybeCheckUpdates(updateStatusPath, existingStatus = null) {
  const statusPath = updateStatusPath || resolveAntigravityPath('agy-hud-update-status.json');
  const status = (existingStatus && typeof existingStatus === 'object') ? { ...existingStatus } : {};
  const lastCheck = typeof status.lastCheck === 'number' ? status.lastCheck : 0;

  const ONE_DAY_MS = 24 * 60 * 60 * 1000;
  if (Date.now() - lastCheck > ONE_DAY_MS) {
    status.lastCheck = Date.now();
    try {
      fs.mkdirSync(path.dirname(statusPath), { recursive: true, mode: 0o700 });
      fs.writeFileSync(statusPath, JSON.stringify(status, null, 2));
    } catch {}

    const checkerPath = path.join(__dirname, '..', 'update-checker.js');
    if (fs.existsSync(checkerPath)) {
      const checker = spawn(process.execPath, [checkerPath], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      checker.unref();
    }
  }
}

/**
 * Derive a verified account identity key for quota capacity tracking.
 * Uses sha256(email.toLowerCase()) from live token email (non-oauth-creds) or
 * token-matched cache payload accountEmail, falling back to tokenHash.
 * NEVER uses stale google_accounts.json or OS username.
 */
function resolveVerifiedAccountKey(tok, cacheSnapshot) {
  if (!tok) return null;
  const verifiedEmail = (tok.email && tok.sourceFormat !== 'oauth-creds')
    ? tok.email
    : getCachedAccountEmail(tok, cacheSnapshot);
  if (typeof verifiedEmail === 'string' && verifiedEmail.includes('@')) {
    return hashCacheKey(verifiedEmail.trim().toLowerCase());
  }
  return getTokenHash(tok);
}

async function main() {
  if (process.argv.includes('--update')) {
    await handleSelfUpdate();
    return;
  }

  if (process.argv.includes('--config')) {
    const { startWizard } = require('../config-wizard.js');
    await startWizard();
    return;
  }

  const stdinData = [];
  let hasHandled = false;

  // Hard cap: if neither 'end' nor enough data arrives within 1.5s, give up.
  // 1.5s tolerates slow Windows pipes that occasionally fail to emit 'end'
  // while still keeping the statusLine snappy.
  const timeout = setTimeout(() => handleInputAndRender(), 1500);

  async function handleInputAndRender() {
    if (hasHandled) return;
    hasHandled = true;
    clearTimeout(timeout);

    const inputStr = Buffer.concat(stdinData).toString();
    // agy on Windows can invoke the statusline before it has a payload ready.
    // Render a baseline HUD instead of returning an empty successful result.
    const agyData = inputStr.trim() ? parseAgyInput(inputStr) : null;

    const targetCwd = agyData?.workspace?.current_dir || agyData?.cwd || process.cwd();

    // Only construct fallback brain/<conversation_id>/... transcriptPath when
    // conversation_id is non-empty; otherwise keep null so unidentified sessions
    // don't collide in daily-cost / speed caches.
    let transcriptPath = (typeof agyData?.transcript_path === 'string' && agyData.transcript_path.trim())
      ? agyData.transcript_path.trim()
      : null;
    const conversationId = typeof agyData?.conversation_id === 'string'
      ? agyData.conversation_id.trim()
      : '';
    if ((!transcriptPath || !fs.existsSync(transcriptPath)) && conversationId) {
      const candidate = resolveAntigravityPath(path.join(
        'brain',
        conversationId,
        '.system_generated',
        'logs',
        'transcript.jsonl'
      ));
      if (fs.existsSync(candidate) || !transcriptPath) {
        transcriptPath = candidate;
      }
    }

    try {
      const config = await loadConfig(targetCwd);
      if (config && config.enabled === false) {
        process.exit(0);
        return;
      }

      const updateStatusPath = resolveAntigravityPath('agy-hud-update-status.json');
      let updateInfo = null;
      try {
        if (fs.existsSync(updateStatusPath)) {
          updateInfo = JSON.parse(fs.readFileSync(updateStatusPath, 'utf8'));
        }
      } catch {}

      // Read active token & quota cache snapshot once per HUD render (hot path
      // skips slow Windows Credential Manager / Linux keyring subprocesses).
      const tok = readToken({
        skipWindowsCredential: process.platform === 'win32',
        skipLinuxKeyring: process.platform === 'linux',
      });
      const cacheSnapshot = readCacheSnapshot();
      const showUsername = config?.display?.showUsername === true;

      const [state, quotaData] = await Promise.all([
        getSessionState(transcriptPath, targetCwd, {
          preloadedToken: tok,
          cacheSnapshot,
          skipUsername: !showUsername,
          skipCredentialSubprocess: true,
        }),
        getQuota({
          fast: true,
          preloadedToken: tok,
          cacheSnapshot,
        }).catch(() => []),
      ]);
      const tierName = getCachedTier(cacheSnapshot);

      let effectiveQuotaData = quotaData;
      // Authoritative live quota passed directly in stdin by agy CLI
      const stdinProviderQuota = parseAgyQuota(agyData?.quota);
      if (stdinProviderQuota) {
        if (Array.isArray(effectiveQuotaData)) {
          effectiveQuotaData = enrichModelsWithQuotaSummary(effectiveQuotaData, stdinProviderQuota);
          effectiveQuotaData.providerQuota = mergeProviderQuota(quotaData.providerQuota, stdinProviderQuota);
        }
      }

      state.accountKey = resolveVerifiedAccountKey(tok, cacheSnapshot);
      state.quotaSource = stdinProviderQuota ? 'stdin' : 'cache';

      const hudOutput = renderHUD(state, agyData, config, effectiveQuotaData, tierName, updateInfo);
      process.stdout.write(hudOutput);

      // Trigger background check for updates after writing output (reusing updateInfo)
      maybeCheckUpdates(updateStatusPath, updateInfo);
    } catch (err) {
      // Write debug error to Antigravity directory
      try {
        const errorLogPath = resolveAntigravityPath('agy-hud-error.log');
        fs.writeFileSync(errorLogPath, err.stack || String(err), { mode: 0o600 });
      } catch {}
    }
    process.exit(0);
  }

  process.stdin.on('error', () => {});
  process.stdin.on('data', chunk => stdinData.push(chunk));
  process.stdin.on('end', handleInputAndRender);
}

if (require.main === module) {
  main();
}

module.exports = {
  resolveVerifiedAccountKey,
  downloadToFile,
  maybeCheckUpdates,
};

