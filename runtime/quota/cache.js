'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { resolveAntigravityPath } = require('../paths.js');
const { mergeQuotaWindows, isObservationExpired } = require('./models.js');

const CACHE_PATH = resolveAntigravityPath('agy-hud-quota-cache.json');
const CACHE_VERSION = 3;

function isCachePayloadFresh(raw) {
  return raw &&
    raw.version === CACHE_VERSION &&
    raw.expiresAt &&
    Date.now() < raw.expiresAt &&
    Array.isArray(raw.data);
}

function hashCacheKey(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function normalizeTokenCacheInput(tokenOrAccessToken) {
  if (typeof tokenOrAccessToken === 'string') {
    return { accessToken: tokenOrAccessToken };
  }
  if (!tokenOrAccessToken || typeof tokenOrAccessToken !== 'object') {
    return null;
  }
  return tokenOrAccessToken;
}

function getTokenCacheIdentity(tokenOrAccessToken) {
  const token = normalizeTokenCacheInput(tokenOrAccessToken);
  if (!token) return null;

  if (token.sourcePath) {
    return `sourcePath:${path.resolve(token.sourcePath)}`;
  }

  if (token.sourceFormat) {
    return `sourceFormat:${token.sourceFormat}`;
  }

  if (token.accessToken) {
    return `accessToken:${token.accessToken}`;
  }

  return null;
}

function getTokenHash(tokenOrAccessToken) {
  const token = normalizeTokenCacheInput(tokenOrAccessToken);
  if (!token || !token.accessToken) return null;
  return hashCacheKey(token.accessToken);
}

function getTokenCacheKeyHash(tokenOrAccessToken) {
  const identity = getTokenCacheIdentity(tokenOrAccessToken);
  return identity ? hashCacheKey(identity) : null;
}

function doesCachePayloadMatchToken(raw, tokenOrAccessToken) {
  if (!raw || !Array.isArray(raw.data)) return false;

  const cacheKeyHash = getTokenCacheKeyHash(tokenOrAccessToken);
  if (raw.cacheKeyHash && cacheKeyHash && raw.cacheKeyHash === cacheKeyHash) {
    return true;
  }

  const tokenHash = getTokenHash(tokenOrAccessToken);
  return Boolean(raw.tokenHash && tokenHash && raw.tokenHash === tokenHash);
}

function didAccessTokenRotate(raw, tokenOrAccessToken) {
  const tokenHash = getTokenHash(tokenOrAccessToken);
  return Boolean(raw && raw.tokenHash && tokenHash && raw.tokenHash !== tokenHash);
}

/**
 * Deeply merge provider-level quota summaries (`google`, `claude`, `argon`),
 * merging per-provider `{ fiveHour, weekly }` windows without wiping sibling
 * windows and pruning expired observations.
 * @param {Object|null} prev
 * @param {Object|null} incoming
 * @param {number} [now]
 * @returns {Object|null}
 */
function mergeProviderQuota(prev, incoming, now = Date.now()) {
  const prevObj = prev && typeof prev === 'object' ? prev : null;
  const incObj = incoming && typeof incoming === 'object' ? incoming : null;
  if (!prevObj && !incObj) return null;

  const providers = new Set([
    ...(prevObj ? Object.keys(prevObj) : []),
    ...(incObj ? Object.keys(incObj) : []),
  ]);
  const merged = {};

  for (const provider of providers) {
    const prevProvider = prevObj && prevObj[provider] && typeof prevObj[provider] === 'object'
      ? prevObj[provider]
      : null;
    const incProvider = incObj && incObj[provider] && typeof incObj[provider] === 'object'
      ? incObj[provider]
      : null;
    const windows = {};

    if (prevProvider) {
      for (const [winKey, winVal] of Object.entries(prevProvider)) {
        if (winVal && typeof winVal === 'object' && !isObservationExpired(winVal, now)) {
          windows[winKey] = winVal;
        }
      }
    }
    if (incProvider) {
      for (const [winKey, winVal] of Object.entries(incProvider)) {
        if (winVal && typeof winVal === 'object' && !isObservationExpired(winVal, now)) {
          windows[winKey] = winVal;
        }
      }
    }

    if (Object.keys(windows).length > 0) {
      merged[provider] = windows;
    }
  }

  return Object.keys(merged).length > 0 ? merged : null;
}

/**
 * Read and parse the quota cache JSON file once. Returns null if missing/corrupt.
 * Callers can pass this snapshot into readCachePayload / getCachedTier /
 * getCachedAccountEmail / readCacheLastRefreshed / readCacheFallback to avoid
 * redundant synchronous disk reads per render.
 */
function readCacheSnapshot() {
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    return raw && typeof raw === 'object' ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Read cached quota if still valid.
 * @param {string|Object} tokenOrAccessToken
 * @param {Object|null} [snapshot]
 * @returns {ModelQuota[] | null}
 */
function readCache(tokenOrAccessToken, snapshot = undefined) {
  try {
    const raw = snapshot !== undefined ? snapshot : readCacheSnapshot();
    if (!isCachePayloadFresh(raw)) return null;
    if (!doesCachePayloadMatchToken(raw, tokenOrAccessToken)) return null;
    if (raw.providerQuota && Array.isArray(raw.data)) {
      raw.data.providerQuota = raw.providerQuota;
    }
    return raw.data;
  } catch {
    return null;
  }
}

/**
 * Read the previous cache payload (any token) for merging the other window's
 * last observation. Tier and per-window state are account-level, so we
 * intentionally skip the token-match check used by readCache.
 */
function readCacheRaw(snapshot = undefined) {
  try {
    const raw = snapshot !== undefined ? snapshot : readCacheSnapshot();
    if (!raw || !Array.isArray(raw.data)) return null;
    return raw;
  } catch {
    return null;
  }
}

/**
 * Write quota cache. Expires at the earliest resetTime among all buckets.
 * Uses atomic write (tmp + rename) to prevent concurrent readers from seeing
 * truncated/empty content — the main fix for statusline quota flicker.
 * Merges with the previous payload so the window not present in this response
 * (e.g. 5-hour when the API returns weekly) keeps its last observation, but
 * only when the cache belongs to the same credential identity (token rotation
 * is fine, account switch is not).
 */
function writeCache(data, tokenOrAccessToken, tier = null, accountEmail = null, providerQuota = null) {
  const now = Date.now();
  const previousRaw = readCacheRaw();
  let sameIdentity = previousRaw && doesCachePayloadMatchToken(previousRaw, tokenOrAccessToken);
  // The OAuth token file path is shared across accounts on one machine, so an
  // access-token rotation (same account) and an account switch look identical
  // at the token level (same cacheKeyHash, different tokenHash). The account
  // email disambiguates them: when the previous and the fresh email are both
  // known and differ, this is a switch — treat it as a new identity so the
  // previous account's windows / tier / email cannot leak into this one.
  if (sameIdentity && accountEmail && previousRaw.accountEmail &&
      accountEmail !== previousRaw.accountEmail) {
    sameIdentity = false;
  }
  const previousData = sameIdentity ? previousRaw.data : [];
  const merged = mergeQuotaWindows(data, previousData, now);

  const incomingProviderQuota = providerQuota || data?.providerQuota || null;
  const previousProviderQuota = sameIdentity && previousRaw?.providerQuota ? previousRaw.providerQuota : null;
  const resolvedProviderQuota = mergeProviderQuota(previousProviderQuota, incomingProviderQuota, now);

  // Find earliest future resetTime across top-level, each merged window, AND
  // resolvedProviderQuota — a preserved 5-hour observation can reset well
  // before the weekly top-level, and past resetTimes must be ignored so they
  // cannot pin expiresAt <= now and cause perpetual refresh churn.
  let earliest = Infinity;
  const considerResetTime = (value) => {
    if (!value) return;
    const t = new Date(value).getTime();
    if (Number.isFinite(t) && t > now && t < earliest) earliest = t;
  };
  for (const m of merged) {
    considerResetTime(m.resetTime);
    considerResetTime(m.windows?.fiveHour?.resetTime);
    considerResetTime(m.windows?.weekly?.resetTime);
  }
  if (resolvedProviderQuota) {
    for (const provider of Object.values(resolvedProviderQuota)) {
      if (!provider || typeof provider !== 'object') continue;
      considerResetTime(provider.fiveHour?.resetTime);
      considerResetTime(provider.weekly?.resetTime);
    }
  }
  const maxFreshDuration = 2 * 60 * 1000;
  let expiresAt = now + maxFreshDuration;
  if (isFinite(earliest) && earliest < expiresAt) {
    expiresAt = earliest;
  }
  const cacheKeyHash = getTokenCacheKeyHash(tokenOrAccessToken);
  const tokenHash = getTokenHash(tokenOrAccessToken);
  // Preserve the previously cached tier when the caller passes null and the
  // cache belongs to the same identity — fetchTierFromCloud transient failures
  // must not wipe 'Google AI Pro' down to 'Free'.
  const resolvedTier = tier || (sameIdentity ? (previousRaw.tier || null) : null);
  const resolvedEmail = accountEmail || (sameIdentity ? (previousRaw.accountEmail || null) : null);
  const payload = {
    version: CACHE_VERSION,
    expiresAt,
    lastRefreshed: now,
    cacheKeyHash,
    tokenHash,
    tier: resolvedTier,
    accountEmail: resolvedEmail,
    providerQuota: resolvedProviderQuota,
    data: merged,
  };
  const tmpPath = `${CACHE_PATH}.tmp.${process.pid}`;
  try {
    fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true, mode: 0o700 });
    fs.writeFileSync(tmpPath, JSON.stringify(payload), { mode: 0o600 });
    fs.renameSync(tmpPath, CACHE_PATH);
  } catch {
    try { fs.unlinkSync(tmpPath); } catch {}
  }
}

