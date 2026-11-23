import type { HudConfig } from './config.ts';
import type { ScopedUsageWindow, UsageData } from './types.ts';

export type UsagePace = 'normal' | 'warning' | 'critical';

export const FIVE_HOUR_WINDOW_MS = 5 * 60 * 60 * 1000;
export const SEVEN_DAY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const MIN_USED_PERCENT = 10;
const WARNING_PROJECTED_PERCENT = 90;
const CRITICAL_PROJECTED_PERCENT = 100;

export function getUsagePace(
  percent: number | null,
  resetAt: Date | null,
  windowMs: number,
  now: number = Date.now(),
): UsagePace | null {
  if (percent === null || !resetAt) return null;
  const remainingMs = resetAt.getTime() - now;
  if (!Number.isFinite(remainingMs) || remainingMs <= 0 || remainingMs >= windowMs) return null;
  if (percent < MIN_USED_PERCENT) return 'normal';
  const elapsedFraction = (windowMs - remainingMs) / windowMs;
  const projected = percent / elapsedFraction;
  if (projected > CRITICAL_PROJECTED_PERCENT) return 'critical';
  if (projected >= WARNING_PROJECTED_PERCENT) return 'warning';
  return 'normal';
}

export function isPaceAlert(pace: UsagePace | null): boolean {
  return pace === 'warning' || pace === 'critical';
}

export interface UsagePaces {
  fiveHour: UsagePace | null;
  sevenDay: UsagePace | null;
  scoped: Array<UsagePace | null>;
  alert: boolean;
  showSevenDay: boolean;
}

export function resolveUsagePaces(
  usage: UsageData,
  scopedWindows: ScopedUsageWindow[],
  display: Partial<HudConfig['display']> | undefined,
  now: number = Date.now(),
): UsagePaces {
  const enabled = display?.usagePace === true;
  const paceOf = (percent: number | null, resetAt: Date | null, windowMs: number): UsagePace | null =>
    enabled ? getUsagePace(percent, resetAt, windowMs, now) : null;

  const fiveHour = paceOf(usage.fiveHour, usage.fiveHourResetAt, FIVE_HOUR_WINDOW_MS);
  const sevenDay = paceOf(usage.sevenDay, usage.sevenDayResetAt, SEVEN_DAY_WINDOW_MS);
  const scoped = scopedWindows.map((w) => paceOf(w.percent, w.resetAt, SEVEN_DAY_WINDOW_MS));
  const sevenDayThreshold = display?.sevenDayThreshold ?? 80;

  return {
    fiveHour,
    sevenDay,
    scoped,
    alert: [fiveHour, sevenDay, ...scoped].some(isPaceAlert),
    showSevenDay: usage.sevenDay !== null && (usage.sevenDay >= sevenDayThreshold || isPaceAlert(sevenDay)),
  };
}
