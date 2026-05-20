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
const crypto = require('crypto');
const { spawn } = require('child_process');
const { getAntigravityRoots, resolveAntigravityPath } = require('./paths.js');

// ─── Cross-platform token discovery ──────────────────────────────────────────
// agy stores its OAuth token in different locations depending on the environment.
// We search in priority order; first readable file wins.
// Includes both antigravity-cli (standard) and jetski-standalone (older installs)
// token filenames, each under all known app-data roots.
const TOKEN_CANDIDATES = [
  ...getAntigravityRoots().map(root => path.join(root, 'antigravity-oauth-token')),
  path.join(os.homedir(), '.gemini', 'jetski-standalone-oauth-token'),
];

const CACHE_PATH = path.join(os.tmpdir(), 'agy-hud-quota-cache.json');
const CACHE_VERSION = 2;

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

// The same endpoints agy uses (daily first — confirmed authoritative source, prod fallback)
const DEFAULT_ENDPOINTS = [
  'https://daily-cloudcode-pa.googleapis.com',
  'https://cloudcode-pa.googleapis.com',
];

// Models to show in the HUD — filtered from the full list, de-duped by quota bucket
const DEFAULT_INTERESTING_MODEL_IDS = [
  'gemini-3-flash-agent',    // Gemini 3.5 Flash (High)
  'gemini-3.5-flash-low',    // Gemini 3.5 Flash (Medium)
  'gemini-3.1-pro-high',     // Gemini 3.1 Pro (High)
  'gemini-3.1-pro-low',      // Gemini 3.1 Pro (Low)
  'claude-sonnet-4-6',       // Claude Sonnet 4.6
  'claude-opus-4-6-thinking',// Claude Opus 4.6
  'gpt-oss-120b-medium',     // GPT-OSS 120B
];