/**
 * Read the cached tier name without requiring a token match.
 * Tier is account-level, not token-level, so we skip token matching.
 * @param {Object|null} [snapshot]
 */
function getCachedTier(snapshot = undefined) {
  try {
    const raw = snapshot !== undefined ? snapshot : readCacheSnapshot();
    return raw?.tier || null;
  } catch {
    return null;
  }
}

/**
 * Read the cached active-account email, but ONLY when the cache belongs to the
 * current token. Unlike tier, a wrong email is worse than none: after an account
 * switch the token no longer matches, so we return null (caller falls back) and
 * let the background refresh repopulate it for the new account.
 * @param {string|Object} tokenOrAccessToken
 * @param {Object|null} [snapshot]
 * @returns {string|null}
 */
function getCachedAccountEmail(tokenOrAccessToken, snapshot = undefined) {
  try {
    const raw = snapshot !== undefined ? snapshot : readCacheSnapshot();
    if (!raw || !raw.accountEmail) return null;
    if (!doesCachePayloadMatchToken(raw, tokenOrAccessToken)) return null;
    return raw.accountEmail;
  } catch {
    return null;
  }
}

function readCachePayload(tokenOrAccessToken, snapshot = undefined) {
  try {
    const raw = snapshot !== undefined ? snapshot : readCacheSnapshot();
    if (!doesCachePayloadMatchToken(raw, tokenOrAccessToken)) return null;
    if (raw.providerQuota && Array.isArray(raw.data)) {
      raw.data.providerQuota = raw.providerQuota;
    }
    return raw;
  } catch {
    return null;
  }
}

