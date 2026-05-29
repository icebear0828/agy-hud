'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { resolveAntigravityPath } = require('../paths.js');
const { mergeQuotaWindows } = require('./models.js');

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
 * Read cached quota if still valid.
 * @param {string|Object} tokenOrAccessToken
 * @returns {ModelQuota[] | null}
 */
function readCache(tokenOrAccessToken) {
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    if (!isCachePayloadFresh(raw)) return null;
    if (!doesCachePayloadMatchToken(raw, tokenOrAccessToken)) return null;
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
function readCacheRaw() {
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
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
function writeCache(data, tokenOrAccessToken, tier = null, accountEmail = null) {
  const now = Date.now();
  const previousRaw = readCacheRaw();
  const sameIdentity = previousRaw && doesCachePayloadMatchToken(previousRaw, tokenOrAccessToken);
  const previousData = sameIdentity ? previousRaw.data : [];
  const merged = mergeQuotaWindows(data, previousData, now);

  // Find earliest resetTime across top-level AND each merged window — a
  // preserved 5-hour observation can reset well before the weekly top-level,
  // and we must refresh by then or risk serving a stale fiveHour.
  let earliest = Infinity;
  const considerResetTime = (value) => {
    if (!value) return;
    const t = new Date(value).getTime();
    if (Number.isFinite(t) && t < earliest) earliest = t;
  };
  for (const m of merged) {
    considerResetTime(m.resetTime);
    considerResetTime(m.windows?.fiveHour?.resetTime);
    considerResetTime(m.windows?.weekly?.resetTime);
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
  // Same as tier: account-level, preserved across token rotation but dropped on
  // an account switch (different identity) so a stale email never outlives it.
  const resolvedEmail = accountEmail || (sameIdentity ? (previousRaw.accountEmail || null) : null);
  const payload = {
    version: CACHE_VERSION,
    expiresAt,
    lastRefreshed: now,
    cacheKeyHash,
    tokenHash,
    tier: resolvedTier,
    accountEmail: resolvedEmail,
    data: merged,
  };
  try {
    const tmpPath = `${CACHE_PATH}.tmp.${process.pid}`;
    fs.writeFileSync(tmpPath, JSON.stringify(payload), { mode: 0o600 });
    fs.renameSync(tmpPath, CACHE_PATH);
  } catch {
    try { fs.unlinkSync(`${CACHE_PATH}.tmp.${process.pid}`); } catch {}
  }
}

/**
 * Read the cached tier name without requiring a token match.
 * Tier is account-level, not token-level, so we skip token matching.
 */
function getCachedTier() {
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    return raw.tier || null;
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
 * @returns {string|null}
 */
function getCachedAccountEmail(tokenOrAccessToken) {
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    if (!raw || !raw.accountEmail) return null;
    if (!doesCachePayloadMatchToken(raw, tokenOrAccessToken)) return null;
    return raw.accountEmail;
  } catch {
    return null;
  }
}

function readCachePayload(tokenOrAccessToken) {
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    if (!doesCachePayloadMatchToken(raw, tokenOrAccessToken)) return null;
    return raw;
  } catch {
    return null;
  }
}

// Read lastRefreshed without requiring token match — used to debounce
// background refresh storms when the caller's token doesn't match the cache.
function readCacheLastRefreshed() {
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    return raw.lastRefreshed || 0;
  } catch {
    return 0;
  }
}

// Return any readable cache payload regardless of token — fallback for
// transient token-read failures to avoid flashing "not logged in".
function readCacheFallback() {
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    if (!raw || !Array.isArray(raw.data) || raw.version !== CACHE_VERSION) return null;
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
  readCache,
  readCacheRaw,
  writeCache,
  getCachedTier,
  getCachedAccountEmail,
  readCachePayload,
  readCacheLastRefreshed,
  readCacheFallback,
};
