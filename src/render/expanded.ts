import type { FirstLineSegment, HudElement } from '../config.ts';
import { DEFAULT_ELEMENT_ORDER, DEFAULT_MERGE_GROUPS, UNMERGEABLE_ELEMENTS } from '../config.ts';
import type { Frame } from './frame.ts';
import { dim, label } from './colors.ts';
import { visibleWidth, separatorLine } from './ansi.ts';
import { contextLine } from './context.ts';
import type { LabelAlign } from './labels.ts';
import { orderParts } from './order.ts';
import { outputStyle } from './derive.ts';
import {
  advisorPart,
  authPart,
  costPart,
  customLinePart,
  durationPart,
  extraPart,
  modelBadge,
  modePart,
  projectParts,
  sessionNamePart,
  speedPart,
  stepsPart,
  tierPart,
  updatePart,
  versionPart,
  type Part,
} from './parts.ts';
import {
  addedDirsLine,
  cacheHitRateLine,
  compactionsLine,
  environmentLine,
  imageQuotaLine,
  memoryLine,
  promptCacheLine,
  sessionTimeLine,
  sessionTokensLine,
} from './lines.ts';
import { agentLines, mcpLine, skillsLine, todosLine, toolsLine } from './activity.ts';
import { agyQuotaExtraLines } from './quota-table.ts';
import { usageParts } from './usage.ts';
import { gitFilesLine } from './vcs.ts';

const ACTIVITY_ELEMENTS = new Set<HudElement>(['tools', 'skills', 'mcp', 'agents', 'todos', 'sessionTokens']);

function firstLine(f: Frame, costSeparate: boolean, envVisible: boolean): string[] {
  const display = f.config?.display;
  const parts: Part[] = [];

  if (display?.showModel !== false) {
    parts.push({ key: 'model', text: modelBadge(f) });
  }
  for (const p of projectParts(f, 'expanded')) {
    parts.push({ key: 'project', text: p });
  }

  const style = !envVisible && display?.showOutputStyle === true ? outputStyle(f) : undefined;
  if (style) {
    parts.push({ key: null, text: label(`style: ${style}`, f.config?.colors) });
  }

  const optional: Array<[FirstLineSegment, string | null]> = [
    ['advisor', advisorPart(f)],
    ['sessionName', sessionNamePart(f)],
    ['version', versionPart(f)],
    ['extra', extraPart(f)],
    ['duration', durationPart(f)],
    ['cost', costSeparate ? null : costPart(f)],
    ['speed', speedPart(f)],
    ['auth', authPart(f)],
  ];
  for (const [key, text] of optional) {
    if (text) parts.push({ key, text });
  }

  const agyExtras = [modePart(f), tierPart(f), stepsPart(f), updatePart(f)].filter((p): p is string => Boolean(p));
  for (const text of agyExtras) {
    parts.push({ key: null, text });
  }

  const order = f.config?.projectLineOrder ?? [];
  const ordered = order.length > 0 ? orderParts(parts, order) : parts.map((p) => p.text);
  const filtered = ordered.filter(Boolean);

  const lines: string[] = [];
  if (filtered.length > 0) lines.push(filtered.join(f.sep));
  const files = gitFilesLine(f);
  if (files) lines.push(files);
  return lines;
}

function renderSingleElement(f: Frame, element: HudElement, align: LabelAlign, costSeparate: boolean, envVisible: boolean): string[] {
  switch (element) {
    case 'project':
      return firstLine(f, costSeparate, envVisible);
    case 'addedDirs': {
      const line = addedDirsLine(f);
      return line ? [line] : [];
    }
    case 'context':
      return [contextLine(f, align)];
    case 'usage':
      return usageParts(f, 'expanded', align) ?? [];
    case 'promptCache': {
      const line = promptCacheLine(f, align);
      return line ? [line] : [];
    }
    case 'cacheHitRate': {
      const line = cacheHitRateLine(f);
      return line ? [line] : [];
    }
    case 'memory': {
      const line = memoryLine(f, align);
      return line ? [line] : [];
    }
    case 'environment': {
      const line = environmentLine(f);
      return line ? [line] : [];
    }
    case 'tools': {
      const line = toolsLine(f);
      return line ? [line] : [];
    }
    case 'skills': {
      const line = skillsLine(f);
      return line ? [line] : [];
    }
    case 'mcp': {
      const line = mcpLine(f);
      return line ? [line] : [];
    }
    case 'agents':
      return agentLines(f);
    case 'todos': {
      const line = todosLine(f);
      return line ? [line] : [];
    }
    case 'sessionTime': {
      const line = sessionTimeLine(f);
      return line ? [line] : [];
    }
    case 'sessionTokens': {
      const tok = sessionTokensLine(f);
      const comp = compactionsLine(f);
      return [tok, comp].filter((l): l is string => Boolean(l));
    }
    case 'cost': {
      const part = costPart(f);
      return part ? [part] : [];
    }
    default:
      return [];
  }
}

