import { setLanguage } from '../i18n/index.ts';
import type { RenderContext } from '../types.ts';
import { wrapToWidth } from './ansi.ts';
import { renderCompact } from './compact.ts';
import { renderExpanded } from './expanded.ts';
import { createFrame } from './frame.ts';

const NO_BREAK_SPACE = /\u00A0/g;

export function render(ctx: RenderContext, columns: number | null = null, now = Date.now()): string {
  setLanguage(ctx.config?.language ?? 'en');
  const frame = createFrame(ctx, columns, now);
  const rawLines = frame.config?.lineLayout === 'compact' ? renderCompact(frame) : renderExpanded(frame);
  const lines = frame.width !== null && frame.width > 0
    ? rawLines.flatMap((line) => wrapToWidth(line, frame.width!))
    : rawLines;
  return lines.map((line) => line.replace(/ /g, '\u00A0')).join('\n');
}

export function renderPlain(ctx: RenderContext, columns: number | null = null, now = Date.now()): string {
  return render(ctx, columns, now).replace(NO_BREAK_SPACE, ' ');
}
