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
  calculateTurnCacheMetrics,
  formatTurnCacheBadge,
  sanitizeTerminalText,
  formatTokens,
  formatDuration,
  formatQuotaPercent,
} = require('./renderer/format.js');
const {
  LANGUAGE_TEXT,
  resolveLanguage,
} = require('./renderer/lang.js');
const { createQuotaRenderers } = require('./renderer/quota-render.js');
const { pickCriticalWindow } = require('./quota/models.js');
const { getSessionCostUsd, formatUsd } = require('./cost.js');
const { getCostTotals } = require('./daily-cost.js');
const { getOutputSpeed } = require('./speed.js');
const { getQuotaCapacityEstimates } = require('./quota-capacity.js');

/**
 * Renders the HUD string for the status line using native ANSI escape codes.
 * Falls back to ASCII when the terminal can't render box-drawing / Nerd Font
 * glyphs (detected via encoding.js, override via env or config.display.unicode).
 *
 * @param {Object} state
 * @param {Object} agyData
 * @param {Object} config
 * @param {Array}  quotaData  — from quota.js getQuota()
 * @param {string} tierName
 * @param {Object} updateInfo — local cache info about updates
 * @returns {string}
 */
function renderHUD(state, agyData, config, quotaData, tierName, updateInfo) {
  const display = config?.display || {};
  const useNerd = display.useNerdFonts === true;

  // Explicit env overrides take precedence over config.display.unicode,
  // followed by config.display.unicode, then runtime terminal detection.
  let unicode;
  if (process.env.AGY_HUD_FORCE_ASCII === '1') {
    unicode = false;
  } else if (process.env.AGY_HUD_FORCE_UNICODE === '1') {
    unicode = true;
  } else if (typeof display.unicode === 'boolean') {
    unicode = display.unicode;
  } else {
    unicode = supportsUnicode();
  }

  const showGitBranch = display.showGitBranch !== false;
  const showTokenBar = display.showTokenBar !== false;
  const showBreadcrumbs = display.showBreadcrumbs !== false;
  const showCurrentDir = display.showCurrentDir !== false;
  const showUsername = display.showUsername === true;
  const showTurnCacheHitRate = display.showTurnCacheHitRate === true;
  const showImageQuota = display.showImageQuota === true;
  const showQuotaCapacity = display.showQuotaCapacity !== false;
  const showCost = display.showCost === true;
  const showDailyCost = display.showDailyCost === true;
  const showWeeklyCost = display.showWeeklyCost === true;
  const showSpeed = display.showSpeed === true;
  const quotaStyle = display.quotaStyle || 'table';
  const isCompact = quotaStyle === 'compact';
  const text = LANGUAGE_TEXT[resolveLanguage(config)];

  // ANSI escape sequences
  const reset = '\x1b[0m';
  const bold = '\x1b[1m';
  const dim = '\x1b[2m';

  const getThemeColor = (key, defaultColor) => {
    const theme = config?.theme && typeof config.theme === 'object' ? config.theme : null;
    const name = theme?.[key] || defaultColor;
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

  // Data extraction
  const usage = agyData?.context_window || {};
  const totalInput = usage.total_input_tokens || 0;
  const totalOutput = usage.total_output_tokens || 0;
  const rawCtxPercent = usage.used_percentage;
  const ctxPercent = Number.isFinite(rawCtxPercent)
    ? Math.min(100, Math.max(0, rawCtxPercent))
    : 0;
  const plan = sanitizeTerminalText(tierName || agyData?.plan_tier || 'Free', 80);

  // Extract model information
  const rawModelName = agyData?.model?.display_name || agyData?.model?.id || 'Unknown Model';
  const modelName = sanitizeTerminalText(simplifyModelName(rawModelName), 80);

  const createProgressBar = (percent, color, width = 10, isUsage = true) => {
    const safePercent = Number.isFinite(percent)
      ? Math.min(100, Math.max(0, percent))
      : 0;
    const completed = Math.min(width, Math.max(0, Math.round((safePercent / 100) * width)));
    const remaining = Math.max(0, width - completed);

    // Auto-color based on usage vs remaining
    let finalColor = color;
    if (isUsage) {
      if (safePercent > critThresh * 100) finalColor = red;
      else if (safePercent > warnThresh * 100) finalColor = yellow;
    } else {
      if (safePercent <= (1 - critThresh) * 100) finalColor = red;
      else if (safePercent <= (1 - warnThresh) * 100) finalColor = yellow;
      else finalColor = green;
    }

    return `${finalColor}[${glyph.bar.repeat(completed)}${glyph.empty.repeat(remaining)}]${reset}`;
  };

  const truncateAndPad = (str, width) => {
    if (str.length > width) {
      const ellipsis = glyph.ellipsis;
      if (width <= ellipsis.length) return ellipsis.slice(0, Math.max(0, width));
      return str.substring(0, width - ellipsis.length) + ellipsis;
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
  const currentDir = sanitizeTerminalText(state.currentDir || '', 80);
  if (showCurrentDir && currentDir) {
    line1Parts.unshift(`${blue}${currentDir}${reset}`);
  }
  const username = sanitizeTerminalText(display.username || state.username || '', 80);
  if (showUsername && username) {
    line1Parts.unshift(`${cyan}${username}${reset}`);
  }
  // Cost tracking & formatting
  let sevenDayResetAt = null;
  if (quotaData?.providerQuota?.google?.weekly?.resetTime) {
    sevenDayResetAt = quotaData.providerQuota.google.weekly.resetTime;
  } else if (Array.isArray(quotaData)) {
    const weeklyQ = quotaData.find(q => q.windows?.weekly?.resetTime);
    if (weeklyQ) sevenDayResetAt = weeklyQ.windows.weekly.resetTime;
  }

  const sessionCost = showCost ? getSessionCostUsd(agyData, state, { allowRoutedCost: display.showRoutedCost }) : null;
  const costTotals = state?.costTotals ?? ((showDailyCost || showWeeklyCost)
    ? getCostTotals(agyData, { allowRoutedCost: display.showRoutedCost, sevenDayResetAt }, undefined, state)
    : null);

  const costSegments = [
    sessionCost !== null ? `${text.costLabel} ${formatUsd(sessionCost)}` : null,
    showDailyCost && costTotals ? `${text.todayLabel} ${formatUsd(costTotals.todayUsd)}` : null,
    showWeeklyCost && costTotals?.weekUsd != null ? `${text.weekLabel} ${formatUsd(costTotals.weekUsd)}` : null,
  ].filter(Boolean);

  if (costSegments.length > 0) {
    line1Parts.push(`${gray}${costSegments.join(' | ')}${reset}`);
  }

  // Token speed calculation & formatting
  const outputSpeed = state?.outputSpeed !== undefined
    ? state.outputSpeed
    : (showSpeed ? getOutputSpeed(agyData, null, state) : null);

  if (showSpeed && outputSpeed !== null && Number.isFinite(outputSpeed)) {
    line1Parts.push(`${gray}${text.outLabel}: ${outputSpeed.toFixed(1)} ${text.tokPerSec}${reset}`);
  }

  if (updateInfo && updateInfo.updateAvailable) {
    const updateIcon = unicode ? '⟳' : '[UP]';
    const safeVersion = sanitizeTerminalText(updateInfo.latestVersion, 40);
    if (safeVersion) {
      line1Parts.push(`${yellow}${updateIcon} v${safeVersion}${reset}`);
    }
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
  } else if (inTokens >= cacheTotal && modelIncludesCacheInInput(rawModelName)) {
    inTokens = Math.max(0, inTokens - cacheTotal);
  }
  const outTokens = totalOutput;

  const hasCacheTelemetry = candidate => candidate && typeof candidate === 'object' && (
    Object.hasOwn(candidate, 'cache_read_input_tokens') ||
    Object.hasOwn(candidate, 'cache_creation_input_tokens')
  );
  const hasCompleteTurnCacheUsage = candidate => candidate && typeof candidate === 'object' &&
    Number.isFinite(candidate.input_tokens) && candidate.input_tokens >= 0 &&
    Number.isFinite(candidate.cache_read_input_tokens) && candidate.cache_read_input_tokens >= 0 &&
    (candidate.cache_creation_input_tokens === undefined || (Number.isFinite(candidate.cache_creation_input_tokens) && candidate.cache_creation_input_tokens >= 0));
  const turnUsageCandidates = [
    agyCurrentUsage,
    usage,
    transcriptCurrentUsage,
    transcriptUsage,
  ];
  const turnUsage = turnUsageCandidates.find(hasCompleteTurnCacheUsage);
  const turnCacheMetrics = turnUsage
    ? calculateTurnCacheMetrics(turnUsage, rawModelName)
    : turnUsageCandidates.some(hasCacheTelemetry) ? { available: false } : null;

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
  const tokenParts = isCompact
    ? formatTokens(tokenTotal)
    : `${formatTokens(tokenTotal)} ${gray}(${reset}${detailParts.join(', ')}${gray})${reset}`;
  const tokenPrefix = tokenIcon === '[Tk] ' ? 'Tokens' : `${tokenIcon}Tokens`;
  const tokensStr = `${cyan}${tokenPrefix} ${tokenParts}${reset}`;
  const ctxBar = createProgressBar(ctxPercent, cyan, 10, true);
  const ctxPctStr = `${Math.round(ctxPercent)}%`;
  const ctxStr = `${cyan}${ctxIcon}${formatTokens(totalInput)}/${formatTokens(usage.context_window_size || 0)}${reset} ${ctxBar} ${cyan}${ctxPctStr}${reset}`;

  // Quota capacity estimate (5h & weekly)
  const quotaCapacity = !showQuotaCapacity
    ? null
    : (state?.quotaCapacity !== undefined
      ? state.quotaCapacity
      : getQuotaCapacityEstimates(agyData, state, quotaData, {
          minDeltaQ: display.quotaCapacityMinDelta,
          tierName,
          quotaSource: state?.quotaSource || 'cache',
        }));

  // In compact mode, find current model's quota and append to line 2
  let currentModelQuota = null;
  if (isCompact && quotaData && quotaData.length > 0) {
    const rawName = agyData?.model?.display_name || '';
    const modelId = agyData?.model?.id || '';

    // 1) Exact / normalized match.
    currentModelQuota = quotaData.find(q =>
      (modelId && q.id === modelId) ||
      q.displayName === rawName ||
      simplifyModelName(q.displayName) === modelName ||
      modelNamesMatch(q.displayName, rawName)
    );

    // 2) Family + tier fallback for cross-generation matching.
    if (!currentModelQuota && (rawName || modelName)) {
      const extractFamilyAndTier = (name) => {
        const s = String(name).toLowerCase();
        let family = '';
        if (s.includes('argon')) family = 'argon';
        else if (s.includes('flash')) family = 'flash';
        else if (s.includes('pro')) family = 'pro';
        else if (s.includes('sonnet')) family = 'sonnet';
        else if (s.includes('opus')) family = 'opus';
        else if (s.includes('haiku')) family = 'haiku';
        else if (s.includes('gpt')) family = 'gpt';

        let tier = '';
        if (s.includes('high') || s.includes('(h)') || s.includes('thinking') || s.includes('(th)')) tier = 'high';
        else if (s.includes('medium') || s.includes('(m)') || s.includes('tiered')) tier = 'medium';
        else if (s.includes('low') || s.includes('(l)') || s.includes('extra-low') || s.includes('lite')) tier = 'low';

        return { family, tier };
      };

      const current = extractFamilyAndTier(rawName || modelName);
      if (current.family) {
        currentModelQuota = quotaData.find(q => {
          const target = extractFamilyAndTier(q.displayName || q.id);
          return target.family === current.family && current.tier && target.tier === current.tier;
        }) || quotaData.find(q => {
          const target = extractFamilyAndTier(q.displayName || q.id);
          return target.family === current.family;
        });
      }
    }
  }

  // Layer 2: resource consumption
  const line2Parts = [];
  if (showTokenBar) line2Parts.push(tokensStr);
  if (showTurnCacheHitRate && (turnCacheMetrics || isCacheSmoothApplied)) {
    const cacheBadge = formatTurnCacheBadge(
      isCacheSmoothApplied ? null : turnCacheMetrics,
      text.cacheLabel,
      { green, cyan, yellow, gray, reset, bold, dim },
      isCompact,
      display.cacheHitThresholds
    );
    line2Parts.push(cacheBadge);
  }
  line2Parts.push(ctxStr);
  if (isCompact && currentModelQuota) {
    const critical = pickCriticalWindow(currentModelQuota.windows, Date.now()) || currentModelQuota;
    const pct = formatQuotaPercent(critical.remainingFraction);
    const pctColor = pct <= (1 - critThresh) * 100 ? red : pct <= (1 - warnThresh) * 100 ? yellow : green;
    let timeStr = '';
    const resetTime = critical.resetTime || currentModelQuota.resetTime;
    if (resetTime) {
      const resetMs = new Date(resetTime).getTime();
      if (Number.isFinite(resetMs)) {
        const secsLeft = Math.max(0, Math.round((resetMs - Date.now()) / 1000));
        const formatted = formatDuration(secsLeft);
        if (formatted) timeStr = ` ${gray}~${formatted}${reset}`;
      }
    }
    let compactEstSuffix = '';
    if (quotaCapacity) {
      const targetWin = (critical.window && quotaCapacity[critical.window]?.status === 'ready')
        ? quotaCapacity[critical.window]
        : (quotaCapacity.critical?.status === 'ready'
          ? quotaCapacity.critical
          : (quotaCapacity.fiveHour?.status === 'ready'
            ? quotaCapacity.fiveHour
            : (quotaCapacity.weekly?.status === 'ready' ? quotaCapacity.weekly : null)));
      if (targetWin) {
        const remPart = (targetWin.exhausted || targetWin.remainingTokens === 0)
          ? `${red}0${gray}`
          : `~${formatTokens(targetWin.remainingTokens || 0)}`;
        const star = targetWin.isPrior ? '*' : '';
        compactEstSuffix = ` ${gray}(${remPart}/${formatTokens(targetWin.totalTokens || 0)}${star})${reset}`;
      }
    }
    line2Parts.push(`${pctColor}${text.quotaLabel}: ${pct}%${reset}${timeStr}${compactEstSuffix}`);
  }

  // Render Image Quota or rate limit exhaustion status
  const imageExhausted = state.imageExhausted;
  let isImageExhaustedDisplayed = false;
  if (imageExhausted && imageExhausted.resetTime) {
    const resetMs = new Date(imageExhausted.resetTime).getTime();
    const secsLeft = Number.isFinite(resetMs) ? Math.max(0, Math.round((resetMs - Date.now()) / 1000)) : 0;
    if (secsLeft > 0) {
      const pad = (n) => String(n).padStart(2, '0');
      const h = Math.floor(secsLeft / 3600);
      const m = Math.floor((secsLeft % 3600) / 60);
      const countdownStr = `${pad(h)}h${pad(m)}m`;
      const icon = unicode ? '⚠️ ' : '[!] ';
      line2Parts.push(`${red}${icon}${text.imageQuotaExhausted} (${text.resetsIn}: ${countdownStr})${reset}`);
      isImageExhaustedDisplayed = true;
    }
  }

  if (!isImageExhaustedDisplayed && showImageQuota) {
    const imgQ = quotaData && quotaData.find(q => (q.id && q.id.includes('image')) || (q.displayName && q.displayName.toLowerCase().includes('image')));
    if (imgQ) {
      const pct = formatQuotaPercent(imgQ.remainingFraction);
      const pctColor = pct <= (1 - critThresh) * 100 ? red : pct <= (1 - warnThresh) * 100 ? yellow : green;
      const bar = createProgressBar(pct, pctColor, 10, false);
      const imgIcon = unicode ? '🖼️ ' : '[IMG] ';
      let timeStr = '';
      if (imgQ.resetTime) {
        const resetMs = new Date(imgQ.resetTime).getTime();
        if (Number.isFinite(resetMs)) {
          const secsLeft = Math.max(0, Math.round((resetMs - Date.now()) / 1000));
          const formatted = formatDuration(secsLeft);
          if (secsLeft > 0 && formatted) timeStr = ` ${gray}~${formatted}${reset}`;
        }
      }
      line2Parts.push(`${cyan}${imgIcon}${text.imageQuotaLabel}: ${bar} ${pctColor}${pct}%${reset}${timeStr}`);
    }
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
  if (rulesCount > 0) metaParts.push(`${gray}${rulesCount} ${text.rulesLabel}${reset}`);
  if (mcpCount > 0) metaParts.push(`${gray}${mcpCount} ${text.mcpsLabel}${reset}`);
  if (hooksCount > 0) metaParts.push(`${gray}${hooksCount} ${text.hooksLabel}${reset}`);
  const line3 = metaParts.length > 0 ? metaParts.join(divider) : '';

  const {
    renderQuotaColumn,
    renderProviderQuotaTable,
    renderCompactQuotaLine,
    renderQuotaCapacityLine,
  } = createQuotaRenderers({
    colors: { cyan, reset, gray, red, yellow, green, dim },
    glyph,
    thresholds: { warnThresh, critThresh },
    nameWidth,
    divider,
    createProgressBar,
    truncateAndPad,
    text,
    unicode,
  });

  // Build quota lines
  let quotaLines = '';
  const hasProviderQuota = Boolean(quotaData?.providerQuota && (!isCompact && quotaStyle !== 'models'));
  if (quotaData && (quotaData.length > 0 || hasProviderQuota)) {
    const now = Date.now();
    if (isCompact) {
      quotaLines = `\n${renderCompactQuotaLine(quotaData, now)}`;
    } else if (quotaStyle === 'models') {
      const isImageModel = (q) => (q.id && q.id.includes('image')) || (q.displayName && q.displayName.toLowerCase().includes('image'));
      const tableQuota = quotaData.filter(q => !isImageModel(q));
      const cols = tableQuota.map(q => renderQuotaColumn(q, now));

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
      const dividerLine = `  ${gray}${glyph.hbar.repeat(columnWidth * 2 + 3)}${reset}`;
      quotaLines = `\n${dividerLine}\n` + rows.join('\n') + `\n${dividerLine}`;
      const capLine = renderQuotaCapacityLine(quotaCapacity);
      if (capLine) quotaLines += `\n${capLine}`;
    } else {
      quotaLines = `\n${renderProviderQuotaTable(quotaData, now)}`;
      const capLine = renderQuotaCapacityLine(quotaCapacity);
      if (capLine) quotaLines += `\n${capLine}`;
    }
  } else if (quotaData && quotaData.unavailableReason) {
    const dividerLine = `  ${gray}${glyph.hbar.repeat(columnWidth * 2 + 3)}${reset}`;
    const reason = sanitizeTerminalText(text.quotaReasons[quotaData.unavailableReason] || quotaData.unavailableReason);
    quotaLines = `\n${dividerLine}\n  ${yellow}${text.quotaUnavailable}:${reset} ${gray}${reason}${reset}\n${dividerLine}`;
  } else if (quotaData && quotaData.length === 0) {
    const dividerLine = `  ${gray}${glyph.hbar.repeat(columnWidth * 2 + 3)}${reset}`;
    quotaLines = `\n${dividerLine}\n  ${gray}${text.quotaLoading}${glyph.ellipsis}${reset}\n${dividerLine}`;
  }

  const lines = [line1, line2];
  if (line3) lines.push(line3);
  return lines.join('\n') + quotaLines;
}

module.exports = {
  renderHUD,
  abbreviateDisplayName,
  compactModelName,
  formatQuotaPercent,
};
