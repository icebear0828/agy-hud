/**
 * quota.js — Real account-level quota fetcher.
 *
 * Calls the same `fetchAvailableModels` endpoint that agy uses for /usage.
 * Token is auto-discovered from known agy app-data locations across platforms.
 * Results are cached to os.tmpdir()/agy-hud-quota-cache.json keyed by the
 * earliest resetTime, so we never hit the network more than once per window.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// ─── Cross-platform token discovery ──────────────────────────────────────────
// agy stores its OAuth token in different locations depending on the environment.
// We search in priority order; first readable file wins.
const TOKEN_CANDIDATES = [
  // Standard install (macOS / Linux via XDG override)
  path.join(os.homedir(), '.gemini', 'antigravity-cli', 'antigravity-oauth-token'),
  // XDG_DATA_HOME override (Linux)
  process.env.XDG_DATA_HOME
    ? path.join(process.env.XDG_DATA_HOME, 'antigravity-cli', 'antigravity-oauth-token')
    : null,
  // Windows: %APPDATA%\antigravity-cli\antigravity-oauth-token
  process.env.APPDATA
    ? path.join(process.env.APPDATA, 'antigravity-cli', 'antigravity-oauth-token')
    : null,
  // Windows: %LOCALAPPDATA%\antigravity-cli\antigravity-oauth-token
  process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'antigravity-cli', 'antigravity-oauth-token')
    : null,
].filter(Boolean);

const CACHE_PATH = path.join(os.tmpdir(), 'agy-hud-quota-cache.json');
const CACHE_VERSION = 3;
const MAX_CACHE_AGE_MS = 60 * 1000;

// ─── Runtime User-Agent ───────────────────────────────────────────────────────
// Read version from our own package.json and detect OS/arch at runtime.
let _pkg = null;
function getPackageVersion() {
  if (_pkg) return _pkg;
  try {
    _pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version;
  } catch {
    _pkg = '0.0.0';
  }
  return _pkg;
}

function getPlatformArch() {
  const plat = { darwin: 'darwin', linux: 'linux', win32: 'windows' }[process.platform] || process.platform;
  const arch = { x64: 'amd64', arm64: 'arm64', ia32: '386' }[process.arch] || process.arch;
  return `${plat}/${arch}`;
}

// The same endpoints agy uses (daily sandbox first, prod fallback)
const ENDPOINTS = [
  'https://daily-cloudcode-pa.googleapis.com',
  'https://cloudcode-pa.googleapis.com',
];

const DEFAULT_PROJECT_ID = 'rising-fact-p41fc';

// Models to show in the HUD — filtered from the full list, de-duped by quota bucket
const INTERESTING_MODEL_IDS = [
  'gemini-3-flash-agent',    // Gemini 3.5 Flash (High)
  'gemini-3.5-flash-low',    // Gemini 3.5 Flash (Medium)
  'gemini-3.1-pro-high',     // Gemini 3.1 Pro (High)
  'gemini-3.1-pro-low',      // Gemini 3.1 Pro (Low)
  'claude-sonnet-4-6',       // Claude Sonnet 4.6
  'claude-opus-4-6-thinking',// Claude Opus 4.6
  'gpt-oss-120b-medium',     // GPT-OSS 120B
];

function normalizeRemainingFraction(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * Normalize the fetchAvailableModels response to the HUD quota shape.
 * agy usage treats quotaInfo objects without remainingFraction as exhausted.
 * @param {Object<string, Object>} models
 * @returns {ModelQuota[]}
 */
function normalizeQuotaModels(models) {
  const results = [];
  for (const id of INTERESTING_MODEL_IDS) {
    const m = models[id];
    if (!m || !m.quotaInfo) continue;
    const qi = m.quotaInfo;
    results.push({
      id,
      displayName: m.displayName || id,
      remainingFraction: normalizeRemainingFraction(qi.remainingFraction),
      resetTime: qi.resetTime || null,
    });
  }
  return results;
}

function createUnavailableQuotaResult(reason) {
  const result = [];
  Object.defineProperty(result, 'unavailableReason', {
    value: reason,
    enumerable: false,
  });
  return result;
}

/**
 * @returns {{ accessToken: string } | null}
 */
function readToken() {
  for (const candidate of TOKEN_CANDIDATES) {
    try {
      const raw = JSON.parse(fs.readFileSync(candidate, 'utf8'));
      const token = raw.token;
      if (token && token.access_token) return { accessToken: token.access_token };
    } catch { /* try next */ }
  }
  return null;
}

/**
 * Build headers matching what agy sends.
 * @param {string} accessToken
 */
