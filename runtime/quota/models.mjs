export const FIVE_HOUR_WINDOW_THRESHOLD_MS = 12 * 60 * 60 * 1000;

export const FALLBACK_AGENT_MODEL_IDS = [
  'gemini-3-flash-agent',
  'gemini-3.5-flash-low',
  'gemini-3.5-flash-extra-low',
  'gemini-pro-agent',
  'gemini-3.1-pro-low',
  'gemini-4-argon',
  'claude-sonnet-4-6',
  'claude-opus-4-6-thinking',
  'gpt-oss-120b-medium',
];

export function discoverAgentModelIds(apiResponse) {
  if (!apiResponse || typeof apiResponse !== 'object') return null;
  const ids = [];
  const sorts = apiResponse.agentModelSorts;
  if (Array.isArray(sorts)) {
    for (const sort of sorts) {
      for (const group of sort?.groups || []) {
        for (const id of group?.modelIds || []) {
          if (typeof id === 'string' && id.trim() && !ids.includes(id)) {
            ids.push(id);
          }
        }
      }
    }
  }
  const tiered = apiResponse.tieredModelIds;
  if (tiered && typeof tiered === 'object') {
    for (const group of Object.values(tiered)) {
      if (Array.isArray(group)) {
        for (const id of group) {
          if (typeof id === 'string' && id.trim() && !ids.includes(id)) {
            ids.push(id);
          }
        }
      }
    }
  }
  return ids.length > 0 ? ids : null;
}

export function resolveDeprecatedIds(ids, apiResponse) {
  if (!Array.isArray(ids)) return [];
  const deprecated = apiResponse?.deprecatedModelIds;
  if (!deprecated || typeof deprecated !== 'object') return ids;
  return ids.map((id) => deprecated[id]?.newModelId || id);
}

export function normalizeRemainingFraction(value, hasResetTime = false) {
  if (value === undefined || value === null) {
    return hasResetTime ? 0 : 1;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

export function classifyQuotaWindow(resetTime, now = Date.now()) {
  if (!resetTime) return null;
  const ms = new Date(resetTime).getTime() - now;
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return ms < FIVE_HOUR_WINDOW_THRESHOLD_MS ? 'fiveHour' : 'weekly';
}

export function isObservationExpired(observation, now = Date.now()) {
  if (!observation || !observation.resetTime) return false;
  const t = new Date(observation.resetTime).getTime();
  return Number.isFinite(t) && t <= now;
}

export function pruneExpiredWindows(windows, now = Date.now()) {
  if (!windows) return {};
  const out = {};
  if (windows.fiveHour && !isObservationExpired(windows.fiveHour, now)) out.fiveHour = windows.fiveHour;
  if (windows.weekly && !isObservationExpired(windows.weekly, now)) out.weekly = windows.weekly;
  return out;
}

export function normalizeQuotaModels(models, interestingModelIds = FALLBACK_AGENT_MODEL_IDS, now = Date.now()) {
  const results = [];
  for (const id of interestingModelIds) {
    const m = models[id];
    if (!m || !m.quotaInfo) continue;
    const qi = m.quotaInfo;
    const resetTime = qi.resetTime || null;
    const remainingFraction = normalizeRemainingFraction(qi.remainingFraction, Boolean(resetTime));
    const window = classifyQuotaWindow(resetTime, now);
    const observation = resetTime ? { remainingFraction, resetTime, observedAt: now } : null;
    results.push({
      id,
      displayName: m.displayName || id,
      modelProvider: m.modelProvider || null,
      remainingFraction,
      resetTime,
      window,
      windows: observation && window ? { [window]: observation } : {},
    });
  }
  return results;
}

function pickAnchoredWindow(oldWin, freshWin, now) {
  if (!oldWin) return freshWin;
  if (!freshWin) return oldWin;
  if (oldWin.remainingFraction >= 1 && freshWin.remainingFraction >= 1 && oldWin.resetTime && freshWin.resetTime) {
    const oldTs = Date.parse(oldWin.resetTime);
    const freshTs = Date.parse(freshWin.resetTime);
    if (Number.isFinite(oldTs) && Number.isFinite(freshTs) && oldTs > now && oldTs < freshTs) {
      return { ...freshWin, resetTime: oldWin.resetTime };
    }
  }
  return freshWin;
}

export function mergeQuotaWindows(fresh, previous, now = Date.now()) {
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
    const freshWindows = q.windows || {};
    const merged = { ...prevWindows, ...freshWindows };
    for (const winKey of ['fiveHour', 'weekly']) {
      if (prevWindows[winKey] && freshWindows[winKey]) {
        merged[winKey] = pickAnchoredWindow(prevWindows[winKey], freshWindows[winKey], now);
      }
    }
    let topResetTime = q.resetTime;
    if (q.remainingFraction >= 1 && q.window && merged[q.window]?.resetTime) {
      topResetTime = merged[q.window].resetTime;
    } else if (
      prev &&
      prev.remainingFraction >= 1 &&
      q.remainingFraction >= 1 &&
      prev.resetTime &&
      q.resetTime &&
      (!prev.window || !q.window || prev.window === q.window)
    ) {
      const oldTs = Date.parse(prev.resetTime);
      const freshTs = Date.parse(q.resetTime);
      if (Number.isFinite(oldTs) && Number.isFinite(freshTs) && oldTs > now && oldTs < freshTs) {
        topResetTime = prev.resetTime;
      }
    }
    results.push({ ...q, resetTime: topResetTime, windows: merged });
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

export function pickCriticalWindow(windows, now = Date.now()) {
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

export function createUnavailableQuotaResult(reason) {
  const result = [];
  Object.defineProperty(result, 'unavailableReason', {
    value: reason,
    enumerable: false,
  });
  return result;
}
