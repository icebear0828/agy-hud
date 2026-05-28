'use strict';

// Fallback model list when agentModelSorts is absent from the API response
const FALLBACK_AGENT_MODEL_IDS = [
  'gemini-3-flash-agent',
  'gemini-3.5-flash-low',
  'gemini-3.5-flash-extra-low',
  'gemini-pro-agent',
  'gemini-3.1-pro-low',
  'claude-sonnet-4-6',
  'claude-opus-4-6-thinking',
  'gpt-oss-120b-medium',
];

function discoverAgentModelIds(apiResponse) {
  const sorts = apiResponse.agentModelSorts;
  if (Array.isArray(sorts) && sorts.length > 0) {
    const ids = sorts[0].groups?.[0]?.modelIds;
    if (Array.isArray(ids) && ids.length > 0) return ids;
  }
  return null;
}

function resolveDeprecatedIds(ids, apiResponse) {
  const deprecated = apiResponse.deprecatedModelIds;
  if (!deprecated || typeof deprecated !== 'object') return ids;
  return ids.map(id => deprecated[id]?.newModelId || id);
}

function normalizeRemainingFraction(value, hasResetTime = false) {
  if (value === undefined || value === null) {
    return hasResetTime ? 0 : 1;
  }
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
function normalizeQuotaModels(models, interestingModelIds = FALLBACK_AGENT_MODEL_IDS) {
  const results = [];
  for (const id of interestingModelIds) {
    const m = models[id];
    if (!m || !m.quotaInfo) continue;
    const qi = m.quotaInfo;
    results.push({
      id,
      displayName: m.displayName || id,
      modelProvider: m.modelProvider || null,
      remainingFraction: normalizeRemainingFraction(qi.remainingFraction, !!qi.resetTime),
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

module.exports = {
  FALLBACK_AGENT_MODEL_IDS,
  discoverAgentModelIds,
  resolveDeprecatedIds,
  normalizeRemainingFraction,
  normalizeQuotaModels,
  createUnavailableQuotaResult,
};