function formatMergedRow(f: Frame, segments: Array<{ element: HudElement; text: string }>, rightSet: Set<HudElement>): string {
  const left = segments.filter((s) => !rightSet.has(s.element)).map((s) => s.text);
  const right = segments.filter((s) => rightSet.has(s.element)).map((s) => s.text);
  const leftText = left.join(f.sep);
  const rightText = right.join(f.sep);

  if (!rightText) return leftText;
  if (!leftText) return rightText;
  if (f.width === null) return `${leftText}${f.sep}${rightText}`;

  const gap = f.width - visibleWidth(leftText) - visibleWidth(rightText);
  return gap >= 2 ? `${leftText}${' '.repeat(gap)}${rightText}` : `${leftText}${f.sep}${rightText}`;
}

export function renderExpanded(f: Frame): string[] {
  const display = f.config?.display;
  const order = f.config?.elementOrder?.length ? f.config.elementOrder : DEFAULT_ELEMENT_ORDER;
  const mergeGroups = display?.mergeGroups ?? DEFAULT_MERGE_GROUPS;
  const rightSet = new Set<HudElement>(display?.rightAlign ?? []);
  const envVisible = Boolean(order.includes('environment') && environmentLine(f));
  const align: LabelAlign = {
    align: display?.showMemoryUsage === true || display?.showPromptCache === true,
    includeMemoryInWidth: display?.showMemoryUsage === true,
    includePromptCacheInWidth: display?.showPromptCache === true,
  };
  const groupByElement = new Map<HudElement, HudElement[]>();
  for (const rawGroup of mergeGroups) {
    if (!Array.isArray(rawGroup)) continue;
    const group = [...new Set(rawGroup.filter((member) => !UNMERGEABLE_ELEMENTS.has(member) && !groupByElement.has(member)))];
    if (group.length < 2) continue;
    for (const member of group) {
      groupByElement.set(member, group);
    }
  }

  const costSeparate = order.includes('cost') || groupByElement.has('cost');

  const emitted = new Set<HudElement>();
  const primaryLines: string[] = [];
  const activityLines: string[] = [];

  for (const element of order) {
    if (emitted.has(element)) continue;

    const group = groupByElement.get(element);
    if (group && !UNMERGEABLE_ELEMENTS.has(element)) {
      const rowSegments: Array<{ element: HudElement; text: string }> = [];
      let allActivity = true;
      for (const member of group) {
        if (emitted.has(member)) continue;
        emitted.add(member);
        if (!ACTIVITY_ELEMENTS.has(member)) allActivity = false;
        const rendered = renderSingleElement(f, member, align, costSeparate, envVisible);
        if (rendered.length > 0) {
          rowSegments.push({ element: member, text: rendered.join(f.sep) });
        }
      }
      if (rowSegments.length > 0) {
        const line = formatMergedRow(f, rowSegments, rightSet);
        (allActivity ? activityLines : primaryLines).push(line);
      }
      continue;
    }

    emitted.add(element);
    const rendered = renderSingleElement(f, element, align, costSeparate, envVisible);
    if (rendered.length === 0) continue;

    if (element === 'project') {
      primaryLines.push(...rendered);
      continue;
    }

    if (element === 'sessionTokens' || element === 'agents') {
      for (const r of rendered) activityLines.push(r);
      continue;
    }

    const row = rendered.join(f.sep);
    const alignedRow = rightSet.has(element) && f.width !== null && f.width > visibleWidth(row)
      ? `${' '.repeat(f.width - visibleWidth(row))}${row}`
      : row;

    if (ACTIVITY_ELEMENTS.has(element)) {
      activityLines.push(alignedRow);
    } else {
      primaryLines.push(alignedRow);
    }
  }

  const quotaExtras = agyQuotaExtraLines(f);
  const imgLine = imageQuotaLine(f);

  const lines: string[] = [];
  const firstCustom = customLinePart(f, 'first');
  if (firstCustom) lines.push(firstCustom);

  lines.push(...primaryLines);
  lines.push(...quotaExtras);
  if (imgLine) lines.push(imgLine);

  if (f.config?.showSeparators && lines.length > 0 && activityLines.length > 0) {
    const sepWidth = Math.max(12, Math.min(f.width ?? 40, 48));
    lines.push(dim(separatorLine(sepWidth, f.unicode)));
  }
  lines.push(...activityLines);

  const lastCustom = customLinePart(f, 'last');
  if (lastCustom) lines.push(lastCustom);

  return lines.filter(Boolean);
}
