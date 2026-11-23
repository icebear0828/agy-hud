'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { resolveAntigravityPath } = require('./paths.js');
const costModule = require('./cost.js');
const {
  classifyQuotaWindow,
  isObservationExpired,
} = require('./quota/models.js');
const {
  simplifyModelName,
  modelIncludesCacheInInput,
} = require('./renderer/format.js');

const LEDGER_VERSION = 1;
const MIN_DELTA_Q_5H = 0.02;
const MIN_DELTA_Q_WEEKLY = 0.01;
const MIN_OBSERVED_TOKENS = 1000;
const WRITE_THROTTLE_MS = 30_000;
const SESSION_TTL_MS = 8 * 24 * 60 * 60 * 1000;
const MAX_ACCOUNTS = 10;
const MAX_SESSIONS_PER_ACCOUNT = 50;
const PRIOR_EMA_ALPHA = 0.4;
const SHRINKAGE_THRESHOLD_DELTA_Q = 0.05;
const UPWARD_JITTER_TOLERANCE = 0.02;

const WINDOW_DURATION_MS = {
  fiveHour: 5 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
};

const WINDOW_JITTER_MS = {
  fiveHour: 5 * 60 * 1000,
  weekly: 30 * 60 * 1000,
};

const DEFAULT_TOKEN_MIX = {
  in: 0.15,
  out: 0.15,
  cache: 0.70,
};

// Fallback pricing per 1,000,000 tokens (USD), matching runtime/cost.js + argon/gpt.
const FALLBACK_MODEL_PRICING = [
  { key: 'opus',   pattern: /opus/i,   input: 15.00, output: 75.00, cacheRead: 1.50 },
  { key: 'sonnet', pattern: /sonnet/i, input: 3.00,  output: 15.00, cacheRead: 0.30 },
  { key: 'haiku',  pattern: /haiku/i,  input: 0.80,  output: 4.00,  cacheRead: 0.08 },
  { key: 'argon',  pattern: /argon/i,  input: 1.25,  output: 5.00,  cacheRead: 0.3125 },
  { key: 'pro',    pattern: /pro/i,    input: 1.25,  output: 5.00,  cacheRead: 0.3125 },
  { key: 'flash',  pattern: /flash/i,  input: 0.075, output: 0.30,  cacheRead: 0.01875 },
  { key: 'gpt4',   pattern: /gpt-?4/i, input: 2.50,  output: 10.00, cacheRead: 1.25 },
  { key: 'gpt',    pattern: /gpt/i,    input: 2.50,  output: 10.00, cacheRead: 1.25 },
];

