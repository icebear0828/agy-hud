'use strict';

const ANSI_COLORS = {
  gray: '\x1b[90m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  red: '\x1b[31m',
};

const DEFAULT_THRESHOLDS = {
  warning: 0.7,
  critical: 0.9,
};

const DEFAULT_COLUMN_WIDTH = 40;
const QUOTA_CHROME_WIDTH = 21;

const TIER_ABBREVS = { Thinking: 'Th', High: 'H', Medium: 'M', Low: 'L' };

const ABBREVIATION_RULES = [
  [/^Gemini (\d+\.\d+) (Flash|Pro) \((\w+)\)/, (_, ver, fam, tier) =>
    `Gemini ${ver} ${fam}(${TIER_ABBREVS[tier] || tier[0]})`],
  [/^Claude (\w+) ([\d.]+) \((\w+)\)/, (_, fam, ver, tier) =>
    `${fam} ${ver}(${TIER_ABBREVS[tier] || tier[0]})`],
  [/^GPT-OSS (.+?) \(\w+\)/, (_, spec) => `GPT-OSS ${spec}`],
];

function abbreviateDisplayName(name) {
  for (const [re, replacer] of ABBREVIATION_RULES) {
    const m = re.exec(name);
    if (m) return name.replace(re, replacer);
  }
  return name;
}

function simplifyModelName(name) {
  if (!name) return '';
  return abbreviateDisplayName(name);
}

const COMPACT_NAME_RULES = [
  [/^Gemini [\d.]+ (Flash|Pro) \((\w+)\)/, (_, fam, tier) =>
    `${fam}(${TIER_ABBREVS[tier] || tier[0]})`],
  [/^Claude (\w+) [\d.]+ \((\w+)\)/, (_, fam) => fam],
  [/^GPT-OSS .+/, () => 'GPT'],
];

function compactModelName(displayName) {
  for (const [re, replacer] of COMPACT_NAME_RULES) {
    const m = re.exec(displayName);
    if (m) return displayName.replace(re, replacer);
  }
  return displayName.slice(0, 6);
}

function normalizeModelMatchValue(value) {
  if (!value) return '';
  return simplifyModelName(value)
    .replace(/\s+(preview|experimental|beta|latest)$/i, '')
    .trim()
    .toLowerCase();
}

function modelNamesMatch(left, right) {
  const a = normalizeModelMatchValue(left);
  const b = normalizeModelMatchValue(right);
  if (!a || !b) return false;
  return a === b || a.startsWith(`${b} `) || b.startsWith(`${a} `);
}

function modelIncludesCacheInInput(nameOrId) {
  if (!nameOrId) return false;
  const name = nameOrId.toLowerCase();
  return name.includes('claude') || name.includes('sonnet') || name.includes('opus') || name.includes('haiku') || name.includes('gpt');
}

/**
 * Format a token count into "1.2M", "150k", or "42" (compact).
 * Boundary thresholds use 999950 / 999.5 so the rounding never spits out
 * spike values like "1000k" (regression covered by a unit test).
 */
function formatTokens(n) {
  if (n >= 999950) {
    const val = n / 1000000;
    let str = val.toFixed(1);
    if (str.endsWith('.0')) str = str.slice(0, -2);
    return str + 'M';
  }
  if (n >= 999.5) {
    const val = n / 1000;
    let str = val.toFixed(1);
    if (str.endsWith('.0')) str = str.slice(0, -2);
    if (str === '1000') return '1M';
    return str + 'k';
  }
  return Math.round(n).toString();
}

/** Format seconds into "XhYm" / "Ym" / "now" (compact). */
function formatDuration(secs) {
  if (secs <= 0) return 'now';
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (d >= 10) return `${d}d`;
  if (d > 0) return `${d}d${h}h`;
  if (h >= 10) return `${h}h`;
  if (h > 0) return `${h}h${m}m`;
  return `${m}m`;
}

function sanitizeTerminalText(value, maxLength = 120) {
  if (value === undefined || value === null) return '';
  return String(value)
    .replace(/\x1b\][^\x07]*?(?:\x07|\x1b\\|$)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .slice(0, maxLength);
}

/**
 * Visual width of a string in terminal columns, after stripping ANSI escapes.
 * CJK ideographs / Hangul / Hiragana / Katakana / Fullwidth forms count as 2
 * columns; everything else as 1. Used to align table cells that may contain
 * mixed Chinese + ASCII text (e.g. "5h 剩余配额与可用时间").
 */
function visualWidth(str) {
  if (!str) return 0;
  const clean = String(str)
    .replace(/\x1b\][^\x07]*?(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;]*[@-~]/g, '');
  let w = 0;
  for (const ch of clean) {
    const cp = ch.codePointAt(0);
    if (cp < 0x20 || cp === 0x7f) continue;
    if (
      (cp >= 0x1100 && cp <= 0x115F) ||
      (cp >= 0x2E80 && cp <= 0x303E) ||
      (cp >= 0x3041 && cp <= 0x33FF) ||
      (cp >= 0x3400 && cp <= 0x4DBF) ||
      (cp >= 0x4E00 && cp <= 0x9FFF) ||
      (cp >= 0xA000 && cp <= 0xA4CF) ||
      (cp >= 0xAC00 && cp <= 0xD7A3) ||
      (cp >= 0xF900 && cp <= 0xFAFF) ||
      (cp >= 0xFE30 && cp <= 0xFE4F) ||
      (cp >= 0xFF00 && cp <= 0xFF60) ||
      (cp >= 0xFFE0 && cp <= 0xFFE6)
    ) {
      w += 2;
    } else {
      w += 1;
    }
  }
  return w;
}

/** Right-pad `str` with spaces so its visual (terminal) width hits `target`. */
function padToVisualWidth(str, target) {
  const pad = Math.max(0, target - visualWidth(str));
  return str + ' '.repeat(pad);
}

module.exports = {
  ANSI_COLORS,
  DEFAULT_THRESHOLDS,
  DEFAULT_COLUMN_WIDTH,
  QUOTA_CHROME_WIDTH,
  TIER_ABBREVS,
  abbreviateDisplayName,
  simplifyModelName,
  compactModelName,
  normalizeModelMatchValue,
  modelNamesMatch,
  modelIncludesCacheInInput,
  sanitizeTerminalText,
  formatTokens,
  formatDuration,
  visualWidth,
  padToVisualWidth,
};
