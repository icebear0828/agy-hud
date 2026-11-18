import { t } from '../i18n/index.ts';
import type { Frame } from './frame.ts';
import { outputStyle } from './derive.ts';
import { label } from './colors.ts';
import { contextBarAndValue, tokenBreakdown } from './context.ts';
import {
  addedDirs,
  advisorPart,
  authPart,
  configCountParts,
  costPart,
  customLinePart,
  durationPart,
  extraPart,
  modelBadge,
  modePart,
  projectParts,
  sessionNamePart,
  sessionTokensSummary,
  speedPart,
  stepsPart,
  tierPart,
  updatePart,
  versionPart,
} from './parts.ts';
import { addedDirsLine, cacheHitRateLine, imageQuotaLine, memoryLine, promptCacheLine, sessionTimeLine } from './lines.ts';
import { agentsLine, mcpLine, skillsLine, todosLine, toolsLine } from './activity.ts';
import { agyQuotaExtraLines } from './quota-table.ts';
import { usageParts } from './usage.ts';
import { gitFilesLine } from './vcs.ts';

export function renderCompact(f: Frame): string[] {
  const display = f.config?.display;
  const mainParts: string[] = [];

  if (display?.showModel !== false) {
    mainParts.push(modelBadge(f));
  }
  mainParts.push(...projectParts(f, 'compact'));

  if (display?.showAddedDirs !== false && (display?.addedDirsLayout ?? 'inline') === 'inline') {
    const dirs = addedDirs(f, '+', ' ');
    if (dirs && display?.showProject === false) mainParts.push(dirs);
  }

  const style = display?.showOutputStyle === true ? outputStyle(f) : undefined;
  if (style) mainParts.push(label(`style: ${style}`, f.config?.colors));

  const { bar, value } = contextBarAndValue(f);
  mainParts.push(`${bar ? `${bar} ` : ''}${value}${tokenBreakdown(f)}`);

  const usage = usageParts(f, 'compact');
  if (usage) mainParts.push(...usage);

  const opt = [
    advisorPart(f),
    sessionNamePart(f),
    versionPart(f),
    extraPart(f),
    durationPart(f),
    costPart(f),
    speedPart(f),
    authPart(f),
    modePart(f),
    tierPart(f),
    stepsPart(f),
    updatePart(f),
    ...(display?.showSessionTokens ? [sessionTokensSummary(f, t('label.tokens'))] : []),
    ...configCountParts(f),
  ].filter((p): p is string => Boolean(p));

  mainParts.push(...opt);

  const lines: string[] = [];
  const firstCustom = customLinePart(f, 'first');
  if (firstCustom) lines.push(firstCustom);

  if (mainParts.length > 0) lines.push(mainParts.join(f.sep));

  const files = gitFilesLine(f);
  if (files) lines.push(files);

  const extraLines = [
    addedDirsLine(f),
    promptCacheLine(f),
    cacheHitRateLine(f),
    memoryLine(f),
    ...agyQuotaExtraLines(f),
    imageQuotaLine(f),
    sessionTimeLine(f),
    toolsLine(f),
    skillsLine(f),
    mcpLine(f),
    agentsLine(f),
    todosLine(f),
  ].filter((l): l is string => Boolean(l));

  lines.push(...extraLines);

  const lastCustom = customLinePart(f, 'last');
  if (lastCustom) lines.push(lastCustom);

  return lines.filter(Boolean);
}
