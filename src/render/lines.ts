import { t } from '../i18n/index.ts';
import type { AgyModelQuota } from '../types.ts';
import { formatTokens } from '../utils/format.ts';
import { sanitizeDisplayText } from '../utils/sanitize.ts';
import type { Frame } from './frame.ts';
import { critical, cyan, dim, getContextColor, getQuotaColor, green, label, quotaBar, RESET, warning, yellow } from './colors.ts';
import { outputStyle } from './derive.ts';
import { barLabel, type LabelAlign } from './labels.ts';
import { addedDirs, compactionsPart, configCountParts, sessionTokensSummary } from './parts.ts';
import { formatAbsoluteTime, formatResetTime, wallClock } from './time.ts';

const FIVE_MINUTES_MS = 5 * 60 * 1000;

function formatBytes(bytes: number): string {
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = Math.max(0, Math.round(bytes / (1024 * 1024)));
  return `${mb} MB`;
}

export function environmentLine(f: Frame): string | null {
  const errors = f.transcript?.mcpErrors ?? [];
  const warnSym = f.unicode ? '⚠' : '!';
  const mcpSuffix = errors.length > 0
    ? ` ${warning(`${warnSym} ${sanitizeDisplayText(errors[0])}${errors.length > 1 ? ` +${errors.length - 1}` : ''}`, f.config?.colors)}`
    : '';
  const parts = configCountParts(f, mcpSuffix);
  if (parts.length === 0) return null;
  const style = f.config?.display?.showOutputStyle === true ? outputStyle(f) : undefined;
  if (style) parts.push(label(`style: ${style}`, f.config?.colors));
  return parts.join(f.sep);
}

export function addedDirsLine(f: Frame): string | null {
  const display = f.config?.display;
  if (display?.showAddedDirs === false || (display?.addedDirsLayout ?? 'inline') !== 'line') return null;
  return addedDirs(f, '+', f.sep);
}

function resolvePromptCache(f: Frame): { warm: boolean; ttl?: string; expiresAtMs?: number; hitRatio?: number } | null {
  const explicit = f.stdin.prompt_cache;
  if (explicit) {
    const expiresAtMs = typeof explicit.expires_at === 'number' && Number.isFinite(explicit.expires_at)
      ? (explicit.expires_at < 1e12 ? explicit.expires_at * 1000 : explicit.expires_at)
      : undefined;
    return {
      warm: Boolean(explicit.warm),
      ttl: explicit.ttl,
      expiresAtMs,
      hitRatio: typeof explicit.hit_ratio === 'number' && Number.isFinite(explicit.hit_ratio) ? explicit.hit_ratio : undefined,
    };
  }
  const cuCache = (f.stdin.context_window?.current_usage?.cache_read_input_tokens ?? 0) + (f.stdin.context_window?.current_usage?.cache_creation_input_tokens ?? 0);
  const txCache = (f.transcript?.lastTurnUsage?.cacheReadTokens ?? 0) + (f.transcript?.lastTurnUsage?.cacheCreationTokens ?? 0);
  const lastReply = f.transcript?.lastAssistantResponseAt?.getTime();
  if ((cuCache > 0 || txCache > 0) && lastReply && Number.isFinite(lastReply)) {
    const expiresAtMs = lastReply + FIVE_MINUTES_MS;
    if (f.now - lastReply <= 60 * 60 * 1000) {
      return { warm: expiresAtMs > f.now, expiresAtMs };
    }
  }
  return null;
}

export function promptCacheLine(f: Frame, align: LabelAlign = {}): string | null {
  const display = f.config?.display;
  if (display?.showPromptCache !== true) return null;
  const cache = resolvePromptCache(f);
  if (!cache) return null;

  const colors = f.config?.colors;
  const prefix = barLabel('label.promptCache', colors, align);
  const clock = f.unicode ? '⏱ ' : '';
  const details: string[] = [];

  if (cache.expiresAtMs !== undefined) {
    if (cache.expiresAtMs <= f.now) {
      details.push(warning(t('status.expired'), colors));
    } else {
      details.push(label(`${clock}${formatAbsoluteTime(new Date(cache.expiresAtMs), new Date(f.now), wallClock(display), 'format.untilTime')}`, colors));
    }
  } else {
    details.push(cache.warm ? green('warm') : dim('cold'));
  }

  if (cache.ttl) details.push(label(sanitizeDisplayText(cache.ttl), colors));
  if (cache.hitRatio !== undefined) details.push(label(`${Math.round(cache.hitRatio * 100)}%`, colors));
  return `${prefix} ${details.join(' ')}`;
}