function buildHeaders(accessToken) {
  return {
    'Authorization': `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'User-Agent': `antigravity/${getPackageVersion()} ${getPlatformArch()}`,
    'X-Goog-Api-Client': `gl-node/${process.versions.node}`,
    'Client-Metadata': JSON.stringify({
      ideType: 'IDE_UNSPECIFIED',
      platform: 'PLATFORM_UNSPECIFIED',
      pluginType: 'GEMINI',
    }),
  };
}

/**
 * Get the projectId from loadCodeAssist, falling back to DEFAULT_PROJECT_ID.
 * @param {string} accessToken
 * @param {string} endpoint
 * @returns {Promise<string>}
 */
async function fetchProjectId(accessToken, endpoint, options = {}) {
  try {
    const r = await fetch(`${endpoint}/v1internal:loadCodeAssist`, {
      method: 'POST',
      headers: buildHeaders(accessToken),
      signal: options.signal,
      body: JSON.stringify({ metadata: { ideType: 'IDE_UNSPECIFIED', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' } }),
    });
    if (r.ok) {
      const data = await r.json();
      const proj = data.cloudaicompanionProject;
      if (typeof proj === 'string' && proj) return proj;
      if (proj && proj.id) return proj.id;
    }
  } catch { /* fallthrough */ }
  return DEFAULT_PROJECT_ID;
}

/**
 * @typedef {Object} ModelQuota
 * @property {string} id
 * @property {string} displayName
 * @property {number} remainingFraction  0–1
 * @property {string|null} resetTime     ISO-8601 or null
 */

/**
 * Fetch quota data from the cloud API.
 * @param {string} accessToken
 * @param {{ timeoutMs?: number, signal?: AbortSignal }} [options]
 * @returns {Promise<ModelQuota[]>}
 */
async function fetchQuotaFromCloud(accessToken, options = {}) {
  let sawAuthFailure = false;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 0;
  const controller = timeoutMs > 0 ? new AbortController() : null;
  const timeout = controller
    ? setTimeout(() => controller.abort(), timeoutMs)
    : null;
  const signal = controller?.signal || options.signal;
  if (timeout && typeof timeout.unref === 'function') timeout.unref();

  try {
    for (const endpoint of ENDPOINTS) {
      try {
        if (signal?.aborted) return createUnavailableQuotaResult('quota_fetch_timeout');
        const projectId = await fetchProjectId(accessToken, endpoint, { signal });
        if (signal?.aborted) return createUnavailableQuotaResult('quota_fetch_timeout');
        const r = await fetch(`${endpoint}/v1internal:fetchAvailableModels`, {
          method: 'POST',
          headers: buildHeaders(accessToken),
          signal,
          body: JSON.stringify({ project: projectId }),
        });
        if (!r.ok) {
          if (r.status === 401 || r.status === 403) sawAuthFailure = true;
          continue;
        }
        const data = await r.json();
        const models = data.models || {};
        return normalizeQuotaModels(models);
      } catch {
        if (signal?.aborted) return createUnavailableQuotaResult('quota_fetch_timeout');
        /* try next endpoint */
      }
    }
    return createUnavailableQuotaResult(sawAuthFailure ? 'auth_failed' : 'quota_fetch_failed');
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function isCachePayloadFresh(raw, now = Date.now()) {
  return raw &&
    raw.version === CACHE_VERSION &&
    raw.createdAt &&
    now - raw.createdAt <= MAX_CACHE_AGE_MS &&
    raw.expiresAt &&
    now < raw.expiresAt &&
    Array.isArray(raw.data);
}

/**
 * Read cached quota if still valid.
 * @returns {ModelQuota[] | null}
 */
function readCache() {
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    if (!isCachePayloadFresh(raw)) return null;
    return raw.data;
  } catch {
    return null;
  }
}

/**
 * Compute cache expiry from reset times, capped by the freshness window.
 * @param {ModelQuota[]} data
 * @param {number} [now]
 */
function computeQuotaCacheExpiresAt(data, now = Date.now()) {
  let earliest = Infinity;
  for (const m of data) {
    if (m.resetTime) {
      const t = new Date(m.resetTime).getTime();
      if (t < earliest) earliest = t;
    }
  }
  const maxFreshUntil = now + MAX_CACHE_AGE_MS;
  return isFinite(earliest) ? Math.min(earliest, maxFreshUntil) : maxFreshUntil;
}

/**
 * Write quota cache. Short-capped because remaining quota can be consumed
 * long before the provider reset window.
 * @param {ModelQuota[]} data
 */
function writeCache(data) {
  const createdAt = Date.now();
  const expiresAt = computeQuotaCacheExpiresAt(data, createdAt);
  try {
    fs.writeFileSync(CACHE_PATH, JSON.stringify({ version: CACHE_VERSION, createdAt, expiresAt, data }));
  } catch { /* ignore write errors */ }
}

/**
 * Get quota data (cached or fresh).
 * @returns {Promise<ModelQuota[]>}
 */
async function getQuota(options = {}) {
  const cached = readCache();
  if (cached) return cached;

  const tok = readToken();
  if (!tok) return createUnavailableQuotaResult('not_logged_in');

  const fresh = await fetchQuotaFromCloud(tok.accessToken, options);
  if (fresh.length > 0) writeCache(fresh);
  return fresh;
}

module.exports = {
  getQuota,
  fetchQuotaFromCloud,
  normalizeQuotaModels,
  isCachePayloadFresh,
  computeQuotaCacheExpiresAt,
  createUnavailableQuotaResult,
  MAX_CACHE_AGE_MS,
};
