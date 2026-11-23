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

const fs = require('fs');
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
  readCacheSnapshot,
  readCachePayload,
  readCacheLastRefreshed,
  readCacheFallback,
  didAccessTokenRotate,
  mergeProviderQuota,
  writeCache,
} = cacheMod;
const { fetchQuotaFromCloud, fetchTierFromCloud, fetchAccountEmail } = cloudMod;
const { createUnavailableQuotaResult } = modelsMod;

const REFRESH_DEBOUNCE_MS = 30 * 1000;
const WINDOWS_CREDENTIAL_REFRESH_DEBOUNCE_MS = REFRESH_DEBOUNCE_MS;
const REFRESH_LOCK_PATH = path.join(path.dirname(CACHE_PATH), 'agy-hud-refresh.lock');

function readRefreshLockTimestamp(lockPath = REFRESH_LOCK_PATH) {
  try {
    const raw = fs.readFileSync(lockPath, 'utf8').trim();
    if (!raw) return 0;
    const asNum = Number(raw);
    if (Number.isFinite(asNum) && asNum > 0) return asNum;
    const parsed = JSON.parse(raw);
    return typeof parsed?.ts === 'number' && Number.isFinite(parsed.ts) ? parsed.ts : 0;
  } catch {
    return 0;
  }
}

function writeRefreshLockTimestamp(lockPath = REFRESH_LOCK_PATH, now = Date.now()) {
  const tmpPath = `${lockPath}.tmp.${process.pid}.${now}`;
  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(tmpPath, String(now), { mode: 0o600 });
    fs.renameSync(tmpPath, lockPath);
  } catch {
    try { fs.unlinkSync(tmpPath); } catch {}
  }
}

function tryAcquireRefreshLock(lockPath = REFRESH_LOCK_PATH, now = Date.now(), ttlMs = REFRESH_DEBOUNCE_MS) {
  if (ttlMs > 0) {
    const prev = readRefreshLockTimestamp(lockPath);
    if (prev > 0 && now - prev < ttlMs) {
      return false;
    }
  }
  writeRefreshLockTimestamp(lockPath, now);
  return true;
}

function triggerBackgroundRefresh() {
  try {
    const subprocess = spawn(process.execPath, [
      path.join(__dirname, 'quota.js'),
      '--refresh',
    ], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    subprocess.unref();
  } catch { /* ignore spawning issues */ }
}

function triggerCredentialRefresh(backgroundRefresh, now, debounceMs, lockPath) {
  if (!tryAcquireRefreshLock(lockPath, now, debounceMs)) return;
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
    preloadedToken = undefined,
    cacheSnapshot: providedCacheSnapshot = undefined,
    backgroundRefresh = triggerBackgroundRefresh,
    credentialReader = readWindowsCredentialTokens,
    keyringReader = tokenMod.readLinuxKeyringTokens,
    keychainReader = tokenMod.readMacosKeychainTokens,
    roots = getAntigravityRoots(),
    refreshLockPath = REFRESH_LOCK_PATH,
    refreshDebounceMs = REFRESH_DEBOUNCE_MS,
    windowsCredentialRefreshDebounceMs = WINDOWS_CREDENTIAL_REFRESH_DEBOUNCE_MS,
    now = Date.now(),
  } = options;
  const shouldRefreshWindowsCredential = fast && platform === 'win32';
  const shouldRefreshLinuxKeyring = fast && platform === 'linux';
  const refreshWindowsCredential = () => {
    if (!shouldRefreshWindowsCredential) return;
    triggerCredentialRefresh(backgroundRefresh, now, windowsCredentialRefreshDebounceMs, refreshLockPath);
  };
  const refreshLinuxKeyring = () => {
    if (!shouldRefreshLinuxKeyring) return;
    triggerCredentialRefresh(backgroundRefresh, now, refreshDebounceMs, refreshLockPath);
  };

  const tok = preloadedToken !== undefined
    ? preloadedToken
    : tokenReader({
        platform,
        roots,
        credentialReader,
        keyringReader,
        keychainReader,
        skipWindowsCredential: fast && platform === 'win32',
        skipLinuxKeyring: fast && platform === 'linux',
      });

  const cacheSnapshot = providedCacheSnapshot !== undefined
    ? providedCacheSnapshot
    : readCacheSnapshot();

  if (!tok) {
    // Token file exists but failed to parse → transient (OAuth mid-refresh).
    // Return fresh cache rather than flashing "not logged in".
    // Token file absent → genuine logout, skip fallback.
    if (anyTokenFileExists(roots)) {
      const fallback = readCacheFallback(cacheSnapshot);
      if (fallback && isCachePayloadFresh(fallback)) {
        return fallback.data;
      }
    }
    refreshWindowsCredential();
    refreshLinuxKeyring();
    return createUnavailableQuotaResult('not_logged_in');
  }

  // For multi-account (Windows Credential Manager), use the primary token for
  // cache keying but fall back to alternates if the primary has no cache.
  const payload = readCachePayload(tok, cacheSnapshot) ||
    (tok.all && tok.all.slice(1).reduce((acc, t) => acc || readCachePayload(t, cacheSnapshot), null));
  const isFresh = payload && isCachePayloadFresh(payload);
  const tokenExpired = isTokenExpired(tok, now);
  const needsRefresh = !tokenExpired && (!isFresh || didAccessTokenRotate(payload, tok));

  if (needsRefresh) {
    // Read lastRefreshed from cache even when payload doesn't match our token,
    // to prevent a storm of concurrent background refresh processes.
    const lastRefreshed = payload
      ? payload.lastRefreshed || 0
      : readCacheLastRefreshed(cacheSnapshot);
    // Debounce stale/no-cache refreshes, and guard all spawns (including
    // rotated tokens and offline failures) with an on-disk attempt lock so
    // rapid statusline renders cannot cause a concurrent refresh storm.
    const cacheDebouncePassed = didAccessTokenRotate(payload, tok) || now - lastRefreshed > refreshDebounceMs;
    if (cacheDebouncePassed && tryAcquireRefreshLock(refreshLockPath, now, refreshDebounceMs)) {
      backgroundRefresh();
    }
  }

  if (payload && (!tokenExpired || isFresh)) {
    return payload.data;
  }

  if (tokenExpired) {
    refreshWindowsCredential();
    return createUnavailableQuotaResult('expired_token');
  }

  // Fallback to any readable cache payload on disk to prevent "Quota loading" flicker
  // while we perform a background refresh for the current token.
  const fallback = readCacheFallback(cacheSnapshot);
  if (fallback) {
    return fallback.data;
  }

  // If no cache exists at all, return empty. Non-fast callers trigger the
  // refresh above; statusline fast path stays bounded and never waits on it.
  return [];
}

