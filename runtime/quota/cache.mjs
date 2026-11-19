import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { resolveAntigravityPath } from '../paths.mjs';
import { mergeQuotaWindows } from './models.mjs';

export const CACHE_VERSION = 3;
export const MAX_CACHE_FRESH_MS = 30 * 1000;
export const CACHE_PATH = resolveAntigravityPath('agy-hud-quota-cache.json');

export function getCachePath(env = process.env) {
  return resolveAntigravityPath('agy-hud-quota-cache.json', env);
}

export function isCachePayloadFresh(raw) {
  return Boolean(
    raw &&
    raw.version === CACHE_VERSION &&
    raw.expiresAt &&
    Date.now() < raw.expiresAt &&
    Array.isArray(raw.data)
  );
}

export function hashCacheKey(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function normalizeTokenCacheInput(tokenOrAccessToken) {
  if (typeof tokenOrAccessToken === 'string') return { accessToken: tokenOrAccessToken };
  if (!tokenOrAccessToken || typeof tokenOrAccessToken !== 'object') return null;
  return tokenOrAccessToken;
}

export function getTokenCacheIdentity(tokenOrAccessToken) {
  const token = normalizeTokenCacheInput(tokenOrAccessToken);
  if (!token) return null;
  if (token.sourcePath) return `sourcePath:${path.resolve(token.sourcePath)}`;
  if (token.sourceFormat) return `sourceFormat:${token.sourceFormat}`;
  if (token.accessToken) return `accessToken:${token.accessToken}`;
  return null;
}

export function getTokenHash(tokenOrAccessToken) {
  const token = normalizeTokenCacheInput(tokenOrAccessToken);
  if (!token || !token.accessToken) return null;
  return hashCacheKey(token.accessToken);
}

export function getTokenCacheKeyHash(tokenOrAccessToken) {
  const identity = getTokenCacheIdentity(tokenOrAccessToken);
  return identity ? hashCacheKey(identity) : null;
}

export function doesCachePayloadMatchToken(raw, tokenOrAccessToken) {
  if (!raw || !Array.isArray(raw.data)) return false;
  const cacheKeyHash = getTokenCacheKeyHash(tokenOrAccessToken);
  if (raw.cacheKeyHash && cacheKeyHash && raw.cacheKeyHash === cacheKeyHash) return true;
  const tokenHash = getTokenHash(tokenOrAccessToken);
  return Boolean(raw.tokenHash && tokenHash && raw.tokenHash === tokenHash);
}

export function didAccessTokenRotate(raw, tokenOrAccessToken) {
  const tokenHash = getTokenHash(tokenOrAccessToken);
  return Boolean(raw && raw.tokenHash && tokenHash && raw.tokenHash !== tokenHash);
}

export function readCache(tokenOrAccessToken, cachePath = getCachePath()) {
  try {
    const raw = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (!isCachePayloadFresh(raw)) return null;
    if (!doesCachePayloadMatchToken(raw, tokenOrAccessToken)) return null;
    if (raw.providerQuota && Array.isArray(raw.data)) raw.data.providerQuota = raw.providerQuota;
    return raw.data;
  } catch {
    return null;
  }
}

export function readCacheRaw(cachePath = getCachePath()) {
  try {
    const raw = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (!raw || raw.version !== CACHE_VERSION || !Array.isArray(raw.data)) return null;
    return raw;
  } catch {
    return null;
  }
}

function isFutureOrUnboundedWindow(win, now) {
  if (!win || typeof win !== 'object') return false;
  if (!win.resetTime) return true;
  const t = new Date(win.resetTime).getTime();
  return !Number.isFinite(t) || t > now;
}

function mergeProviderQuotaCache(previousPq, incomingPq, now) {
  if (!previousPq && !incomingPq) return null;
  const merged = {};
  for (const key of ['google', 'claude', 'argon']) {
    const prevGroup = previousPq?.[key];
    const incGroup = incomingPq?.[key];
    if (!prevGroup && !incGroup) continue;
    const nextGroup = {};
    for (const winKey of ['fiveHour', 'weekly']) {
      const incWin = isFutureOrUnboundedWindow(incGroup?.[winKey], now) ? incGroup[winKey] : null;
      const prevWin = isFutureOrUnboundedWindow(prevGroup?.[winKey], now) ? prevGroup[winKey] : null;
      const chosen = incWin || prevWin;
      if (chosen) nextGroup[winKey] = chosen;
    }
    if (nextGroup.fiveHour || nextGroup.weekly) {
      merged[key] = nextGroup;
    }
  }
  return Object.keys(merged).length > 0 ? merged : null;
}

function sanitizeModelTopLevelReset(model, now) {
  if (!model || !model.resetTime) return model;
  const t = new Date(model.resetTime).getTime();
  if (!Number.isFinite(t) || t > now) return model;
  const liveFive = isFutureOrUnboundedWindow(model.windows?.fiveHour, now) ? model.windows.fiveHour : null;
  const liveWeek = isFutureOrUnboundedWindow(model.windows?.weekly, now) ? model.windows.weekly : null;
  const fallback = liveFive && liveWeek
    ? (liveFive.remainingFraction <= liveWeek.remainingFraction ? liveFive : liveWeek)
    : (liveFive || liveWeek);
  return {
    ...model,
    resetTime: fallback?.resetTime ?? null,
    ...(fallback ? { remainingFraction: fallback.remainingFraction } : {}),
  };
}

export function writeCache(data, tokenOrAccessToken, tier = null, accountEmail = null, providerQuota = null, cachePath = getCachePath()) {
  const now = Date.now();
  const previousRaw = readCacheRaw(cachePath);
  const tokenEmail = typeof tokenOrAccessToken === 'object' ? tokenOrAccessToken?.email : null;
  const effectiveEmail = accountEmail || tokenEmail || null;
  let sameIdentity = Boolean(previousRaw && doesCachePayloadMatchToken(previousRaw, tokenOrAccessToken));
  if (sameIdentity && effectiveEmail && previousRaw.accountEmail && effectiveEmail !== previousRaw.accountEmail) {
    sameIdentity = false;
  }
  if (sameIdentity && didAccessTokenRotate(previousRaw, tokenOrAccessToken) && previousRaw.accountEmail && !effectiveEmail) {
    sameIdentity = false;
  }

  const previousData = sameIdentity ? previousRaw.data : [];
  const merged = mergeQuotaWindows(data, previousData, now).map((m) => sanitizeModelTopLevelReset(m, now));

  const incomingProviderQuota = providerQuota || data?.providerQuota || null;
  const previousProviderQuota = sameIdentity && previousRaw?.providerQuota ? previousRaw.providerQuota : null;
  const resolvedProviderQuota = mergeProviderQuotaCache(previousProviderQuota, incomingProviderQuota, now);

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
    for (const group of Object.values(resolvedProviderQuota)) {
      considerResetTime(group?.fiveHour?.resetTime);
      considerResetTime(group?.weekly?.resetTime);
    }
  }
  const maxFreshDuration = MAX_CACHE_FRESH_MS;
  let expiresAt = now + maxFreshDuration;
  if (Number.isFinite(earliest) && earliest < expiresAt) expiresAt = earliest;

  const cacheKeyHash = getTokenCacheKeyHash(tokenOrAccessToken);
  const tokenHash = getTokenHash(tokenOrAccessToken);
  const resolvedTier = tier || (sameIdentity ? (previousRaw.tier || null) : null);
  const resolvedEmail = effectiveEmail || (sameIdentity ? (previousRaw.accountEmail || null) : null);

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
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    const tmpPath = `${cachePath}.tmp.${process.pid}`;
    fs.writeFileSync(tmpPath, JSON.stringify(payload), { mode: 0o600 });
    fs.renameSync(tmpPath, cachePath);
  } catch {
    try { fs.unlinkSync(`${cachePath}.tmp.${process.pid}`); } catch {}
  }
}

