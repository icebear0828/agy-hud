'use strict';

const fs = require('fs');
const path = require('path');
const {
  FALLBACK_AGENT_MODEL_IDS,
  discoverAgentModelIds,
  resolveDeprecatedIds,
  normalizeQuotaModels,
  createUnavailableQuotaResult,
} = require('./models.js');

// The same endpoints agy uses (daily first — confirmed authoritative source, prod fallback)
const DEFAULT_ENDPOINTS = [
  'https://daily-cloudcode-pa.googleapis.com',
  'https://cloudcode-pa.googleapis.com',
];

// ─── Runtime User-Agent ──────────────────────────────────────────────────────
let _pkg = null;
function getPackageVersion() {
  if (_pkg) return _pkg;
  try {
    _pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')).version;
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

function resolveEndpoints(config) {
  if (process.env.AGY_HUD_ENDPOINTS) {
    return process.env.AGY_HUD_ENDPOINTS.split(',').map(s => s.trim()).filter(Boolean);
  }
  return config.endpoints || DEFAULT_ENDPOINTS;
}

/**
 * Extract a human-readable tier name from a loadCodeAssist response.
 * Priority: paidTier.name > first non-free allowedTier name > null
 * @param {Object} data
 * @returns {string|null}
 */
function extractTierName(data) {
  if (data.paidTier && data.paidTier.name) return data.paidTier.name;
  const nonFree = (data.allowedTiers || []).find(t => t.id !== 'free-tier');
  if (nonFree && nonFree.name) return nonFree.name;
  if (data.allowedTiers && data.allowedTiers.length > 0) return data.allowedTiers[0].name;
  return null;
}

// Google OIDC userinfo endpoints. agy resolves the signed-in account from the
// live access token at runtime (it is not persisted to any local file), so this
// is the only authoritative source for the active account email. The OIDC-spec
// host (openidconnect.googleapis.com) is tried first — it is the more reliable
// route in proxied environments; the legacy www host is a fallback.
const USERINFO_ENDPOINTS = [
  'https://openidconnect.googleapis.com/v1/userinfo',
  'https://www.googleapis.com/oauth2/v3/userinfo',
];

/**
 * Resolve the email of the account the live access token belongs to.
 * @param {string} accessToken
 * @returns {Promise<string|null>}
 */
async function fetchAccountEmail(accessToken) {
  for (const endpoint of USERINFO_ENDPOINTS) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000);
    try {
      const r = await fetch(endpoint, {
        headers: { 'Authorization': `Bearer ${accessToken}` },
        signal: controller.signal,
      });
      if (!r.ok) continue;
      const data = await r.json();
      if (data && typeof data.email === 'string') return data.email;
    } catch {
      /* try next endpoint */
    } finally {
      clearTimeout(timeoutId);
    }
  }
  return null;
}

/**
 * Fetch the user's subscription tier from loadCodeAssist.
 * Returns a display string like "Google AI Pro" or null if unavailable.
 * @param {string} accessToken
 * @returns {Promise<string|null>}
 */
async function fetchTierFromCloud(accessToken) {
  const { loadConfig } = require('../config.js');
  const config = await loadConfig().catch(() => ({}));
  const endpoints = resolveEndpoints(config);

  for (const endpoint of endpoints) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000);
    try {
      const r = await fetch(`${endpoint}/v1internal:loadCodeAssist`, {
        method: 'POST',
        headers: buildHeaders(accessToken),
        body: JSON.stringify({
          cloudaicompanionProject: '',
          metadata: {
            ideType: 'IDE_UNSPECIFIED',
            platform: 'PLATFORM_UNSPECIFIED',
            pluginType: 'GEMINI',
          },
        }),
        signal: controller.signal,
      });
      if (!r.ok) {
        clearTimeout(timeoutId);
        continue;
      }
      const data = await r.json();
      clearTimeout(timeoutId);
      return extractTierName(data);
    } catch {
      clearTimeout(timeoutId);
      /* try next endpoint */
    }
  }
  return null;
}

// ─── retrieveUserQuotaSummary helpers ──────────────────────────────────────

/**
 * Parse the retrieveUserQuotaSummary response into provider-level windows.
 * Expected shape: { groups: [{ displayName, buckets: [{ bucketId, window, remainingFraction, resetTime }] }] }
 * Handles both bucketId (gemini-weekly, 3p-5h) and window (weekly, 5h) signals.
 * @param {Object} data
 * @returns {{google: Object, claude: Object}|null}
 */
