'use strict';

const { supportsUnicode } = require('./encoding.js');
const {
  ANSI_COLORS,
  DEFAULT_THRESHOLDS,
  DEFAULT_COLUMN_WIDTH,
  QUOTA_CHROME_WIDTH,
  simplifyModelName,
  sanitizeTerminalText,
  formatTokens,
  formatDuration,
  modelIncludesCacheInInput,
  modelNamesMatch,
  abbreviateDisplayName,
  compactModelName,
} = require('./renderer/format.js');
const {
  LANGUAGE_TEXT,
  resolveLanguage,
} = require('./renderer/lang.js');

function renderHUD(state, agyData, config, quotaData, tierName, updateInfo) {
  const display = config?.display || {};
  const unicode = typeof display.unicode === 'boolean' ? display.unicode : supportsUnicode();
  const text = LANGUAGE_TEXT[resolveLanguage(config)];

  const reset = '\x1b[0m';
  const gray = ANSI_COLORS.gray;
  const blue = ANSI_COLORS.blue;
  const magenta = ANSI_COLORS.magenta;
  const yellow = ANSI_COLORS.yellow;
  const cyan = ANSI_COLORS.cyan;
  const green = ANSI_COLORS.green;
  const red = ANSI_COLORS.red;

  const warnThresh = config?.thresholds?.warning ?? DEFAULT_THRESHOLDS.warning;
  const critThresh = config?.thresholds?.critical ?? DEFAULT_THRESHOLDS.critical;

  // Extract variables
  const branch = sanitizeTerminalText(state.branch || 'unknown', 20);
  const currentDir = sanitizeTerminalText(state.currentDir || '', 20);
  const username = sanitizeTerminalText(display.username || state.username || '', 20);
  const rawModelName = agyData?.model?.display_name || agyData?.model?.id || 'Unknown Model';
  const modelName = sanitizeTerminalText(simplifyModelName(rawModelName), 40);
  const plan = sanitizeTerminalText(tierName || agyData?.plan_tier || 'Free', 15);

  const usage = agyData?.context_window || {};
  const totalInput = usage.total_input_tokens || 0;
  const totalOutput = usage.total_output_tokens || 0;
  const ctxPercent = usage.used_percentage || 0;

  // Badge generator helper
  const badge = (label, value, color) => {
    return `${gray}[${color}${label}${gray}:${reset} ${value}${gray}]${reset}`;
  };

  const createProgressBar = (percent, color, width = 6) => {
    const completed = Math.round((percent / 100) * width);
    const remaining = width - completed;
    const glyphBar = unicode ? '█' : '#';
    const glyphEmpty = unicode ? '░' : '-';
    return `[${color}${glyphBar.repeat(completed)}${gray}${glyphEmpty.repeat(remaining)}${reset}${gray}]${reset}`;
  };

  // Row 1: Context Badges
  const r1Parts = [];
  if (username) r1Parts.push(badge('user', username, cyan));
  if (currentDir) r1Parts.push(badge('dir', currentDir, blue));
  if (branch) r1Parts.push(badge('branch', branch, blue));
  r1Parts.push(badge('model', modelName, green));
  r1Parts.push(badge('tier', plan, magenta));
  
  if (updateInfo?.updateAvailable) {
    r1Parts.push(badge('update', `v${updateInfo.latestVersion}`, yellow));
  }

  // Compiling detailed cache breakdown for tokens
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
  } else if (modelIncludesCacheInInput && modelIncludesCacheInInput(rawModelName)) {
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
  const detailParts = [`in: ${formatTokens(displayIn)}`, `out: ${formatTokens(outTokens)}`];
  if (displayCache > 0) {
    const cacheLabel = isCacheSmoothApplied ? `${formatTokens(displayCache)}*` : formatTokens(displayCache);
    detailParts.push(`cache: ${cacheLabel}`);
  }
  const tokensVal = `${formatTokens(tokenTotal)} ${gray}(in: ${formatTokens(displayIn)}, out: ${formatTokens(outTokens)}${displayCache > 0 ? `, cache: ${isCacheSmoothApplied ? `${formatTokens(displayCache)}*` : formatTokens(displayCache)}` : ''})${reset}`;
  
  const ctxBarColor = ctxPercent > critThresh * 100 ? red : ctxPercent > warnThresh * 100 ? yellow : cyan;
  const ctxVal = `${formatTokens(totalInput)}/${formatTokens(usage.context_window_size || 0)} (${ctxBarColor}${Math.round(ctxPercent)}%${reset})`;

  const r2Parts = [
    badge('tokens', tokensVal, cyan),
    badge('ctx', ctxVal, cyan)
  ];

  // Image Quota Badge
  const imageExhausted = state.imageExhausted;
  const imgQ = quotaData && quotaData.find(q => q.id && q.id.toLowerCase().includes('image'));
  
  if (imageExhausted) {
    r2Parts.push(badge('image-quota', `${red}Exhausted${reset}`, red));
  } else if (imgQ) {
    const pct = Math.round(imgQ.remainingFraction * 100);
    const pctColor = pct <= (1 - critThresh) * 100 ? red : pct <= (1 - warnThresh) * 100 ? yellow : green;
    r2Parts.push(badge('image-quota', `${pctColor}${pct}%${reset}`, cyan));
  }

  // Row 3: Metadata Badges
  const r3Parts = [];
  const showBreadcrumbs = display.showBreadcrumbs !== false;
  const breadcrumbCount = typeof display.breadcrumbCount === 'number'
    ? Math.max(0, Math.floor(display.breadcrumbCount))
    : 3;
  if (showBreadcrumbs && breadcrumbCount > 0) {
    if (Array.isArray(state.breadcrumbs) && state.breadcrumbs.length > 0) {
      for (const item of state.breadcrumbs.filter(Boolean).slice(-breadcrumbCount)) {
        r3Parts.push(badge('memory', sanitizeTerminalText(item, 40), gray));
      }
    } else if (state.memoryFile) {
      r3Parts.push(badge('memory', sanitizeTerminalText(state.memoryFile, 40), gray));
    }
  } else if (state.memoryFile) {
    r3Parts.push(badge('memory', sanitizeTerminalText(state.memoryFile, 40), gray));
  }

  const rulesCount = state.rulesCount || 0;
  const mcpCount = state.mcpCount || 0;
  const hooksCount = state.hooksCount || 0;
  if (rulesCount > 0) r3Parts.push(badge('rules', rulesCount, gray));
  if (mcpCount > 0) r3Parts.push(badge('mcps', mcpCount, gray));
  if (hooksCount > 0) r3Parts.push(badge('hooks', hooksCount, gray));

  // Build the basic lines array
  const lines = [
    r1Parts.join(' '),
    r2Parts.join(' ')
  ];
  if (r3Parts.length > 0) {
    lines.push(r3Parts.join(' '));
  }

  // Check if we are compact / single-line mode (Option 4 style)
  const quotaStyle = display.quotaStyle || 'table';
  const isCompact = quotaStyle === 'compact';

  // If in compact mode, append current model quota to line 2 if available
  if (isCompact && quotaData && quotaData.length > 0) {
    const rawName = agyData?.model?.display_name || '';
    const modelId = agyData?.model?.id || '';
    const currentModelQuota = quotaData.find(q =>
      (modelId && q.id === modelId) ||
      q.displayName === rawName ||
      simplifyModelName(q.displayName) === modelName
    );
    if (currentModelQuota) {
      const pct = Math.round(currentModelQuota.remainingFraction * 100);
      const pctColor = pct <= (1 - critThresh) * 100 ? red : pct <= (1 - warnThresh) * 100 ? yellow : green;
      let timeStr = '';
      if (currentModelQuota.resetTime) {
        const secsLeft = Math.max(0, Math.round((new Date(currentModelQuota.resetTime).getTime() - Date.now()) / 1000));
        timeStr = ` ${gray}~${formatDuration(secsLeft)}${reset}`;
      }
      r2Parts.push(badge('quota', `${pctColor}${pct}%${reset}${timeStr}`, cyan));
      // Re-build line 2 with the newly added badge
      lines[1] = r2Parts.join(' ');
    }
  }

  // Quota Table Block (Option 6 Style with progress bars & 3 columns for Gemini, Claude/Other, Images)
  if (!isCompact && quotaData && quotaData.length > 0) {
    const geminiModels = [];
    const claudeOtherModels = [];
    const imageModels = [];

    for (const q of quotaData) {
      const id = (q.id || '').toLowerCase();
      const disp = (q.displayName || '').toLowerCase();
      if (id.includes('image') || disp.includes('image')) {
        imageModels.push(q);
      } else if (id.includes('gemini') || disp.includes('gemini')) {
        geminiModels.push(q);
      } else {
        claudeOtherModels.push(q);
      }
    }

    if (geminiModels.length > 0 || claudeOtherModels.length > 0 || imageModels.length > 0) {
      lines.push(`${gray}-------------------------------------------------------------------------------------------------${reset}`);
      lines.push(`${gray}Quota Status (Gemini │ Claude/Other │ Images):${reset}`);

      const renderQuotaBadge = (q) => {
        if (!q) return '';
        const pct = Math.round(q.remainingFraction * 100);
        const pctColor = pct <= (1 - critThresh) * 100 ? red : pct <= (1 - warnThresh) * 100 ? yellow : green;
        const name = sanitizeTerminalText(simplifyModelName(q.displayName || q.id), 18).padEnd(18, ' ');
        const bar = createProgressBar(pct, pctColor, 6);
        let timeStr = '';
        if (q.resetTime) {
          const secs = Math.max(0, Math.round((new Date(q.resetTime).getTime() - Date.now()) / 1000));
          if (secs > 0) timeStr = ` ${gray}(${formatDuration(secs)})${reset}`;
        }
        return `${gray}[${reset}${name} ${bar} ${pctColor}${pct}%${reset}${timeStr}${gray}]${reset}`;
      };

      const maxLen = Math.max(geminiModels.length, claudeOtherModels.length, imageModels.length);
      const colWidth = 42;

      for (let i = 0; i < maxLen; i++) {
        const geminiCol = renderQuotaBadge(geminiModels[i]);
        const claudeCol = renderQuotaBadge(claudeOtherModels[i]);
        const imageCol = renderQuotaBadge(imageModels[i]);

        // Standard pad logic for columns mapping to align them cleanly
        const geminiStr = geminiCol ? geminiCol.padEnd(colWidth + 15, ' ') : ' '.repeat(colWidth);
        const claudeStr = claudeCol ? claudeCol.padEnd(colWidth + 15, ' ') : ' '.repeat(colWidth);
        lines.push(`  ${geminiStr} ${gray}│${reset} ${claudeStr} ${gray}│${reset} ${imageCol}`);
      }
    }
  } else if (!isCompact && quotaData && quotaData.unavailableReason) {
    const reason = sanitizeTerminalText(text.quotaReasons[quotaData.unavailableReason] || quotaData.unavailableReason);
    lines.push(badge('quota', `${yellow}${text.quotaUnavailable}:${reset} ${gray}${reason}${reset}`, yellow));
  } else if (!isCompact && quotaData && quotaData.length === 0) {
    lines.push(badge('quota', `${gray}${text.quotaLoading}${unicode ? '…' : '...'}${reset}`, gray));
  }

  return lines.join('\n');
}

module.exports = {
  renderHUD,
  simplifyModelName,
  abbreviateDisplayName,
  compactModelName,
};
