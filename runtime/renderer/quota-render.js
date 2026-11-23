'use strict';

const {
  PROVIDER_LABELS,
  LANGUAGE_TEXT,
} = require('./lang.js');
const {
  simplifyModelName,
  compactModelName,
  sanitizeTerminalText,
  formatTokens,
  formatDuration,
  formatQuotaPercent,
} = require('./format.js');
const { pickCriticalWindow, classifyQuotaWindow, isObservationExpired } = require('../quota/models.js');

const ANSI_STRIP_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const MAX_CAPACITY_LINE_COLS = 78;

/**
 * Estimate visible terminal column width (CJK / wide chars = 2, others = 1).
 * @param {string} str
 * @returns {number}
 */
function visibleColumnWidth(str) {
  const clean = String(str || '').replace(ANSI_STRIP_RE, '');
  let width = 0;
  for (const ch of clean) {
    const code = ch.codePointAt(0);
    if (
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe10 && code <= 0xfe19) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6)
    ) {
      width += 2;
    } else {
      width += 1;
    }
  }
  return width;
}

function formatCalibratingPercent(fraction) {
  const pct = Math.max(0, (Number(fraction) || 0) * 100);
  return pct.toFixed(1).replace(/\.0$/, '');
}

/**
 * Render the 5h & Weekly Quota Capacity Estimate line for table / models modes.
 * Returns empty string when idle/uncalibrated so existing layouts add 0 extra lines.
 *
 * @param {Object|null} quotaCapacity
 * @param {Object} ctx
 * @returns {string}
 */
function renderQuotaCapacityLine(quotaCapacity, ctx) {
  if (!quotaCapacity || typeof quotaCapacity !== 'object') return '';

  const five = quotaCapacity.fiveHour || null;
  const week = quotaCapacity.weekly || null;
  const hasReady = five?.status === 'ready' || week?.status === 'ready';
  const hasCalibrating = five?.status === 'calibrating' || week?.status === 'calibrating';

  if (!hasReady && !hasCalibrating) return '';

  const colors = ctx?.colors || {};
  const cyan = colors.cyan || '';
  const reset = colors.reset || '';
  const gray = colors.gray || '';
  const red = colors.red || '';
  const yellow = colors.yellow || '';
  const dim = colors.dim || '';
  const glyph = ctx?.glyph || { vbar: '│', ellipsis: '…' };
  const thresholds = ctx?.thresholds || { warnThresh: 0.7, critThresh: 0.9 };
  const unicode = ctx?.unicode !== undefined ? Boolean(ctx.unicode) : glyph.vbar === '│';
  const text = ctx?.text || LANGUAGE_TEXT.en;

  const approx = unicode ? '≈' : '~';
  const estLabel = text.estLabel || 'Est';
  const fiveShort = text.fiveHourShort || '5h';
  const weekShort = text.weekShort || 'week';
  const tokUnit = text.tokUnit || 'tok';
  const calibratingLabel = text.estCalibrating || 'calibrating';

  let modelLabel = sanitizeTerminalText(quotaCapacity.modelName || quotaCapacity.bucket || '', 24);

  const buildLine = (label) => {
    const labelSegment = label ? ` (${cyan}${label}${gray})` : '';
    const prefix = `  ${gray}${approx} ${estLabel}${labelSegment}:${reset} `;

    if (!hasReady && hasCalibrating) {
      let target = null;
      if (five?.status === 'calibrating' && week?.status === 'calibrating') {
        const fiveRatio = (five.observedDeltaQ || 0) / (five.minDeltaQ || 0.02);
        const weekRatio = (week.observedDeltaQ || 0) / (week.minDeltaQ || 0.01);
        target = fiveRatio >= weekRatio ? five : week;
      } else {
        target = five?.status === 'calibrating' ? five : week;
      }
      const obsPct = formatCalibratingPercent(target.observedDeltaQ);
      const minPct = formatCalibratingPercent(target.minDeltaQ || 0.02);
      return `${prefix}${gray}${calibratingLabel} (${obsPct}%/${minPct}%)${reset}`;
    }

    const formatWindowSegment = (winLabel, win) => {
      if (!win || win.status !== 'ready') {
        return `${gray}${winLabel} --${reset}`;
      }
      const totalStr = formatTokens(win.totalTokens || 0);
      const star = win.isPrior ? `${dim}*${reset}` : '';
      if (win.exhausted || win.remainingTokens === 0) {
        return `${gray}${winLabel} ${red}0${gray}/${totalStr} ${tokUnit}${star}${reset}`;
      }
      const remStr = formatTokens(win.remainingTokens || 0);
      const pct = Number.isFinite(win.remainingFraction) ? win.remainingFraction * 100 : 100;
      const valColor = pct <= (1 - thresholds.critThresh) * 100
        ? red
        : pct <= (1 - thresholds.warnThresh) * 100
          ? yellow
          : gray;
      return `${gray}${winLabel} ${valColor}~${remStr}${gray}/${totalStr} ${tokUnit}${star}${reset}`;
    };

    const fivePart = formatWindowSegment(fiveShort, five);
    const weekPart = formatWindowSegment(weekShort, week);
    return `${prefix}${fivePart} ${gray}${glyph.vbar}${reset} ${weekPart}`;
  };

  let line = buildLine(modelLabel);
  // Enforce <= 78 visible columns by trimming modelLabel if necessary.
  while (modelLabel.length > 4 && visibleColumnWidth(line) > MAX_CAPACITY_LINE_COLS) {
    const excess = visibleColumnWidth(line) - MAX_CAPACITY_LINE_COLS;
    const ellipsis = glyph.ellipsis || '...';
    const nextLen = Math.max(1, modelLabel.length - Math.max(1, excess) - ellipsis.length);
    modelLabel = modelLabel.slice(0, nextLen).trimEnd() + ellipsis;
    line = buildLine(modelLabel);
    if (modelLabel.endsWith(ellipsis) && visibleColumnWidth(line) > MAX_CAPACITY_LINE_COLS) {
      modelLabel = modelLabel.slice(0, Math.max(1, nextLen - 1)).trimEnd() + ellipsis;
      line = buildLine(modelLabel);
      break;
    }
  }

  return line;
}

