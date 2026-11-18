import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Ask, CommandRequest, Facts, Paths, ReplyMessage } from './channel.ts';
import {
  CONFIG_PRESETS,
  DEFAULT_CONFIG,
  checkValue,
  configKey,
  loadConfigFiles,
  mergeConfig,
  mergeOverrides,
  type HudConfig,
} from './config.ts';
import { readAuthInfo } from './auth.ts';
import { agyQuotaToUsageData, mergeAgyQuotaProbe } from './agy-quota.ts';
import { schemaLines } from './schema.ts';
import { getTerminalWidth } from './utils/terminal.ts';
import { renderPlain } from './render/index.ts';
import type { AgyQuotaProbe, RenderContext, StdinData } from './types.ts';

const CAPABILITY_KEYS = new Set(['display.externalUsagePath', 'display.externalUsageWritePath']);
const SECRET_KEYS = new Set(['display.authUserOverride']);

function setNested(obj: Record<string, unknown>, dottedKey: string, value: unknown): void {
  const parts = dottedKey.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (k === '__proto__' || k === 'prototype' || k === 'constructor') return;
    const next = cur[k];
    if (!next || typeof next !== 'object' || Array.isArray(next)) {
      cur[k] = {};
    }
    cur = cur[k] as Record<string, unknown>;
  }
  const leaf = parts[parts.length - 1];
  if (leaf !== '__proto__' && leaf !== 'prototype' && leaf !== 'constructor') {
    if (value === undefined) delete cur[leaf];
    else cur[leaf] = value;
  }
}

function getNested(obj: Record<string, unknown>, dottedKey: string): unknown {
  let cur: unknown = obj;
  for (const part of dottedKey.split('.')) {
    if (!cur || typeof cur !== 'object' || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function parseUserValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === 'null') return null;
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      return JSON.parse(trimmed);
    } catch {}
  }
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseAssignment(args: string[]): Array<{ key: string; rawValue: string | null }> {
  const pairs: Array<{ key: string; rawValue: string | null }> = [];
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token === '--reset') {
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        pairs.push({ key: next, rawValue: null });
        i++;
      }
      continue;
    }
    const eq = token.indexOf('=');
    if (eq > 0) {
      pairs.push({ key: token.slice(0, eq), rawValue: token.slice(eq + 1) });
      continue;
    }
    if (i + 1 < args.length) {
      pairs.push({ key: token, rawValue: args[i + 1] });
      i++;
    } else {
      pairs.push({ key: token, rawValue: '' });
    }
  }
  return pairs;
}

function scrubText(value: string, facts: Facts): string {
  const home = path.dirname(path.dirname(facts.configPath));
  let out = value;
  if (facts.cwd && facts.cwd.length > 2) out = out.split(facts.cwd).join('<cwd>');
  if (home && home.length > 2) out = out.split(home).join('<home>');
  if (facts.account.email) out = out.split(facts.account.email).join('<redacted-email>');
  return out;
}

function scrubUnknown(val: unknown, facts: Facts): unknown {
  if (typeof val === 'string') return scrubText(val, facts);
  if (Array.isArray(val)) return val.map((v) => scrubUnknown(v, facts));
  if (val && typeof val === 'object') {
    const res: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val)) {
      if (k === 'accountEmail' || k === 'email' || k === 'user' || SECRET_KEYS.has(`display.${k}`)) {
        res[k] = v ? '<redacted>' : null;
      } else {
        res[k] = scrubUnknown(v, facts);
      }
    }
    return res;
  }
  return val;
}

function configDiff(base: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const defaults = DEFAULT_CONFIG as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(base)) {
    if (JSON.stringify(v) !== JSON.stringify(defaults[k])) {
      result[k] = v;
    }
  }
  return result;
}

function sampleStdin(facts: Facts): StdinData {
  const hb = facts.heartbeat?.stdin;
  if (hb && typeof hb === 'object') return hb;
  return {
    model: { id: 'gemini-3-pro', display_name: 'Gemini 3 Pro (High)' },
    cwd: facts.cwd,
    workspace: { current_dir: facts.cwd, project_dir: facts.cwd },
    context_window: {
      context_window_size: 200_000,
      used_percentage: 24,
      current_usage: { input_tokens: 42_000, output_tokens: 4_500, cache_read_input_tokens: 30_000, cache_creation_input_tokens: 2_000 },
    },
    rate_limits: {
      five_hour: { used_percentage: 18, resets_at: Math.floor(Date.now() / 1000) + 10_800 },
      seven_day: { used_percentage: 9, resets_at: Math.floor(Date.now() / 1000) + 360_000 },
    },
  };
}

