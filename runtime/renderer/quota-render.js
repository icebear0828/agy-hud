'use strict';

const {
  PROVIDER_LABELS,
} = require('./lang.js');
const {
  simplifyModelName,
  compactModelName,
  sanitizeTerminalText,
  formatDuration,
} = require('./format.js');

/**
 * Build the quota-rendering closures bound to a single renderHUD invocation's
 * configuration. Renders each model as a single line "name [bar] pct ~time"
 * and pairs lines into 2 columns at the call site.
 *
 * Note: per-window data (q.windows.fiveHour / q.windows.weekly) is preserved
 * in the cache layer but intentionally not surfaced by this renderer — the
 * binding-window value already lives in q.remainingFraction / q.resetTime.
 * See runtime/quota/models.js for the windows merging logic and PR #59 for
 * a 3-column variant that displays both windows.
 *
 * @param {Object} ctx
 * @param {Object} ctx.colors  { cyan, reset, gray, red, yellow, green }
 * @param {Object} ctx.glyph   { bar, empty, vbar, hbar, ellipsis }
 * @param {Object} ctx.thresholds  { warnThresh, critThresh }
 * @param {number} ctx.nameWidth
 * @param {string} ctx.divider
 * @param {Function} ctx.createProgressBar  (percent, color, width, isUsage) => string
 * @param {Function} ctx.truncateAndPad     (str, width) => string
 */
function createQuotaRenderers(ctx) {
  const { colors, glyph, thresholds, nameWidth, divider, createProgressBar, truncateAndPad } = ctx;
  const { cyan, reset, gray, red, yellow, green } = colors;
  const { warnThresh, critThresh } = thresholds;

  const renderQuotaColumn = (q, now) => {
    const pct = Math.round(q.remainingFraction * 100);
    const pctColor = pct <= (1 - critThresh) * 100 ? red
                   : pct <= (1 - warnThresh) * 100 ? yellow
                   : green;

    const rawName = sanitizeTerminalText(simplifyModelName(q.displayName || q.id), 120);
    const namePart = truncateAndPad(rawName, nameWidth);
    const coloredName = `${cyan}${namePart}${reset}`;

    const barPart = createProgressBar(pct, pctColor, 6, false);

    const pctStr = `${pct}%`.padStart(4, ' ');
    const coloredPct = `${pctColor}${pctStr}${reset}`;

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

  // Compact: provider-grouped mini bars based on the top-level fraction.
  const renderCompactQuotaLine = (data, _now) => {
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

  return {
    renderQuotaColumn,
    renderCompactQuotaLine,
  };
}

module.exports = {
  createQuotaRenderers,
};
