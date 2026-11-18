import type { FirstLineSegment, PathLevels } from '../config.ts';
import { DEFAULT_CONFIG } from '../config.ts';
import { formatAuthSegment } from '../auth.ts';
import { formatEffort } from '../effort.ts';
import { formatUsd } from '../cost.ts';
import { formatModelName, getProviderLabel, resolveAgentMode, resolveModelName } from '../stdin.ts';
import { t } from '../i18n/index.ts';
import { formatTokens } from '../utils/format.ts';
import { getFileHref, safeHyperlink } from '../utils/hyperlinks.ts';
import { displayLabel, sanitizeDisplayText } from '../utils/sanitize.ts';
import { truncateString } from '../utils/truncate.ts';
import type { Frame, Layout } from './frame.ts';
import { cyan, custom, dim, label, magenta, model as modelColor, project as projectColor, warning, yellow } from './colors.ts';
import { claudeCodeVersion, effort, sessionCostUsd, sessionDuration, sessionName } from './derive.ts';
import { vcsPart } from './vcs.ts';

export interface Part {
  key: FirstLineSegment | null;
  text: string;
}

function effortSuffix(f: Frame, baseName: string): { trimmedName: string; suffix: string } {
  const display = f.config?.display;
  const info = display?.showEffortLevel ? effort(f) : null;
  if (!info) return { trimmedName: baseName, suffix: '' };
  const suffix = ` ${formatEffort(info, display?.effortFormat)}`;
  // Avoid redundant "[Gemini 4 Hydrogen (XHigh) ◕ xhigh]" when model name already ends with "(XHigh)"
  const parenRe = /\s*\(([^)]+)\)\s*$/;
  const m = parenRe.exec(baseName);
  if (m && m[1].trim().toLowerCase().replace(/[^a-z]/g, '') === info.level.toLowerCase().replace(/[^a-z]/g, '')) {
    return { trimmedName: baseName.replace(parenRe, '').trim(), suffix };
  }
  return { trimmedName: baseName, suffix };
}

export function modelBadge(f: Frame): string {
  const display = f.config?.display;
  const rawName = sanitizeDisplayText(
    formatModelName(resolveModelName(f.stdin, f.transcript, display?.modelSource), display?.modelFormat, display?.modelOverride),
  );
  const { trimmedName, suffix } = effortSuffix(f, rawName);
  const core = `${trimmedName}${suffix}`;
  const provider = getProviderLabel(f.stdin);
  let text = provider ? `${core} | ${provider}` : core;
  if (display?.showProvider) {
    const shown = display.providerName?.trim() || provider;
    text = shown ? `${shown} | ${core}` : core;
  }
  const icon = display?.useNerdFonts ? '\udb81\ude97 ' : '';
  return modelColor(`${icon}[${text}]`, f.config?.colors);
}

const pathSegments = (p: string): string[] => p.split(/[/\\]/).filter(Boolean);

function formatProjectPath(cwd: string, pathLevels: PathLevels): string {
  const safe = sanitizeDisplayText(cwd);
  const segments = pathSegments(safe);
  if (pathLevels !== 'full') {
    return segments.slice(-pathLevels).join('/') || (/^[/\\]/.test(safe) ? '/' : safe);
  }
  if (/^[\\/]{2}/.test(safe)) return segments.length > 0 ? `//${segments.join('/')}` : '//';
  if (/^[A-Za-z]:[\\/]/.test(safe)) return segments.length === 1 ? `${segments[0]}/` : segments.join('/');
  if (/^[\\/]/.test(safe)) return segments.length > 0 ? `/${segments.join('/')}` : '/';
  return segments.join('/') || safe;
}

function launchDirName(cwd: string, launchDir: unknown, pathLevels: PathLevels): string | null {
  if (pathLevels === 'full' || typeof launchDir !== 'string') return null;
  const launch = pathSegments(sanitizeDisplayText(launchDir));
  const current = pathSegments(sanitizeDisplayText(cwd));
  const inside = launch.every((segment, i) => current[i] === segment);
  if (inside && current.length - launch.length < pathLevels) return null;
  return launch.at(-1) ?? null;
}

const MAX_ADDED_DIRS = 5;
const ADDED_DIR_NAME_MAX = 24;

function addedDirNames(f: Frame): Array<{ dir: string; name: string }> {
  const dirs = f.stdin.workspace?.added_dirs;
  if (!Array.isArray(dirs)) return [];
  return dirs
    .filter((dir): dir is string => typeof dir === 'string' && dir.length > 0)
    .map((dir) => {
      const segments = pathSegments(dir);
      const name = sanitizeDisplayText(segments[segments.length - 1] ?? dir);
      return { dir, name: truncateString(name, ADDED_DIR_NAME_MAX, f.unicode ? '…' : '...') };
    })
    .filter(({ name }) => name.length > 0);
}

