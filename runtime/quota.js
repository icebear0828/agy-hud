/**
 * quota.js — Real account-level quota fetcher (orchestrator).
 *
 * Calls the same `fetchAvailableModels` endpoint that agy uses for /usage.
 * Token is auto-discovered from known agy app-data locations across platforms.
 * Results are cached to os.tmpdir()/agy-hud-quota-cache.json. The cache key is
 * the stable credential source when available, so access-token rotation does
 * not hide a still-fresh quota cache from the statusline.
 *
 * Submodules:
 *   ./quota/token.js  — OAuth file + Windows Credential Manager + temp mirror
 *   ./quota/cache.js  — atomic cache read/write, token-keyed match
 *   ./quota/cloud.js  — fetchAvailableModels + loadCodeAssist HTTP calls
 *   ./quota/models.js — model-id discovery, deprecation map, quota normalize
 */

'use strict';

const path = require('path');
const { spawn } = require('child_process');
const { getAntigravityRoots } = require('./paths.js');

const tokenMod = require('./quota/token.js');
const cacheMod = require('./quota/cache.js');
const cloudMod = require('./quota/cloud.js');
const modelsMod = require('./quota/models.js');

const {
  readToken,
  readWindowsCredentialTokens,
  isTokenExpired,
  anyTokenFileExists,
} = tokenMod;
const {
  CACHE_PATH,
  isCachePayloadFresh,
  readCachePayload,
  readCacheLastRefreshed,
  readCacheFallback,
  didAccessTokenRotate,
  writeCache,
} = cacheMod;
const { fetchQuotaFromCloud, fetchTierFromCloud, fetchAccountEmail } = cloudMod;
const { createUnavailableQuotaResult } = modelsMod;

const WINDOWS_CREDENTIAL_REFRESH_DEBOUNCE_MS = 30 * 1000;
let lastWindowsCredentialRefreshAt = 0;

function triggerBackgroundRefresh() {
  try {
    const subprocess = spawn(process.execPath, [
      path.join(__dirname, 'quota.js'),
      '--refresh',
    ], {
      detached: true,
      stdio: 'ignore',
    });
    subprocess.unref();
  } catch { /* ignore spawning issues */ }
}

function triggerWindowsCredentialRefresh(backgroundRefresh, now, debounceMs) {
  if (now - lastWindowsCredentialRefreshAt < debounceMs) return;
  lastWindowsCredentialRefreshAt = now;
  backgroundRefresh();
}

/**
 * Get quota data using a non-blocking Stale-While-Revalidate pattern.
 * @returns {Promise<ModelQuota[]>}
 */