function buildPreviewContext(
  stdin: StdinData,
  config: HudConfig,
  quotaProbe: AgyQuotaProbe | null,
  unicodeSupported: boolean,
  now: number,
): RenderContext {
  const mergedQuota = mergeAgyQuotaProbe(quotaProbe, stdin, now);
  return {
    stdin,
    transcript: { tools: [], skills: [], mcpServers: [], mcpErrors: [], agents: [], todos: [] },
    claudeMdCount: 1,
    memoryLabelName: 'AGENTS.md',
    rulesCount: 2,
    mcpCount: 3,
    hooksCount: 1,
    costTotals: config.display.showDailyCost || config.display.showWeeklyCost ? { todayUsd: 1.42, weekUsd: 12.8 } : null,
    outputSpeed: config.display.showSpeed ? 48.6 : null,
    gitStatus: config.gitStatus.enabled ? { branch: 'main', isDirty: true, ahead: 1, behind: 0 } : null,
    usageData: agyQuotaToUsageData(mergedQuota, stdin, now) ?? {
      fiveHour: stdin.rate_limits?.five_hour?.used_percentage ?? 18,
      sevenDay: stdin.rate_limits?.seven_day?.used_percentage ?? 9,
      fiveHourResetAt: new Date(now + 10_800_000),
      sevenDayResetAt: new Date(now + 360_000_000),
    },
    agyQuota: mergedQuota,
    memoryUsage: config.display.showMemoryUsage
      ? { totalBytes: 16 * 1024 ** 3, usedBytes: 8 * 1024 ** 3, freeBytes: 8 * 1024 ** 3, usedPercent: 50 }
      : null,
    config,
    extraLabel: null,
    unicodeSupported,
  };
}

