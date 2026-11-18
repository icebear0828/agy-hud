import * as fs from 'node:fs';
import { createChannel, type Ask, type Paths, type Probe } from './channel.ts';
import { readAuthInfo } from './auth.ts';
import { agyQuotaToUsageData, mergeAgyQuotaProbe } from './agy-quota.ts';
import { runHudCommand } from './commands.ts';
import { loadConfigFiles } from './config.ts';
import { countConfigs } from './config-reader.ts';
import { getCostTotals } from './daily-cost.ts';
import { extraCmdLabel } from './extra-cmd.ts';
import { externalUsageSnapshot, getUsageFromExternalSnapshot, type UsageTarget } from './external-usage.ts';
import { getGitStatus } from './git.ts';
import { getJjStatus } from './jj.ts';
import { getMemoryUsage, readMemory, type MemoryFacts } from './memory.ts';
import { render } from './render/index.ts';
import { getOutputSpeed } from './speed.ts';
import { getUsageFromStdin } from './stdin.ts';
import { addSubagentEfforts, parseTranscript } from './transcript.ts';
import type { AgyQuotaProbe, RenderContext, StdinData, TranscriptData, UsageData } from './types.ts';
import { getTerminalWidth } from './utils/terminal.ts';

function requiredProbes(
  stdin: StdinData,
  config: RenderContext['config'],
): Probe[] {
  const probes: Probe[] = ['agy.unicode'];
  const cwd = stdin.workspace?.current_dir ?? stdin.cwd;

  if (cwd) {
    if (config.jjStatus.enabled) {
      probes.push('jj');
    }
    if (config.gitStatus.enabled) {
      probes.push('git.status');
      if (!stdin.workspace?.repo) probes.push('git.repo');
      if (config.gitStatus.showFileStats) probes.push('git.numstat');
    }
    if (config.display.showConfigCounts) {
      probes.push('git.hooks');
    }
  }

  if (config.display.showMemoryUsage) probes.push('memory');
  probes.push('extra');

  if (config.display.showUsage) {
    if (config.display.externalUsagePath) probes.push('usage.read');
    if (config.display.externalUsageWritePath) probes.push('usage.target');
    probes.push('agy.quota');
  } else if (
    config.display.showAuth ||
    config.display.showAuthUser ||
    config.display.showTier ||
    config.display.showUpdateNotice ||
    config.display.showImageQuota
  ) {
    probes.push('agy.quota');
  }

  return [...new Set(probes)];
}

function emptyTranscript(): TranscriptData {
  return { tools: [], skills: [], mcpServers: [], mcpErrors: [], agents: [], todos: [] };
}

function hasUsableStdinUsage(stdinUsage: UsageData | null): boolean {
  return Boolean(stdinUsage && (stdinUsage.fiveHour !== null || stdinUsage.sevenDay !== null));
}

function problemLine(problems: string[]): string | null {
  if (problems.length === 0) return null;
  const shown = problems.slice(0, 2).join('; ');
  const suffix = problems.length > 2 ? ` (+${problems.length - 2} more)` : '';
  return `[agy-hud config] ${shown}${suffix}`;
}

