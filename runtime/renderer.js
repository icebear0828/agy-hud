'use strict';

const { supportsUnicode } = require('./encoding.js');

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

const PROVIDER_LABELS = {
  MODEL_PROVIDER_GOOGLE: 'Google',
  MODEL_PROVIDER_ANTHROPIC: 'Anthropic',
  MODEL_PROVIDER_OPENAI: 'OpenAI',
};

const LANGUAGE_TEXT = {
  en: {
    quotaUnavailable: 'Quota unavailable',
    quotaLoading: 'Quota loading',
    quotaReasons: {
      not_logged_in: 'not logged into Antigravity',
      expired_token: 'Antigravity token expired',
      auth_failed: 'Antigravity auth failed',
      quota_fetch_failed: 'quota fetch failed',
    },
  },
  zh: {
    quotaUnavailable: '额度不可用',
    quotaLoading: '额度加载中',
    quotaReasons: {
      not_logged_in: '未登录 Antigravity',
      expired_token: 'Antigravity token 已过期',
      auth_failed: 'Antigravity 认证失败',
      quota_fetch_failed: '额度获取失败',
    },
  },
};

function resolveLanguage(config, env = process.env) {
  const language = config?.language;
  if (language === 'en' || language === 'zh') return language;
  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG || '';
  return /^zh(?:_|-|$)/i.test(locale) ? 'zh' : 'en';
}

/**
 * Renders the HUD string for the status line using native ANSI escape codes.
 * Falls back to ASCII when the terminal can't render box-drawing / Nerd Font
 * glyphs (detected via encoding.js, override via config.display.unicode).
 *
 * @param {Object} state
 * @param {Object} agyData
 * @param {Object} config
 * @param {Array}  quotaData  — from quota.js getQuota()
 * @returns {string}
 */
