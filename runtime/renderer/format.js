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

const TIER_ABBREVS = {
  Thinking: 'Thinking',
  High: 'High',
  Medium: 'Medium',
  Low: 'Low',
  Minimal: 'Minimal',
  Max: 'Max',
  XHigh: 'XHigh',
};

const ABBREVIATION_RULES = [
  [/^Gemini ([\d.]+) (Flash|Pro|Argon|Hydrogen) \(([^)]+)\)/, (_, ver, fam, rawTier) => {
    const tier = rawTier.replace(/\s+thinking$/i, '').trim();
    return `Gemini ${ver} ${fam}(${TIER_ABBREVS[tier] || tier})`;
  }],
  [/^Claude (\w+) ([\d.]+) \(([^)]+)\)/, (_, fam, ver, rawTier) => {
    const tier = rawTier.replace(/\s+thinking$/i, '').trim();
    return `${fam} ${ver}(${TIER_ABBREVS[tier] || tier})`;
  }],
  [/^GPT-OSS (.+?) \(\w+\)/, (_, spec) => `GPT-OSS ${spec}`],
];

function normalizeEffortLabel(rawEffort) {
  if (!rawEffort || typeof rawEffort !== 'string') return '';
  const cleaned = rawEffort.replace(/\s+thinking$/i, '').trim();
  if (!cleaned) return '';
  const lower = cleaned.toLowerCase();
  if (lower === 'thinking' || lower === 'th') return 'Thinking';
  if (lower === 'high' || lower === 'h') return 'High';
  if (lower === 'medium' || lower === 'med' || lower === 'm' || lower === 'tiered') return 'Medium';
  if (lower === 'low' || lower === 'l' || lower === 'extra-low' || lower === 'lite') return 'Low';
  if (lower === 'minimal' || lower === 'min') return 'Minimal';
  if (lower === 'max') return 'Max';
  if (lower === 'xhigh' || lower === 'xh') return 'XHigh';
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

function inferEffortFromModelId(modelId) {
  if (!modelId || typeof modelId !== 'string') return '';
  const s = modelId.toLowerCase();
  if (/(?:^|[-_])(extra-low|lite)(?:[-_]|$)/.test(s)) return 'Low';
  if (/(?:^|[-_])xhigh(?:[-_]|$)/.test(s)) return 'XHigh';
  if (/(?:^|[-_])high(?:[-_]|$)/.test(s)) return 'High';
  if (/(?:^|[-_])(medium|tiered)(?:[-_]|$)/.test(s)) return 'Medium';
  if (/(?:^|[-_])low(?:[-_]|$)/.test(s)) return 'Low';
  if (/(?:^|[-_])(minimal|min)(?:[-_]|$)/.test(s)) return 'Minimal';
  if (/(?:^|[-_])max(?:[-_]|$)/.test(s)) return 'Max';
  if (/(?:^|[-_])thinking(?:[-_]|$)/.test(s)) return 'Thinking';
  return '';
}

function humanizeModelId(modelId) {
  if (!modelId || typeof modelId !== 'string') return '';
  let m = /^gemini-([\d.]+)-(flash|pro|argon|hydrogen)(?:-(.+))?$/i.exec(modelId);
  if (m) {
    const fam = m[2].charAt(0).toUpperCase() + m[2].slice(1).toLowerCase();
    const effort = inferEffortFromModelId(m[3] || '');
    return effort ? `Gemini ${m[1]} ${fam} (${effort})` : `Gemini ${m[1]} ${fam}`;
  }
  m = /^claude-(sonnet|opus|haiku)-(\d+)-(\d+)(?:-(.+))?$/i.exec(modelId);
  if (m) {
    const fam = m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase();
    const effort = inferEffortFromModelId(m[4] || '');
    return effort ? `Claude ${fam} ${m[2]}.${m[3]} (${effort})` : `Claude ${fam} ${m[2]}.${m[3]}`;
  }
  return modelId;
}

/**
 * Reconstructs the full model display name including thinking/effort level.
 * agy's BuildStatusLineData strips the "(High)" / "(Thinking)" suffix from
 * model.display_name into model.effort (or omits effort for single-variant models).
 */
function resolveModelWithEffort(agyData, state = null, quotaData = null) {
  const modelObj = agyData?.model;
  const hasExplicitModel = Boolean(modelObj && (modelObj.display_name || modelObj.id));

  let baseName = '';
  let modelId = '';
  if (hasExplicitModel) {
    modelId = modelObj.id || '';
    baseName = modelObj.display_name || '';
    if (!baseName && modelId) {
      const matchedQ = Array.isArray(quotaData)
        ? quotaData.find(q => q && q.id === modelId && q.displayName)
        : null;
      baseName = matchedQ ? matchedQ.displayName : humanizeModelId(modelId);
    }
  } else if (!agyData && state) {
    // When invoked with empty stdin (e.g. standalone CLI check), fall back to active session / settings model
    baseName = state.transcriptModelSelection || state.configuredModel || humanizeModelId(state.transcriptModelId) || 'Unknown Model';
    modelId = state.transcriptModelId || '';
  } else {
    return 'Unknown Model';
  }

  const explicitEffort = normalizeEffortLabel(
    modelObj?.effort ||
    agyData?.effort ||
    modelObj?.thinking_level ||
    agyData?.thinking_level ||
    modelObj?.reasoning_effort ||
    agyData?.reasoning_effort ||
    ''
  );

  // If baseName already has a parenthetical effort/tier suffix:
  if (/\([^)]+\)/.test(baseName)) {
    if (explicitEffort) {
      return baseName.replace(/\(([^)]+)\)/, `(${explicitEffort})`);
    }
    return baseName;
  }

  // Otherwise, infer effort from available sources so thinking intensity is always shown:
  let effort = explicitEffort;
  if (!effort && modelId && Array.isArray(quotaData)) {
    const matchedQ = quotaData.find(q => q && q.id === modelId && typeof q.displayName === 'string');
    const parenMatch = matchedQ?.displayName?.match(/\(([^)]+)\)/);
    if (parenMatch) {
      effort = normalizeEffortLabel(parenMatch[1]);
    }
  }
  if (!effort && modelId) {
    effort = inferEffortFromModelId(modelId);
  }
  if (!effort && state) {
    for (const candidate of [state.transcriptModelSelection, state.configuredModel]) {
      if (typeof candidate === 'string' && candidate.toLowerCase().startsWith(baseName.toLowerCase())) {
        const parenMatch = candidate.match(/\(([^)]+)\)/);
        if (parenMatch) {
          effort = normalizeEffortLabel(parenMatch[1]);
          break;
        }
      }
    }
    if (!effort && state.transcriptModelId && baseName.toLowerCase().includes(' argon')) {
      effort = inferEffortFromModelId(state.transcriptModelId);
    }
  }

  return effort ? `${baseName} (${effort})` : baseName;
}

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
  [/^Gemini [\d.]+ (Flash|Pro|Argon|Hydrogen).*/i, (_, fam) => fam],
  [/^Claude (\w+) [\d.]+ \((\w+)\)/i, (_, fam) => fam],
  [/^GPT-OSS .*/i, () => 'GPT'],
  [/gemini-.*hydrogen/i, () => 'Hydrogen'],
  [/gemini-.*argon/i, () => 'Argon'],
  [/gemini-.*flash/i, () => 'Flash'],
  [/gemini-.*pro/i, () => 'Pro'],
  [/claude-.*sonnet/i, () => 'Sonnet'],
  [/claude-.*opus/i, () => 'Opus'],
  [/claude-.*haiku/i, () => 'Haiku'],
  [/gpt/i, () => 'GPT'],
];