async function getQuota(options = {}) {
  const {
    fast = false,
    platform = process.platform,
    tokenReader = readToken,
    backgroundRefresh = triggerBackgroundRefresh,
    credentialReader = readWindowsCredentialTokens,
    roots = getAntigravityRoots(),
    windowsCredentialRefreshDebounceMs = WINDOWS_CREDENTIAL_REFRESH_DEBOUNCE_MS,
  } = options;
  const shouldRefreshWindowsCredential = fast && platform === 'win32';
  const refreshWindowsCredential = () => {
    if (!shouldRefreshWindowsCredential) return;
    triggerWindowsCredentialRefresh(backgroundRefresh, Date.now(), windowsCredentialRefreshDebounceMs);
  };
  const tok = tokenReader({
    platform,
    roots,
    credentialReader,
    skipWindowsCredential: fast && platform === 'win32',
  });
  if (!tok) {
    // Token file exists but failed to parse → transient (OAuth mid-refresh).
    // Return fresh cache rather than flashing "not logged in".
    // Token file absent → genuine logout, skip fallback.
    if (anyTokenFileExists(roots)) {
      const fallback = readCacheFallback();
      if (fallback && isCachePayloadFresh(fallback)) {
        return fallback.data;
      }
    }
    refreshWindowsCredential();
    return createUnavailableQuotaResult('not_logged_in');
  }

  // For multi-account (Windows Credential Manager), use the primary token for
  // cache keying but fall back to alternates if the primary has no cache.
  const payload = readCachePayload(tok) ||
    (tok.all && tok.all.slice(1).reduce((acc, t) => acc || readCachePayload(t), null));
  const isFresh = payload && isCachePayloadFresh(payload);
  const tokenExpired = isTokenExpired(tok);
  const needsRefresh = !tokenExpired && (!isFresh || didAccessTokenRotate(payload, tok));

  if (needsRefresh) {
    // Read lastRefreshed from cache even when payload doesn't match our token,
    // to prevent a storm of concurrent background refresh processes.
    const lastRefreshed = payload
      ? payload.lastRefreshed || 0
      : readCacheLastRefreshed();
    // Debounce stale/no-cache refreshes, but refresh immediately when a fresh
    // cache belongs to the same source and only the access token has rotated.
    if (didAccessTokenRotate(payload, tok) || Date.now() - lastRefreshed > 30 * 1000) {
      backgroundRefresh();
    }
  }

  if (payload) {
    return payload.data;
  }

  if (tokenExpired) {
    refreshWindowsCredential();
    return createUnavailableQuotaResult('expired_token');
  }

  // Fallback to any readable cache payload on disk to prevent "Quota loading" flicker
  // while we perform a background refresh for the current token.
  const fallback = readCacheFallback();
  if (fallback) {
    return fallback.data;
  }

  // If no cache exists at all, return empty. Non-fast callers trigger the
  // refresh above; statusline fast path stays bounded and never waits on it.
  return [];
}

// ─── CLI Execution for background refreshes ──────────────────────────────────
if (process.argv.includes('--refresh')) {
  (async () => {
    try {
      const tok = readToken();
      if (tok) {
        const [fresh, tier, accountEmail] = await Promise.all([
          fetchQuotaFromCloud(tok.accessToken),
          fetchTierFromCloud(tok.accessToken),
          fetchAccountEmail(tok.accessToken),
        ]);
        // Write when we got quota OR an email: an ineligible/just-switched
        // account may return no quota yet still needs its email cached.
        if (fresh.length > 0 || accountEmail) {
          writeCache(fresh, tok, tier, accountEmail);
        }
      }
    } catch {}
    process.exit(0);
  })();
}

module.exports = {
  // orchestrator
  getQuota,
  // cache module
  CACHE_PATH,
  isCachePayloadFresh,
  readCache: cacheMod.readCache,
  writeCache,
  readCachePayload,
  readCacheLastRefreshed,
  readCacheFallback,
  getCachedTier: cacheMod.getCachedTier,
  getCachedAccountEmail: cacheMod.getCachedAccountEmail,
  // token module
  readToken,
  readWindowsCredentialTokens,
  readLinuxKeyringTokens: tokenMod.readLinuxKeyringTokens,
  probeLinuxKeyringAvailability: tokenMod.probeLinuxKeyringAvailability,
  isTokenExpired,
  getTokenCandidates: tokenMod.getTokenCandidates,
  parseTokenPayload: tokenMod.parseTokenPayload,
  selectUsableTokens: tokenMod.selectUsableTokens,
  anyTokenFileExists,
  // cloud module
  fetchQuotaFromCloud,
  fetchTierFromCloud,
  fetchAccountEmail,
  extractTierName: cloudMod.extractTierName,
  // models module
  normalizeQuotaModels: modelsMod.normalizeQuotaModels,
  discoverAgentModelIds: modelsMod.discoverAgentModelIds,
  resolveDeprecatedIds: modelsMod.resolveDeprecatedIds,
  classifyQuotaWindow: modelsMod.classifyQuotaWindow,
  isObservationExpired: modelsMod.isObservationExpired,
  pruneExpiredWindows: modelsMod.pruneExpiredWindows,
  mergeQuotaWindows: modelsMod.mergeQuotaWindows,
  pickCriticalWindow: modelsMod.pickCriticalWindow,
  FIVE_HOUR_WINDOW_THRESHOLD_MS: modelsMod.FIVE_HOUR_WINDOW_THRESHOLD_MS,
  createUnavailableQuotaResult,
};
