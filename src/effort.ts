import type { EffortFormatMode } from './config.ts';
import type { StdinData } from './types.ts';
import { displayLabel } from './utils/sanitize.ts';

export interface EffortInfo {
  level: string;
  symbol: string;
}

const SYMBOLS: Record<string, string> = {
  minimal: '·',
  low: '○',
  medium: '◔',
  high: '◑',
  xhigh: '◕',
  max: '●',
  thinking: '◈',
};

export function effortInfo(value: unknown): EffortInfo | null {
  const raw = displayLabel(value, 32).replace(/\s+thinking$/i, '').trim().toLowerCase();
  if (!raw) return null;
  const aliases: Record<string, string> = {
    h: 'high',
    m: 'medium',
    med: 'medium',
    tiered: 'medium',
    l: 'low',
    'extra-low': 'low',
    lite: 'low',
    min: 'minimal',
    xh: 'xhigh',
    th: 'thinking',
  };
  const level = aliases[raw] ?? raw;
  return { level, symbol: SYMBOLS[level] ?? '' };
}

export function resolveEffortLevel(
  effort: StdinData['effort'],
  ultracodeActive?: boolean,
  stdin?: StdinData,
): EffortInfo | null {
  const rawLevel =
    (typeof effort === 'string' ? effort : effort?.level) ??
    stdin?.model?.effort ??
    stdin?.model?.thinking_level ??
    stdin?.thinking_level ??
    stdin?.model?.reasoning_effort ??
    stdin?.reasoning_effort;
  const info = effortInfo(rawLevel);
  return info && ultracodeActive === true ? { ...info, level: `ultracode(${info.level})` } : info;
}

export function formatEffort(info: EffortInfo, format: EffortFormatMode | undefined): string {
  if (format === 'symbol' && info.symbol && !info.level.startsWith('ultracode(')) return info.symbol;
  return format === 'text' || !info.symbol ? info.level : `${info.symbol} ${info.level}`;
}