// Read lastRefreshed without requiring token match — used to debounce
// background refresh storms when the caller's token doesn't match the cache.
function readCacheLastRefreshed(snapshot = undefined) {
  try {
    const raw = snapshot !== undefined ? snapshot : readCacheSnapshot();
    return raw?.lastRefreshed || 0;
  } catch {
    return 0;
  }
}

// Return any readable cache payload regardless of token — fallback for
// transient token-read failures to avoid flashing "not logged in".
function readCacheFallback(snapshot = undefined) {
  try {
    const raw = snapshot !== undefined ? snapshot : readCacheSnapshot();
    if (!raw || !Array.isArray(raw.data) || raw.version !== CACHE_VERSION) return null;
    if (raw.providerQuota && Array.isArray(raw.data)) {
      raw.data.providerQuota = raw.providerQuota;
    }
    return raw;
  } catch {
    return null;
  }
}

module.exports = {
  CACHE_PATH,
  CACHE_VERSION,
  isCachePayloadFresh,
  hashCacheKey,
  getTokenCacheIdentity,
  getTokenHash,
  getTokenCacheKeyHash,
  doesCachePayloadMatchToken,
  didAccessTokenRotate,
  mergeProviderQuota,
  readCacheSnapshot,
  readCache,
  readCacheRaw,
  writeCache,
  getCachedTier,
  getCachedAccountEmail,
  readCachePayload,
  readCacheLastRefreshed,
  readCacheFallback,
};