export async function renderStdin(
  stdin: StdinData,
  paths: Paths,
  ask: Ask,
  now = Date.now(),
): Promise<{ lines: string[]; snapshot: ReturnType<typeof externalUsageSnapshot>; failed: boolean }> {
  const loaded = loadConfigFiles(paths);
  const config = loaded.config;
  const needed = requiredProbes(stdin, config);

  const [probeAnswers, transcript] = await Promise.all([
    ask(needed),
    paths.transcript ? parseTranscript(paths.transcript, paths.data) : Promise.resolve(emptyTranscript()),
  ]);

  if (config.display.showAgents && config.display.showAgentEffort && paths.subagents && transcript.agents.length > 0) {
    await addSubagentEfforts(paths.subagents, transcript.agents);
  }

  const jjStatus = config.jjStatus.enabled ? await getJjStatus(async () => ({ jj: probeAnswers.jj } as Record<Probe, unknown>)) : null;
  const gitStatus = jjStatus
    ? jjStatus
    : config.gitStatus.enabled
      ? await getGitStatus(async (names) => {
          const out: Record<string, unknown> = {};
          for (const n of names) {
            out[n] = n in probeAnswers ? probeAnswers[n] : (await ask([n]))[n];
          }
          return out as Record<Probe, unknown>;
        }, {
          lineDiffs: config.gitStatus.showFileStats,
          repo: stdin.workspace?.repo ?? ((probeAnswers['git.repo'] as StdinData['workspace'] extends { repo?: infer R } ? R : never) ?? null),
        })
      : null;

  const counts = config.display.showConfigCounts
    ? countConfigs(paths)
    : { claudeMdCount: 0, rulesCount: 0, mcpCount: 0, hooksCount: 0 };
  const gitHooksCount = config.display.showConfigCounts && typeof probeAnswers['git.hooks'] === 'number'
    ? probeAnswers['git.hooks']
    : 0;

  const rawQuota = (probeAnswers['agy.quota'] as AgyQuotaProbe | null | undefined) ?? null;
  const agyQuota = mergeAgyQuotaProbe(rawQuota, stdin, now);

  const externalUsage = config.display.externalUsagePath
    ? getUsageFromExternalSnapshot(probeAnswers['usage.read'], config, now)
    : null;
  const stdinUsage = getUsageFromStdin(stdin);
  const agyUsage = agyQuotaToUsageData(agyQuota, stdin, now);

  const usageData = externalUsage ?? (hasUsableStdinUsage(stdinUsage) ? stdinUsage : agyUsage);
  const snapshot = config.display.externalUsageWritePath && hasUsableStdinUsage(stdinUsage)
    ? externalUsageSnapshot(probeAnswers['usage.target'] as UsageTarget, stdinUsage, now)
    : null;

  const costTotals = (config.display.showDailyCost || config.display.showWeeklyCost)
    ? getCostTotals(
        stdin,
        {
          allowRoutedCost: config.display.showRoutedCost,
          sevenDayResetAt: usageData?.sevenDayResetAt ?? null,
          weeklyCostPeriod: config.display.weeklyCostPeriod,
          transcript,
        },
        { dataDir: () => paths.data, now: () => now },
      )
    : null;

  const outputSpeed = config.display.showSpeed ? getOutputSpeed(stdin, paths.data, transcript) : null;
  const memoryUsage = config.display.showMemoryUsage
    ? getMemoryUsage(readMemory(probeAnswers.memory as MemoryFacts))
    : null;
  const extraLabel = extraCmdLabel(probeAnswers.extra);

  const authInfo = config.display.showAuth || config.display.showAuthUser
    ? readAuthInfo(paths.claudeJson, {
        email: agyQuota?.accountEmail ?? null,
        tier: agyQuota?.tierName ?? stdin.plan_tier ?? null,
      })
    : null;

  const unicodeSupported = typeof probeAnswers['agy.unicode'] === 'boolean' ? probeAnswers['agy.unicode'] : true;

  const ctx: RenderContext = {
    stdin,
    transcript,
    claudeMdCount: counts.claudeMdCount,
    memoryLabelName: counts.memoryLabelName,
    rulesCount: counts.rulesCount,
    mcpCount: counts.mcpCount,
    hooksCount: counts.hooksCount + gitHooksCount,
    costTotals,
    outputSpeed,
    gitStatus,
    usageData,
    agyQuota,
    memoryUsage,
    config,
    extraLabel,
    authInfo,
    unicodeSupported,
  };

  const rendered = render(ctx, getTerminalWidth(), now);
  const lines = rendered ? rendered.split('\n') : [];
  const warning = problemLine(loaded.problems);
  if (warning && lines.length > 0) lines.push(warning);
  else if (warning) lines.push(warning);

  return { lines, snapshot, failed: loaded.problems.length > 0 };
}

export async function runMain(): Promise<void> {
  const { init, ask, reply } = createChannel();
  const msg = await init;

  if (msg.command) {
    const result = await runHudCommand(msg.command, msg.paths, ask, msg.now);
    reply(result);
    return;
  }

  if (!msg.stdin) {
    reply({ lines: [] });
    return;
  }

  const out = await renderStdin(msg.stdin, msg.paths, ask, msg.now);
  reply(out);
}

const isEntrypoint = Boolean(process.argv[1] && process.argv[1].endsWith('main.ts') && !fs.lstatSync(process.argv[1], { throwIfNoEntry: false })?.isDirectory());
if (isEntrypoint) {
  await runMain();
}