export function cacheHitRateLine(f: Frame): string | null {
  const display = f.config?.display;
  if (display?.showCacheHitRate !== true) return null;
  const cu = f.stdin.context_window?.current_usage;
  const tu = f.transcript?.lastTurnUsage;
  const input = cu ? (cu.input_tokens ?? 0) : (tu?.inputTokens ?? 0);
  const creation = cu ? (cu.cache_creation_input_tokens ?? 0) : (tu?.cacheCreationTokens ?? 0);
  const read = cu ? (cu.cache_read_input_tokens ?? 0) : (tu?.cacheReadTokens ?? 0);
  const total = input + creation + read;
  if (total <= 0) return null;

  const pct = Math.round((read / total) * 100);
  const colors = f.config?.colors;
  const excellent = display.cacheHitExcellentThreshold ?? 80;
  const partial = display.cacheHitPartialThreshold ?? 50;
  const pctText = pct >= excellent ? green(`${pct}%`) : pct >= partial ? yellow(`${pct}%`) : dim(`${pct}%`);
  return `${label(`${t('label.cacheHitRate')}:`, colors)} ${pctText} ${dim(`(${formatTokens(read)}/${formatTokens(total)})`)}`;
}

export function memoryLine(f: Frame, align: LabelAlign = {}): string | null {
  const display = f.config?.display;
  if (display?.showMemoryUsage !== true || !f.memoryUsage) return null;
  const { usedBytes, totalBytes, usedPercent } = f.memoryUsage;
  const colors = f.config?.colors;
  const prefix = barLabel('label.approxRam', colors, align);
  const bar = quotaBar(usedPercent, f.barWidth, colors, null, f.unicode);
  const pct = `${getContextColor(usedPercent, colors)}${Math.round(usedPercent)}%${RESET}`;
  return `${prefix} ${bar} ${pct} ${dim(`(${formatBytes(usedBytes)} / ${formatBytes(totalBytes)})`)}`;
}

export function sessionTimeLine(f: Frame): string | null {
  const display = f.config?.display;
  const wc = wallClock(display);
  const colors = f.config?.colors;
  const parts: string[] = [];
  if (display?.showSessionStartDate === true && f.transcript?.sessionStart) {
    const abs = formatAbsoluteTime(f.transcript.sessionStart, new Date(f.now), wc);
    if (abs) parts.push(`${label(`${t('label.sessionStarted')}:`, colors)} ${abs}`);
  }
  if (display?.showLastResponseAt === true && f.transcript?.lastAssistantResponseAt) {
    const abs = formatAbsoluteTime(f.transcript.lastAssistantResponseAt, new Date(f.now), wc);
    if (abs) parts.push(`${label(`${t('label.lastReply')}:`, colors)} ${abs}`);
  }
  return parts.length > 0 ? parts.join(f.sep) : null;
}

export function sessionTokensLine(f: Frame): string | null {
  if (f.config?.display?.showSessionTokens !== true) return null;
  return sessionTokensSummary(f, t('label.tokens'));
}

export function compactionsLine(f: Frame): string | null {
  return compactionsPart(f);
}

function isImageModel(q: AgyModelQuota): boolean {
  return Boolean(q.id?.includes('image') || q.displayName?.toLowerCase().includes('image'));
}

export function imageQuotaLine(f: Frame): string | null {
  if (f.config?.display?.showImageQuota !== true) return null;
  const colors = f.config?.colors;
  const exhausted = f.transcript?.imageExhausted;
  if (exhausted?.exhausted) {
    const resetPart = exhausted.resetTime ? ` (${sanitizeDisplayText(exhausted.resetTime)})` : '';
    return `${label(`${t('label.imageQuota')}:`, colors)} ${critical(t('status.imageExhausted') + resetPart, colors)}`;
  }
  const imgModel = f.agyQuota?.models?.find(isImageModel);
  if (!imgModel) return null;
  const remaining = Math.floor(Math.min(1, Math.max(0, imgModel.remainingFraction)) * 100);
  const used = 100 - remaining;
  const color = getQuotaColor(used, colors, null);
  const bar = quotaBar(used, f.barWidth, colors, null, f.unicode);
  const name = cyan(sanitizeDisplayText(imgModel.displayName || imgModel.id));
  const reset = imgModel.resetTime
    ? formatResetTime(new Date(Date.parse(imgModel.resetTime)), 'relative', wallClock(f.config.display), f.now)
    : '';
  return `${label(`${t('label.imageQuota')}:`, colors)} ${name} ${bar} ${color}${remaining}%${RESET}${reset ? dim(` (${reset})`) : ''}`;
}
