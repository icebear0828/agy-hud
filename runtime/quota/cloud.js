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

/**
 * Fetch quota data from the cloud API.
 * loadCodeAssist no longer returns cloudaicompanionProject; fetchAvailableModels
 * accepts an empty body and returns quota directly.
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
      const interestingModelIds = envModelIds
        || config.interestingModels
        || resolveDeprecatedIds(
            discoverAgentModelIds(data) || FALLBACK_AGENT_MODEL_IDS,
            data
          );
      return normalizeQuotaModels(models, interestingModelIds);
    } catch {
      clearTimeout(timeoutId);
      /* try next endpoint */
    }
  }
  return createUnavailableQuotaResult(sawAuthFailure ? 'auth_failed' : 'quota_fetch_failed');
}

module.exports = {
  DEFAULT_ENDPOINTS,
  buildHeaders,
  resolveEndpoints,
  extractTierName,
  fetchAccountEmail,
  fetchTierFromCloud,
  fetchQuotaFromCloud,
};
