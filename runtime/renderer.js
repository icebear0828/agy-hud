'use strict';

const { supportsUnicode } = require('./encoding.js');
const {
  ANSI_COLORS,
  DEFAULT_THRESHOLDS,
  DEFAULT_COLUMN_WIDTH,
  QUOTA_CHROME_WIDTH,
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

  const truncateAndPad = (str, width) => {
    if (str.length > width) {
      return str.substring(0, width - 1) + glyph.ellipsis;
    }
    return str.padEnd(width, ' ');
  };

  const divider = ` ${gray}${glyph.vbar}${reset} `;

  const quotaStyle = display.quotaStyle || 'table';
  const isCompact = quotaStyle === 'compact';

  // Find current model's quota for compact mode display
  let currentModelQuota = null;
  if (quotaData && quotaData.length > 0) {
    const rawName = agyData?.model?.display_name || '';
    const modelId = agyData?.model?.id || '';
    currentModelQuota = quotaData.find(q =>
      (modelId && q.id === modelId) ||
      q.displayName === rawName ||
      simplifyModelName(q.displayName) === modelName ||
      modelNamesMatch(q.displayName, rawName)
    );
  }

  // Layer 1: identity + status
  // Line 1 Left
  const line1LeftParts = [];
  const username = sanitizeTerminalText(display.username || state.username || '', 80);
  if (showUsername && username) {
    line1LeftParts.push(`${cyan}${username}${reset}`);
  }
  const currentDir = sanitizeTerminalText(state.currentDir || '', 80);
  if (showCurrentDir && currentDir) {
    line1LeftParts.push(`${blue}${currentDir}${reset}`);
  }
  if (showGitBranch) {
    line1LeftParts.push(branchName);
  }
  const line1Left = line1LeftParts.join(' ');

  // Line 1 Right
  const line1RightParts = [
    `${green}${modelName}${reset}`,
  ];
  if (plan) {
    line1RightParts.push(`${magenta}${plan}${reset}`);
  }
  if (updateInfo && updateInfo.updateAvailable) {
    const updateIcon = unicode ? '⟳' : '[UP]';
    line1RightParts.push(`${yellow}${updateIcon} v${updateInfo.latestVersion}${reset}`);
  }
  if (isCompact && currentModelQuota) {
    const pct = Math.round(currentModelQuota.remainingFraction * 100);
    const pctColor = pct <= (1 - critThresh) * 100 ? red : pct <= (1 - warnThresh) * 100 ? yellow : green;
    let timeStr = '';
    if (currentModelQuota.resetTime) {
      const secsLeft = Math.max(0, Math.round((new Date(currentModelQuota.resetTime).getTime() - Date.now()) / 1000));
      timeStr = ` ~${formatDuration(secsLeft)}`;
    }
    line1RightParts.push(`(${pctColor}Quota: ${pct}%${reset}${gray}${timeStr}${reset})`);
  }
  const line1Right = line1RightParts.join(' ');

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

  // Line 2 Left
  const line2Left = showTokenBar ? tokensStr : '';

  // Line 2 Right
  const line2Right = ctxStr;

  // Layer 3: project metadata
  let line3Left = '';
  const breadcrumbCount = typeof display.breadcrumbCount === 'number'
    ? Math.max(0, Math.floor(display.breadcrumbCount))
    : 3;
  if (showBreadcrumbs && breadcrumbCount > 0) {
    if (Array.isArray(state.breadcrumbs) && state.breadcrumbs.length > 0) {
      const parts = [];
      for (const item of state.breadcrumbs.filter(Boolean).slice(-breadcrumbCount)) {
        parts.push(`${gray}${sanitizeTerminalText(item)}${reset}`);
      }
      line3Left = parts.join(divider);
    } else if (state.memoryFile) {
      line3Left = `${gray}1 ${sanitizeTerminalText(state.memoryFile)}${reset}`;
    }
  }

  // Line 3 Right
  const line3RightParts = [];
  
  // Render Image Quota or rate limit exhaustion status
  const imageExhausted = state.imageExhausted;
  let isImageExhaustedDisplayed = false;
  if (imageExhausted) {
    const secsLeft = Math.max(0, Math.round((new Date(imageExhausted.resetTime).getTime() - Date.now()) / 1000));
    if (secsLeft > 0) {
      const pad = (n) => String(n).padStart(2, '0');
      const h = Math.floor(secsLeft / 3600);
      const m = Math.floor((secsLeft % 3600) / 60);
      const countdownStr = `${pad(h)}h${pad(m)}m`;
      const icon = unicode ? '⚠️ ' : '[!] ';
      line3RightParts.push(`${red}${icon}Image Quota Exhausted (Resets in: ${countdownStr})${reset}`);
      isImageExhaustedDisplayed = true;
    }
  }

  if (!isImageExhaustedDisplayed) {
    const imgQ = quotaData && quotaData.find(q => q.id && q.id.toLowerCase().includes('image'));
    if (imgQ) {
      const pct = Math.round(imgQ.remainingFraction * 100);
      const pctColor = pct <= (1 - critThresh) * 100 ? red : pct <= (1 - warnThresh) * 100 ? yellow : green;
      const bar = createProgressBar(pct, pctColor, 6, false); // 6-grid image progress bar
      const imgIcon = unicode ? '🖼️ ' : '[IMG] ';
      let timeStr = '';
      if (imgQ.resetTime) {
        const secsLeft = Math.max(0, Math.round((new Date(imgQ.resetTime).getTime() - Date.now()) / 1000));
        if (secsLeft > 0) timeStr = ` ~${formatDuration(secsLeft)}`;
      }
      line3RightParts.push(`${cyan}${imgIcon}Image Quota: ${bar} ${pctColor}${pct}%${reset}${gray}${timeStr}${reset}`);
    }
  }

  // Metadata stats
  const rulesCount = state.rulesCount || 0;
  const mcpCount = state.mcpCount || 0;
  const hooksCount = state.hooksCount || 0;
  const bullet = unicode ? '•' : '*';
  const metaStrParts = [];
  if (rulesCount > 0) metaStrParts.push(`${gray}${rulesCount} rules${reset}`);
  if (mcpCount > 0) metaStrParts.push(`${gray}${mcpCount} MCPs${reset}`);
  if (hooksCount > 0) metaStrParts.push(`${gray}${hooksCount} hooks${reset}`);
  if (metaStrParts.length > 0) {
    line3RightParts.push(metaStrParts.join(` ${gray}${bullet}${reset} `));
  }
  const line3Right = line3RightParts.join('  ');

  const getVisibleLength = (str) => sanitizeTerminalText(str).length;
  const hasLine3 = getVisibleLength(line3Left) > 0 || getVisibleLength(line3Right) > 0;

  // Width auto-stretching
  const baseWidth = typeof display.columnWidth === 'number'
    ? display.columnWidth
    : DEFAULT_COLUMN_WIDTH;

  const leftLengths = [
    getVisibleLength(line1Left),
    getVisibleLength(line2Left),
  ];
  if (hasLine3) leftLengths.push(getVisibleLength(line3Left));

  const rightLengths = [
    getVisibleLength(line1Right),
    getVisibleLength(line2Right),
  ];
  if (hasLine3) rightLengths.push(getVisibleLength(line3Right));

  const maxL = Math.max(...leftLengths);
  const maxR = Math.max(...rightLengths);
  const colWidth = Math.max(baseWidth, maxL, maxR);
  const quotaNameWidth = Math.max(10, colWidth - QUOTA_CHROME_WIDTH);

  const padToWidth = (str, width) => {
    const len = getVisibleLength(str);
    if (len >= width) return str;
    return str + ' '.repeat(width - len);
  };

  const formatColumns = (left, right) => {
    const leftPadded = padToWidth(left, colWidth);
    const rightPadded = padToWidth(right, colWidth);
    return `  ${leftPadded} ${gray}${glyph.vbar}${reset} ${rightPadded}`;
  };

  const line1 = formatColumns(line1Left, line1Right);
  const line2 = formatColumns(line2Left, line2Right);
  const line3 = hasLine3 ? formatColumns(line3Left, line3Right) : '';
  const dividerLine = `  ${gray}${glyph.hbar.repeat(colWidth * 2 + 1)}${reset}`;

  const { renderQuotaColumn, renderCompactQuotaLine } = createQuotaRenderers({
    colors: { cyan, reset, gray, red, yellow, green },
    glyph,
    thresholds: { warnThresh, critThresh },
    nameWidth: quotaNameWidth,
    divider,
    createProgressBar,
    truncateAndPad,
  });

  const lines = [dividerLine, line1, line2];
  if (line3) lines.push(line3);

  // Build quota lines and close the box frame
  if (quotaData && quotaData.length > 0) {
    const now = Date.now();
    if (isCompact) {
      const compactLine = `  ${renderCompactQuotaLine(quotaData, now)}`;
      lines.push(dividerLine, compactLine, dividerLine);
    } else {
      const isImageModel = (q) => q.id && q.id.toLowerCase().includes('image');
      const tableQuota = quotaData.filter(q => !isImageModel(q));
      const cols = tableQuota.map(q => renderQuotaColumn(q, now));

      const rows = [];
      for (let i = 0; i < cols.length; i += 2) {
        const col1 = cols[i];
        const col2 = cols[i + 1];
        if (col2) {
          rows.push(`  ${col1} ${gray}${glyph.vbar}${reset} ${col2}`);
        } else {
          rows.push(`  ${col1} ${gray}${glyph.vbar}${reset} ${' '.repeat(colWidth)}`);
        }
      }
      lines.push(dividerLine);
      lines.push(...rows);
      lines.push(dividerLine);
    }
  } else if (quotaData && quotaData.unavailableReason) {
    const reason = sanitizeTerminalText(text.quotaReasons[quotaData.unavailableReason] || quotaData.unavailableReason);
    const diagLine = `  ${yellow}${text.quotaUnavailable}:${reset} ${gray}${reason}${reset}`;
    lines.push(dividerLine, diagLine, dividerLine);
  } else if (quotaData && quotaData.length === 0) {
    const loadLine = `  ${gray}${text.quotaLoading}${glyph.ellipsis}${reset}`;
    lines.push(dividerLine, loadLine, dividerLine);
  } else {
    // If no quotaData is requested (null/undefined), we still close the box frame with the bottom line
    lines.push(dividerLine);
  }

  return lines.join('\n');
}

module.exports = {
  renderHUD,
  abbreviateDisplayName,
  compactModelName,
};