/**
 * Execute a full background refresh: read live token, fetch quota/tier/email,
 * and persist to cache. Does NOT overwrite cache when quota fetch fails
 * (e.g. `quota_fetch_failed`), even if `accountEmail` succeeded.
 */
async function refreshQuotaCache(deps = {}) {
  const {
    readTokenFn = readToken,
    fetchQuotaFn = fetchQuotaFromCloud,
    fetchTierFn = fetchTierFromCloud,
    fetchEmailFn = fetchAccountEmail,
    writeCacheFn = writeCache,
    clearTokenTempFn = tokenMod.clearTokenTemp,
  } = deps;

  const tok = readTokenFn();
  if (!tok) return false;

  const candidates = Array.isArray(tok.all) && tok.all.length > 0
    ? tok.all.map((t, idx) => (idx === 0 ? tok : { ...tok, ...t }))
    : [tok];

  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i];
    const [fresh, tier, accountEmail] = await Promise.all([
      fetchQuotaFn(candidate.accessToken),
      fetchTierFn(candidate.accessToken),
      fetchEmailFn(candidate.accessToken),
    ]);
    if (fresh && fresh.unavailableReason === 'auth_failed') {
      if (i < candidates.length - 1) continue;
      clearTokenTempFn();
      return false;
    }
    if (fresh && fresh.unavailableReason) {
      return false;
    }
    if ((Array.isArray(fresh) && fresh.length > 0) || accountEmail) {
      writeCacheFn(fresh, candidate, tier, accountEmail, fresh?.providerQuota);
      return true;
    }
    return false;
  }
  return false;
}

// ─── CLI Execution for background refreshes ──────────────────────────────────
if (process.argv.includes('--refresh')) {
  (async () => {
    try {
      await refreshQuotaCache();
    } catch {}
    process.exit(0);
  })();
}

module.exports = {
  // orchestrator
  getQuota,
  refreshQuotaCache,
  REFRESH_LOCK_PATH,
  REFRESH_DEBOUNCE_MS,
  tryAcquireRefreshLock,
  // cache module
  CACHE_PATH,
  isCachePayloadFresh,
  readCacheSnapshot,
  readCache: cacheMod.readCache,
  writeCache,
  mergeProviderQuota,
  readCachePayload,
  readCacheLastRefreshed,
  readCacheFallback,
  getCachedTier: cacheMod.getCachedTier,
  getCachedAccountEmail: cacheMod.getCachedAccountEmail,
  // token module
  readToken,
  clearTokenTemp: tokenMod.clearTokenTemp,
  readWindowsCredentialTokens,
  normalizeWindowsCredentialTokens: tokenMod.normalizeWindowsCredentialTokens,
  readLinuxKeyringTokens: tokenMod.readLinuxKeyringTokens,
  probeLinuxKeyringAvailability: tokenMod.probeLinuxKeyringAvailability,
  readMacosKeychainTokens: tokenMod.readMacosKeychainTokens,
  probeMacosKeychainAvailability: tokenMod.probeMacosKeychainAvailability,
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
  parseQuotaSummary: cloudMod.parseQuotaSummary,
  enrichModelsWithQuotaSummary: cloudMod.enrichModelsWithQuotaSummary,
  fetchUserQuotaSummaryFromCloud: cloudMod.fetchUserQuotaSummaryFromCloud,
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
