'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { resolveAntigravityPath } = require('../paths.js');

const CACHE_PATH = resolveAntigravityPath('agy-hud-quota-cache.json');
const CACHE_VERSION = 2;

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
 * Write quota cache. Expires at the earliest resetTime among all buckets.
 * Uses atomic write (tmp + rename) to prevent concurrent readers from seeing
 * truncated/empty content — the main fix for statusline quota flicker.
 * @param {ModelQuota[]} data
 * @param {string|Object} tokenOrAccessToken
 */
function writeCache(data, tokenOrAccessToken, tier = null) {
  let earliest = Infinity;
  for (const m of data) {
    if (m.resetTime) {
      const t = new Date(m.resetTime).getTime();
      if (t < earliest) earliest = t;
    }
  }
  // Cache should not stay "fresh" longer than 2 minutes to ensure we fetch updated quotas frequently,
  // but it must expire at the earliest resetTime.
  const maxFreshDuration = 2 * 60 * 1000;
  let expiresAt = Date.now() + maxFreshDuration;
  if (isFinite(earliest) && earliest < expiresAt) {
    expiresAt = earliest;
  }
  const cacheKeyHash = getTokenCacheKeyHash(tokenOrAccessToken);
  const tokenHash = getTokenHash(tokenOrAccessToken);
  const payload = {
    version: CACHE_VERSION,
    expiresAt,
    lastRefreshed: Date.now(),
    cacheKeyHash,
    tokenHash,
    tier: tier || null,
    data,
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
  writeCache,
  getCachedTier,
  readCachePayload,
  readCacheLastRefreshed,
  readCacheFallback,
};
