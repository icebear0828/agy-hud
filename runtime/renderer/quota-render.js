'use strict';

const { classifyQuotaWindow, pickCriticalWindow } = require('../quota.js');
const {
  PROVIDER_LABELS,
} = require('./lang.js');
const {
  simplifyModelName,
  compactModelName,
  sanitizeTerminalText,
  formatDuration,
  visualWidth,
  padToVisualWidth,
} = require('./format.js');

/**
 * Build the quota-rendering closures bound to a single renderHUD invocation's
 * configuration. The returned `renderQuotaTable` produces the entire 3-column
 * table (header + divider + N data rows) as a single newline-joined string.
 *
 * @param {Object} ctx
 * @param {Object} ctx.colors  { cyan, reset, gray, red, yellow, green }
 * @param {Object} ctx.glyph   { bar, empty, vbar, hbar, cross, ellipsis }
 * @param {Object} ctx.thresholds  { warnThresh, critThresh }
 * @param {number} ctx.columnWidth
 * @param {string} ctx.divider
 * @param {Object} ctx.text    LANGUAGE_TEXT entry (en/zh)
 * @param {Function} ctx.createProgressBar  (percent, color, width, isUsage) => string
 */
function createQuotaRenderers(ctx) {
  const { colors, glyph, thresholds, columnWidth, divider, text, createProgressBar } = ctx;
  const { cyan, reset, gray, red, yellow, green } = colors;
  const { warnThresh, critThresh } = thresholds;

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

  // Render one window-cell's content (already padded to columnWidth). Two
  // shapes: "  [bar] pct% (~Xh Ym)" for an observation, "  ─ no data" for
  // a window we've never seen.
  const renderCell = (obs, now) => {
    if (!obs) {
      const content = `  ${glyph.hbar} ${text.quotaNoData}`;
      return `${gray}${padToVisualWidth(content, columnWidth)}${reset}`;
    }
    const pct = Math.round(obs.remainingFraction * 100);
    const pctColor = pct <= (1 - critThresh) * 100 ? red
                   : pct <= (1 - warnThresh) * 100 ? yellow
                   : green;
    // createProgressBar returns `${color}[████░░]${reset}` — the brackets
    // count as 2 visible chars, bar/empty as 10, so 12 visible width.
    const barPart = createProgressBar(pct, pctColor, 10, false);
    const pctStr = `${pct}%`.padStart(4, ' ');
    let timeStr = '';
    if (obs.resetTime) {
      const secsLeft = Math.max(0, Math.round((new Date(obs.resetTime).getTime() - now) / 1000));
      timeStr = ` (~${formatDuration(secsLeft)})`;
    }
    // Visible layout: "  [████████░░]  80% (~2h31m)"  → 2 + 12 + 2 + 4 + variable
    const content = `  ${barPart}  ${pctColor}${pctStr}${reset}${gray}${timeStr}${reset}`;
    return padToVisualWidth(content, columnWidth);
  };

  /**
   * Render the full quota table as one string (header row, divider row, then
   * one row per model). Each row is 3 columns wide; column separator is `│`
   * (or `|`), divider crosses are `┼` (or `+`).
   *
   * @param {ModelQuota[]} data
   * @param {number} now epoch ms
   * @returns {string}
   */
  const renderQuotaTable = (data, now) => {
    const vbar = `${gray}${glyph.vbar}${reset}`;
    const indent = '  ';

    const headerCell = (label) =>
      `${cyan}${padToVisualWidth(' ' + label, columnWidth)}${reset}`;
    const headerRow = `${indent}${headerCell(text.quotaHeaders.model)}${vbar}${headerCell(text.quotaHeaders.fiveHour)}${vbar}${headerCell(text.quotaHeaders.weekly)}`;

    const dividerSegment = glyph.hbar.repeat(columnWidth);
    const cross = `${gray}${glyph.cross}${reset}`;
    const dividerRow = `${indent}${gray}${dividerSegment}${reset}${cross}${gray}${dividerSegment}${reset}${cross}${gray}${dividerSegment}${reset}`;

    const dataRows = data.map(q => {
      const windows = resolveWindows(q, now);
      const rawName = sanitizeTerminalText(simplifyModelName(q.displayName || q.id), 80);
      // 1 leading space for breathing room, then the name; pad to columnWidth.
      const nameCell = `${cyan}${padToVisualWidth(' ' + rawName, columnWidth)}${reset}`;
      const fiveCell = renderCell(windows?.fiveHour, now);
      const weekCell = renderCell(windows?.weekly, now);
      return `${indent}${nameCell}${vbar}${fiveCell}${vbar}${weekCell}`;
    });

    return [headerRow, dividerRow, ...dataRows].join('\n');
  };

  // Compact: provider-grouped mini bars (unchanged from prior layout).
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
    renderQuotaTable,
    renderCompactQuotaLine,
    resolveWindows,
  };
}

module.exports = {
  createQuotaRenderers,
};