function normalizeRemainingFraction(value) {
  if (value === undefined || value === null) return 1;
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * Normalize the fetchAvailableModels response to the HUD quota shape.
 * @param {Object<string, Object>} models
 * @returns {ModelQuota[]}
 */
function normalizeQuotaModels(models, interestingModelIds = DEFAULT_INTERESTING_MODEL_IDS) {
  const results = [];
  for (const id of interestingModelIds) {
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
  // Windows: hook writes Credential Manager tokens to a temp file (5 min TTL).
  // Multiple accounts are stored as an array — caller tries each in order.
  if (process.platform === 'win32') {
    try {
      const tmp = resolveAntigravityPath('agy-hud-token.json');
      const raw = JSON.parse(fs.readFileSync(tmp, 'utf8'));
      const ttl = 5 * 60 * 1000;
      if (raw.writtenAt && Date.now() - raw.writtenAt < ttl && Array.isArray(raw.tokens)) {
        const valid = raw.tokens.filter(t => t && t.accessToken);
        if (valid.length > 0) return { accessToken: valid[0].accessToken, all: valid };
      }
    } catch { /* fall through to file candidates */ }
  }

  for (const candidate of TOKEN_CANDIDATES) {
    try {
      const raw = JSON.parse(fs.readFileSync(candidate, 'utf8'));
      // antigravity-cli format: { token: { access_token } }
      if (raw.token && raw.token.access_token) return { accessToken: raw.token.access_token };
      // jetski-standalone format: { access_token } (flat)
      if (raw.access_token) return { accessToken: raw.access_token };
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
 * Get the caller's Google Cloud project id from loadCodeAssist.
 * Returns null if the endpoint is unreachable or the response doesn't carry
 * a project — callers should treat that as "quota unavailable" rather than
 * substituting an arbitrary project id (which leaks identity).
 *
 * @param {string} accessToken
 * @param {string} endpoint
 * @returns {Promise<string|null>}
 */
/**
 * @typedef {Object} ModelQuota
 * @property {string} id
 * @property {string} displayName
 * @property {number} remainingFraction  0–1
 * @property {string|null} resetTime     ISO-8601 or null
 */

/**
 * Fetch quota data from the cloud API.
 * loadCodeAssist no longer returns cloudaicompanionProject; fetchAvailableModels
 * accepts an empty body and returns quota directly.
 * @param {string} accessToken
 * @returns {Promise<ModelQuota[]>}
 */
async function fetchQuotaFromCloud(accessToken) {
  let sawAuthFailure = false;
  const { loadConfig } = require('./config.js');
  const config = await loadConfig().catch(() => ({}));

  const endpoints = process.env.AGY_HUD_ENDPOINTS
    ? process.env.AGY_HUD_ENDPOINTS.split(',').map(s => s.trim()).filter(Boolean)
    : (config.endpoints || DEFAULT_ENDPOINTS);

  const interestingModelIds = process.env.AGY_HUD_INTERESTING_MODELS
    ? process.env.AGY_HUD_INTERESTING_MODELS.split(',').map(s => s.trim()).filter(Boolean)
    : (config.interestingModels || DEFAULT_INTERESTING_MODEL_IDS);

  for (const endpoint of endpoints) {
    try {
      const r = await fetch(`${endpoint}/v1internal:fetchAvailableModels`, {
        method: 'POST',
        headers: buildHeaders(accessToken),
        body: JSON.stringify({}),
      });
      if (!r.ok) {
        if (r.status === 401 || r.status === 403) sawAuthFailure = true;
        continue;
      }
      const data = await r.json();
      const models = data.models || {};
      return normalizeQuotaModels(models, interestingModelIds);
    } catch { /* try next endpoint */ }
  }
  return createUnavailableQuotaResult(sawAuthFailure ? 'auth_failed' : 'quota_fetch_failed');
}

function isCachePayloadFresh(raw) {
  return raw &&
    raw.version === CACHE_VERSION &&
    raw.expiresAt &&
    Date.now() < raw.expiresAt &&
    Array.isArray(raw.data);
}

/**
 * Read cached quota if still valid.
 * @param {string} accessToken
 * @returns {ModelQuota[] | null}
 */
function readCache(accessToken) {
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    if (!isCachePayloadFresh(raw)) return null;
    const currentHash = crypto.createHash('sha256').update(accessToken).digest('hex');
    if (raw.tokenHash !== currentHash) return null;
    return raw.data;
  } catch {
    return null;
  }
}

/**
 * Write quota cache. Expires at the earliest resetTime among all buckets.
 * @param {ModelQuota[]} data
 * @param {string} accessToken
 */
function writeCache(data, accessToken) {
  // Find earliest resetTime
  let earliest = Infinity;
  for (const m of data) {
    if (m.resetTime) {
      const t = new Date(m.resetTime).getTime();
      if (t < earliest) earliest = t;
    }
  }
  // If no resetTime found, cache for 5 minutes
  const expiresAt = isFinite(earliest) ? earliest : Date.now() + 5 * 60 * 1000;
  const tokenHash = crypto.createHash('sha256').update(accessToken).digest('hex');
  const payload = {
    version: CACHE_VERSION,
    expiresAt,
    lastRefreshed: Date.now(),
    tokenHash,
    data
  };
  try {
    fs.writeFileSync(CACHE_PATH, JSON.stringify(payload));
  } catch { /* ignore write errors */ }
}

/**
 * Read the entire raw cache payload (even if expired).
 * @param {string} accessToken
 * @returns {Object | null}
 */
function readCachePayload(accessToken) {
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    const currentHash = crypto.createHash('sha256').update(accessToken).digest('hex');
    if (raw.tokenHash !== currentHash) return null;
    return raw;
  } catch {
    return null;
  }
}

/**
 * Spawn a detached background process to refresh the quota cache.
 */
function triggerBackgroundRefresh() {
  try {
    const subprocess = spawn(process.execPath, [
      path.join(__dirname, 'quota.js'),
      '--refresh'
    ], {
      detached: true,
      stdio: 'ignore'
    });
    subprocess.unref();
  } catch { /* ignore spawning issues */ }
}

/**
 * Get quota data using a non-blocking Stale-While-Revalidate pattern.
 * @returns {Promise<ModelQuota[]>}
 */
async function getQuota() {
  const tok = readToken();
  if (!tok) return createUnavailableQuotaResult('not_logged_in');

  // For multi-account (Windows Credential Manager), use the primary token for
  // cache keying but fall back to alternates if the primary has no cache.
  const payload = readCachePayload(tok.accessToken) ||
    (tok.all && tok.all.slice(1).reduce((acc, t) => acc || readCachePayload(t.accessToken), null));
  const isFresh = payload && isCachePayloadFresh(payload);

  if (!isFresh) {
    const lastRefreshed = payload ? payload.lastRefreshed || 0 : 0;
    // Debounce background refreshes — only spawn one if not refreshed in the last 30s
    if (Date.now() - lastRefreshed > 30 * 1000) {
      triggerBackgroundRefresh();
    }
  }

  if (payload) {
    return payload.data;
  }

  // If no cache exists at all, return empty but trigger background load
  return [];
}

// ─── CLI Execution for background refreshes ──────────────────────────────────
if (process.argv.includes('--refresh')) {
  (async () => {
    try {
      const tok = readToken();
      if (tok) {
        const fresh = await fetchQuotaFromCloud(tok.accessToken);
        if (fresh.length > 0) {
          writeCache(fresh, tok.accessToken);
        }
      }
    } catch {}
    process.exit(0);
  })();
}

module.exports = {
  getQuota,
  fetchQuotaFromCloud,
  normalizeQuotaModels,
  isCachePayloadFresh,
  createUnavailableQuotaResult,
  readCache,
  writeCache,
};
