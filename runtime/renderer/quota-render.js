'use strict';

const { classifyQuotaWindow, pickCriticalWindow } = require('../quota.js');
const {
  PROVIDER_LABELS,
} = require('./lang.js');
const {
  QUOTA_CHROME_WIDTH,
  simplifyModelName,
  compactModelName,
  sanitizeTerminalText,
  formatDuration,
} = require('./format.js');

/**
 * Build the quota-rendering closures bound to a single renderHUD invocation's
 * configuration. The factory is the only API; the returned bag is private to
 * the calling renderHUD body.
 *
 * @param {Object} ctx
 * @param {Object} ctx.colors  { cyan, reset, gray, red, yellow, green }
 * @param {Object} ctx.glyph   { bar, empty, vbar, hbar, ellipsis }
 * @param {Object} ctx.thresholds  { warnThresh, critThresh }
 * @param {number} ctx.columnWidth
 * @param {number} ctx.nameWidth
 * @param {string} ctx.divider
 * @param {Function} ctx.createProgressBar  (percent, color, width, isUsage) => string
 * @param {Function} ctx.truncateAndPad     (str, width) => string
 */
function createQuotaRenderers(ctx) {
  const { colors, glyph, thresholds, columnWidth, nameWidth, divider, createProgressBar, truncateAndPad } = ctx;
  const { cyan, reset, gray, red, yellow, green } = colors;
  const { warnThresh, critThresh } = thresholds;

  const renderQuotaColumn = (q, now) => {
    const pct = Math.round(q.remainingFraction * 100);
    const pctColor = pct <= (1 - critThresh) * 100 ? red : pct <= (1 - warnThresh) * 100 ? yellow : green;

    // 1. Name
    const rawName = sanitizeTerminalText(simplifyModelName(q.displayName || q.id), 120);
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

  // Resolve the per-window observations for a quota entry, falling back to
  // the legacy flat shape (no `windows` field) by classifying its resetTime.
  const resolveWindows = (q, now) => {
    const observed = q.windows && (q.windows.fiveHour || q.windows.weekly)
      ? q.windows
      : null;
    if (observed) return observed;
    if (!q.resetTime) return null;
    const window = classifyQuotaWindow(q.resetTime, now);
    if (!window) return null;
    return {
      [window]: {
        remainingFraction: q.remainingFraction,
        resetTime: q.resetTime,
        observedAt: now,
      },
    };
  };

  // Render one row of "label [bar] pct ~time" inside a per-model block, padded
  // out to columnWidth so paired blocks line up under their vertical divider.
  const renderWindowRow = (label, obs, now) => {
    const labelPart = `${gray}${label.padEnd(3, ' ')}${reset}`;
    const indent = '  ';
    // visible chars: 2 indent + 3 label + 1 space = 6 before the bar
    if (!obs) {
      const message = `${glyph.hbar} no data yet`;
      const trailing = Math.max(0, columnWidth - 6 - message.length);
      return `${indent}${labelPart} ${gray}${message}${reset}${' '.repeat(trailing)}`;
    }
    const pct = Math.round(obs.remainingFraction * 100);
    const pctColor = pct <= (1 - critThresh) * 100 ? red : pct <= (1 - warnThresh) * 100 ? yellow : green;
    const barPart = createProgressBar(pct, pctColor, 6, false);
    const pctStr = `${pct}%`.padStart(4, ' ');
    const coloredPct = `${pctColor}${pctStr}${reset}`;
    let rawTime = '';
    if (obs.resetTime) {
      const resetMs = new Date(obs.resetTime).getTime();
      const secsLeft = Math.max(0, Math.round((resetMs - now) / 1000));
      rawTime = `~${formatDuration(secsLeft)}`;
    }
    const timePart = rawTime.padEnd(6, ' ');
    const coloredTime = `${gray}${timePart}${reset}`;
    // 6 (prefix) + 8 (bar) + 1 + 4 (pct) + 1 + 6 (time) = 26 visible chars.
    const trailing = Math.max(0, columnWidth - 26);
    return `${indent}${labelPart} ${barPart} ${coloredPct} ${coloredTime}${' '.repeat(trailing)}`;
  };

  // Render a per-model block: header line with model name, then one row per
  // window. Returns an array of lines so callers can pair blocks side-by-side.
  const renderQuotaBlock = (q, now) => {
    const windows = resolveWindows(q, now);
    if (!windows) {
      // Legacy / unlimited / no quota data: single-line layout.
      return [renderQuotaColumn(q, now)];
    }
    const rawName = sanitizeTerminalText(simplifyModelName(q.displayName || q.id), 120);
    const namePart = truncateAndPad(rawName, nameWidth);
    const trailing = ' '.repeat(QUOTA_CHROME_WIDTH);
    const headerLine = `${cyan}${namePart}${reset}${trailing}`;
    return [
      headerLine,
      renderWindowRow('5h', windows.fiveHour, now),
      renderWindowRow('Wk', windows.weekly, now),
    ];
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
        const name = sanitizeTerminalText(compactModelName(q.displayName || q.id), 20);
        const windows = resolveWindows(q, now);
        const critical = windows ? pickCriticalWindow(windows, now) : null;
        const fraction = critical ? critical.remainingFraction : q.remainingFraction;
        const pct = Math.round(fraction * 100);
        const filled = Math.round((pct / 100) * 3);
        const empty = 3 - filled;
        const barColor = pct <= (1 - critThresh) * 100 ? red : pct <= (1 - warnThresh) * 100 ? yellow : green;
        return `${cyan}${name}${reset}${barColor}${glyph.bar.repeat(filled)}${gray}${glyph.empty.repeat(empty)}${reset}`;
      });
      segments.push(`${gray}${provider}:${reset} ${items.join(' ')}`);
    }
    return segments.join(divider);
  };

  return {
    renderQuotaColumn,
    resolveWindows,
    renderWindowRow,
    renderQuotaBlock,
    renderCompactQuotaLine,
  };
}

module.exports = {
  createQuotaRenderers,
};