export function addedDirs(f: Frame, prefix: string, joiner: string): string | null {
  const dirs = addedDirNames(f);
  if (dirs.length === 0) return null;
  const shown = dirs.slice(0, MAX_ADDED_DIRS).map(({ dir, name }) => safeHyperlink(getFileHref(dir), dim(`${prefix}${name}`)));
  if (dirs.length > MAX_ADDED_DIRS) shown.push(dim(`+${dirs.length - MAX_ADDED_DIRS} more`));
  return shown.join(joiner);
}

export function projectParts(f: Frame, layout: Layout): string[] {
  const display = f.config?.display;
  const colors = f.config?.colors;
  const cwd = f.stdin.workspace?.current_dir ?? f.stdin.cwd;
  let project: string | null = null;
  if (display?.showProject !== false && cwd) {
    const pathLevels = f.config?.pathLevels ?? 1;
    const p = formatProjectPath(cwd, pathLevels);
    const launch = display?.showLaunchDir ? launchDirName(cwd, f.stdin.workspace?.project_dir, pathLevels) : null;
    const arrow = f.unicode ? '›' : '>';
    const text = projectColor(launch ? `${launch} ${arrow} ${p}` : p, colors);
    project = layout === 'expanded' ? safeHyperlink(getFileHref(cwd), text) : text;
  }
  if (layout === 'expanded' && display?.showAddedDirs !== false && (display?.addedDirsLayout ?? 'inline') === 'inline') {
    const dirs = addedDirs(f, '+', ' ');
    if (dirs) project = project ? `${project} ${dirs}` : dirs;
  }

  const vcs = vcsPart(f, layout);
  if (project && vcs) {
    const overflow = f.config.gitStatus?.branchOverflow ?? DEFAULT_CONFIG.gitStatus.branchOverflow;
    return overflow === 'wrap' ? [project, vcs] : [`${project} ${vcs}`];
  }
  return [project ?? vcs].filter((part): part is string => Boolean(part));
}

const ADVISOR_MAX_LENGTH = 64;
const ADVISOR_ID = /^(?:claude-)?(opus|sonnet|haiku)-(\d+)-(\d+)/i;
const capitalize = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();

function prettifyAdvisorId(rawId: string): string {
  const id = rawId.trim();
  const match = id.match(ADVISOR_ID);
  if (match) return `${capitalize(match[1])} ${match[2]}.${match[3]}`;
  if (/^(opus|sonnet|haiku)$/i.test(id)) return capitalize(id);
  return id.replace(/^claude-/i, '');
}

export function advisorPart(f: Frame): string | null {
  const display = f.config?.display;
  if (display?.showAdvisor !== true) return null;
  const clean = (value: unknown): string => displayLabel(value, ADVISOR_MAX_LENGTH);
  const override = clean(display.advisorOverride);
  const name = override || clean(prettifyAdvisorId(clean(f.transcript?.advisorModel)));
  return name ? `${label(`${t('label.advisor')}:`, f.config?.colors)} ${name}` : null;
}

const labeled = (f: Frame, text: string | null | undefined): string | null => (text ? label(text, f.config?.colors) : null);

export function sessionNamePart(f: Frame): string | null {
  return f.config?.display?.showSessionName ? labeled(f, sessionName(f)) : null;
}

export function versionPart(f: Frame): string | null {
  const version = f.config?.display?.showClaudeCodeVersion ? claudeCodeVersion(f) : undefined;
  if (!version) return null;
  const prefix = f.stdin.product === 'antigravity' ? 'agy v' : 'CC v';
  return labeled(f, `${prefix}${version}`);
}

export function durationPart(f: Frame): string | null {
  const duration = f.config?.display?.showDuration === true ? sessionDuration(f, f.now) : '';
  if (!duration) return null;
  const clock = f.unicode ? '⏱️  ' : '';
  return labeled(f, `${clock}${duration}`);
}

export function extraPart(f: Frame): string | null {
  return labeled(f, f.extraLabel);
}

export function costPart(f: Frame): string | null {
  const display = f.config?.display;
  const costUsd = display?.showCost === true ? sessionCostUsd(f) : null;
  const parts = [
    costUsd !== null ? `${t('label.cost')} ${formatUsd(costUsd)}` : null,
    display?.showDailyCost === true && f.costTotals ? `${t('label.today')} ${formatUsd(f.costTotals.todayUsd)}` : null,
    display?.showWeeklyCost === true && f.costTotals?.weekUsd != null ? `${t('label.week')} ${formatUsd(f.costTotals.weekUsd)}` : null,
  ].filter(Boolean);
  return labeled(f, parts.join(' | '));
}

