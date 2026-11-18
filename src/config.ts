import * as fs from 'node:fs';
import type { Paths } from './channel.ts';
import { createDebug } from './debug.ts';
import type { Language } from './i18n/types.ts';
import { MAX_TERMINAL_WIDTH } from './utils/terminal.ts';
import { sanitizeDisplayText } from './utils/sanitize.ts';
import { truncateString } from './utils/truncate.ts';

const debug = createDebug('config');
const MAX_CONFIG_FILE_BYTES = 64 * 1024;
const MAX_CONFIG_NESTING_DEPTH = 8;
const UNSAFE_CONFIG_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

const LANGUAGES = ['auto', 'en', 'zh', 'zh-Hans', 'zh-Hant', 'zh-TW'] as const satisfies readonly Language[];
const LINE_LAYOUTS = ['compact', 'expanded'] as const;
const PATH_LEVELS = [1, 2, 3, 'full'] as const;
const CONTEXT_VALUE_MODES = ['percent', 'tokens', 'remaining', 'both'] as const;
const USAGE_VALUE_MODES = ['percent', 'remaining'] as const;
const QUOTA_STYLES = ['minimal', 'table', 'models', 'compact'] as const;
const UNICODE_MODES = ['auto', true, false] as const;
const GIT_BRANCH_OVERFLOW_MODES = ['truncate', 'wrap'] as const;
const MODEL_FORMATS = ['full', 'compact', 'short'] as const;
const MODEL_SOURCES = ['auto', 'stdin', 'transcript'] as const;
const EFFORT_FORMATS = ['full', 'symbol', 'text'] as const;
const TIME_FORMATS = ['relative', 'absolute', 'both', 'elapsed', 'elapsedAndAbsolute'] as const;
const HOUR_CYCLES = ['auto', 'h11', 'h12', 'h23', 'h24'] as const;
const CUSTOM_LINE_POSITIONS = ['first', 'last'] as const;
const ADDED_DIRS_LAYOUTS = ['inline', 'line'] as const;
const WEEKLY_COST_PERIODS = ['quota', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;
const COLOR_NAMES = ['dim', 'gray', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'brightBlue', 'brightMagenta'] as const;

const ELEMENTS = [
  'project',
  'addedDirs',
  'context',
  'usage',
  'promptCache',
  'cacheHitRate',
  'memory',
  'environment',
  'tools',
  'skills',
  'mcp',
  'agents',
  'todos',
  'sessionTime',
  'sessionTokens',
  'cost',
] as const;

const FIRST_LINE_SEGMENTS = [
  'model',
  'project',
  'advisor',
  'sessionName',
  'version',
  'extra',
  'duration',
  'cost',
  'speed',
  'auth',
] as const;

export type LineLayoutType = typeof LINE_LAYOUTS[number];
export type PathLevels = typeof PATH_LEVELS[number];
export type ContextValueMode = typeof CONTEXT_VALUE_MODES[number];
export type UsageValueMode = typeof USAGE_VALUE_MODES[number];
export type QuotaStyleMode = typeof QUOTA_STYLES[number];
export type UnicodeMode = typeof UNICODE_MODES[number];
export type GitBranchOverflowMode = typeof GIT_BRANCH_OVERFLOW_MODES[number];
export type ModelFormatMode = typeof MODEL_FORMATS[number];
export type EffortFormatMode = typeof EFFORT_FORMATS[number];
export type TimeFormatMode = typeof TIME_FORMATS[number];
export type HourCycleMode = typeof HOUR_CYCLES[number];
export type CustomLinePosition = typeof CUSTOM_LINE_POSITIONS[number];
export type AddedDirsLayout = typeof ADDED_DIRS_LAYOUTS[number];
export type WeeklyCostPeriod = typeof WEEKLY_COST_PERIODS[number];
export type HudColorName = typeof COLOR_NAMES[number];
export type HudElement = typeof ELEMENTS[number];
export type FirstLineSegment = typeof FIRST_LINE_SEGMENTS[number];

export type HudColorValue = HudColorName | number | string;

export interface HudColorOverrides {
  context: HudColorValue;
  usage: HudColorValue;
  warning: HudColorValue;
  usageWarning: HudColorValue;
  critical: HudColorValue;
  model: HudColorValue;
  project: HudColorValue;
  git: HudColorValue;
  gitBranch: HudColorValue;
  label: HudColorValue;
  custom: HudColorValue;
  barFilled: string;
  barEmpty: string;
}

export const DEFAULT_ELEMENT_ORDER: HudElement[] = ELEMENTS.filter((element) => element !== 'cost');
export const DEFAULT_MERGE_GROUPS: HudElement[][] = [['context', 'usage']];
export const DEFAULT_PROJECT_LINE_ORDER: FirstLineSegment[] = [];

export interface HudConfig {
  language: Language;
  lineLayout: LineLayoutType;
  showSeparators: boolean;
  pathLevels: PathLevels;
  maxWidth: number | null;
  forceMaxWidth: boolean;
  elementOrder: HudElement[];
  projectLineOrder: FirstLineSegment[];
  gitStatus: {
    enabled: boolean;
    showDirty: boolean;
    showAheadBehind: boolean;
    showFileStats: boolean;
    showWorktree: boolean;
    branchOverflow: GitBranchOverflowMode;
    pushWarningThreshold: number;
    pushCriticalThreshold: number;
  };
  jjStatus: {
    enabled: boolean;
    showDirty: boolean;
    showConflicts: boolean;
  };
  display: {
    showModel: boolean;
    showProject: boolean;
    showLaunchDir: boolean;
    showAddedDirs: boolean;
    addedDirsLayout: AddedDirsLayout;
    showContextBar: boolean;
    contextValue: ContextValueMode;
    showConfigCounts: boolean;
    showCost: boolean;
    showRoutedCost: boolean;
    showDailyCost: boolean;
    showWeeklyCost: boolean;
    weeklyCostPeriod: WeeklyCostPeriod;
    showDuration: boolean;
    showSpeed: boolean;
    showTokenBreakdown: boolean;
    showUsage: boolean;
    usageValue: UsageValueMode;
    usageBarEnabled: boolean;
    showResetLabel: boolean;
    usageCompact: boolean;
    showModelScopedUsage: boolean;
    usagePace: boolean;
    quotaStyle: QuotaStyleMode;
    usageDecimals: boolean;
    columnWidth: number;
    showImageQuota: boolean;
    showTools: boolean;
    showSkills: boolean;
    showMcp: boolean;
    toolNameMaxLength: number;
    toolsMaxVisible: number;
    skillsMaxVisible: number;
    showAgents: boolean;
    showTodos: boolean;
    showSessionName: boolean;
    showAuth: boolean;
    showAuthUser: boolean;
    authUserFullEmail: boolean;
    authUserLength: number;
    authUserOverride: string;
    showClaudeCodeVersion: boolean;
    showEffortLevel: boolean;
    effortFormat: EffortFormatMode;
    showAgentEffort: boolean;
    showMemoryUsage: boolean;
    showPromptCache: boolean;
    showCacheHitRate: boolean;
    cacheHitExcellentThreshold: number;
    cacheHitPartialThreshold: number;
    showSessionTokens: boolean;
    showOutputStyle: boolean;
    showSessionStartDate: boolean;
    showLastResponseAt: boolean;
    showCompactions: boolean;
    showMode: boolean;
    showTier: boolean;
    showSessionSteps: boolean;
    showUpdateNotice: boolean;
    showBreadcrumbs: boolean;
    breadcrumbCount: number;
    useNerdFonts: boolean;
    unicode: UnicodeMode;
    mergeGroups: HudElement[][];
    rightAlign: HudElement[];
    contextWarningThreshold: number;
    contextCriticalThreshold: number;
    usageThreshold: number;
    sevenDayThreshold: number;
    environmentThreshold: number;
    externalUsagePath: string;
    externalUsageWritePath: string;
    externalUsageFreshnessMs: number;
    modelFormat: ModelFormatMode;
    modelOverride: string;
    modelSource: typeof MODEL_SOURCES[number];
    showProvider: boolean;
    providerName: string;
    customLine: string;
    customLinePosition: CustomLinePosition;
    timeFormat: TimeFormatMode;
    hourCycle: HourCycleMode;
    showClockSeconds: boolean;
    showAdvisor: boolean;
    advisorOverride: string;
    autoCompactWindow: number | null;
  };
  colors: HudColorOverrides;
}

export const DEFAULT_CONFIG: HudConfig = {
  language: 'auto',
  lineLayout: 'expanded',
  showSeparators: false,
  pathLevels: 1,
  maxWidth: null,
  forceMaxWidth: false,
  elementOrder: [...DEFAULT_ELEMENT_ORDER],
  projectLineOrder: [...DEFAULT_PROJECT_LINE_ORDER],
  gitStatus: {
    enabled: true,
    showDirty: true,
    showAheadBehind: true,
    showFileStats: false,
    showWorktree: false,
    branchOverflow: 'truncate',
    pushWarningThreshold: 0,
    pushCriticalThreshold: 0,
  },
  jjStatus: {
    enabled: true,
    showDirty: true,
    showConflicts: true,
  },
  display: {
    showModel: true,
    showProject: true,
    showLaunchDir: false,
    showAddedDirs: true,
    addedDirsLayout: 'inline',
    showContextBar: true,
    contextValue: 'percent',
    showConfigCounts: true,
    showCost: true,
    showRoutedCost: true,
    showDailyCost: false,
    showWeeklyCost: false,
    weeklyCostPeriod: 'quota',
    showDuration: true,
    showSpeed: true,
    showTokenBreakdown: true,
    showUsage: true,
    usageValue: 'percent',
    usageBarEnabled: true,
    showResetLabel: true,
    usageCompact: true,
    showModelScopedUsage: true,
    usagePace: false,
    quotaStyle: 'minimal',
    usageDecimals: false,
    columnWidth: 40,
    showImageQuota: false,
    showTools: true,
    showSkills: true,
    showMcp: true,
    toolNameMaxLength: 24,
    toolsMaxVisible: 4,
    skillsMaxVisible: 4,
    showAgents: true,
    showTodos: true,
    showSessionName: false,
    showAuth: false,
    showAuthUser: false,
    authUserFullEmail: false,
    authUserLength: 16,
    authUserOverride: '',
    showClaudeCodeVersion: true,
    showEffortLevel: true,
    effortFormat: 'full',
    showAgentEffort: true,
    showMemoryUsage: true,
    showPromptCache: true,
    showCacheHitRate: false,
    cacheHitExcellentThreshold: 80,
    cacheHitPartialThreshold: 50,
    showSessionTokens: true,
    showOutputStyle: true,
    showSessionStartDate: false,
    showLastResponseAt: false,
    showCompactions: true,
    showMode: false,
    showTier: false,
    showSessionSteps: false,
    showUpdateNotice: true,
    showBreadcrumbs: false,
    breadcrumbCount: 3,
    useNerdFonts: false,
    unicode: 'auto',
    mergeGroups: DEFAULT_MERGE_GROUPS.map((group) => [...group]),
    rightAlign: [],
    contextWarningThreshold: 70,
    contextCriticalThreshold: 85,
    usageThreshold: 0,
    sevenDayThreshold: 0,
    environmentThreshold: 0,
    externalUsagePath: '',
    externalUsageWritePath: '',
    externalUsageFreshnessMs: 300000,
    modelFormat: 'full',
    modelOverride: '',
    modelSource: 'stdin',
    showProvider: false,
    providerName: '',
    customLine: '',
    customLinePosition: 'last',
    timeFormat: 'relative',
    hourCycle: 'auto',
    showClockSeconds: false,
    showAdvisor: true,
    advisorOverride: '',
    autoCompactWindow: null,
  },
  colors: {
    context: 'green',
    usage: 'brightBlue',
    warning: 'yellow',
    usageWarning: 'brightMagenta',
    critical: 'red',
    model: 'cyan',
    project: 'yellow',
    git: 'magenta',
    gitBranch: 'cyan',
    label: 'dim',
    custom: 208,
    barFilled: '█',
    barEmpty: '░',
  },
};

export const CONFIG_PRESETS: Record<'minimal' | 'essential' | 'full', Record<string, unknown>> = {
  minimal: {
    gitStatus: { enabled: true, showDirty: true, showAheadBehind: false, showFileStats: false },
    jjStatus: { enabled: false },
    display: {
      showTools: false,
      showSkills: false,
      showMcp: false,
      showAgents: false,
      showTodos: false,
      showConfigCounts: false,
      showCost: false,
      showDuration: false,
      showSpeed: false,
      showMemoryUsage: false,
      showPromptCache: false,
      showSessionTokens: false,
      showCompactions: false,
      showEffortLevel: false,
      showClaudeCodeVersion: false,
      showOutputStyle: false,
      showAdvisor: false,
      usageCompact: false,
      sevenDayThreshold: 80,
    },
  },
  essential: {
    gitStatus: { enabled: true, showDirty: true, showAheadBehind: true },
    display: {
      showTools: true,
      showAgents: true,
      showTodos: true,
      showDuration: true,
      showConfigCounts: true,
      showSpeed: false,
      showCost: false,
      showMemoryUsage: false,
      showPromptCache: false,
      showSessionTokens: false,
      showSkills: false,
      showMcp: false,
      showCompactions: false,
    },
  },
  full: {},
};

type Rule = ((value: unknown, fallback: unknown) => unknown) & { accepts: string; freeText: boolean };
const rule = (accepts: string, fn: (value: unknown, fallback: unknown) => unknown, freeText = false): Rule =>
  Object.assign(fn, { accepts, freeText });

const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const list = (values: readonly unknown[]) => values.map((value) => JSON.stringify(value)).join(' | ');

const oneOf = (allowed: readonly unknown[]): Rule =>
  rule(list(allowed), (value, fallback) => (allowed.includes(value) ? value : fallback));
const clamp = (min: number, max: number): Rule =>
  rule(`a number from ${min} to ${max}`, (value, fallback) => (isNumber(value) ? Math.max(min, Math.min(max, value)) : fallback));
const floorAtLeastZero = rule('a whole number, 0 or more', (value, fallback) =>
  isNumber(value) ? Math.max(0, Math.floor(value)) : fallback,
);
const count = rule('a whole number, 0 or more', (value, fallback) =>
  Number.isInteger(value) && (value as number) >= 0 ? value : fallback,
);
const text = (maxLength: number): Rule =>
  rule(
    `text, up to ${maxLength} characters`,
    (value, fallback) => (typeof value === 'string' ? truncateString(sanitizeDisplayText(value), maxLength, '') : fallback),
    true,
  );

const names = (known: readonly unknown[], nonEmpty: boolean): Rule =>
  rule(`a list of ${list(known)}`, (value, fallback) => {
    if (!Array.isArray(value)) return fallback;
    const kept = [...new Set(value.filter((item) => known.includes(item)))];
    return kept.length > 0 || !nonEmpty ? kept : fallback;
  });

const mergeGroups = rule(`a list of groups, each 2 or more of ${list(ELEMENTS)}, each element in one group`, (value, fallback) => {
  if (!Array.isArray(value)) return fallback;
  if (value.length === 0) return [];
  const used = new Set<unknown>();
  const groups: unknown[][] = [];
  for (const group of value) {
    if (!Array.isArray(group)) continue;
    const members = [...new Set(group.filter((item) => (ELEMENTS as readonly unknown[]).includes(item) && !used.has(item)))];
    if (members.length < 2) continue;
    members.forEach((member) => used.add(member));
    groups.push(members);
  }
  return groups.length > 0 ? groups : fallback;
});

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const color = rule(`${list(COLOR_NAMES)}, a 256-color number 0-255, or "#rrggbb"`, (value, fallback) =>
  COLOR_NAMES.includes(value as HudColorName)
  || (Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 255)
  || (typeof value === 'string' && HEX_COLOR.test(value))
    ? value
    : fallback,
);

const INVISIBLE_CODEPOINT = /[\p{Cc}\p{Cf}\p{Variation_Selector}\p{Zl}\p{Zp}\p{Cn}]/u;
const barChar = rule('one visible character', (value, fallback) => {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  const graphemes = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value)];
  return graphemes.length === 1 && !INVISIBLE_CODEPOINT.test(value) ? value : fallback;
});