const FALLBACK_DEFAULT_PRICING = {
  key: 'default',
  input: 0.075,
  output: 0.30,
  cacheRead: 0.01875,
};

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonNegFinite(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function firstNonNegFinite(...values) {
  for (const value of values) {
    if (isNonNegFinite(value)) return value;
  }
  return undefined;
}

function clamp(min, max, value) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function parseResetMs(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  if (typeof value === 'string' && value) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

function hasSubPercentPrecision(remainingFraction) {
  if (!Number.isFinite(remainingFraction)) return false;
  const pct = remainingFraction * 100;
  return Math.abs(pct - Math.round(pct)) > 1e-4;
}

function fallbackGetModelPricing(modelNameOrId) {
  const modelStr = String(modelNameOrId || '');
  return FALLBACK_MODEL_PRICING.find(p => p.pattern.test(modelStr)) || FALLBACK_DEFAULT_PRICING;
}

function getEffectiveModelPricing(modelNameOrId) {
  if (typeof costModule.getModelPricing === 'function') {
    const p = costModule.getModelPricing(modelNameOrId);
    if (p && isNonNegFinite(p.input) && isNonNegFinite(p.output) && isNonNegFinite(p.cacheRead)) {
      return p;
    }
  }
  return fallbackGetModelPricing(modelNameOrId);
}

/**
 * Resolve the normalized pricing family key for a model name or ID.
 * @param {string|Object} modelNameOrId
 * @returns {string}
 */
function resolveModelPricingKey(modelNameOrId) {
  const raw = typeof modelNameOrId === 'string'
    ? modelNameOrId
    : (modelNameOrId?.id || modelNameOrId?.display_name || modelNameOrId?.displayName || '');
  const entry = FALLBACK_MODEL_PRICING.find(p => p.pattern.test(String(raw)));
  return entry ? entry.key : 'default';
}

/**
 * Resolve the quota bucket ('argon' | 'google' | 'claude' | null) for a model or quota entry.
 * Mirrors cloud.js:233-236 and quota-render.js:81-84 identically. Image models return null.
 *
 * @param {string|Object} modelOrQuota
 * @returns {'argon'|'google'|'claude'|null}
 */
function resolveQuotaBucket(modelOrQuota) {
  if (!modelOrQuota) return null;
  const id = typeof modelOrQuota === 'string' ? modelOrQuota : String(modelOrQuota.id || '');
  const displayName = typeof modelOrQuota === 'string'
    ? modelOrQuota
    : String(modelOrQuota.displayName || modelOrQuota.display_name || '');
  const modelProvider = typeof modelOrQuota === 'object' ? (modelOrQuota.modelProvider || '') : '';

  if (/image/i.test(id) || /image/i.test(displayName)) return null;

  const isArgon = /argon/i.test(id) || /argon/i.test(displayName);
  if (isArgon) return 'argon';

  const isGoogle = modelProvider === 'MODEL_PROVIDER_GOOGLE'
    || /gemini/i.test(id)
    || /gemini/i.test(displayName);
  if (isGoogle) return 'google';

  const isClaude = modelProvider === 'MODEL_PROVIDER_ANTHROPIC'
    || modelProvider === 'MODEL_PROVIDER_OPENAI'
    || /claude|sonnet|opus|haiku|gpt/i.test(id)
    || /claude|sonnet|opus|haiku|gpt/i.test(displayName);
  if (isClaude) return 'claude';

  return null;
}

function getQuotaCapacityLedgerPath(rootDir = null) {
  if (rootDir) return path.join(rootDir, 'quota-capacity.json');
  return resolveAntigravityPath('quota-capacity.json');
}

/**
 * Extract current observed cumulative session tokens, honoring cache-in-input semantics.
 *
 * @param {Object} agyData
 * @param {Object|null} state
 * @param {string|null} modelNameOrId
 * @returns {{ totalIn: number, out: number, cache: number, uncachedIn: number, rawTotal: number, includesCache: boolean }}
 */
function extractSessionTokens(agyData, state = null, modelNameOrId = null) {
  const model = modelNameOrId ?? agyData?.model?.id ?? agyData?.model?.display_name ?? '';
  const usage = agyData?.context_window || {};
  const agyCurrent = usage.current_usage || {};
  const transcriptUsage = state?.usage || {};
  const transcriptCurrent = transcriptUsage.current_usage || {};

  const totalIn = firstNonNegFinite(
    usage.total_input_tokens,
    transcriptUsage.total_input_tokens,
    agyCurrent.input_tokens,
    transcriptCurrent.input_tokens
  ) ?? 0;

  const out = firstNonNegFinite(
    usage.total_output_tokens,
    transcriptUsage.total_output_tokens,
    agyCurrent.output_tokens,
    transcriptCurrent.output_tokens
  ) ?? 0;

  const rawCacheRead = firstNonNegFinite(
    agyCurrent.cache_read_input_tokens,
    usage.cache_read_input_tokens,
    transcriptCurrent.cache_read_input_tokens,
    transcriptUsage.cache_read_input_tokens
  ) ?? 0;

  const includesCache = modelIncludesCacheInInput(model);
  const cache = includesCache ? Math.min(totalIn, rawCacheRead) : rawCacheRead;
  const uncachedIn = includesCache ? Math.max(0, totalIn - cache) : totalIn;
  const rawTotal = uncachedIn + cache + out;

  return {
    totalIn,
    out,
    cache,
    uncachedIn,
    rawTotal,
    includesCache,
  };
}

/**
 * Compute deterministic cost-weighted spend units for token deltas using a single pricing source.
 *
 * @param {{ uncachedIn?: number, in?: number, dUncachedIn?: number, out?: number, dOut?: number, cache?: number, dCache?: number }} deltas
 * @param {string} modelNameOrId
 * @returns {number}
 */
function computeWeightedUnits(deltas, modelNameOrId) {
  if (!deltas || typeof deltas !== 'object') return 0;
  const p = getEffectiveModelPricing(modelNameOrId);
  const dUncachedIn = Math.max(0, Number(deltas.uncachedIn ?? deltas.dUncachedIn ?? deltas.in ?? 0) || 0);
  const dOut = Math.max(0, Number(deltas.out ?? deltas.dOut ?? 0) || 0);
  const dCache = Math.max(0, Number(deltas.cache ?? deltas.dCache ?? 0) || 0);

  const units = (dUncachedIn * p.input + dOut * p.output + dCache * p.cacheRead) / 1_000_000;
  return Number.isFinite(units) && units > 0 ? units : 0;
}

/**
 * Compute weighted spend units per raw token for a given token mix and active model.
 *
 * @param {{ in: number, out: number, cache: number }} mix
 * @param {string} modelNameOrId
 * @returns {number}
 */
function computeUnitsPerToken(mix, modelNameOrId) {
  const m = isObject(mix) ? mix : DEFAULT_TOKEN_MIX;
  const rawIn = Math.max(0, Number(m.in) || 0);
  const rawOut = Math.max(0, Number(m.out) || 0);
  const rawCache = Math.max(0, Number(m.cache) || 0);
  const sum = rawIn + rawOut + rawCache;

  const normalized = sum > 0
    ? { in: rawIn / sum, out: rawOut / sum, cache: rawCache / sum }
    : DEFAULT_TOKEN_MIX;

  const p = getEffectiveModelPricing(modelNameOrId);
  const unitsPerTok = (
    normalized.in * p.input +
    normalized.out * p.output +
    normalized.cache * p.cacheRead
  ) / 1_000_000;

  return Number.isFinite(unitsPerTok) && unitsPerTok > 0 ? unitsPerTok : 0;
}

function normalizeMixCounts(counts) {
  if (!isObject(counts)) return null;
  const cIn = Math.max(0, Number(counts.in ?? counts.uncachedIn ?? 0) || 0);
  const cOut = Math.max(0, Number(counts.out ?? 0) || 0);
  const cCache = Math.max(0, Number(counts.cache ?? 0) || 0);
  const total = cIn + cOut + cCache;
  if (total < MIN_OBSERVED_TOKENS) return null;
  return {
    in: cIn / total,
    out: cOut / total,
    cache: cCache / total,
  };
}

/**
 * Resolve active-model token mix with 4-level fallback priority:
 *   1. windowState.byModel[activeModelKey] if >= 1000 tokens
 *   2. current session mix if same model family and >= 1000 tokens
 *   3. bucket window aggregate mix if >= 1000 tokens
 *   4. default coding-agent mix { in: 0.15, out: 0.15, cache: 0.70 }
 *
 * @param {Object|null} windowState
 * @param {string} activeModelKey
 * @param {Object|null} [sessionTokens]
 * @returns {{ in: number, out: number, cache: number }}
 */
function resolveActiveTokenMix(windowState, activeModelKey, sessionTokens = null) {
  const key = activeModelKey || 'default';

  // 1. Observed mix for active model in this window
  const modelMix = normalizeMixCounts(windowState?.byModel?.[key]);
  if (modelMix) return modelMix;

  // 2. Current session mix if same model family
  if (isObject(sessionTokens)) {
    const sessKey = sessionTokens.modelKey || resolveModelPricingKey(sessionTokens.model || '');
    if (!sessionTokens.modelKey || sessKey === key) {
      const sessMix = normalizeMixCounts({
        in: sessionTokens.uncachedIn ?? sessionTokens.in ?? 0,
        out: sessionTokens.out ?? 0,
        cache: sessionTokens.cache ?? 0,
      });
      if (sessMix) return sessMix;
    }
  }

  // 3. Bucket window aggregate mix across all models in this window
  if (isObject(windowState?.byModel)) {
    let aggIn = 0;
    let aggOut = 0;
    let aggCache = 0;
    for (const counts of Object.values(windowState.byModel)) {
      if (!isObject(counts)) continue;
      aggIn += Math.max(0, Number(counts.in ?? 0) || 0);
      aggOut += Math.max(0, Number(counts.out ?? 0) || 0);
      aggCache += Math.max(0, Number(counts.cache ?? 0) || 0);
    }
    const bucketMix = normalizeMixCounts({ in: aggIn, out: aggOut, cache: aggCache });
    if (bucketMix) return bucketMix;
  }

  // 4. Default coding-agent token mix
  return { ...DEFAULT_TOKEN_MIX };
}

/**
 * Extract active non-expired quota windows per bucket from effectiveQuotaData.
 * Mirrors providerQuota precedence and model fallback in quota-render.js.
 *
 * @param {Array|Object|null} quotaData
 * @param {number} [now]
 * @returns {{ google: { fiveHour: Object|null, weekly: Object|null }, claude: { fiveHour: Object|null, weekly: Object|null }, argon: { fiveHour: Object|null, weekly: Object|null } }|null}
 */
function extractBucketWindows(quotaData, now = Date.now()) {
  if (!quotaData || quotaData.unavailableReason) return null;

  const buckets = {
    google: { fiveHour: null, weekly: null },
    claude: { fiveHour: null, weekly: null },
    argon: { fiveHour: null, weekly: null },
  };
  let hasAny = false;

  const mergeModelWin = (bucketKey, winType, win) => {
    if (!win || !Number.isFinite(win.remainingFraction)) return;
    if (isObservationExpired(win, now)) return;
    const normalized = {
      remainingFraction: clamp(0, 1, win.remainingFraction),
      resetTime: win.resetTime || null,
      observedAt: Number.isFinite(win.observedAt) ? win.observedAt : now,
    };
    const cur = buckets[bucketKey][winType];
    if (
      !cur ||
      normalized.observedAt > (cur.observedAt || 0) ||
      (normalized.observedAt === (cur.observedAt || 0) && normalized.remainingFraction < cur.remainingFraction)
    ) {
      buckets[bucketKey][winType] = normalized;
      hasAny = true;
    }
  };

  if (Array.isArray(quotaData)) {
    for (const q of quotaData) {
      if (!q) continue;
      const bucketKey = resolveQuotaBucket(q);
      if (!bucketKey) continue;

      if (q.windows?.fiveHour) mergeModelWin(bucketKey, 'fiveHour', q.windows.fiveHour);
      if (q.windows?.weekly) mergeModelWin(bucketKey, 'weekly', q.windows.weekly);

      if (!q.windows?.fiveHour && !q.windows?.weekly && q.resetTime && Number.isFinite(q.remainingFraction)) {
        const winType = classifyQuotaWindow(q.resetTime, now);
        if (winType) {
          mergeModelWin(bucketKey, winType, {
            remainingFraction: q.remainingFraction,
            resetTime: q.resetTime,
            observedAt: now,
          });
        }
      }
    }
  }

  // Authoritative providerQuota overrides per-model windows.
  const pq = quotaData.providerQuota;
  if (isObject(pq)) {
    for (const bucketKey of ['google', 'claude', 'argon']) {
      const pBucket = pq[bucketKey];
      if (!isObject(pBucket)) continue;
      for (const winType of ['fiveHour', 'weekly']) {
        const win = pBucket[winType];
        if (!win || !Number.isFinite(win.remainingFraction)) continue;
        if (isObservationExpired(win, now)) continue;
        buckets[bucketKey][winType] = {
          remainingFraction: clamp(0, 1, win.remainingFraction),
          resetTime: win.resetTime || null,
          observedAt: Number.isFinite(win.observedAt) ? win.observedAt : now,
        };
        hasAny = true;
      }
    }
  }

  return hasAny ? buckets : null;
}

/**
 * Detect whether a quota window has rolled over to a new cycle.
 *
 * @param {Object|null} prevWindow
 * @param {Object|null} newReading
 * @param {'fiveHour'|'weekly'} windowType
 * @param {number} [now]
 * @returns {boolean}
 */
function detectWindowRollover(prevWindow, newReading, windowType, now = Date.now()) {
  if (!prevWindow || !newReading) return false;

  const jitterMs = WINDOW_JITTER_MS[windowType] || WINDOW_JITTER_MS.fiveHour;
  const prevResetMs = parseResetMs(prevWindow.resetMs ?? prevWindow.resetTime);
  const newResetMs = parseResetMs(newReading.resetTime);

  if (prevResetMs !== null && now >= prevResetMs) {
    return true;
  }

  if (prevResetMs !== null && newResetMs !== null && (newResetMs - prevResetMs) > jitterMs) {
    return true;
  }

  const prevRem = prevWindow.lastRemaining;
  const currRem = newReading.remainingFraction;
  if (Number.isFinite(prevRem) && Number.isFinite(currRem) && currRem > prevRem + UPWARD_JITTER_TOLERANCE) {
    return true;
  }

  return false;
}

function resolveMinDeltaQ(windowType, win, options = {}) {
  const override = options?.minDeltaQ ?? options?.quotaCapacityMinDelta;
  if (typeof override === 'number' && Number.isFinite(override) && override > 0 && override < 1) {
    return override;
  }
  if (windowType === 'weekly') {
    return win?.hasSubPercentPrecision ? MIN_DELTA_Q_WEEKLY : MIN_DELTA_Q_5H;
  }
  return MIN_DELTA_Q_5H;
}

function createEmptyWindowState(reading, windowType, now) {
  const resetMs = parseResetMs(reading.resetTime);
  const durationMs = WINDOW_DURATION_MS[windowType] || WINDOW_DURATION_MS.fiveHour;
  const openedAt = resetMs !== null ? resetMs - durationMs : now;
  const currRem = clamp(0, 1, reading.remainingFraction);
  return {
    resetMs,
    openedAt,
    lastRemaining: currRem,
    hasSubPercentPrecision: hasSubPercentPrecision(currRem),
    liveUnits: 0,
    lastTickUnits: 0,
    observedUnits: 0,
    observedDeltaQ: 0,
    observedRawTokens: 0,
    pendingRawTokens: 0,
    byModel: {},
    pendingByModel: {},
  };
}

function addModelCounts(targetMap, modelKey, dIn, dOut, dCache) {
  if (dIn <= 0 && dOut <= 0 && dCache <= 0) return;
  if (!isObject(targetMap[modelKey])) {
    targetMap[modelKey] = { in: 0, out: 0, cache: 0 };
  }
  targetMap[modelKey].in += dIn;
  targetMap[modelKey].out += dOut;
  targetMap[modelKey].cache += dCache;
}

function flushPendingModels(win) {
  if (!isObject(win.pendingByModel)) return;
  if (!isObject(win.byModel)) win.byModel = {};
  for (const [mKey, counts] of Object.entries(win.pendingByModel)) {
    if (!isObject(counts)) continue;
    addModelCounts(
      win.byModel,
      mKey,
      Math.max(0, Number(counts.in) || 0),
      Math.max(0, Number(counts.out) || 0),
      Math.max(0, Number(counts.cache) || 0)
    );
  }
  win.pendingByModel = {};
}

function archiveWindowPrior(bucket, windowType, prevWin, options = {}) {
  if (!prevWin) return;
  const minDeltaQ = resolveMinDeltaQ(windowType, prevWin, options);
  if (
    prevWin.observedDeltaQ >= minDeltaQ &&
    prevWin.observedRawTokens >= MIN_OBSERVED_TOKENS &&
    prevWin.observedUnits > 0
  ) {
    const liveCapUnits = prevWin.observedUnits / prevWin.observedDeltaQ;
    if (Number.isFinite(liveCapUnits) && liveCapUnits > 0) {
      if (!isObject(bucket.prior)) bucket.prior = {};
      const existingPrior = bucket.prior[windowType];
      if (typeof existingPrior === 'number' && Number.isFinite(existingPrior) && existingPrior > 0) {
        bucket.prior[windowType] = PRIOR_EMA_ALPHA * liveCapUnits + (1 - PRIOR_EMA_ALPHA) * existingPrior;
      } else {
        bucket.prior[windowType] = liveCapUnits;
      }
    }
  }
}

function normalizeAccountKey(rawKey) {
  if (typeof rawKey !== 'string' || !rawKey.trim()) return 'default';
  const trimmed = rawKey.trim();
  if (trimmed.includes('@')) {
    return crypto.createHash('sha256').update(trimmed.toLowerCase()).digest('hex').slice(0, 16);
  }
  return trimmed;
}

function pruneAccountAndSessions(ledger, now) {
  let pruned = false;
  if (!isObject(ledger.accounts)) {
    ledger.accounts = {};
    return false;
  }

  for (const account of Object.values(ledger.accounts)) {
    if (!isObject(account) || !isObject(account.sessions)) continue;
    const entries = Object.entries(account.sessions);
    for (const [sid, s] of entries) {
      if (!isObject(s) || !isNonNegFinite(s.ts) || now - s.ts > SESSION_TTL_MS) {
        delete account.sessions[sid];
        pruned = true;
      }
    }
    const remaining = Object.entries(account.sessions);
    if (remaining.length > MAX_SESSIONS_PER_ACCOUNT) {
      remaining.sort((a, b) => (b[1].ts || 0) - (a[1].ts || 0));
      const keep = new Set(remaining.slice(0, MAX_SESSIONS_PER_ACCOUNT).map(([id]) => id));
      for (const [sid] of remaining) {
        if (!keep.has(sid)) {
          delete account.sessions[sid];
          pruned = true;
        }
      }
    }
  }

  const accountEntries = Object.entries(ledger.accounts);
  if (accountEntries.length > MAX_ACCOUNTS) {
    accountEntries.sort((a, b) => (b[1]?.lastSeenAt || 0) - (a[1]?.lastSeenAt || 0));
    const keep = new Set(accountEntries.slice(0, MAX_ACCOUNTS).map(([k]) => k));
    for (const [k] of accountEntries) {
      if (!keep.has(k)) {
        delete ledger.accounts[k];
        pruned = true;
      }
    }
  }

  return pruned;
}

/**
 * Pure ledger state-transition function: folds a single observation into the ledger.
 *
 * @param {Object|null} ledger
 * @param {Object} observation
 * @returns {{ ledger: Object, changed: boolean, accountKey: string, bucket: string|null, modelKey: string }}
 */
function foldObservationIntoLedger(ledger, observation) {
  const now = Number.isFinite(observation?.now) ? observation.now : Date.now();
  const nextLedger = isObject(ledger) && isObject(ledger.accounts)
    ? ledger
    : { version: LEDGER_VERSION, accounts: {} };
  let changed = !isObject(ledger) || !isObject(ledger.accounts);

  if (pruneAccountAndSessions(nextLedger, now)) {
    changed = true;
  }

  const accountKey = normalizeAccountKey(observation?.accountKey);
  if (!isObject(nextLedger.accounts[accountKey])) {
    nextLedger.accounts[accountKey] = {
      tier: null,
      lastSeenAt: now,
      sessions: {},
      buckets: {},
    };
    changed = true;
  }
  const account = nextLedger.accounts[accountKey];
  if (!isObject(account.sessions)) account.sessions = {};
  if (!isObject(account.buckets)) account.buckets = {};
  account.lastSeenAt = now;

  // Tier change invalidates priors immediately.
  const tier = typeof observation?.tier === 'string' && observation.tier.trim()
    ? observation.tier.trim()
    : null;
  if (tier) {
    if (account.tier && account.tier !== tier) {
      for (const b of Object.values(account.buckets)) {
        if (isObject(b)) b.prior = {};
      }
      account.tier = tier;
      changed = true;
    } else if (!account.tier) {
      account.tier = tier;
      changed = true;
    }
  }

  const bucketKey = observation?.bucket || null;
  const modelKey = observation?.modelKey || 'default';
  const modelNameOrId = observation?.modelNameOrId || modelKey;
  const bucketWindows = observation?.bucketWindows || null;
  const options = observation?.options || {};

  // 1. Ensure windows exist & process rollovers across all observed buckets first.
  const windowNewlyCreated = {};
  if (isObject(bucketWindows)) {
    for (const [bKey, wins] of Object.entries(bucketWindows)) {
      if (!isObject(wins)) continue;
      if (!wins.fiveHour && !wins.weekly) continue;
      if (!isObject(account.buckets[bKey])) {
        account.buckets[bKey] = { prior: {}, windows: {} };
        changed = true;
      }
      const bucketState = account.buckets[bKey];
      if (!isObject(bucketState.windows)) bucketState.windows = {};
      if (!isObject(bucketState.prior)) bucketState.prior = {};

      for (const winType of ['fiveHour', 'weekly']) {
        const reading = wins[winType];
        if (!reading || !Number.isFinite(reading.remainingFraction)) continue;
        const prevWin = bucketState.windows[winType];
        if (!prevWin) {
          bucketState.windows[winType] = createEmptyWindowState(reading, winType, now);
          windowNewlyCreated[`${bKey}:${winType}`] = true;
          changed = true;
        } else if (detectWindowRollover(prevWin, reading, winType, now)) {
          archiveWindowPrior(bucketState, winType, prevWin, options);
          bucketState.windows[winType] = createEmptyWindowState(reading, winType, now);
          windowNewlyCreated[`${bKey}:${winType}`] = true;
          changed = true;
        } else {
          // Update sub-percent precision flag if observed.
          if (hasSubPercentPrecision(reading.remainingFraction) && !prevWin.hasSubPercentPrecision) {
            prevWin.hasSubPercentPrecision = true;
            changed = true;
          }
          // Refresh resetMs within jitter tolerance if previously missing.
          const newResetMs = parseResetMs(reading.resetTime);
          if (prevWin.resetMs === null && newResetMs !== null) {
            prevWin.resetMs = newResetMs;
            prevWin.openedAt = newResetMs - (WINDOW_DURATION_MS[winType] || WINDOW_DURATION_MS.fiveHour);
            changed = true;
          }
        }
      }
    }
  }

  // 2. Monotonic per-session token delta extraction & attribution to active bucket's windows.
  const rawSessionId = observation?.sessionId;
  const sessionId = typeof rawSessionId === 'string' ? rawSessionId.trim() : '';
  const tokens = observation?.tokens || null;
  const sessionStartedAt = Number.isFinite(observation?.sessionStartedAt)
    ? observation.sessionStartedAt
    : null;

  if (sessionId && isObject(tokens)) {
    const prevSess = account.sessions[sessionId];
    const includesCache = Boolean(tokens.includesCache);
    const obsTotalIn = Math.max(0, Number(tokens.totalIn) || 0);
    const obsOut = Math.max(0, Number(tokens.out) || 0);
    const obsCache = Math.max(0, Number(tokens.cache) || 0);

    if (!prevSess) {
      const cumTotalIn = obsTotalIn;
      const cumOut = obsOut;
      const cumCache = includesCache ? Math.min(cumTotalIn, obsCache) : obsCache;

      account.sessions[sessionId] = {
        totalIn: cumTotalIn,
        out: cumOut,
        cache: cumCache,
        modelKey,
        ts: now,
      };
      changed = true;

      // Resumed-session guard: only attribute 0 -> current if sessionStartedAt >= win.openedAt
      // AND (window already existed OR window started at 100% remaining).
      const dCache = cumCache;
      const dUncachedIn = includesCache ? Math.max(0, cumTotalIn - dCache) : cumTotalIn;
      const dOut = cumOut;
      const dRawTotal = dUncachedIn + dCache + dOut;

      if (bucketKey && dRawTotal > 0 && isObject(account.buckets[bucketKey]?.windows)) {
        const dUnits = computeWeightedUnits({ uncachedIn: dUncachedIn, out: dOut, cache: dCache }, modelNameOrId);
        for (const winType of ['fiveHour', 'weekly']) {
          const win = account.buckets[bucketKey].windows[winType];
          if (!win) continue;
          const isNewWin = Boolean(windowNewlyCreated[`${bucketKey}:${winType}`]);
          const startedInsideWindow = sessionStartedAt !== null && Number.isFinite(win.openedAt) && sessionStartedAt >= win.openedAt;
          const canCreditInitial = startedInsideWindow && (!isNewWin || win.lastRemaining >= 1.0);
          if (canCreditInitial && dUnits > 0) {
            win.liveUnits += dUnits;
            win.pendingRawTokens = (win.pendingRawTokens || 0) + dRawTotal;
            if (!isObject(win.pendingByModel)) win.pendingByModel = {};
            addModelCounts(win.pendingByModel, modelKey, dUncachedIn, dOut, dCache);
            changed = true;
          }
        }
      }
    } else {
      const cumTotalIn = Math.max(prevSess.totalIn || 0, obsTotalIn);
      const cumOut = Math.max(prevSess.out || 0, obsOut);
      const cumCache = includesCache
        ? Math.min(cumTotalIn, Math.max(prevSess.cache || 0, obsCache))
        : Math.max(prevSess.cache || 0, obsCache);

      const dRawIn = Math.max(0, cumTotalIn - (prevSess.totalIn || 0));
      const dCache = includesCache
        ? Math.min(dRawIn, Math.max(0, cumCache - (prevSess.cache || 0)))
        : Math.max(0, cumCache - (prevSess.cache || 0));
      const dUncachedIn = includesCache ? Math.max(0, dRawIn - dCache) : dRawIn;
      const dOut = Math.max(0, cumOut - (prevSess.out || 0));
      const dRawTotal = dUncachedIn + dCache + dOut;

      if (dRawTotal > 0 || prevSess.modelKey !== modelKey) {
        prevSess.totalIn = cumTotalIn;
        prevSess.out = cumOut;
        prevSess.cache = cumCache;
        prevSess.modelKey = modelKey;
        changed = true;
      }
      prevSess.ts = now;

      if (bucketKey && dRawTotal > 0 && isObject(account.buckets[bucketKey]?.windows)) {
        const dUnits = computeWeightedUnits({ uncachedIn: dUncachedIn, out: dOut, cache: dCache }, modelNameOrId);
        for (const winType of ['fiveHour', 'weekly']) {
          const win = account.buckets[bucketKey].windows[winType];
          if (!win) continue;
          if (dUnits > 0) {
            win.liveUnits += dUnits;
            win.pendingRawTokens = (win.pendingRawTokens || 0) + dRawTotal;
            if (!isObject(win.pendingByModel)) win.pendingByModel = {};
            addModelCounts(win.pendingByModel, modelKey, dUncachedIn, dOut, dCache);
            changed = true;
          }
        }
      }
    }
  }

  // 3. Matched-endpoint quota-tick sampling across all observed buckets.
  if (isObject(bucketWindows)) {
    for (const [bKey, wins] of Object.entries(bucketWindows)) {
      if (!isObject(wins) || !isObject(account.buckets[bKey]?.windows)) continue;
      for (const winType of ['fiveHour', 'weekly']) {
        const reading = wins[winType];
        const win = account.buckets[bKey].windows[winType];
        if (!reading || !win || !Number.isFinite(reading.remainingFraction)) continue;
        if (windowNewlyCreated[`${bKey}:${winType}`]) continue;

        const currRemaining = clamp(0, 1, reading.remainingFraction);
        const dQ = win.lastRemaining - currRemaining;

        if (dQ > 0) {
          const tickUnits = Math.max(0, (win.liveUnits || 0) - (win.lastTickUnits || 0));
          if (tickUnits > 0) {
            win.observedUnits = (win.observedUnits || 0) + tickUnits;
            win.observedDeltaQ = (win.observedDeltaQ || 0) + dQ;
            win.observedRawTokens = (win.observedRawTokens || 0) + (win.pendingRawTokens || 0);
            win.pendingRawTokens = 0;
            flushPendingModels(win);
            win.lastTickUnits = win.liveUnits;
          }
          // Always advance lastRemaining (external burn when tickUnits === 0 does not pollute observedDeltaQ).
          win.lastRemaining = currRemaining;
          changed = true;
        }
        // Upward jitter <= 0.02 is silently ignored (no negative dQ, no rollover).
      }
    }
  }

  return {
    ledger: nextLedger,
    changed,
    accountKey,
    bucket: bucketKey,
    modelKey,
  };
}

/**
 * Compute remaining and total token capacity estimates for a single window.
 *
 * @param {Object|null} win
 * @param {number|null} priorCapUnits
 * @param {string} activeModelKey
 * @param {Object|null} sessionTokens
 * @param {'fiveHour'|'weekly'} windowType
 * @param {Object} [options]
 * @returns {Object}
 */
function estimateWindowCapacity(win, priorCapUnits, activeModelKey, sessionTokens = null, windowType = 'fiveHour', options = {}) {
  const minDeltaQ = resolveMinDeltaQ(windowType, win, options);
  if (!win || !Number.isFinite(win.lastRemaining)) {
    return {
      status: 'idle',
      confidence: 'none',
      isPrior: false,
      remainingTokens: null,
      totalTokens: null,
      capacityUnits: null,
      observedDeltaQ: 0,
      minDeltaQ,
      remainingFraction: null,
      exhausted: false,
    };
  }

  const currRemaining = clamp(0, 1, win.lastRemaining);
  const observedDeltaQ = Math.max(0, Number(win.observedDeltaQ) || 0);
  const observedUnits = Math.max(0, Number(win.observedUnits) || 0);
  const observedRawTokens = Math.max(0, Number(win.observedRawTokens) || 0);

  const hasLive = observedDeltaQ >= minDeltaQ && observedRawTokens >= MIN_OBSERVED_TOKENS && observedUnits > 0;
  const hasPrior = typeof priorCapUnits === 'number' && Number.isFinite(priorCapUnits) && priorCapUnits > 0;

  if (!hasLive && !hasPrior) {
    if (observedDeltaQ > 0) {
      return {
        status: 'calibrating',
        confidence: 'none',
        isPrior: false,
        remainingTokens: null,
        totalTokens: null,
        capacityUnits: null,
        observedDeltaQ,
        minDeltaQ,
        remainingFraction: currRemaining,
        exhausted: currRemaining <= 0,
      };
    }
    return {
      status: 'idle',
      confidence: 'none',
      isPrior: false,
      remainingTokens: null,
      totalTokens: null,
      capacityUnits: null,
      observedDeltaQ: 0,
      minDeltaQ,
      remainingFraction: currRemaining,
      exhausted: currRemaining <= 0,
    };
  }

  let capacityUnits;
  let confidence;
  let isPrior;

  if (hasLive) {
    const liveCapUnits = observedUnits / observedDeltaQ;
    if (hasPrior && observedDeltaQ < SHRINKAGE_THRESHOLD_DELTA_Q) {
      const w = observedDeltaQ / SHRINKAGE_THRESHOLD_DELTA_Q;
      capacityUnits = w * liveCapUnits + (1 - w) * priorCapUnits;
    } else {
      capacityUnits = liveCapUnits;
    }
    confidence = 'high';
    isPrior = false;
  } else {
    capacityUnits = priorCapUnits;
    confidence = 'prior';
    isPrior = true;
  }

  const modelForPricing = options?.modelNameOrId || activeModelKey;
  const mix = resolveActiveTokenMix(win, activeModelKey, sessionTokens);
  const unitsPerTok = computeUnitsPerToken(mix, modelForPricing);
  if (!Number.isFinite(unitsPerTok) || unitsPerTok <= 0) {
    return {
      status: 'idle',
      confidence: 'none',
      isPrior: false,
      remainingTokens: null,
      totalTokens: null,
      capacityUnits: null,
      observedDeltaQ,
      minDeltaQ,
      remainingFraction: currRemaining,
      exhausted: currRemaining <= 0,
    };
  }

  const estTotalTokens = capacityUnits / unitsPerTok;
  const unreconciledUnits = Math.max(0, (win.liveUnits || 0) - (win.lastTickUnits || 0));
  const estRemainingTokens = currRemaining <= 0
    ? 0
    : clamp(0, estTotalTokens, Math.max(0, capacityUnits * currRemaining - unreconciledUnits) / unitsPerTok);

  return {
    status: 'ready',
    confidence,
    isPrior,
    remainingTokens: Math.round(estRemainingTokens),
    totalTokens: Math.round(estTotalTokens),
    capacityUnits,
    observedDeltaQ,
    minDeltaQ,
    remainingFraction: currRemaining,
    exhausted: currRemaining <= 0,
  };
}

function readLedger(ledgerPath) {
  try {
    const raw = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    if (!isObject(raw) || raw.version !== LEDGER_VERSION || !isObject(raw.accounts)) {
      return null;
    }
    return raw;
  } catch {
    return null;
  }
}

function isThrottled(ledgerPath, now) {
  try {
    return now - fs.statSync(ledgerPath).mtimeMs <= WRITE_THROTTLE_MS;
  } catch {
    return false;
  }
}

function writeLedger(ledgerPath, ledger, now) {
  const tmpPath = `${ledgerPath}.${process.pid}.${now}.tmp`;
  try {
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(tmpPath, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmpPath, ledgerPath);
    try {
      fs.utimesSync(ledgerPath, new Date(now), new Date(now));
    } catch {}
  } catch {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {}
  }
}

function formatCapacityModelLabel(rawModelName) {
  if (!rawModelName) return '';
  return simplifyModelName(String(rawModelName))
    .replace(/\((?:Th|H|M|L)\)\s*$/i, '')
    .trim();
}

const defaultDeps = {
  rootDir: () => resolveAntigravityPath(''),
  now: () => Date.now(),
};

/**
 * Top-level entry point: reads ledger, folds the current HUD observation,
 * persists atomically (with 30s throttle for timestamp-only writes), and returns
 * active-bucket 5h and weekly token capacity estimates.
 *
 * @param {Object} agyData
 * @param {Object} state
 * @param {Array|Object} quotaData
 * @param {Object} [options]
 * @param {Object} [deps]
 * @returns {Object|null}
 */
function getQuotaCapacityEstimates(agyData, state = null, quotaData = null, options = {}, deps = defaultDeps) {
  const now = typeof deps?.now === 'function' ? deps.now() : Date.now();
  const bucketWindows = extractBucketWindows(quotaData, now);
  if (!bucketWindows) return null;

  const rawModelId = agyData?.model?.id || '';
  const rawModelDisplay = agyData?.model?.display_name || '';
  const activeModelObj = (rawModelId || rawModelDisplay)
    ? { id: rawModelId, displayName: rawModelDisplay }
    : null;
  const activeBucket = resolveQuotaBucket(activeModelObj);
  if (!activeBucket) return null;

  const rawSessionId = agyData?.session_id || agyData?.conversation_id || state?.transcriptPath || '';
  const sessionId = typeof rawSessionId === 'string' ? rawSessionId.trim() : '';
  const accountKeyInput = options?.accountKey ?? state?.accountKey ?? null;

  // Guard against synthetic renderer unit tests without session/account identity touching real user disk.
  if (!sessionId && !accountKeyInput && deps === defaultDeps) {
    return null;
  }

  const rootDir = typeof deps?.rootDir === 'function' ? deps.rootDir() : null;
  const ledgerPath = options?.ledgerPath || getQuotaCapacityLedgerPath(rootDir);
  const stored = readLedger(ledgerPath);

  const modelForPricing = rawModelId || rawModelDisplay;
  const modelKey = resolveModelPricingKey(modelForPricing);
  const tokens = extractSessionTokens(agyData, state, modelForPricing);
  const tier = options?.tierName || agyData?.plan_tier || null;
  const sessionStartedAt = Number.isFinite(state?.sessionStartedAt)
    ? state.sessionStartedAt
    : (Number.isFinite(agyData?.session_started_at) ? agyData.session_started_at : null);

  const folded = foldObservationIntoLedger(stored, {
    now,
    accountKey: accountKeyInput,
    tier,
    bucket: activeBucket,
    modelKey,
    modelNameOrId: modelForPricing,
    sessionId,
    sessionStartedAt,
    tokens,
    bucketWindows,
    options,
  });

  if (folded.changed || !isThrottled(ledgerPath, now)) {
    writeLedger(ledgerPath, folded.ledger, now);
  }

  const account = folded.ledger.accounts[folded.accountKey];
  const bucketState = account?.buckets?.[activeBucket];
  if (!bucketState) return null;

  const sessionMixInput = {
    modelKey,
    uncachedIn: tokens.uncachedIn,
    out: tokens.out,
    cache: tokens.cache,
  };

  const estOpts = { ...options, modelNameOrId: modelForPricing };
  const fiveHour = estimateWindowCapacity(
    bucketState.windows?.fiveHour || null,
    bucketState.prior?.fiveHour ?? null,
    modelKey,
    sessionMixInput,
    'fiveHour',
    estOpts
  );
  const weekly = estimateWindowCapacity(
    bucketState.windows?.weekly || null,
    bucketState.prior?.weekly ?? null,
    modelKey,
    sessionMixInput,
    'weekly',
    estOpts
  );

  // Determine critical window for compact-mode inline display.
  let criticalWindow = null;
  const hasFive = Number.isFinite(fiveHour.remainingFraction);
  const hasWeek = Number.isFinite(weekly.remainingFraction);
  if (hasFive && hasWeek) {
    criticalWindow = fiveHour.remainingFraction <= weekly.remainingFraction ? 'fiveHour' : 'weekly';
  } else if (hasFive) {
    criticalWindow = 'fiveHour';
  } else if (hasWeek) {
    criticalWindow = 'weekly';
  }

  const critical = criticalWindow === 'fiveHour'
    ? fiveHour
    : (criticalWindow === 'weekly' ? weekly : null);

  return {
    bucket: activeBucket,
    modelName: formatCapacityModelLabel(rawModelDisplay || rawModelId),
    modelKey,
    fiveHour,
    weekly,
    criticalWindow,
    critical,
  };
}

module.exports = {
  getQuotaCapacityLedgerPath,
  resolveQuotaBucket,
  resolveModelPricingKey,
  extractSessionTokens,
  computeWeightedUnits,
  computeUnitsPerToken,
  resolveActiveTokenMix,
  extractBucketWindows,
  detectWindowRollover,
  foldObservationIntoLedger,
  estimateWindowCapacity,
  getQuotaCapacityEstimates,
  MIN_DELTA_Q_5H,
  MIN_DELTA_Q_WEEKLY,
  WRITE_THROTTLE_MS,
};