/**
 * Build the quota-rendering closures bound to a single renderHUD invocation's
 * configuration. Renders each model as a single line "name [bar] pct ~time"
 * and pairs lines into 2 columns at the call site.
 *
 * @param {Object} ctx
 * @param {Object} ctx.colors  { cyan, reset, gray, red, yellow, green, dim }
 * @param {Object} ctx.glyph   { bar, empty, vbar, hbar, ellipsis }
 * @param {Object} ctx.thresholds  { warnThresh, critThresh }
 * @param {number} ctx.nameWidth
 * @param {string} ctx.divider
 * @param {Function} ctx.createProgressBar  (percent, color, width, isUsage) => string
 * @param {Function} ctx.truncateAndPad     (str, width) => string
 * @param {Object} [ctx.text]
 * @param {boolean} [ctx.unicode]
 */
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
      if (Number.isFinite(resetMs)) {
        const secsLeft = Math.max(0, Math.round((resetMs - now) / 1000));
        const formatted = formatDuration(secsLeft);
        if (formatted) rawTime = `~${formatted}`;
      }
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
      Argon: { fiveHour: null, weekly: null },
    };

    for (const q of data || []) {
      if (!q || isImageModel(q)) continue;
      const isArgon = /argon/i.test(q.id || q.displayName);
      const isGoogle = !isArgon && (q.modelProvider === 'MODEL_PROVIDER_GOOGLE' || /gemini/i.test(q.id || q.displayName));
      const isClaude = q.modelProvider === 'MODEL_PROVIDER_ANTHROPIC' || /claude/i.test(q.id || q.displayName) || /gpt/i.test(q.id || q.displayName);
      const key = isArgon ? 'Argon' : isGoogle ? 'Google' : isClaude ? 'Claude' : null;
      if (!key) continue;

      if (q.windows?.fiveHour && !isObservationExpired(q.windows.fiveHour, now)) {
        const cur = providerWindows[key].fiveHour;
        const win = q.windows.fiveHour;
        if (!cur || (win.observedAt || 0) > (cur.observedAt || 0) ||
            ((win.observedAt || 0) === (cur.observedAt || 0) && win.remainingFraction < cur.remainingFraction)) {
          providerWindows[key].fiveHour = win;
        }
      }
      if (q.windows?.weekly && !isObservationExpired(q.windows.weekly, now)) {
        const cur = providerWindows[key].weekly;
        const win = q.windows.weekly;
        if (!cur || (win.observedAt || 0) > (cur.observedAt || 0) ||
            ((win.observedAt || 0) === (cur.observedAt || 0) && win.remainingFraction < cur.remainingFraction)) {
          providerWindows[key].weekly = win;
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
        if (!providerWindows[key].fiveHour && key !== 'Argon') {
          providerWindows[key].fiveHour = { remainingFraction: q.remainingFraction, resetTime: null };
        }
        if (!providerWindows[key].weekly) {
          providerWindows[key].weekly = { remainingFraction: q.remainingFraction, resetTime: null };
        }
      }
    }

    // Provider summaries are authoritative and must win over model-derived data.
    const pq = data?.providerQuota;
    if (pq && typeof pq === 'object') {
      if (pq.google?.fiveHour && !isObservationExpired(pq.google.fiveHour, now)) providerWindows.Google.fiveHour = pq.google.fiveHour;
      if (pq.google?.weekly && !isObservationExpired(pq.google.weekly, now)) providerWindows.Google.weekly = pq.google.weekly;
      if (pq.claude?.fiveHour && !isObservationExpired(pq.claude.fiveHour, now)) providerWindows.Claude.fiveHour = pq.claude.fiveHour;
      if (pq.claude?.weekly && !isObservationExpired(pq.claude.weekly, now)) providerWindows.Claude.weekly = pq.claude.weekly;
      if (pq.argon?.fiveHour && !isObservationExpired(pq.argon.fiveHour, now)) providerWindows.Argon.fiveHour = pq.argon.fiveHour;
      if (pq.argon?.weekly && !isObservationExpired(pq.argon.weekly, now)) providerWindows.Argon.weekly = pq.argon.weekly;
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
        if (Number.isFinite(resetMs)) {
          const secsLeft = Math.max(0, Math.round((resetMs - now) / 1000));
          const formatted = formatDuration(secsLeft);
          if (formatted) rawTime = `~${formatted}`;
        }
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
      `  ${g5} ${gray}${glyph.vbar}${reset} ${c5}`,
      `  ${gw} ${gray}${glyph.vbar}${reset} ${cw}`,
    ];

    const hasArgon = Boolean(providerWindows.Argon.weekly || providerWindows.Argon.fiveHour);
    if (hasArgon) {
      if (providerWindows.Argon.fiveHour && providerWindows.Argon.weekly) {
        const a5 = renderWindowItem('Argon 5h', providerWindows.Argon.fiveHour);
        const aw = renderWindowItem('Argon week', providerWindows.Argon.weekly);
        rows.push(`  ${a5} ${gray}${glyph.vbar}${reset} ${aw}`);
      } else {
        const argonLabel = providerWindows.Argon.weekly ? 'Argon week' : 'Argon 5h';
        const aw = renderWindowItem(argonLabel, providerWindows.Argon.weekly || providerWindows.Argon.fiveHour);
        rows.push(`  ${aw}`);
      }
    }

    // 2 columns of 32 chars + 3-char separator (" | ") = 67 chars (fits 80-col terminals)
    const dividerLine = `  ${gray}${glyph.hbar.repeat(67)}${reset}`;
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
    renderQuotaCapacityLine: (quotaCapacity) => renderQuotaCapacityLine(quotaCapacity, ctx),
  };
}

module.exports = {
  createQuotaRenderers,
  renderQuotaCapacityLine,
  visibleColumnWidth,
};
