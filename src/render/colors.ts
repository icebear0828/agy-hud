import type { HudColorName, HudColorValue, HudColorOverrides, UsageValueMode } from '../config.ts';
import { isPaceAlert, type UsagePace } from '../usage-pace.ts';

export const RESET = '\x1b[0m';

const DIM = '\x1b[2m';
const GRAY = '\x1b[90m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[34m';
const MAGENTA = '\x1b[35m';
const CYAN = '\x1b[36m';
const BRIGHT_BLUE = '\x1b[94m';
const BRIGHT_MAGENTA = '\x1b[95m';
const CLAUDE_ORANGE = '\x1b[38;5;208m';

const ANSI_BY_NAME: Record<HudColorName, string> = {
  dim: DIM,
  gray: GRAY,
  red: RED,
  green: GREEN,
  yellow: YELLOW,
  blue: BLUE,
  magenta: MAGENTA,
  cyan: CYAN,
  brightBlue: BRIGHT_BLUE,
  brightMagenta: BRIGHT_MAGENTA,
};

function hexToAnsi(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `\x1b[38;2;${r};${g};${b}m`;
}

export function resolveAnsi(value: HudColorValue | undefined, fallback: string): string {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'number') return `\x1b[38;5;${value}m`;
  if (typeof value === 'string' && value.startsWith('#') && value.length === 7) return hexToAnsi(value);
  return ANSI_BY_NAME[value as HudColorName] ?? fallback;
}

function colorize(text: string, color: string): string {
  return `${color}${text}${RESET}`;
}

function withOverride(text: string, value: HudColorValue | undefined, fallback: string): string {
  return colorize(text, resolveAnsi(value, fallback));
}

export const green = (text: string): string => colorize(text, GREEN);
export const yellow = (text: string): string => colorize(text, YELLOW);
export const red = (text: string): string => colorize(text, RED);
export const cyan = (text: string): string => colorize(text, CYAN);
export const magenta = (text: string): string => colorize(text, MAGENTA);
export const dim = (text: string): string => colorize(text, DIM);

export const model = (text: string, colors?: Partial<HudColorOverrides>): string => withOverride(text, colors?.model, CYAN);
export const project = (text: string, colors?: Partial<HudColorOverrides>): string => withOverride(text, colors?.project, YELLOW);
export const git = (text: string, colors?: Partial<HudColorOverrides>): string => withOverride(text, colors?.git, MAGENTA);
export const gitBranch = (text: string, colors?: Partial<HudColorOverrides>): string => withOverride(text, colors?.gitBranch, CYAN);
export const label = (text: string, colors?: Partial<HudColorOverrides>): string => withOverride(text, colors?.label, DIM);
export const custom = (text: string, colors?: Partial<HudColorOverrides>): string => withOverride(text, colors?.custom, CLAUDE_ORANGE);
export const warning = (text: string, colors?: Partial<HudColorOverrides>): string => colorize(text, resolveAnsi(colors?.warning, YELLOW));
export const critical = (text: string, colors?: Partial<HudColorOverrides>): string => colorize(text, resolveAnsi(colors?.critical, RED));

interface ContextThresholds {
  warning?: number;
  critical?: number;
}

export function getContextColor(
  percent: number,
  colors?: Partial<HudColorOverrides>,
  thresholds?: ContextThresholds,
): string {
  const crit = thresholds?.critical ?? 85;
  const warn = thresholds?.warning ?? 70;
  if (percent >= crit) return resolveAnsi(colors?.critical, RED);
  if (percent >= warn) return resolveAnsi(colors?.warning, YELLOW);
  return resolveAnsi(colors?.context, GREEN);
}

export function getQuotaColor(
  percent: number,
  colors?: Partial<HudColorOverrides>,
  pace: UsagePace | null = null,
): string {
  if (percent >= 90 || pace === 'critical') return resolveAnsi(colors?.critical, RED);
  if (percent >= 75 || pace === 'warning') return resolveAnsi(colors?.usageWarning, BRIGHT_MAGENTA);
  return resolveAnsi(colors?.usage, BRIGHT_BLUE);
}

export function truncateTwoDecimals(valuePercent: number): number {
  if (!Number.isFinite(valuePercent)) return 0;
  const clamped = Math.min(100, Math.max(0, valuePercent));
  return Math.floor(Math.round(clamped * 1e4) / 100) / 100;
}

export function formatQuotaPercent(
  percent: number | null,
  colors?: Partial<HudColorOverrides>,
  mode: UsageValueMode = 'percent',
  pace: UsagePace | null = null,
  exactRemaining: number | null = null,
  decimals = false,
  unicode = true,
): string {
  if (percent === null) return label('--', colors);
  const color = getQuotaColor(percent, colors, pace);
  let displayStr: string;
  if (mode === 'remaining') {
    if (decimals && exactRemaining !== null) {
      displayStr = `${truncateTwoDecimals(exactRemaining).toFixed(2)}%`;
    } else {
      displayStr = `${Math.max(0, 100 - percent)}%`;
    }
  } else if (decimals && exactRemaining !== null) {
    displayStr = `${truncateTwoDecimals(100 - exactRemaining).toFixed(2)}%`;
  } else {
    displayStr = `${percent}%`;
  }
  const tri = unicode ? '▲' : '^';
  const marker = isPaceAlert(pace) ? ` ${colorize(tri, getQuotaColor(0, colors, pace))}` : '';
  return `${color}${displayStr}${RESET}${marker}`;
}

function resolveBarChars(colors?: Partial<HudColorOverrides>, unicode = true): { filled: string; empty: string } {
  const defaultFilled = unicode ? '█' : '#';
  const defaultEmpty = unicode ? '░' : '-';
  const filled = !unicode && (!colors?.barFilled || colors.barFilled === '█') ? defaultFilled : (colors?.barFilled ?? defaultFilled);
  const empty = !unicode && (!colors?.barEmpty || colors.barEmpty === '░') ? defaultEmpty : (colors?.barEmpty ?? defaultEmpty);
  return { filled, empty };
}

function renderBar(
  fillPercent: number,
  color: string,
  width = 10,
  colors?: Partial<HudColorOverrides>,
  unicode = true,
): string {
  const safeWidth = Number.isFinite(width) ? Math.max(0, Math.round(width)) : 0;
  const safePercent = Number.isFinite(fillPercent) ? Math.min(100, Math.max(0, fillPercent)) : 0;
  const filled = Math.round((safePercent / 100) * safeWidth);
  const empty = safeWidth - filled;
  const chars = resolveBarChars(colors, unicode);
  return `${color}${chars.filled.repeat(filled)}${DIM}${chars.empty.repeat(empty)}${RESET}`;
}

export function quotaBar(
  percent: number,
  width = 10,
  colors?: Partial<HudColorOverrides>,
  pace: UsagePace | null = null,
  unicode = true,
): string {
  const safePercent = Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : 0;
  return renderBar(safePercent, getQuotaColor(safePercent, colors, pace), width, colors, unicode);
}

export function remainingQuotaBar(
  remainingPercent: number,
  usedPercent: number,
  width = 10,
  colors?: Partial<HudColorOverrides>,
  pace: UsagePace | null = null,
  unicode = true,
): string {
  return renderBar(remainingPercent, getQuotaColor(usedPercent, colors, pace), width, colors, unicode);
}

export function coloredBar(
  percent: number,
  width = 10,
  colors?: Partial<HudColorOverrides>,
  thresholds?: ContextThresholds,
  unicode = true,
): string {
  const safePercent = Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : 0;
  return renderBar(safePercent, getContextColor(safePercent, colors, thresholds), width, colors, unicode);
}
