'use strict';

// Resets shorter than this come from the 5-hour bucket; longer ones from the
// weekly bucket. 12 h is well-separated from both natural ranges
// (5 h max for the short window, ~7 d for the weekly).
const FIVE_HOUR_WINDOW_THRESHOLD_MS = 12 * 60 * 60 * 1000;

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
 * Classify a resetTime as belonging to the 5-hour or weekly quota window.
 * The fetchAvailableModels API exposes only one window at a time, so we infer
 * which one by how far away the reset is. resetTimes already in the past
 * cannot be classified — they refer to a window that has already rolled over.
 * @param {string|null} resetTime ISO-8601 string
 * @param {number} now epoch ms
 * @returns {'fiveHour' | 'weekly' | null}
 */
function classifyQuotaWindow(resetTime, now = Date.now()) {
  if (!resetTime) return null;
  const ms = new Date(resetTime).getTime() - now;
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return ms < FIVE_HOUR_WINDOW_THRESHOLD_MS ? 'fiveHour' : 'weekly';
}

/**
 * True when a window observation's resetTime has already elapsed — the
 * observation is stale and refers to a window cycle that has rolled over.
 */
function isObservationExpired(observation, now = Date.now()) {
  if (!observation || !observation.resetTime) return false;
  const t = new Date(observation.resetTime).getTime();
  return Number.isFinite(t) && t <= now;
}

function pruneExpiredWindows(windows, now = Date.now()) {
  if (!windows) return {};
  const out = {};
  if (windows.fiveHour && !isObservationExpired(windows.fiveHour, now)) out.fiveHour = windows.fiveHour;
  if (windows.weekly && !isObservationExpired(windows.weekly, now)) out.weekly = windows.weekly;
  return out;
}

function normalizeQuotaModels(models, interestingModelIds = FALLBACK_AGENT_MODEL_IDS, now = Date.now(), quotaBuckets = null) {
  const bucketsByModel = {};
  if (quotaBuckets && Array.isArray(quotaBuckets)) {
    for (const b of quotaBuckets) {
      if (!b.modelId) continue;
      if (!bucketsByModel[b.modelId]) bucketsByModel[b.modelId] = [];
      bucketsByModel[b.modelId].push(b);
    }
  }

  const results = [];
  for (const id of interestingModelIds) {
    const m = models[id];
    const myBuckets = bucketsByModel[id];
    
    // If we have no quota info at all for this model, skip it
    if ((!m || !m.quotaInfo) && (!myBuckets || myBuckets.length === 0)) continue;

    const windows = {};
    let fallbackFraction = null;
    let fallbackResetTime = null;

    if (myBuckets && myBuckets.length > 0) {
      for (const b of myBuckets) {
        const resetTime = b.resetTime || null;
        const remainingFraction = normalizeRemainingFraction(b.remainingFraction, !!resetTime);
        const win = classifyQuotaWindow(resetTime, now);
        if (win) {
          windows[win] = { remainingFraction, resetTime, observedAt: now };
        } else if (fallbackFraction === null) {
          fallbackFraction = remainingFraction;
          fallbackResetTime = resetTime;
        }
      }
    } else if (m && m.quotaInfo) {
      const qi = m.quotaInfo;
      const resetTime = qi.resetTime || null;
      const remainingFraction = normalizeRemainingFraction(qi.remainingFraction, !!resetTime);
      const win = classifyQuotaWindow(resetTime, now);
      if (win) {
        windows[win] = { remainingFraction, resetTime, observedAt: now };
      } else {
        fallbackFraction = remainingFraction;
        fallbackResetTime = resetTime;
      }
    }

    let bindingFraction = 0;
    let bindingResetTime = null;
    let bindingWindow = null;

    const crit = pickCriticalWindow(windows, now);
    if (crit) {
      bindingFraction = crit.remainingFraction;
      bindingResetTime = crit.resetTime;
      bindingWindow = crit.window;
    } else if (fallbackFraction !== null) {
      bindingFraction = fallbackFraction;
      bindingResetTime = fallbackResetTime;
      bindingWindow = null;
    } else {
      bindingFraction = 1;
    }

    results.push({
      id,
      displayName: (m && m.displayName) ? m.displayName : id,
      modelProvider: (m && m.modelProvider) ? m.modelProvider : null,
      remainingFraction: bindingFraction,
      resetTime: bindingResetTime,
      window: bindingWindow,
      windows: Object.keys(windows).length > 0 ? windows : {},
    });
  }
  return results;
}

/**
 * Merge a freshly observed quota response with the previously cached one,
 * preserving the *other* window's last observation. The cloud API only
 * exposes one window per response, so without merging the never-observed
 * window would never appear in the UI.
 *
 * Expired previous observations are dropped so a 5-hour bucket that has
 * since rolled over server-side cannot keep dominating pickCriticalWindow.
 * Models present in `previous` but missing from `fresh` are carried forward
 * with their non-expired windows so a temporary API omission doesn't erase
 * the user's window history.
 */
function mergeQuotaWindows(fresh, previous, now = Date.now()) {
  const prevById = new Map();
  for (const q of previous || []) {
    if (q && q.id) prevById.set(q.id, q);
  }
  const freshIds = new Set();
  const results = [];
  for (const q of fresh || []) {
    if (!q || !q.id) continue;
    freshIds.add(q.id);
    const prev = prevById.get(q.id);
    const prevWindows = prev ? pruneExpiredWindows(prev.windows, now) : {};
    const merged = { ...prevWindows, ...(q.windows || {}) };
    results.push({ ...q, windows: merged });
  }
  for (const q of previous || []) {
    if (!q || !q.id || freshIds.has(q.id)) continue;
    const merged = pruneExpiredWindows(q.windows, now);
    if (merged.fiveHour || merged.weekly) {
      results.push({ ...q, windows: merged });
    }
  }
  return results;
}

/**
 * Pick the binding window (lower remaining fraction) for surface display.
 * Falls back to whichever single window we have, or null if none.
 * Expired observations are skipped — a 5-hour bucket whose resetTime has
 * already elapsed must not keep winning the pick.
 */
function pickCriticalWindow(windows, now = Date.now()) {
  if (!windows) return null;
  const five = isObservationExpired(windows.fiveHour, now) ? null : windows.fiveHour;
  const week = isObservationExpired(windows.weekly, now) ? null : windows.weekly;
  if (five && week) {
    return five.remainingFraction <= week.remainingFraction
      ? { ...five, window: 'fiveHour' }
      : { ...week, window: 'weekly' };
  }
  if (five) return { ...five, window: 'fiveHour' };
  if (week) return { ...week, window: 'weekly' };
  return null;
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
  FIVE_HOUR_WINDOW_THRESHOLD_MS,
  discoverAgentModelIds,
  resolveDeprecatedIds,
  normalizeRemainingFraction,
  normalizeQuotaModels,
  classifyQuotaWindow,
  isObservationExpired,
  pruneExpiredWindows,
  mergeQuotaWindows,
  pickCriticalWindow,
  createUnavailableQuotaResult,
};