export async function runHudCommand(
  req: CommandRequest,
  paths: Paths,
  ask: Ask,
  now: number,
): Promise<ReplyMessage> {
  const { name, args, facts } = req;

  if (name === 'schema') {
    return { lines: schemaLines(args) };
  }

  const loaded = loadConfigFiles(paths);

  if (name === 'preset') {
    const presetName = (args[0] ?? '').toLowerCase() as keyof typeof CONFIG_PRESETS;
    if (!Object.hasOwn(CONFIG_PRESETS, presetName)) {
      return { lines: [`Usage: hud preset <${Object.keys(CONFIG_PRESETS).join('|')}>`], failed: true };
    }
    const nextConfig = presetName === 'full' ? {} : structuredClone(CONFIG_PRESETS[presetName]);
    return { lines: [`Applied preset "${presetName}" to ${paths.config}`], config: nextConfig };
  }

  if (name === 'set') {
    if (args.length === 0) {
      return { lines: ['Usage: hud set <key>=<value> ... | hud set --reset [<key>] | hud set --undo'], failed: true };
    }
    if (args.includes('--reset') && args.length === 1) {
      return { lines: ['Reset config.json to defaults.'], config: {} };
    }
    const nextBase = structuredClone(loaded.base);
    const errors: string[] = [];
    const changes: string[] = [];
    for (const { key, rawValue } of parseAssignment(args)) {
      if (CAPABILITY_KEYS.has(key)) {
        errors.push(`${key} can only be edited directly in ${paths.config}`);
        continue;
      }
      if (rawValue === null) {
        setNested(nextBase, key, undefined);
        changes.push(`Reset ${key} to default`);
        continue;
      }
      const entry = configKey(key);
      if (!entry) {
        errors.push(`Unknown config key: ${key}. Run \`hud schema\` to list valid keys.`);
        continue;
      }
      const parsed = entry.freeText ? rawValue : parseUserValue(rawValue);
      const err = checkValue(key, parsed);
      if (err) {
        errors.push(err);
        continue;
      }
      setNested(nextBase, key, parsed);
      changes.push(`${key} = ${JSON.stringify(parsed)}`);
    }
    if (errors.length > 0) return { lines: errors, failed: true };
    return { lines: changes, config: nextBase };
  }

  if (name === 'preview') {
    const tempBase = structuredClone(loaded.base);
    for (const { key, rawValue } of parseAssignment(args)) {
      if (rawValue !== null && configKey(key)) {
        const entry = configKey(key)!;
        const parsed = entry.freeText ? rawValue : parseUserValue(rawValue);
        if (!checkValue(key, parsed)) setNested(tempBase, key, parsed);
      }
    }
    const merged = mergeConfig(mergeOverrides(tempBase, loaded.override) as Partial<HudConfig>);
    const probeAnswers = await ask(['agy.quota', 'agy.unicode']);
    const quota = (probeAnswers['agy.quota'] as AgyQuotaProbe | null) ?? null;
    const unicodeSupported = typeof probeAnswers['agy.unicode'] === 'boolean' ? probeAnswers['agy.unicode'] : true;
    const stdin = sampleStdin(facts);
    const rendered = renderPlain(buildPreviewContext(stdin, merged, quota, unicodeSupported, now), getTerminalWidth(), now);
    return { lines: rendered.split('\n') };
  }

  const probeAnswers = await ask(['agy.quota']);
  const quota = (probeAnswers['agy.quota'] as AgyQuotaProbe | null) ?? null;
  const auth = readAuthInfo(paths.claudeJson, facts.account);

  const findings: string[] = [...loaded.problems];
  if (!facts.runtime.supported) {
    findings.push(`Runtime ${facts.runtime.name} ${facts.runtime.version} is below Node 22.18+.`);
  }
  if (!facts.heartbeat) {
    findings.push('No render heartbeat recorded yet (run Antigravity CLI with HUD enabled first).');
  } else if (facts.heartbeat.outcome && facts.heartbeat.outcome !== 'ok') {
    findings.push(`Last render outcome: ${facts.heartbeat.outcome}`);
  }
  if (!facts.account.email && !quota?.models?.length && !quota?.providerQuota) {
    const reason = quota?.unavailableReason ?? 'not_logged_in';
    findings.push(`Antigravity quota unavailable (${reason}).`);
  }
  if (!fs.existsSync(paths.config)) {
    findings.push('No user config.json found (using defaults).');
  }

  if (name === 'doctor') {
    const payload = {
      runtime: facts.runtime,
      plugin: facts.plugin,
      runtimes: facts.runtimes,
      configPath: facts.configPath,
      configOverrides: configDiff(loaded.base),
      account: { tier: facts.account.tier, signedIn: Boolean(facts.account.email || quota?.models?.length), authMethod: auth.method },
      quota: {
        modelsCount: quota?.models?.length ?? 0,
        hasProviderQuota: Boolean(quota?.providerQuota),
        unavailableReason: quota?.unavailableReason ?? null,
        updateAvailable: quota?.updateInfo?.updateAvailable ?? false,
        latestVersion: quota?.updateInfo?.latestVersion ?? null,
      },
      lastRender: facts.heartbeat
        ? { at: facts.heartbeat.at, runtime: facts.heartbeat.runtime, path: facts.heartbeat.path, outcome: facts.heartbeat.outcome }
        : null,
      findings,
    };
    return { lines: [JSON.stringify(payload)], failed: loaded.problems.length > 0 };
  }

  // `report`: scrubbed diagnostic case payload for bug reports
  const reportPayload = {
    plugin: { version: facts.plugin.version },
    runtime: { name: facts.runtime.name, version: facts.runtime.version, supported: facts.runtime.supported },
    platform: process.platform,
    config: scrubUnknown(configDiff(loaded.base), facts),
    problems: loaded.problems.map((p) => scrubText(p, facts)),
    lastRender: scrubUnknown(
      facts.heartbeat
        ? { at: facts.heartbeat.at, outcome: facts.heartbeat.outcome, columns: facts.heartbeat.columns }
        : null,
      facts,
    ),
    quotaSummary: {
      modelsCount: quota?.models?.length ?? 0,
      hasProviderQuota: Boolean(quota?.providerQuota),
      unavailableReason: quota?.unavailableReason ?? null,
      tier: facts.account.tier ?? null,
    },
    findings: findings.map((f) => scrubText(f, facts)),
  };
  return { lines: [JSON.stringify(reportPayload)] };
}

export { getNested };
