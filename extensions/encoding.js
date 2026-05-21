'use strict';

const { execSync } = require('child_process');

/**
 * Read the active Windows console codepage via `chcp`.
 * Returns the numeric codepage as a string, or '' if unavailable.
 * @returns {string}
 */
function readWindowsCodepage() {
  try {
    const out = execSync('chcp', { stdio: ['ignore', 'pipe', 'ignore'], timeout: 500 }).toString();
    const match = out.match(/(\d{3,5})/);
    return match ? match[1] : '';
  } catch {
    return '';
  }
}

/**
 * Decide whether the current terminal can render the box-drawing and Nerd Font
 * glyphs used by the HUD.
 *
 * Resolution order:
 *   1. AGY_HUD_FORCE_ASCII=1   → false
 *   2. AGY_HUD_FORCE_UNICODE=1 → true
 *   3. Windows: codepage 65001 → true, anything else → false
 *   4. Unix: LANG/LC_ALL/LC_CTYPE contains "UTF-8" or "utf8" → true
 *   5. Default → true (modern terminals dominate)
 *
 * @param {object} [opts]
 * @param {NodeJS.ProcessEnv} [opts.env]      defaults to process.env
 * @param {NodeJS.Platform}  [opts.platform]  defaults to process.platform
 * @param {() => string}     [opts.readCodepage] injected for testability
 * @returns {boolean}
 */
function detectUnicodeSupport(opts = {}) {
  const env = opts.env || process.env;
  const platform = opts.platform || process.platform;
  const readCodepage = opts.readCodepage || readWindowsCodepage;

  if (env.AGY_HUD_FORCE_ASCII === '1') return false;
  if (env.AGY_HUD_FORCE_UNICODE === '1') return true;

  if (platform === 'win32') {
    const cp = readCodepage();
    return cp === '65001';
  }

  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG || '';
  if (/utf-?8/i.test(locale)) return true;
  if (locale && locale.toUpperCase().includes('POSIX')) return false;
  if (!locale) return true;
  return false;
}

let _cached = null;
function supportsUnicode() {
  if (_cached === null) _cached = detectUnicodeSupport();
  return _cached;
}

module.exports = {
  detectUnicodeSupport,
  supportsUnicode,
};
