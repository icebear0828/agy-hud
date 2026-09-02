'use strict';

const {
  PROVIDER_LABELS,
} = require('./lang.js');
const {
  simplifyModelName,
  compactModelName,
  sanitizeTerminalText,
  formatDuration,
  formatQuotaPercent,
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
const { pickCriticalWindow, classifyQuotaWindow, isObservationExpired } = require('../quota/models.js');

function createQuotaRenderers(ctx) {
  const { colors, glyph, thresholds, nameWidth, divider, createProgressBar, truncateAndPad } = ctx;
  const { cyan, reset, gray, red, yellow, green } = colors;
  const { warnThresh, critThresh } = thresholds;

  const renderQuotaColumn = (q, now) => {
    const critical = pickCriticalWindow(q.windows, now) || q;
    const pct = formatQuotaPercent(critical.remainingFraction);
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
    const resetTime = critical.resetTime || q.resetTime;
    if (resetTime) {
      const resetMs = new Date(resetTime).getTime();
      const secsLeft = Math.max(0, Math.round((resetMs - now) / 1000));
      rawTime = `~${formatDuration(secsLeft)}`;
    }
    const timePart = rawTime.padEnd(6, ' ');
    const coloredTime = `${gray}${timePart}${reset}`;

    return `${coloredName} ${barPart} ${coloredPct} ${coloredTime}`;
  };

  const isImageModel = (q) => Boolean((q?.id && q.id.includes('image')) || (q?.displayName && q.displayName.toLowerCase().includes('image')));

  const renderProviderQuotaTable = (data, now = Date.now()) => {
    const providerWindows = {
      Google: { fiveHour: null, weekly: null },
      Claude: { fiveHour: null, weekly: null },
    };

    for (const q of data || []) {
      if (!q || isImageModel(q)) continue;
      const isGoogle = q.modelProvider === 'MODEL_PROVIDER_GOOGLE' || /gemini/i.test(q.id || q.displayName);
      const isClaude = q.modelProvider === 'MODEL_PROVIDER_ANTHROPIC' || /claude/i.test(q.id || q.displayName);
      const key = isGoogle ? 'Google' : isClaude ? 'Claude' : null;
      if (!key) continue;

      if (q.windows?.fiveHour && !isObservationExpired(q.windows.fiveHour, now)) {
        const cur = providerWindows[key].fiveHour;
        if (!cur || q.windows.fiveHour.remainingFraction < cur.remainingFraction) {
          providerWindows[key].fiveHour = q.windows.fiveHour;
        }
      }
      if (q.windows?.weekly && !isObservationExpired(q.windows.weekly, now)) {
        const cur = providerWindows[key].weekly;
        if (!cur || q.windows.weekly.remainingFraction < cur.remainingFraction) {
          providerWindows[key].weekly = q.windows.weekly;
        }
      }

      if (q.resetTime && !q.windows?.fiveHour && !q.windows?.weekly) {
        const winType = classifyQuotaWindow(q.resetTime, now);
        if (winType === 'fiveHour') {
          const cur = providerWindows[key].fiveHour;
          if (!cur || q.remainingFraction < cur.remainingFraction) {
            providerWindows[key].fiveHour = { remainingFraction: q.remainingFraction, resetTime: q.resetTime };
          }
        } else if (winType === 'weekly') {
          const cur = providerWindows[key].weekly;
          if (!cur || q.remainingFraction < cur.remainingFraction) {
            providerWindows[key].weekly = { remainingFraction: q.remainingFraction, resetTime: q.resetTime };
          }
        }
      } else if (!q.resetTime && !q.windows?.fiveHour && !q.windows?.weekly) {
        if (!providerWindows[key].fiveHour) {
          providerWindows[key].fiveHour = { remainingFraction: q.remainingFraction, resetTime: null };
        }
        if (!providerWindows[key].weekly) {
          providerWindows[key].weekly = { remainingFraction: q.remainingFraction, resetTime: null };
        }
      }
    }

    const renderWindowItem = (label, win) => {
      const targetWin = win || { remainingFraction: 1.0, resetTime: null };
      const pct = formatQuotaPercent(targetWin.remainingFraction);
      const pctColor = pct <= (1 - critThresh) * 100 ? red
                     : pct <= (1 - warnThresh) * 100 ? yellow
                     : green;

      const namePart = truncateAndPad(label, 11);
      const coloredName = `${cyan}${namePart}${reset}`;

      const barPart = createProgressBar(pct, pctColor, 6, false);

      const pctStr = `${pct}%`.padStart(4, ' ');
      const coloredPct = `${pctColor}${pctStr}${reset}`;

      let rawTime = '';
      if (targetWin.resetTime) {
        const resetMs = new Date(targetWin.resetTime).getTime();
        const secsLeft = Math.max(0, Math.round((resetMs - now) / 1000));
        rawTime = `~${formatDuration(secsLeft)}`;
      }
      const timePart = rawTime.padEnd(6, ' ');
      const coloredTime = `${gray}${timePart}${reset}`;

      return `${coloredName} ${barPart} ${coloredPct} ${coloredTime}`;
    };

    const g5 = renderWindowItem('Google 5h', providerWindows.Google.fiveHour);
    const gw = renderWindowItem('Google week', providerWindows.Google.weekly);
    const c5 = renderWindowItem('Claude 5h', providerWindows.Claude.fiveHour);
    const cw = renderWindowItem('Claude week', providerWindows.Claude.weekly);

    const rows = [
      `  ${g5}   ${gray}${glyph.vbar}${reset} ${c5}`,
      `  ${gw}  ${gray}${glyph.vbar}${reset} ${cw}`,
    ];

    const dividerLine = `  ${gray}${glyph.hbar.repeat(81)}${reset}`;
    return `${dividerLine}\n` + rows.join('\n');
  };

  // Compact: provider-grouped mini bars based on the most constrained quota window.
  const renderCompactQuotaLine = (data, now = Date.now()) => {
    const groups = new Map();
    for (const q of data || []) {
      if (!q || isImageModel(q)) continue;
      const label = PROVIDER_LABELS[q.modelProvider] || 'Other';
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label).push(q);
    }
    const segments = [];
    for (const [provider, models] of groups) {
      // Family-level dedup: retain the most constrained model (lowest effective remaining fraction).
      const familyMap = new Map();
      for (const q of models) {
        const key = compactModelName(q.displayName || q.id);
        const critical = pickCriticalWindow(q?.windows, now) || q;
        const effFraction = typeof critical?.remainingFraction === 'number' ? critical.remainingFraction : 1;
        if (!familyMap.has(key)) {
          familyMap.set(key, { model: q, effFraction, critical });
        } else {
          const current = familyMap.get(key);
          if (effFraction < current.effFraction) {
            familyMap.set(key, { model: q, effFraction, critical });
          }
        }
      }
      const items = Array.from(familyMap.values()).map(({ model: q, critical }) => {
        const name = sanitizeTerminalText(compactModelName(q.displayName || q.id), 20);
        const pct = formatQuotaPercent(critical.remainingFraction);
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
    renderProviderQuotaTable,
    renderCompactQuotaLine,
  };
}

module.exports = {
  createQuotaRenderers,
};