function renderHUD(state, agyData, config, quotaData, tierName) {
  const display = config?.display || {};
  const useNerd = display.useNerdFonts === true;
  const unicode = typeof display.unicode === 'boolean'
    ? display.unicode
    : supportsUnicode();
  const showGitBranch = display.showGitBranch !== false;
  const showTokenBar = display.showTokenBar !== false;
  const showBreadcrumbs = display.showBreadcrumbs !== false;
  const text = LANGUAGE_TEXT[resolveLanguage(config)];

  // ANSI escape sequences
  const reset = '\x1b[0m';
  const bold = '\x1b[1m';

  const getThemeColor = (key, defaultColor) => {
    const name = config?.theme?.[key] || defaultColor;
    return ANSI_COLORS[name] || ANSI_COLORS[defaultColor];
  };

  const primaryColor = getThemeColor('primary', 'green');
  const secondaryColor = getThemeColor('secondary', 'gray');
  const warningColor = getThemeColor('warning', 'yellow');
  const criticalColor = getThemeColor('critical', 'red');

  const gray = secondaryColor;
  const blue = ANSI_COLORS.blue;
  const magenta = ANSI_COLORS.magenta;
  const yellow = warningColor;
  const cyan = ANSI_COLORS.cyan;
  const green = primaryColor;
  const red = criticalColor;

  const warnThresh = typeof config?.thresholds?.warning === 'number'
    ? config.thresholds.warning
    : DEFAULT_THRESHOLDS.warning;
  const critThresh = typeof config?.thresholds?.critical === 'number'
    ? config.thresholds.critical
    : DEFAULT_THRESHOLDS.critical;

  const columnWidth = typeof display.columnWidth === 'number'
    ? display.columnWidth
    : DEFAULT_COLUMN_WIDTH;
  const nameWidth = Math.max(10, columnWidth - QUOTA_CHROME_WIDTH);

  // Box-drawing glyphs with ASCII fallback
  const glyph = unicode
    ? { bar: '█', empty: '░', vbar: '│', hbar: '─', ellipsis: '…' }
    : { bar: '#', empty: '-', vbar: '|', hbar: '-', ellipsis: '...' };

  // Icons: Nerd Font > emoji > plain ASCII
  let branchIcon, planIcon, stepIcon, taskIcon, tokenIcon, ctxIcon, modelIcon;
  if (useNerd) {
    branchIcon = ' ';
    planIcon = '󰌢 ';
    stepIcon = ' ';
    taskIcon = ' ';
    tokenIcon = '󰚩 ';
    ctxIcon = '󱔐 ';
    modelIcon = '󰚗 ';
  } else if (unicode) {
    branchIcon = '⎇ ';
    planIcon = '❖ ';
    stepIcon = '⚡ ';
    taskIcon = '✓ ';
    tokenIcon = '⚿ ';
    ctxIcon = '⛁ ';
    modelIcon = '🤖 ';
  } else {
    branchIcon = '[B] ';
    planIcon = '[P] ';
    stepIcon = '[S] ';
    taskIcon = '[T] ';
    tokenIcon = '[Tk] ';
    ctxIcon = '[C] ';
    modelIcon = '[M] ';
  }

  // Override via config.icons if present
  if (config && config.icons) {
    if (config.icons.branch !== undefined) branchIcon = config.icons.branch;
    if (config.icons.plan !== undefined) planIcon = config.icons.plan;
    if (config.icons.step !== undefined) stepIcon = config.icons.step;
    if (config.icons.task !== undefined) taskIcon = config.icons.task;
    if (config.icons.token !== undefined) tokenIcon = config.icons.token;
    if (config.icons.ctx !== undefined) ctxIcon = config.icons.ctx;
    if (config.icons.model !== undefined) modelIcon = config.icons.model;
  }

  const branchName = `${blue}${branchIcon}${state.branch || 'unknown'}${reset}`;

  // Compact arrow glyphs for token breakdown
  const inArrow = unicode ? '↑' : '^';
  const outArrow = unicode ? '↓' : 'v';
  const cacheArrow = unicode ? '⟳' : 'c:';

  // Data extraction
  const usage = agyData?.context_window || {};
  const totalInput = usage.total_input_tokens || 0;
  const totalOutput = usage.total_output_tokens || 0;
  const ctxPercent = usage.used_percentage || 0;
  const plan = tierName || agyData?.plan_tier || 'Free';
  const tasks = agyData?.task_count || 0;

  // Extract model information
  const rawModelName = agyData?.model?.display_name || agyData?.model?.id || 'Unknown Model';
  const modelName = simplifyModelName(rawModelName);

  const formatTokens = (n) => {
    if (n >= 1000000) {
      const val = n / 1000000;
      let str = val.toFixed(1);
      if (str.endsWith('.0')) str = str.slice(0, -2);
      return str + 'M';
    }
    if (n >= 1000) {
      const val = n / 1000;
      let str = val.toFixed(1);
      if (str.endsWith('.0')) str = str.slice(0, -2);
      return str + 'k';
    }
    return n.toString();
  };

  /**
   * Format seconds into human-readable "XhYm" or "Ym" string (compact).
   * @param {number} secs
   */
  const formatDuration = (secs) => {
    if (secs <= 0) return 'now';
    const d = Math.floor(secs / 86400);
    const h = Math.floor((secs % 86400) / 3600);
    const m = Math.floor((secs % 3600) / 60);
    if (d >= 10) return `${d}d`;
    if (d > 0) return `${d}d${h}h`;
    if (h >= 10) return `${h}h`;
    if (h > 0) return `${h}h${m}m`;
    return `${m}m`;
  };

  const createProgressBar = (percent, color, width = 10, isUsage = true) => {
    const completed = Math.round((percent / 100) * width);
    const remaining = width - completed;

    // Auto-color based on usage vs remaining
    let finalColor = color;
    if (isUsage) {
      if (percent > critThresh * 100) finalColor = red;
      else if (percent > warnThresh * 100) finalColor = yellow;
    } else {
      if (percent <= (1 - critThresh) * 100) finalColor = red;
      else if (percent <= (1 - warnThresh) * 100) finalColor = yellow;
      else finalColor = green;
    }

    return `${finalColor}[${glyph.bar.repeat(completed)}${glyph.empty.repeat(remaining)}]${reset}`;
  };

  const truncateAndPad = (str, width) => {
    if (str.length > width) {
      return str.substring(0, width - 1) + glyph.ellipsis;
    }
    return str.padEnd(width, ' ');
  };

  const divider = ` ${gray}${glyph.vbar}${reset} `;

  // Layer 1: identity + status
  const line1Parts = [
    `${green}${modelName}${reset}`,
    `${magenta}${plan}${reset}`,
  ];
  if (showGitBranch) line1Parts.unshift(branchName);
  const line1 = line1Parts.join(divider);

  const firstNumber = (...values) => values.find(value => Number.isFinite(value));
  const agyCurrentUsage = usage.current_usage || {};
  const transcriptUsage = state?.usage || {};
  const transcriptCurrentUsage = transcriptUsage.current_usage || {};
  const cacheRead = firstNumber(
    agyCurrentUsage.cache_read_input_tokens,
    usage.cache_read_input_tokens,
    transcriptCurrentUsage.cache_read_input_tokens,
    transcriptUsage.cache_read_input_tokens
  ) ?? 0;
  let inTokens = firstNumber(
    agyCurrentUsage.input_tokens,
    transcriptCurrentUsage.input_tokens
  );
  if (inTokens === undefined) {
    inTokens = Math.max(0, totalInput - cacheRead);
  }
  const outTokens = totalOutput;
  const tokenTotal = inTokens + outTokens + cacheRead;

  // Compact token format: Tokens 150k (in: 127k, out: 23k, cache: Xk)
  const detailParts = [`in: ${formatTokens(inTokens)}`, `out: ${formatTokens(outTokens)}`];
  if (cacheRead > 0) {
    detailParts.push(`cache: ${formatTokens(cacheRead)}`);
  }
  const tokenParts = `${formatTokens(tokenTotal)} ${gray}(${reset}${detailParts.join(', ')}${gray})${reset}`;
  const tokenPrefix = tokenIcon === '[Tk] ' ? 'Tokens' : `${tokenIcon}Tokens`;
  const tokensStr = `${cyan}${tokenPrefix} ${tokenParts}${reset}`;
  const ctxBar = createProgressBar(ctxPercent, cyan, 10, true);
  const ctxPctStr = `${Math.round(ctxPercent)}%`;
  const ctxStr = `${cyan}${ctxIcon}${formatTokens(totalInput)}/${formatTokens(usage.context_window_size || 0)}${reset} ${ctxBar} ${cyan}${ctxPctStr}${reset}`;

  const quotaStyle = display.quotaStyle || 'table';
  const isCompact = quotaStyle === 'compact';

  // In compact mode, find current model's quota and append to line 2
  let currentModelQuota = null;
  if (isCompact && quotaData && quotaData.length > 0) {
    const rawName = agyData?.model?.display_name || '';
    const modelId = agyData?.model?.id || '';
    currentModelQuota = quotaData.find(q =>
      (modelId && q.id === modelId) ||
      q.displayName === rawName ||
      simplifyModelName(q.displayName) === modelName ||
      modelNamesMatch(q.displayName, rawName)
    );
  }

  // Layer 2: resource consumption + compact steps/tasks
  const stepsTasksStr = `${yellow}${stepIcon}${state.steps}${reset} ${yellow}${taskIcon}${tasks}${reset}`;
  const line2Parts = [];
  if (showTokenBar) line2Parts.push(tokensStr);
  line2Parts.push(ctxStr, stepsTasksStr);
  if (isCompact && currentModelQuota) {
    const pct = Math.round(currentModelQuota.remainingFraction * 100);
    const pctColor = pct <= (1 - critThresh) * 100 ? red : pct <= (1 - warnThresh) * 100 ? yellow : green;
    let timeStr = '';
    if (currentModelQuota.resetTime) {
      const secsLeft = Math.max(0, Math.round((new Date(currentModelQuota.resetTime).getTime() - Date.now()) / 1000));
      timeStr = ` ${gray}~${formatDuration(secsLeft)}${reset}`;
    }
    line2Parts.push(`${pctColor}Quota: ${pct}%${reset}${timeStr}`);
  }
  const line2 = line2Parts.join(divider);

  // Layer 3: project metadata (non-zero items only)
  const metaParts = [];
  const breadcrumbCount = typeof display.breadcrumbCount === 'number'
    ? Math.max(0, Math.floor(display.breadcrumbCount))
    : 3;
  if (showBreadcrumbs && breadcrumbCount > 0) {
    if (Array.isArray(state.breadcrumbs) && state.breadcrumbs.length > 0) {
      for (const item of state.breadcrumbs.filter(Boolean).slice(-breadcrumbCount)) {
        metaParts.push(`${gray}${item}${reset}`);
      }
    } else if (state.memoryFile) {
      metaParts.push(`${gray}1 ${state.memoryFile}${reset}`);
    }
  }
  const rulesCount = state.rulesCount || 0;
  const mcpCount = state.mcpCount || 0;
  const hooksCount = state.hooksCount || 0;
  if (rulesCount > 0) metaParts.push(`${gray}${rulesCount} rules${reset}`);
  if (mcpCount > 0) metaParts.push(`${gray}${mcpCount} MCPs${reset}`);
  if (hooksCount > 0) metaParts.push(`${gray}${hooksCount} hooks${reset}`);
  const line3 = metaParts.length > 0 ? metaParts.join(divider) : '';

  const renderQuotaColumn = (q, now) => {
    const pct = Math.round(q.remainingFraction * 100);
    const pctColor = pct <= (1 - critThresh) * 100 ? red : pct <= (1 - warnThresh) * 100 ? yellow : green;

    // 1. Name
    const rawName = simplifyModelName(q.displayName || q.id);
    const namePart = truncateAndPad(rawName, nameWidth);
    const coloredName = `${cyan}${namePart}${reset}`;

    // 2. Bar (8 chars visible: [ + 6 bars + ])
    const barPart = createProgressBar(pct, pctColor, 6, false);

    // 3. Percent (4 chars)
    const pctStr = `${pct}%`.padStart(4, ' ');
    const coloredPct = `${pctColor}${pctStr}${reset}`;

    // 4. Time (6 chars)
    let rawTime = '';
    if (q.resetTime) {
      const resetMs = new Date(q.resetTime).getTime();
      const secsLeft = Math.max(0, Math.round((resetMs - now) / 1000));
      rawTime = `~${formatDuration(secsLeft)}`;
    }
    const timePart = rawTime.padEnd(6, ' ');
    const coloredTime = `${gray}${timePart}${reset}`;

    return `${coloredName} ${barPart} ${coloredPct} ${coloredTime}`;
  };

  // Compact: provider-grouped mini bars
  const renderCompactQuotaLine = (data, now) => {
    const groups = new Map();
    for (const q of data) {
      const label = PROVIDER_LABELS[q.modelProvider] || 'Other';
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label).push(q);
    }
    const segments = [];
    for (const [provider, models] of groups) {
      const items = models.map(q => {
        const name = compactModelName(q.displayName || q.id);
        const pct = Math.round(q.remainingFraction * 100);
        const filled = Math.round((pct / 100) * 3);
        const empty = 3 - filled;
        const barColor = pct <= (1 - critThresh) * 100 ? red : pct <= (1 - warnThresh) * 100 ? yellow : green;
        return `${cyan}${name}${reset}${barColor}${glyph.bar.repeat(filled)}${gray}${glyph.empty.repeat(empty)}${reset}`;
      });
      segments.push(`${gray}${provider}:${reset} ${items.join(' ')}`);
    }
    return segments.join(divider);
  };

  // Build quota lines
  let quotaLines = '';
  if (quotaData && quotaData.length > 0) {
    const now = Date.now();
    if (isCompact) {
      quotaLines = `\n${renderCompactQuotaLine(quotaData, now)}`;
    } else {
      const cols = quotaData.map(q => renderQuotaColumn(q, now));
      const rows = [];
      for (let i = 0; i < cols.length; i += 2) {
        const col1 = cols[i];
        const col2 = cols[i + 1];
        if (col2) {
          rows.push(`  ${col1} ${gray}${glyph.vbar}${reset} ${col2}`);
        } else {
          rows.push(`  ${col1}`);
        }
      }
      const dividerLine = `  ${gray}${glyph.hbar.repeat(columnWidth * 2 + 1)}${reset}`;
      quotaLines = `\n${dividerLine}\n` + rows.join('\n') + `\n${dividerLine}`;
    }
  } else if (quotaData && quotaData.unavailableReason) {
    const dividerLine = `  ${gray}${glyph.hbar.repeat(columnWidth * 2 + 1)}${reset}`;
    const reason = text.quotaReasons[quotaData.unavailableReason] || quotaData.unavailableReason;
    quotaLines = `\n${dividerLine}\n  ${yellow}${text.quotaUnavailable}:${reset} ${gray}${reason}${reset}\n${dividerLine}`;
  } else if (quotaData && quotaData.length === 0) {
    const dividerLine = `  ${gray}${glyph.hbar.repeat(columnWidth * 2 + 1)}${reset}`;
    quotaLines = `\n${dividerLine}\n  ${gray}${text.quotaLoading}${glyph.ellipsis}${reset}\n${dividerLine}`;
  }

  const lines = [line1, line2];
  if (line3) lines.push(line3);
  return lines.join('\n') + quotaLines + '\n';
}

module.exports = {
  renderHUD,
  abbreviateDisplayName,
  compactModelName,
};
