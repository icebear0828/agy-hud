'use strict';

const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const { resolveAntigravityPath } = require('./paths.js');

// Below 500ms API time a rate is mostly noise
const MIN_API_DELTA_MS = 500;
const SPEED_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const SPEED_CACHE_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const SPEED_CACHE_MAX_PRUNE_DELETES = 50;

function isCount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function getSpeedCachePath(rootDir, transcriptPath) {
  const baseDir = rootDir || resolveAntigravityPath('speed-cache');
  const cacheDir = path.basename(baseDir) === 'speed-cache' ? baseDir : path.join(baseDir, 'speed-cache');
  const str = String(transcriptPath || '');
  const target = (path.isAbsolute(str) || str.includes('/') || str.includes('\\'))
    ? path.resolve(str)
    : str;
  const key = createHash('sha256').update(target).digest('hex');
  return path.join(cacheDir, `${key}.json`);
}

function readState(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const speed = raw.speed ?? null;
    const outputTokens = isCount(raw.outputTokens) ? raw.outputTokens : null;
    return isCount(raw.apiDurationMs) && typeof raw.usageKey === 'string' && (speed === null || isCount(speed))
      ? { apiDurationMs: raw.apiDurationMs, usageKey: raw.usageKey, speed, outputTokens }
      : null;
  } catch {
    return null;
  }
}

function pruneStaleSpeedCache(
  cacheDir,
  now = Date.now(),
  maxAgeMs = SPEED_CACHE_MAX_AGE_MS,
  maxDeletes = SPEED_CACHE_MAX_PRUNE_DELETES
) {
  let deleted = 0;
  try {
    const entries = fs.readdirSync(cacheDir);
    for (const name of entries) {
      if (deleted >= maxDeletes) break;
      if (name === '.last-prune') continue;
      if (!name.endsWith('.json') && !name.endsWith('.tmp')) continue;
      const fullPath = path.join(cacheDir, name);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.isFile() && now - stat.mtimeMs > maxAgeMs) {
          fs.unlinkSync(fullPath);
          deleted += 1;
        }
      } catch { /* ignore individual entry errors */ }
    }
  } catch { /* best-effort pruning */ }
  return deleted;
}

function maybePruneStaleSpeedCache(cacheDir, now = Date.now()) {
  try {
    const markerPath = path.join(cacheDir, '.last-prune');
    try {
      const stat = fs.statSync(markerPath);
      if (now - stat.mtimeMs < SPEED_CACHE_PRUNE_INTERVAL_MS) return;
    } catch { /* marker doesn't exist yet */ }
    fs.writeFileSync(markerPath, String(now), { mode: 0o600 });
    pruneStaleSpeedCache(cacheDir, now);
  } catch { /* best-effort */ }
}

function writeState(file, state) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    const cacheDir = path.dirname(file);
    fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(tmp, file);
    maybePruneStaleSpeedCache(cacheDir);
  } catch {
    try { fs.unlinkSync(tmp); } catch {}
    // Speed is cosmetic; safe fallback on permission/filesystem issues
  }
}

/**
 * Calculates output token speed (tokens / second) for the finished response.
 * Follows claude-hud contract and holds the reading until the next response.
 *
 * @param {Object} agyData
 * @param {string} [rootDir]
 * @param {Object} [state]
 * @returns {number|null}
 */
function getOutputSpeed(agyData, rootDir = null, state = null) {
  const transcriptPath = (agyData?.transcript_path || state?.transcriptPath || agyData?.session_id || '')?.trim();
  const currentUsage = agyData?.context_window?.current_usage || state?.usage?.current_usage || null;
  const hasPerTurnOutput = isCount(currentUsage?.output_tokens);
  const directOutput = !hasPerTurnOutput && isCount(agyData?.context_window?.output_tokens);
  const stateDirectOutput = !hasPerTurnOutput && !directOutput && isCount(state?.usage?.output_tokens);
  const isPerTurn = hasPerTurnOutput || directOutput || stateDirectOutput;

  const usage = isPerTurn
    ? (hasPerTurnOutput ? currentUsage : (directOutput ? agyData.context_window : state.usage))
    : (agyData?.context_window || state?.usage);
  const output = isPerTurn
    ? (hasPerTurnOutput ? currentUsage.output_tokens : (directOutput ? agyData.context_window.output_tokens : state.usage.output_tokens))
    : (agyData?.context_window?.total_output_tokens ?? state?.usage?.total_output_tokens);
  const isCumulative = !isPerTurn;

  const apiDurationMs = (
    agyData?.cost?.total_api_duration_ms ??
    agyData?.cost?.total_duration_ms ??
    agyData?.total_api_duration_ms ??
    state?.totalApiDurationMs
  );

  if (!transcriptPath || !usage || !isCount(output) || !isCount(apiDurationMs)) {
    return null;
  }

  const file = getSpeedCachePath(rootDir, transcriptPath);
  const usageKey = [
    usage.input_tokens ?? usage.total_input_tokens ?? 0,
    output,
    usage.cache_creation_input_tokens ?? 0,
    usage.cache_read_input_tokens ?? 0,
    isCumulative ? 'cum' : 'turn',
  ].join(':');

  const previous = readState(file);
  if (!previous || apiDurationMs < previous.apiDurationMs) {
    writeState(file, {
      apiDurationMs,
      usageKey,
      speed: null,
      outputTokens: isCumulative ? output : null,
    });
    return null;
  }

  if (apiDurationMs === previous.apiDurationMs) {
    return previous.speed;
  }

  // API time from requests that leave the main usage untouched (e.g. subagents)
  // folds into the baseline instead of being charged to the next response.
  const deltaMs = apiDurationMs - previous.apiDurationMs;
  let speed = previous.speed;

  if (isCumulative) {
    if (previous.outputTokens === null) {
      // Transitioned from legacy/per-turn state without a cumulative baseline.
      writeState(file, { apiDurationMs, usageKey, speed: previous.speed, outputTokens: output });
      return previous.speed;
    }
    if (output < previous.outputTokens) {
      // Cumulative counter reset -> start over cleanly.
      writeState(file, { apiDurationMs, usageKey, speed: null, outputTokens: output });
      return null;
    }
    const deltaOutput = output - previous.outputTokens;
    if (deltaOutput > 0 && deltaMs >= MIN_API_DELTA_MS) {
      speed = deltaOutput / (deltaMs / 1000);
    }
  } else {
    const isNewResponse = usageKey !== previous.usageKey && output > 0;
    if (isNewResponse && deltaMs >= MIN_API_DELTA_MS) {
      speed = output / (deltaMs / 1000);
    }
  }

  writeState(file, {
    apiDurationMs,
    usageKey,
    speed,
    outputTokens: isCumulative ? output : null,
  });
  return speed;
}

/**
 * Formats token output speed string according to locale.
 *
 * @param {number|null} speed
 * @param {string} [lang='en']
 * @returns {string|null}
 */
function formatSpeed(speed, lang = 'en') {
  if (speed === null || speed === undefined || !Number.isFinite(speed)) {
    return null;
  }
  const prefix = lang === 'zh' ? '输出' : 'out';
  return `${prefix}: ${speed.toFixed(1)} tok/s`;
}

module.exports = {
  getOutputSpeed,
  formatSpeed,
  getSpeedCachePath,
  pruneStaleSpeedCache,
  SPEED_CACHE_MAX_AGE_MS,
};