export function getCachedTier(cachePath = getCachePath()) {
  try {
    const raw = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    return raw.tier || null;
  } catch {
    return null;
  }
}

export function getCachedAccountEmail(tokenOrAccessToken, cachePath = getCachePath()) {
  try {
    const raw = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (!raw || !raw.accountEmail) return null;
    if (!doesCachePayloadMatchToken(raw, tokenOrAccessToken)) return null;
    return raw.accountEmail;
  } catch {
    return null;
  }
}

export function readCachePayload(tokenOrAccessToken, cachePath = getCachePath()) {
  try {
    const raw = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (!raw || raw.version !== CACHE_VERSION) return null;
    if (!doesCachePayloadMatchToken(raw, tokenOrAccessToken)) return null;
    if (raw.providerQuota && Array.isArray(raw.data)) raw.data.providerQuota = raw.providerQuota;
    return raw;
  } catch {
    return null;
  }
}

export function readCacheLastRefreshed(cachePath = getCachePath()) {
  try {
    const raw = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    return raw.lastRefreshed || 0;
  } catch {
    return 0;
  }
}

export function readCacheFallback(cachePath = getCachePath()) {
  try {
    const raw = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (!raw || !Array.isArray(raw.data) || raw.version !== CACHE_VERSION) return null;
    if (raw.providerQuota && Array.isArray(raw.data)) raw.data.providerQuota = raw.providerQuota;
    return raw;
  } catch {
    return null;
  }
}
