import type { HudColorOverrides } from '../config.ts';
import type { MessageKey } from '../i18n/types.ts';
import { t } from '../i18n/index.ts';
import { label } from './colors.ts';
import { textWidth } from './ansi.ts';

const BAR_LABELS: MessageKey[] = ['label.context', 'label.usage', 'label.weekly'];

export interface LabelAlign {
  align?: boolean;
  includeMemoryInWidth?: boolean;
  includePromptCacheInWidth?: boolean;
}

export function barLabel(key: MessageKey, colors?: Partial<HudColorOverrides>, options: LabelAlign = {}): string {
  const text = t(key);
  if (!options.align) return label(text, colors);
  const keys = [...BAR_LABELS];
  if (options.includeMemoryInWidth) keys.push('label.approxRam');
  if (options.includePromptCacheInWidth) keys.push('label.promptCache');
  const pad = Math.max(...keys.map((k) => textWidth(t(k)))) - textWidth(text);
  return label(pad > 0 ? text + ' '.repeat(pad) : text, colors);
}