function parseQuotaSummary(data) {
  if (!data || !Array.isArray(data.groups)) return null;
  const result = { google: {}, claude: {} };
  let hasAny = false;
  for (const group of data.groups) {
    if (!group || !Array.isArray(group.buckets)) continue;
    const buckets = group.buckets;
    const displayName = (group.displayName || '').toLowerCase();
    const hasGeminiBucket = buckets.some(b => b && typeof b.bucketId === 'string' && b.bucketId.startsWith('gemini-'));
    const has3pBucket = buckets.some(b => b && typeof b.bucketId === 'string' && b.bucketId.startsWith('3p-'));
    let target = null;
    if (displayName.includes('gemini') || hasGeminiBucket) target = 'google';
    else if (displayName.includes('claude') || displayName.includes('3p') || has3pBucket) target = 'claude';
    else continue;

    for (const b of buckets) {
      if (!b || typeof b.remainingFraction !== 'number' || typeof b.resetTime !== 'string') continue;
      const bucketId = b.bucketId || '';
      const windowRaw = b.window || '';
      let winType = null;
      if (windowRaw === 'weekly' || bucketId.includes('weekly')) winType = 'weekly';
      else if (windowRaw === '5h' || bucketId.includes('5h') || bucketId.includes('fiveHour')) winType = 'fiveHour';
      else continue;
      // Validate resetTime is parseable
      const ts = Date.parse(b.resetTime);
      if (!Number.isFinite(ts)) continue;
      if (!result[target][winType]) {
        // Clamp remainingFraction 0..1
        let rf = b.remainingFraction;
        if (typeof rf !== 'number' || !Number.isFinite(rf)) rf = 0;
        if (rf < 0) rf = 0;
        if (rf > 1) rf = 1;
        result[target][winType] = {
          remainingFraction: rf,
          resetTime: b.resetTime,
        };
        hasAny = true;
      }
    }
  }
  if (!hasAny) return null;
  // Prune empty provider keys so callers can distinguish
  if (!result.google.weekly && !result.google.fiveHour) delete result.google;
  if (!result.claude.weekly && !result.claude.fiveHour) delete result.claude;
  // If both deleted, return null
  if (!result.google && !result.claude) return null;
  // Ensure at least one exists
  if (Object.keys(result).length === 0) return null;
  return result;
}

/**
 * Enrich normalized models with provider-level weekly/5h windows from summary.
 * Provider mapping: GOOGLE/gemini -> google summary, ANTHROPIC/claude/gpt -> claude summary.
 * @param {Array} models
 * @param {{google:Object, claude:Object}|null} summary
 * @param {number} now
 * @returns {Array}
 */
function enrichModelsWithQuotaSummary(models, summary, now = Date.now()) {
  if (!Array.isArray(models) || !summary) return models;
  const hasGoogle = summary.google && (summary.google.weekly || summary.google.fiveHour);
  const hasClaude = summary.claude && (summary.claude.weekly || summary.claude.fiveHour);
  if (!hasGoogle && !hasClaude) return models;
  return models.map(m => {
    if (!m || !m.id) return m;
    const isGoogle = m.modelProvider === 'MODEL_PROVIDER_GOOGLE' || /gemini/i.test(m.id) || /gemini/i.test(m.displayName || '');
    const isClaude = m.modelProvider === 'MODEL_PROVIDER_ANTHROPIC' || /claude/i.test(m.id) || /claude/i.test(m.displayName || '') || /gpt/i.test(m.id) || /gpt/i.test(m.displayName || '');
    const key = isGoogle ? 'google' : isClaude ? 'claude' : null;
    if (!key) return m;
    const providerSummary = summary[key];
    if (!providerSummary) return m;
    const windows = { ...(m.windows || {}) };
    if (providerSummary.weekly) {
      windows.weekly = {
        remainingFraction: providerSummary.weekly.remainingFraction,
        resetTime: providerSummary.weekly.resetTime,
        observedAt: now,
      };
    }
    if (providerSummary.fiveHour) {
      windows.fiveHour = {
        remainingFraction: providerSummary.fiveHour.remainingFraction,
        resetTime: providerSummary.fiveHour.resetTime,
        observedAt: now,
      };
    }
    return { ...m, windows };
  });
}