export function speedPart(f: Frame): string | null {
  if (!f.config?.display?.showSpeed || f.outputSpeed === null) return null;
  return labeled(f, `${t('format.out')}: ${f.outputSpeed.toFixed(1)} ${t('format.tokPerSec')}`);
}

export function authPart(f: Frame): string | null {
  return labeled(f, formatAuthSegment(f.authInfo, f.config?.display));
}

export function modePart(f: Frame): string | null {
  if (f.config?.display?.showMode !== true) return null;
  const modeStr = resolveAgentMode(f.stdin, f.transcript?.transcriptMode);
  if (!modeStr) return null;
  const lower = modeStr.toLowerCase();
  if (lower.includes('accept') || lower.includes('always') || lower.includes('bypass')) return yellow(modeStr);
  return lower === 'plan' ? cyan(modeStr) : cyan(modeStr);
}

export function tierPart(f: Frame): string | null {
  if (f.config?.display?.showTier !== true) return null;
  const raw = f.agyQuota?.tierName ?? f.stdin.plan_tier;
  const tier = displayLabel(raw, 40);
  return tier ? magenta(tier) : null;
}

export function stepsPart(f: Frame): string | null {
  if (f.config?.display?.showSessionSteps !== true) return null;
  const steps = f.transcript?.steps ?? 0;
  const tasks = f.stdin.task_count ?? 0;
  const stepPrefix = f.unicode ? '⚡' : 'S:';
  const taskPrefix = f.unicode ? '✓' : 'T:';
  return label(`${stepPrefix}${steps}${tasks > 0 ? ` ${taskPrefix}${tasks}` : ''}`, f.config?.colors);
}

export function updatePart(f: Frame): string | null {
  if (f.config?.display?.showUpdateNotice === false) return null;
  const info = f.agyQuota?.updateInfo;
  if (!info?.updateAvailable || !info.latestVersion) return null;
  const icon = f.unicode ? '⟳' : '[UP]';
  return warning(`${icon} v${sanitizeDisplayText(info.latestVersion)}`, f.config?.colors);
}

export function customLinePart(f: Frame, position: 'first' | 'last'): string | null {
  const display = f.config?.display;
  if (!display?.customLine || (display.customLinePosition ?? 'last') !== position) return null;
  return custom(display.customLine, f.config?.colors);
}

export function configCountParts(f: Frame, mcpSuffix = ''): string[] {
  const display = f.config?.display;
  const total = f.claudeMdCount + f.rulesCount + f.mcpCount + f.hooksCount;
  if (display?.showConfigCounts !== true || total === 0 || total < (display?.environmentThreshold ?? 0)) return [];
  const colors = f.config?.colors;
  const memLabel = f.memoryLabelName ?? 'CLAUDE.md';
  return [
    f.claudeMdCount > 0 ? label(`${f.claudeMdCount} ${memLabel}`, colors) : null,
    f.rulesCount > 0 ? label(`${f.rulesCount} ${t('label.rules')}`, colors) : null,
    f.mcpCount > 0 ? `${label(`${f.mcpCount} MCPs`, colors)}${mcpSuffix}` : null,
    f.hooksCount > 0 ? label(`${f.hooksCount} ${t('label.hooks')}`, colors) : null,
  ].filter((part): part is string => part !== null);
}

export function sessionTokensSummary(f: Frame, prefix: string): string | null {
  const tokens = f.transcript.sessionTokens;
  if (!tokens) return null;
  const total = tokens.inputTokens + tokens.outputTokens + tokens.cacheCreationTokens + tokens.cacheReadTokens;
  if (total === 0) return null;
  const parts = [`${t('format.in')}: ${formatTokens(tokens.inputTokens)}`, `${t('format.out')}: ${formatTokens(tokens.outputTokens)}`];
  const cache = tokens.cacheCreationTokens + tokens.cacheReadTokens;
  if (cache > 0) parts.push(`${t('format.cache')}: ${formatTokens(cache)}`);
  return label(`${prefix} ${formatTokens(total)} (${parts.join(', ')})`, f.config?.colors);
}

export function compactionsPart(f: Frame): string | null {
  const count = f.transcript.compactionCount ?? 0;
  return f.config?.display?.showCompactions === true && count > 0 ? label(`${t('label.compactions')}: ${count}`, f.config?.colors) : null;
}