function compactModelName(displayName) {
  if (!displayName || typeof displayName !== 'string') return '';
  for (const [re, replacer] of COMPACT_NAME_RULES) {
    const m = re.exec(displayName);
    if (m) return replacer(...m);
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
  return name.includes('claude') || name.includes('sonnet') || name.includes('opus') ||
    name.includes('haiku') || name.includes('gpt') || name.includes('deepseek') ||
    name.includes('gemini');
}

function normalizeTokenCount(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

/** Calculate a per-turn cache hit rate with self-adaptive total prompt resolution. */
function calculateTurnCacheMetrics(usage) {
  if (!usage || typeof usage !== 'object') return null;

  const cacheRead = normalizeTokenCount(usage.cache_read_input_tokens);
  const cacheWrite = normalizeTokenCount(usage.cache_creation_input_tokens) ?? 0;
  const input = normalizeTokenCount(usage.input_tokens);

  if (cacheRead === null || input === null) return { available: false };

  const cacheTotal = cacheRead + cacheWrite;
  const totalPrompt = input >= cacheTotal ? input : input + cacheTotal;
  if (totalPrompt === 0) return { available: false };

  return {
    cacheRead,
    totalPrompt,
    hitRate: Math.min(100, Math.max(0, (cacheRead / totalPrompt) * 100)),
    available: true,
  };
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

function formatTurnCacheBadge(metrics, label, colors, isCompact, thresholds = {}) {
  const palette = colors || {};
  const reset = palette.reset || '';
  const dim = palette.dim || '';
  const safeLabel = label || 'cache';

  if (!metrics || metrics.available === false) {
    return `${palette.gray || ''}${dim}${safeLabel} --${reset}`;
  }

  const levels = thresholds && typeof thresholds === 'object' ? thresholds : {};
  const excellent = Number.isFinite(levels.excellent) ? levels.excellent : 80;
  const partial = Number.isFinite(levels.partial) ? levels.partial : 50;
  const hitRate = Number.isFinite(metrics.hitRate)
    ? Math.min(100, Math.max(0, metrics.hitRate))
    : 0;

  let style;
  if (hitRate >= excellent) {
    style = `${palette.green || palette.cyan || ''}${palette.bold || ''}`;
  } else if (hitRate >= partial) {
    style = palette.yellow || '';
  } else if (hitRate > 0) {
    style = `${palette.yellow || ''}${dim}`;
  } else {
    style = `${palette.gray || ''}${dim}`;
  }

  const absolute = isCompact
    ? ''
    : ` (${formatTokens(normalizeTokenCount(metrics.cacheRead) ?? 0)}/${formatTokens(normalizeTokenCount(metrics.totalPrompt) ?? 0)})`;
  return `${style}${safeLabel} ${hitRate.toFixed(1)}%${absolute}${reset}`;
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

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function resolveAgentMode(agyData, state = null, showModeByDefault = false) {
  const raw = (
    agyData?.cycle_mode ||
    agyData?.cycleMode ||
    agyData?.agent_mode ||
    agyData?.agentMode ||
    agyData?.permission_mode ||
    agyData?.permissionMode ||
    agyData?.mode ||
    state?.agentMode ||
    (showModeByDefault ? 'auto' : '')
  );
  if (!raw || typeof raw !== 'string') return '';
  return raw.trim();
}

/**
 * Format remainingFraction into a two-decimal percentage string (e.g. "96.69", "100.00").
 * Clamps non-100% values (e.g. 0.99999) to at most "99.99" so that
 * fractional usage does not get rounded up to 100.00% and look stuck.
 */
function formatQuotaPercent(fraction) {
  if (fraction === undefined || fraction === null || Number.isNaN(fraction)) return '0.00';
  if (fraction >= 1) return '100.00';
  if (fraction <= 0) return '0.00';
  return Math.min(99.99, Math.max(0, Math.round(fraction * 10000) / 100)).toFixed(2);
}

module.exports = {
  ANSI_COLORS,
  DEFAULT_THRESHOLDS,
  DEFAULT_COLUMN_WIDTH,
  QUOTA_CHROME_WIDTH,
  TIER_ABBREVS,
  abbreviateDisplayName,
  simplifyModelName,
  resolveModelWithEffort,
  compactModelName,
  normalizeModelMatchValue,
  modelNamesMatch,
  modelIncludesCacheInInput,
  calculateTurnCacheMetrics,
  formatTurnCacheBadge,
  sanitizeTerminalText,
  formatTokens,
  formatBytes,
  formatDuration,
  formatQuotaPercent,
  resolveAgentMode,
};
