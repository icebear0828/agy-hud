'use strict';

const { supportsUnicode } = require('./encoding.js');

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
function renderHUD(state, agyData, config, quotaData) {
  const useNerd = config?.display?.useNerdFonts === true;
  const unicode = typeof config?.display?.unicode === 'boolean'
    ? config.display.unicode
    : supportsUnicode();

  // ANSI escape sequences
  const reset = '\x1b[0m';
  const bold = '\x1b[1m';
  
  const colors = {
    gray: '\x1b[90m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    yellow: '\x1b[33m',
    cyan: '\x1b[36m',
    green: '\x1b[32m',
    red: '\x1b[31m',
  };

  const getThemeColor = (key, defaultColor) => {
    const name = config?.theme?.[key] || defaultColor;
    return colors[name] || colors[defaultColor];
  };

  const primaryColor = getThemeColor('primary', 'green');
  const secondaryColor = getThemeColor('secondary', 'gray');
  const warningColor = getThemeColor('warning', 'yellow');
  const criticalColor = getThemeColor('critical', 'red');

  const gray = secondaryColor;
  const blue = colors.blue;
  const magenta = colors.magenta;
  const yellow = warningColor;
  const cyan = colors.cyan;
  const green = primaryColor;
  const red = criticalColor;

  const warnThresh = typeof config?.thresholds?.warning === 'number' ? config.thresholds.warning : 0.7;
  const critThresh = typeof config?.thresholds?.critical === 'number' ? config.thresholds.critical : 0.9;

  const columnWidth = typeof config?.display?.columnWidth === 'number' ? config.display.columnWidth : 37;
  const nameWidth = Math.max(10, columnWidth - 21);

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

  const brand = `${bold}${cyan}AGY-HUD${reset}`;
  const branchName = `${blue}${branchIcon}${state.branch || 'unknown'}${reset}`;

  // Data extraction
  const usage = agyData?.context_window || {};
  const totalInput = usage.total_input_tokens || 0;
  const totalOutput = usage.total_output_tokens || 0;
  const ctxPercent = usage.used_percentage || 0;
  const plan = agyData?.plan_tier || 'Free';
  const tasks = agyData?.task_count || 0;

  // Model display name simplification helper
  const simplifyModelName = (name) => {
    if (!name) return '';
    return name
      .replace('Gemini 3.5 Flash (High)', 'Gem 3.5 Flash(H)')
      .replace('Gemini 3.5 Flash (Medium)', 'Gem 3.5 Flash(M)')
      .replace('Gemini 3.1 Pro (High)', 'Gem 3.1 Pro(H)')
      .replace('Gemini 3.1 Pro (Low)', 'Gem 3.1 Pro(L)')
      .replace('Claude Sonnet 4.6 (Thinking)', 'Claude 4.6(Th)')
      .replace('Claude Opus 4.6 (Thinking)', 'Claude Opus(Th)')
      .replace('GPT-OSS 120B (Medium)', 'GPT-OSS 120B');
  };

  // Extract model information
  let rawModelName = agyData?.model?.display_name || agyData?.model?.id || 'Unknown Model';
  const modelName = simplifyModelName(rawModelName);

  const formatTokens = (n) => {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
    return n.toString();
  };

  /**
   * Format seconds into human-readable "XhYm" or "Ym" string (compact).
   * @param {number} secs
   */
  const formatDuration = (secs) => {
    if (secs <= 0) return 'now';
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
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

  const line1 = [
    brand,
    branchName,
    `${magenta}${planIcon}Plan: ${plan}${reset}`,
    `${yellow}${stepIcon}Steps: ${state.steps}${reset}`,
    `${yellow}${taskIcon}Tasks: ${tasks}${reset}`
  ].join(divider);

  const tokensStr = `${cyan}${tokenIcon}Tokens: ${formatTokens(totalInput)}/${formatTokens(totalOutput)}${reset}`;
  const ctxStr = `${cyan}${ctxIcon}Ctx: ${formatTokens(totalInput)}/${formatTokens(usage.context_window_size || 0)}${reset}`;
  const ctxBar = createProgressBar(ctxPercent, cyan, 10, true);
  const modelStr = `${green}${modelIcon}Model: ${modelName}${reset}`;

  const line2 = [
    tokensStr,
    `${ctxStr} ${ctxBar}`,
    modelStr
  ].join(divider);

  // Helper to render one quota item inside a column of exactly columnWidth visible chars
  const renderQuotaColumn = (q, now) => {
    const pct = Math.round(q.remainingFraction * 100);

    // 1. Name
    const rawName = simplifyModelName(q.displayName || q.id);
    const namePart = truncateAndPad(rawName, nameWidth);
    const coloredName = `${cyan}${namePart}${reset}`;

    // 2. Bar (8 chars visible: [ + 6 bars + ])
    const barPart = createProgressBar(pct, green, 6, false);

    // 3. Percent (4 chars)
    const pctStr = `${pct}%`.padStart(4, ' ');
    const pctColor = pct <= (1 - critThresh) * 100 ? red : pct <= (1 - warnThresh) * 100 ? yellow : green;
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

  // Build quota lines
  let quotaLines = '';
  if (quotaData && quotaData.length > 0) {
    const now = Date.now();
    const cols = quotaData.map(q => renderQuotaColumn(q, now));

    const rows = [];
    for (let i = 0; i < cols.length; i += 2) {
      const col1 = cols[i];
      const col2 = cols[i + 1] || ' '.repeat(columnWidth);
      rows.push(`  ${col1} ${gray}${glyph.vbar}${reset} ${col2}`);
    }

    const dividerLine = `  ${gray}${glyph.hbar.repeat(columnWidth * 2 + 1)}${reset}`;
    quotaLines = `\n${dividerLine}\n` + rows.join('\n') + `\n${dividerLine}`;
  } else if (quotaData && quotaData.unavailableReason) {
    const dividerLine = `  ${gray}${glyph.hbar.repeat(columnWidth * 2 + 1)}${reset}`;
    const reasonMessages = {
      not_logged_in: 'not logged into Antigravity',
      auth_failed: 'Antigravity auth failed',
      quota_fetch_failed: 'quota fetch failed',
    };
    const reason = reasonMessages[quotaData.unavailableReason] || quotaData.unavailableReason;
    quotaLines = `\n${dividerLine}\n  ${yellow}Quota unavailable:${reset} ${gray}${reason}${reset}\n${dividerLine}`;
  }

  return `${line1}\n${line2}${quotaLines}\n`;
}

module.exports = {
  renderHUD
};
