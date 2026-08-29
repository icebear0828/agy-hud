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

// The same endpoints agy uses (production first for fast response, daily fallback)
const DEFAULT_ENDPOINTS = [
  'https://cloudcode-pa.googleapis.com',
  'https://daily-cloudcode-pa.googleapis.com',
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

function parseRetrieveUserQuotaSummary(summaryData, now = Date.now()) {
  if (!summaryData || !Array.isArray(summaryData.groups)) return null;
  const results = [];
  for (const group of summaryData.groups) {
    const buckets = group.buckets || [];
    const fiveHourBucket = buckets.find(b => b.window === '5h' || b.bucketId?.includes('5h'));
    const weeklyBucket = buckets.find(b => b.window === 'weekly' || b.bucketId?.includes('weekly'));

    const isGemini = group.displayName?.toLowerCase().includes('gemini') || group.description?.toLowerCase().includes('gemini');
    const modelProvider = isGemini ? 'MODEL_PROVIDER_GOOGLE' : 'MODEL_PROVIDER_ANTHROPIC';

    const windows = {};
    if (fiveHourBucket) {
      windows.fiveHour = {
        remainingFraction: fiveHourBucket.remainingFraction ?? 1,
        resetTime: fiveHourBucket.resetTime || null,
        observedAt: now,
      };
    }
    if (weeklyBucket) {
      windows.weekly = {
        remainingFraction: weeklyBucket.remainingFraction ?? 1,
        resetTime: weeklyBucket.resetTime || null,
        observedAt: now,
      };
    }

    results.push({
      modelProvider,
      windows,
    });
  }
  return results.length > 0 ? results : null;
}

/**
 * Fetch real account quota from the Cloud Code backend.
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
      const normalized = normalizeQuotaModels(models, interestingModelIds);

      // Attempt retrieveUserQuotaSummary to populate accurate 5h and weekly buckets
      try {
        const summaryRes = await fetch(`${endpoint}/v1internal:retrieveUserQuotaSummary`, {
          method: 'POST',
          headers: buildHeaders(accessToken),
          body: JSON.stringify({}),
        });
        if (summaryRes.ok) {
          const summaryData = await summaryRes.json();
          const summaryList = parseRetrieveUserQuotaSummary(summaryData);
          if (summaryList) {
            const geminiSummary = summaryList.find(s => s.modelProvider === 'MODEL_PROVIDER_GOOGLE');
            const claudeSummary = summaryList.find(s => s.modelProvider === 'MODEL_PROVIDER_ANTHROPIC');
            for (const m of normalized) {
              if (m.modelProvider === 'MODEL_PROVIDER_GOOGLE' && geminiSummary?.windows) {
                m.windows = { ...m.windows, ...geminiSummary.windows };
              } else if (m.modelProvider === 'MODEL_PROVIDER_ANTHROPIC' && claudeSummary?.windows) {
                m.windows = { ...m.windows, ...claudeSummary.windows };
              }
            }
          }
        }
      } catch {}

      return normalized;
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
  fetchTierFromCloud,
  fetchQuotaFromCloud,
};