const usagePath = rule('an absolute path (a leading ~ and ${VAR} are expanded)', (value) => (typeof value === 'string' ? value.trim() : ''), true);
const booleanRule = rule('true | false', (value, fallback) => (typeof value === 'boolean' ? value : fallback));

const RULES: Record<string, Rule> = {
  language: oneOf(LANGUAGES),
  lineLayout: oneOf(LINE_LAYOUTS),
  pathLevels: oneOf(PATH_LEVELS),
  maxWidth: rule('a positive number, or null', (value) => (isNumber(value) && value > 0 ? Math.min(Math.floor(value), MAX_TERMINAL_WIDTH) : null)),
  elementOrder: names(ELEMENTS, true),
  projectLineOrder: names(FIRST_LINE_SEGMENTS, false),
  'gitStatus.branchOverflow': oneOf(GIT_BRANCH_OVERFLOW_MODES),
  'gitStatus.pushWarningThreshold': floorAtLeastZero,
  'gitStatus.pushCriticalThreshold': floorAtLeastZero,
  'display.addedDirsLayout': oneOf(ADDED_DIRS_LAYOUTS),
  'display.contextValue': oneOf(CONTEXT_VALUE_MODES),
  'display.weeklyCostPeriod': oneOf(WEEKLY_COST_PERIODS),
  'display.usageValue': oneOf(USAGE_VALUE_MODES),
  'display.quotaStyle': oneOf(QUOTA_STYLES),
  'display.columnWidth': clamp(24, 120),
  'display.breadcrumbCount': count,
  'display.unicode': oneOf(UNICODE_MODES),
  'display.toolNameMaxLength': count,
  'display.toolsMaxVisible': count,
  'display.skillsMaxVisible': count,
  'display.authUserLength': count,
  'display.authUserOverride': text(80),
  'display.effortFormat': oneOf(EFFORT_FORMATS),
  'display.cacheHitExcellentThreshold': clamp(0, 100),
  'display.cacheHitPartialThreshold': clamp(0, 100),
  'display.mergeGroups': mergeGroups,
  'display.rightAlign': names(ELEMENTS, false),
  'display.contextWarningThreshold': clamp(0, 100),
  'display.contextCriticalThreshold': clamp(0, 100),
  'display.usageThreshold': clamp(0, 100),
  'display.sevenDayThreshold': clamp(0, 100),
  'display.environmentThreshold': clamp(0, 100),
  'display.externalUsagePath': usagePath,
  'display.externalUsageWritePath': usagePath,
  'display.externalUsageFreshnessMs': floorAtLeastZero,
  'display.modelFormat': oneOf(MODEL_FORMATS),
  'display.modelOverride': text(80),
  'display.modelSource': oneOf(MODEL_SOURCES),
  'display.providerName': text(40),
  'display.customLine': text(80),
  'display.customLinePosition': oneOf(CUSTOM_LINE_POSITIONS),
  'display.timeFormat': oneOf(TIME_FORMATS),
  'display.hourCycle': oneOf(HOUR_CYCLES),
  'display.advisorOverride': text(80),
  'display.autoCompactWindow': rule('a positive whole number, or null', (value) => (Number.isInteger(value) && (value as number) > 0 ? value : null)),
  'colors.barFilled': barChar,
  'colors.barEmpty': barChar,
  'colors.*': color,
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const ruleFor = (keyPath: string, fallback: unknown): Rule | undefined =>
  RULES[keyPath] ?? RULES[`${keyPath.slice(0, keyPath.lastIndexOf('.') + 1)}*`] ?? (typeof fallback === 'boolean' ? booleanRule : undefined);

function normalize(defaults: Record<string, unknown>, input: unknown, prefix = ''): Record<string, unknown> {
  const source = isPlainObject(input) ? input : {};
  const result: Record<string, unknown> = {};
  for (const [key, fallback] of Object.entries(defaults)) {
    const keyPath = prefix + key;
    const keyRule = ruleFor(keyPath, fallback);
    const value = source[key];
    if (keyRule) {
      result[key] = keyRule(value, fallback);
    } else if (isPlainObject(fallback)) {
      result[key] = normalize(fallback, value, `${keyPath}.`);
    } else {
      result[key] = fallback;
    }
  }
  return result;
}

export interface ConfigKey {
  key: string;
  default: unknown;
  accepts: string;
  freeText: boolean;
}

export function configKeys(defaults: Record<string, unknown> = DEFAULT_CONFIG as unknown as Record<string, unknown>, prefix = ''): ConfigKey[] {
  return Object.entries(defaults).flatMap(([key, fallback]) => {
    const keyPath = prefix + key;
    const keyRule = ruleFor(keyPath, fallback);
    if (!keyRule && isPlainObject(fallback)) return configKeys(fallback, `${keyPath}.`);
    return [{ key: keyPath, default: fallback, accepts: keyRule?.accepts ?? 'a value', freeText: keyRule?.freeText ?? false }];
  });
}

const UNSET = Symbol('unset');
const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

let allKeys: Map<string, ConfigKey> | undefined;
const keyEntry = (key: string) => (allKeys ??= new Map(configKeys().map((entry) => [entry.key, entry]))).get(key);

export const configKey = (key: string): ConfigKey | undefined => keyEntry(key);

export function checkValue(key: string, value: unknown): string | null {
  const entry = keyEntry(key);
  if (!entry) return `${key} is not a config key`;
  const keyRule = ruleFor(key, entry.default);
  const valid = keyRule === usagePath ? typeof value === 'string' : keyRule ? sameJson(keyRule(value, UNSET), value) : false;
  return valid ? null : `${key} must be ${entry.accepts}`;
}

export function configProblems(raw: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(raw).flatMap(([key, value]) => {
    const keyPath = prefix + key;
    if (keyEntry(keyPath)) {
      const problem = checkValue(keyPath, value);
      return problem ? [problem] : [];
    }
    const isSection = isPlainObject((DEFAULT_CONFIG as unknown as Record<string, unknown>)[keyPath]) && prefix === '';
    if (!isSection) return [];
    return isPlainObject(value) ? configProblems(value, `${keyPath}.`) : [`${keyPath} must be an object`];
  });
}

function migrateLegacyLayout(config: Record<string, unknown>): Record<string, unknown> {
  let current = config;
  if ('layout' in current && !('lineLayout' in current)) {
    const { layout, ...rest } = current;
    if (typeof layout === 'string') {
      current = { ...rest, lineLayout: 'compact', showSeparators: layout === 'separators' };
    } else if (isPlainObject(layout)) {
      const { lineLayout, showSeparators, pathLevels } = layout;
      current = {
        ...rest,
        ...(typeof lineLayout === 'string' && { lineLayout }),
        ...(typeof showSeparators === 'boolean' && { showSeparators }),
        ...((typeof pathLevels === 'number' || pathLevels === 'full') && { pathLevels }),
      };
    } else {
      current = rest;
    }
  }

  // Migrate legacy agy-hud v0.3.x config keys (`theme`, `thresholds`, `display.showGitBranch`, etc.).
  const hasLegacyAgy = 'theme' in current || 'thresholds' in current || (isPlainObject(current.display) && (
    'showGitBranch' in current.display || 'showCurrentDir' in current.display
    || 'showUsername' in current.display || 'username' in current.display
    || 'showTokenBar' in current.display || 'showTurnCacheHitRate' in current.display
    || 'cacheHitThresholds' in current.display
  ));
  if (!hasLegacyAgy) return current;

  const out: Record<string, unknown> = { ...current };
  const colors = isPlainObject(out.colors) ? { ...out.colors } : {};
  if (isPlainObject(out.theme)) {
    const t = out.theme;
    if (t.primary !== undefined && colors.context === undefined) colors.context = t.primary;
    if (t.secondary !== undefined && colors.label === undefined) colors.label = t.secondary;
    if (t.warning !== undefined && colors.warning === undefined) colors.warning = t.warning;
    if (t.critical !== undefined && colors.critical === undefined) colors.critical = t.critical;
    delete out.theme;
    out.colors = colors;
  }

  const display = isPlainObject(out.display) ? { ...out.display } : {};
  if (isPlainObject(out.thresholds)) {
    const th = out.thresholds;
    if (isNumber(th.warning) && display.contextWarningThreshold === undefined) {
      display.contextWarningThreshold = th.warning <= 1 ? Math.round(th.warning * 100) : th.warning;
    }
    if (isNumber(th.critical) && display.contextCriticalThreshold === undefined) {
      display.contextCriticalThreshold = th.critical <= 1 ? Math.round(th.critical * 100) : th.critical;
    }
    delete out.thresholds;
  }

  if ('showGitBranch' in display) {
    const gitStatus = isPlainObject(out.gitStatus) ? { ...out.gitStatus } : {};
    if (gitStatus.enabled === undefined) gitStatus.enabled = display.showGitBranch;
    out.gitStatus = gitStatus;
    delete display.showGitBranch;
  }
  if ('showCurrentDir' in display) {
    if (display.showProject === undefined) display.showProject = display.showCurrentDir;
    delete display.showCurrentDir;
  }
  if ('showUsername' in display) {
    if (display.showAuthUser === undefined) display.showAuthUser = display.showUsername;
    delete display.showUsername;
  }
  if ('username' in display) {
    if (display.authUserOverride === undefined) display.authUserOverride = display.username;
    delete display.username;
  }
  if ('showTokenBar' in display) {
    if (display.showSessionTokens === undefined) display.showSessionTokens = display.showTokenBar;
    delete display.showTokenBar;
  }
  if ('showTurnCacheHitRate' in display) {
    if (display.showCacheHitRate === undefined) display.showCacheHitRate = display.showTurnCacheHitRate;
    delete display.showTurnCacheHitRate;
  }
  if (isPlainObject(display.cacheHitThresholds)) {
    const ch = display.cacheHitThresholds;
    if (isNumber(ch.excellent) && display.cacheHitExcellentThreshold === undefined) display.cacheHitExcellentThreshold = ch.excellent;
    if (isNumber(ch.partial) && display.cacheHitPartialThreshold === undefined) display.cacheHitPartialThreshold = ch.partial;
    delete display.cacheHitThresholds;
  }
  out.display = display;
  return out;
}

export function mergeConfig(userConfig: Partial<HudConfig>): HudConfig {
  const migrated = migrateLegacyLayout(userConfig as Record<string, unknown>);
  const defaults = structuredClone(DEFAULT_CONFIG) as unknown as Record<string, unknown>;
  return normalize(defaults, migrated) as unknown as HudConfig;
}

function hasSafeConfigShape(value: unknown, depth = 0): boolean {
  if (depth > MAX_CONFIG_NESTING_DEPTH) return false;
  if (Array.isArray(value)) return value.every((item) => hasSafeConfigShape(item, depth + 1));
  if (!isPlainObject(value)) return true;
  return Object.entries(value).every(([key, child]) => !UNSAFE_CONFIG_KEYS.has(key) && hasSafeConfigShape(child, depth + 1));
}

export function mergeOverrides(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const result = Object.assign(Object.create(null), base) as Record<string, unknown>;
  for (const [key, value] of Object.entries(override)) {
    const current = result[key];
    result[key] = isPlainObject(current) && isPlainObject(value) ? mergeOverrides(current, value) : value;
  }
  return result;
}

function readConfigFile(configPath: string | null | undefined): Record<string, unknown> | string | null {
  if (!configPath) return null;
  try {
    const fd = fs.openSync(configPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      if (!fs.fstatSync(fd).isFile()) {
        debug('Ignoring %s: not a regular file', configPath);
        return 'is not a regular file';
      }
      const buf = Buffer.alloc(MAX_CONFIG_FILE_BYTES + 1);
      let length = 0;
      let bytesRead: number;
      do {
        bytesRead = fs.readSync(fd, buf, length, buf.length - length, length);
        length += bytesRead;
      } while (bytesRead > 0 && length < buf.length);
      if (length > MAX_CONFIG_FILE_BYTES) {
        debug('Ignoring %s: larger than %d bytes', configPath, MAX_CONFIG_FILE_BYTES);
        return `is larger than ${MAX_CONFIG_FILE_BYTES / 1024} KB`;
      }
      const parsed: unknown = JSON.parse(buf.subarray(0, length).toString('utf-8'));
      if (!isPlainObject(parsed) || !hasSafeConfigShape(parsed)) {
        debug('Ignoring %s: not a bounded JSON object without unsafe keys', configPath);
        return 'is not a JSON object (or nests too deep, or uses __proto__)';
      }
      return parsed;
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    debug('Ignoring %s:', configPath, err instanceof Error ? err.message : err);
    return err instanceof SyntaxError ? 'is not valid JSON' : "can't be read";
  }
}

export interface LoadedConfig {
  config: HudConfig;
  base: Record<string, unknown>;
  baseUnreadable: string | null;
  override: Record<string, unknown>;
  problems: string[];
}

export function loadConfigFiles(paths: Pick<Paths, 'config' | 'override' | 'legacyConfig' | 'project'>): LoadedConfig {
  const rawBase = readConfigFile(paths.config);
  const rawLegacy = rawBase === null ? readConfigFile(paths.legacyConfig) : null;
  const baseFile = rawBase !== null ? rawBase : rawLegacy;
  const baseName = rawBase !== null ? 'config.json' : 'agy-hud.config.json';

  const rawDirOverride = readConfigFile(paths.override);
  const rawLocalOverride = readConfigFile(paths.project?.localAgyHudConfig);

  const problems: string[] = [];
  const checkEntry = (name: string, file: Record<string, unknown> | string | null): Record<string, unknown> | null => {
    if (typeof file === 'string') {
      problems.push(`${name} ${file}`);
      return null;
    }
    if (file) {
      problems.push(...configProblems(migrateLegacyLayout(file)).map((problem) => `${name}: ${problem}`));
      return migrateLegacyLayout(file);
    }
    return null;
  };

  const base = checkEntry(baseName, baseFile);
  const dirOverride = checkEntry('agy-hud.json', rawDirOverride);
  const localOverride = checkEntry('agy-hud.config.json', rawLocalOverride);

  let override: Record<string, unknown> = {};
  if (dirOverride) override = mergeOverrides(override, dirOverride);
  if (localOverride) override = mergeOverrides(override, localOverride);

  const merged = Object.keys(override).length > 0 ? mergeOverrides(base ?? {}, override) : (base ?? {});
  return {
    config: mergeConfig(merged as Partial<HudConfig>),
    base: base ?? {},
    baseUnreadable: typeof rawBase === 'string' ? `config.json ${rawBase}` : null,
    override,
    problems,
  };
}

export async function loadConfig(paths: Pick<Paths, 'config' | 'override' | 'legacyConfig' | 'project'>): Promise<HudConfig> {
  return loadConfigFiles(paths).config;
}
