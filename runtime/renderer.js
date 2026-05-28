'use strict';

const { supportsUnicode } = require('./encoding.js');
const { classifyQuotaWindow, pickCriticalWindow } = require('./quota.js');
const {
  ANSI_COLORS,
  DEFAULT_THRESHOLDS,
  DEFAULT_COLUMN_WIDTH,
  abbreviateDisplayName,
  simplifyModelName,
  compactModelName,
  modelNamesMatch,
  modelIncludesCacheInInput,
  sanitizeTerminalText,
  formatTokens,
  formatDuration,
} = require('./renderer/format.js');
const {
  LANGUAGE_TEXT,
  resolveLanguage,
} = require('./renderer/lang.js');
const { createQuotaRenderers } = require('./renderer/quota-render.js');

/**
 * Renders the HUD string for the status line using native ANSI escape codes.
 * Falls back to ASCII when the terminal can't render box-drawing / Nerd Font
 * glyphs (detected via encoding.js, override via config.display.unicode).
 *
 * @param {Object} state
 * @param {Object} agyData
 * @param {Object} config
 * @param {Array}  quotaData  — from quota.js getQuota()
 * @param {Object} updateInfo — local cache info about updates
 * @returns {string}
 */
function renderHUD(state, agyData, config, quotaData, tierName, updateInfo) {
  const display = config?.display || {};
  const useNerd = display.useNerdFonts === true;
  const unicode = typeof display.unicode === 'boolean'
    ? display.unicode
    : supportsUnicode();
  const showGitBranch = display.showGitBranch !== false;
  const showTokenBar = display.showTokenBar !== false;
  const showBreadcrumbs = display.showBreadcrumbs !== false;
  const showCurrentDir = display.showCurrentDir !== false;
  const showUsername = display.showUsername === true;
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

  // Box-drawing glyphs with ASCII fallback
  const glyph = unicode
    ? { bar: '█', empty: '░', vbar: '│', hbar: '─', cross: '┼', ellipsis: '…' }
    : { bar: '#', empty: '-', vbar: '|', hbar: '-', cross: '+', ellipsis: '...' };

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

  // Override via config.icons if present — strip control/escape sequences first
  if (config && config.icons) {
    const sanitizeIcon = (v) => sanitizeTerminalText(v, 8);
    if (config.icons.branch !== undefined) branchIcon = sanitizeIcon(config.icons.branch);
    if (config.icons.plan !== undefined) planIcon = sanitizeIcon(config.icons.plan);
    if (config.icons.step !== undefined) stepIcon = sanitizeIcon(config.icons.step);
    if (config.icons.task !== undefined) taskIcon = sanitizeIcon(config.icons.task);
    if (config.icons.token !== undefined) tokenIcon = sanitizeIcon(config.icons.token);
    if (config.icons.ctx !== undefined) ctxIcon = sanitizeIcon(config.icons.ctx);
    if (config.icons.model !== undefined) modelIcon = sanitizeIcon(config.icons.model);
  }

  const branchName = `${blue}${branchIcon}${sanitizeTerminalText(state.branch || 'unknown', 80)}${reset}`;

  // Compact arrow glyphs for token breakdown
  const inArrow = unicode ? '↑' : '^';
  const outArrow = unicode ? '↓' : 'v';
  const cacheArrow = unicode ? '⟳' : 'c:';

  // Data extraction
  const usage = agyData?.context_window || {};
  const totalInput = usage.total_input_tokens || 0;
  const totalOutput = usage.total_output_tokens || 0;
  const ctxPercent = usage.used_percentage || 0;
  const plan = sanitizeTerminalText(tierName || agyData?.plan_tier || 'Free', 80);
  const tasks = agyData?.task_count || 0;

  // Extract model information
  const rawModelName = agyData?.model?.display_name || agyData?.model?.id || 'Unknown Model';
  const modelName = sanitizeTerminalText(simplifyModelName(rawModelName), 80);

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

  const divider = ` ${gray}${glyph.vbar}${reset} `;

  // Layer 1: identity + status
  const line1Parts = [
    `${green}${modelName}${reset}`,
    `${magenta}${plan}${reset}`,
  ];
  if (showGitBranch) line1Parts.unshift(branchName);
  const currentDir = sanitizeTerminalText(state.currentDir || '', 80);
  if (showCurrentDir && currentDir) {
    line1Parts.unshift(`${blue}${currentDir}${reset}`);
  }
  const username = sanitizeTerminalText(display.username || state.username || '', 80);
  if (showUsername && username) {
    line1Parts.unshift(`${cyan}${username}${reset}`);
  }
  if (updateInfo && updateInfo.updateAvailable) {
    const updateIcon = unicode ? '⟳' : '[UP]';
    line1Parts.push(`${yellow}${updateIcon} v${updateInfo.latestVersion}${reset}`);
  }
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
  const cacheWrite = firstNumber(
    agyCurrentUsage.cache_creation_input_tokens,
    usage.cache_creation_input_tokens,
    transcriptCurrentUsage.cache_creation_input_tokens,
    transcriptUsage.cache_creation_input_tokens
  ) ?? 0;
  const cacheTotal = cacheRead + cacheWrite;

  let inTokens = firstNumber(
    agyCurrentUsage.input_tokens,
    transcriptCurrentUsage.input_tokens
  );
  if (inTokens === undefined) {
    inTokens = Math.max(0, totalInput - cacheTotal);
  } else if (modelIncludesCacheInInput(rawModelName)) {
    inTokens = Math.max(0, inTokens - cacheTotal);
  }
  const outTokens = totalOutput;

  // Apply cache smoothing adaption to absorb CLI truncation/fluctuation bugs
  let displayCache = cacheTotal;
  let displayIn = inTokens;
  let isCacheSmoothApplied = false;

  const maxHistCache = state.maxHistoricalCache || 0;
  if (cacheTotal === 0 && maxHistCache > 10000 && inTokens >= maxHistCache * 0.9) {
    displayCache = maxHistCache;
    displayIn = Math.max(0, inTokens - maxHistCache);
    isCacheSmoothApplied = true;
  }

  const tokenTotal = displayIn + outTokens + displayCache;

  // Compact token format: Tokens 150k (in: 127k, out: 23k, cache: Xk)
  const detailParts = [`in: ${formatTokens(displayIn)}`, `out: ${formatTokens(outTokens)}`];
  if (displayCache > 0) {
    const cacheLabel = isCacheSmoothApplied ? `${formatTokens(displayCache)}*` : formatTokens(displayCache);
    detailParts.push(`cache: ${cacheLabel}`);
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

  // Layer 2: resource consumption
  const line2Parts = [];
  if (showTokenBar) line2Parts.push(tokensStr);
  line2Parts.push(ctxStr);
  if (isCompact && currentModelQuota) {
    const now = Date.now();
    const windows = currentModelQuota.windows && (currentModelQuota.windows.fiveHour || currentModelQuota.windows.weekly)
      ? currentModelQuota.windows
      : null;
    const critical = windows
      ? pickCriticalWindow(windows, now)
      : (currentModelQuota.resetTime
        ? { remainingFraction: currentModelQuota.remainingFraction, resetTime: currentModelQuota.resetTime, window: classifyQuotaWindow(currentModelQuota.resetTime, now) }
        : { remainingFraction: currentModelQuota.remainingFraction, resetTime: null, window: null });
    // pickCriticalWindow can return null if all observations are expired; fall
    // back to the flat top-level fields so the statusline shows *something*.
    const safeCritical = critical || {
      remainingFraction: currentModelQuota.remainingFraction,
      resetTime: currentModelQuota.resetTime || null,
      window: null,
    };
    const pct = Math.round(safeCritical.remainingFraction * 100);
    const pctColor = pct <= (1 - critThresh) * 100 ? red : pct <= (1 - warnThresh) * 100 ? yellow : green;
    let timeStr = '';
    if (safeCritical.resetTime) {
      const secsLeft = Math.max(0, Math.round((new Date(safeCritical.resetTime).getTime() - now) / 1000));
      timeStr = ` ${gray}~${formatDuration(secsLeft)}${reset}`;
    }
    const windowSuffix = safeCritical.window === 'fiveHour' ? '5h'
      : safeCritical.window === 'weekly' ? 'W'
      : '';
    const label = windowSuffix ? `Quota[${windowSuffix}]` : 'Quota';
    line2Parts.push(`${pctColor}${label}: ${pct}%${reset}${timeStr}`);
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
        metaParts.push(`${gray}${sanitizeTerminalText(item)}${reset}`);
      }
    } else if (state.memoryFile) {
      metaParts.push(`${gray}1 ${sanitizeTerminalText(state.memoryFile)}${reset}`);
    }
  }
  const rulesCount = state.rulesCount || 0;
  const mcpCount = state.mcpCount || 0;
  const hooksCount = state.hooksCount || 0;
  if (rulesCount > 0) metaParts.push(`${gray}${rulesCount} rules${reset}`);
  if (mcpCount > 0) metaParts.push(`${gray}${mcpCount} MCPs${reset}`);
  if (hooksCount > 0) metaParts.push(`${gray}${hooksCount} hooks${reset}`);
  const line3 = metaParts.length > 0 ? metaParts.join(divider) : '';

  const { renderQuotaTable, renderCompactQuotaLine } = createQuotaRenderers({
    colors: { cyan, reset, gray, red, yellow, green },
    glyph,
    thresholds: { warnThresh, critThresh },
    columnWidth,
    divider,
    text,
    createProgressBar,
  });

  const fullWidth = columnWidth * 3 + 4; // 2 indent + 3*cw + 2 vbars

  // Build quota lines
  let quotaLines = '';
  if (quotaData && quotaData.length > 0) {
    const now = Date.now();
    if (isCompact) {
      quotaLines = `\n${renderCompactQuotaLine(quotaData, now)}`;
    } else {
      quotaLines = `\n${renderQuotaTable(quotaData, now)}`;
    }
  } else if (quotaData && quotaData.unavailableReason) {
    const dividerLine = `  ${gray}${glyph.hbar.repeat(fullWidth - 2)}${reset}`;
    const reason = sanitizeTerminalText(text.quotaReasons[quotaData.unavailableReason] || quotaData.unavailableReason);
    quotaLines = `\n${dividerLine}\n  ${yellow}${text.quotaUnavailable}:${reset} ${gray}${reason}${reset}\n${dividerLine}`;
  } else if (quotaData && quotaData.length === 0) {
    const dividerLine = `  ${gray}${glyph.hbar.repeat(fullWidth - 2)}${reset}`;
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
