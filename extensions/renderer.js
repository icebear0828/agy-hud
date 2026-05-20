/**
 * Renders the HUD string for the status line using native ANSI escape codes.
 * Features Dual Progress Bars for Context and Quota with Nerd Font fallbacks.
 * 
 * @param {Object} state 
 * @param {Object} agyData
 * @param {Object} config
 * @param {Array}  quotaData  — from quota.js getQuota()
 * @returns {string}
 */
function renderHUD(state, agyData, config, quotaData) {
  const useNerd = config?.display?.useNerdFonts === true;

  // ANSI escape sequences
  const reset = '\x1b[0m';
  const bold = '\x1b[1m';
  const gray = '\x1b[90m';
  const blue = '\x1b[34m';
  const magenta = '\x1b[35m';
  const yellow = '\x1b[33m';
  const cyan = '\x1b[36m';
  const green = '\x1b[32m';
  const red = '\x1b[31m';
  
  const bgBlue = '\x1b[44m';
  const fgWhite = '\x1b[37m';

  // Fallbacks for Nerd Fonts
  const branchIcon = useNerd ? ' ' : '⎇ ';
  const planIcon = useNerd ? '󰌢 ' : '❖ ';
  const stepIcon = useNerd ? ' ' : '⚡ ';
  const taskIcon = useNerd ? ' ' : '✓ ';
  const tokenIcon = useNerd ? '󰚩 ' : '⚿ ';
  const ctxIcon = useNerd ? '󱔐 ' : '⛁ ';
  const modelIcon = useNerd ? '󰚗 ' : '🤖 ';

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
      if (percent > 80) finalColor = red;
      else if (percent > 50) finalColor = yellow;
    } else {
      if (percent <= 20) finalColor = red;
      else if (percent <= 50) finalColor = yellow;
      else finalColor = green;
    }

    // Use solid blocks for progress bar
    return `${finalColor}[${'█'.repeat(completed)}${'░'.repeat(remaining)}]${reset}`;
  };

  const truncateAndPad = (str, width) => {
    if (str.length > width) {
      return str.substring(0, width - 1) + '…';
    }
    return str.padEnd(width, ' ');
  };

  const divider = ` ${gray}│${reset} `;

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

  // Helper to render one quota item inside a column of exactly 37 visible chars
  const renderQuotaColumn = (q, now) => {
    const pct = Math.round(q.remainingFraction * 100);
    
    // 1. Name (16 chars)
    const rawName = simplifyModelName(q.displayName || q.id);
    const namePart = truncateAndPad(rawName, 16);
    const coloredName = `${cyan}${namePart}${reset}`;
    
    // 2. Bar (8 chars visible: [ + 6 bars + ])
    const barPart = createProgressBar(pct, green, 6, false);
    
    // 3. Percent (4 chars)
    const pctStr = `${pct}%`.padStart(4, ' ');
    const pctColor = pct <= 10 ? red : pct <= 30 ? yellow : green;
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
    
    // Combined visually: 16 + 1 + 8 + 1 + 4 + 1 + 6 = 37 chars
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
      const col2 = cols[i + 1] || ' '.repeat(37);
      rows.push(`  ${col1} ${gray}│${reset} ${col2}`);
    }

    const dividerLine = `  ${gray}${'─'.repeat(75)}${reset}`;
    quotaLines = `\n${dividerLine}\n` + rows.join('\n') + `\n${dividerLine}`;
  } else if (quotaData && quotaData.unavailableReason) {
    const dividerLine = `  ${gray}${'─'.repeat(75)}${reset}`;
    const reasonMessages = {
      not_logged_in: 'not logged into Antigravity',
      auth_failed: 'Antigravity auth failed',
      quota_fetch_failed: 'quota fetch failed',
      quota_fetch_timeout: 'quota fetch timed out',
    };
    const reason = reasonMessages[quotaData.unavailableReason] || quotaData.unavailableReason;
    quotaLines = `\n${dividerLine}\n  ${yellow}Quota unavailable:${reset} ${gray}${reason}${reset}\n${dividerLine}`;
  }

  return `\n${line1}\n${line2}${quotaLines}\n`;
}

module.exports = {
  renderHUD
};
