'use strict';

const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const { resolveAntigravityPath } = require('./paths.js');

// Below 500ms API time a rate is mostly noise
const MIN_API_DELTA_MS = 500;

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
    return isCount(raw.apiDurationMs) && typeof raw.usageKey === 'string' && (speed === null || isCount(speed))
      ? { apiDurationMs: raw.apiDurationMs, usageKey: raw.usageKey, speed }
      : null;
  } catch {
    return null;
  }
}

function writeState(file, state) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {
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
  const usage = agyData?.context_window?.current_usage || agyData?.context_window || state?.usage?.current_usage || state?.usage;
  const output = usage?.output_tokens ?? agyData?.context_window?.total_output_tokens;
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
    usage.input_tokens ?? 0,
    output,
    usage.cache_creation_input_tokens ?? 0,
    usage.cache_read_input_tokens ?? 0,
  ].join(':');

  const previous = readState(file);
  if (!previous || apiDurationMs < previous.apiDurationMs) {
    writeState(file, { apiDurationMs, usageKey, speed: null });
    return null;
  }

  if (apiDurationMs === previous.apiDurationMs) {
    return previous.speed;
  }

  // API time from requests that leave the main usage untouched (e.g. subagents)
  // folds into the baseline instead of being charged to the next response.
  const deltaMs = apiDurationMs - previous.apiDurationMs;
  const isNewResponse = usageKey !== previous.usageKey && output > 0;
  const speed = isNewResponse && deltaMs >= MIN_API_DELTA_MS
    ? output / (deltaMs / 1000)
    : previous.speed;

  writeState(file, { apiDurationMs, usageKey, speed });
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
};
