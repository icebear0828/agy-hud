import type { RenderContext } from '../types.ts';

export interface Frame extends RenderContext {
  now: number;
  width: number | null;
  barWidth: number;
  unicode: boolean;
  sep: string;
}

export type Layout = 'expanded' | 'compact';

export function createFrame(ctx: RenderContext, columns: number | null, now: number): Frame {
  const maxWidth = ctx.config?.maxWidth ?? null;
  const width = ctx.config?.forceMaxWidth && maxWidth !== null ? maxWidth : columns ?? maxWidth;
  const barWidth = columns === null || columns >= 100 ? 10 : columns >= 60 ? 6 : 4;
  const unicodeCfg = ctx.config?.display?.unicode;
  const unicode = typeof unicodeCfg === 'boolean' ? unicodeCfg : (ctx.unicodeSupported ?? true);
  const sep = unicode ? ' │ ' : ' | ';
  return { ...ctx, now, width, barWidth, unicode, sep };
}