/**
 * Fetch provider-level quota summary (weekly + 5h) from cloud.
 * Non-critical: returns null on any failure to allow graceful downgrade.
 * @param {string} accessToken
 * @param {Object} [injectedConfig] optional pre-loaded config to avoid double load
 * @returns {Promise<{google:Object, claude:Object}|null>}
 */
async function fetchUserQuotaSummaryFromCloud(accessToken, injectedConfig) {
  let config = injectedConfig;
  if (!config) {
    const { loadConfig } = require('../config.js');
    config = await loadConfig().catch(() => ({}));
  }
  const endpoints = resolveEndpoints(config);
  for (const endpoint of endpoints) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000);
    try {
      const r = await fetch(`${endpoint}/v1internal:retrieveUserQuotaSummary`, {
        method: 'POST',
        headers: buildHeaders(accessToken),
        body: JSON.stringify({}),
        signal: controller.signal,
      });
      if (!r.ok) {
        clearTimeout(timeoutId);
        continue;
      }
      const data = await r.json();
      clearTimeout(timeoutId);
      const parsed = parseQuotaSummary(data);
      if (parsed) return parsed;
      // Response ok but unparsable -> try next endpoint
      continue;
    } catch {
      clearTimeout(timeoutId);
      /* try next endpoint */
    }
  }
  return null;
}

/**
 * Fetch quota data from the cloud API.
 * loadCodeAssist no longer returns cloudaicompanionProject; fetchAvailableModels
 * accepts an empty body and returns quota directly.
 * Now also enriches with retrieveUserQuotaSummary for accurate weekly windows.
 * @param {string} accessToken
 * @returns {Promise<ModelQuota[]>}
 */
async function fetchQuotaFromCloud(accessToken) {
  let sawAuthFailure = false;
  const { loadConfig } = require('../config.js');
  const config = await loadConfig().catch(() => ({}));

  const endpoints = resolveEndpoints(config);

  const envModelIds = process.env.AGY_HUD_INTERESTING_MODELS
    ? process.env.AGY_HUD_INTERESTING_MODELS.split(',').map(s => s.trim()).filter(Boolean)
    : null;

  // Kick off summary fetch in parallel — non-blocking, graceful fallback on failure.
  const summaryPromise = fetchUserQuotaSummaryFromCloud(accessToken, config).catch(() => null);

  let normalized = null;
  for (const endpoint of endpoints) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000);
    try {
      const r = await fetch(`${endpoint}/v1internal:fetchAvailableModels`, {
        method: 'POST',
        headers: buildHeaders(accessToken),
        body: JSON.stringify({}),
        signal: controller.signal,
      });
      if (!r.ok) {
        clearTimeout(timeoutId);
        if (r.status === 401 || r.status === 403) sawAuthFailure = true;
        continue;
      }
      const data = await r.json();
      clearTimeout(timeoutId);
      const models = data.models || {};
      let interestingModelIds = envModelIds
        || config.interestingModels
        || resolveDeprecatedIds(
            discoverAgentModelIds(data) || FALLBACK_AGENT_MODEL_IDS,
            data
          );
      if (data && data.models) {
        const imageModelIds = Object.keys(data.models).filter(id => id.includes('-image') || id.toLowerCase().includes('image'));
        interestingModelIds = [...new Set([...interestingModelIds, ...imageModelIds])];
      }
      normalized = normalizeQuotaModels(models, interestingModelIds);
      break;
    } catch {
      clearTimeout(timeoutId);
      /* try next endpoint */
    }
  }
  if (!normalized) {
    return createUnavailableQuotaResult(sawAuthFailure ? 'auth_failed' : 'quota_fetch_failed');
  }
  // Enrich with summary if available; never fail the whole call if summary fetch errors.
  try {
    const summary = await summaryPromise;
    if (summary) {
      normalized = enrichModelsWithQuotaSummary(normalized, summary, Date.now());
    }
  } catch {
    /* graceful downgrade: return models-only */
  }
  return normalized;
}

module.exports = {
  DEFAULT_ENDPOINTS,
  buildHeaders,
  resolveEndpoints,
  extractTierName,
  fetchAccountEmail,
  fetchTierFromCloud,
  fetchQuotaFromCloud,
  // new helpers exported for testing / reuse
  parseQuotaSummary,
  enrichModelsWithQuotaSummary,
  fetchUserQuotaSummaryFromCloud,
};
