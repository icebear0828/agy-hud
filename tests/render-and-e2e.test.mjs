import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { mergeConfig } from '../src/config.ts';
import { renderPlain } from '../src/render/index.ts';
import { stripAnsi, visibleWidth, wrapToWidth } from '../src/render/ansi.ts';
import { extraCmdLabel } from '../src/extra-cmd.ts';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const NOW = Date.parse('2026-11-18T10:00:00Z');

function baseCtx(overrides = {}) {
  return {
    stdin: {
      model: { id: 'gemini-3-pro', display_name: 'Gemini 3 Pro (High)' },
      cwd: '/work/my-repo',
      workspace: { current_dir: '/work/my-repo', project_dir: '/work' },
      context_window: {
        context_window_size: 200_000,
        used_percentage: 35,
        current_usage: { input_tokens: 50_000, output_tokens: 4_000, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 5_000 },
      },
      cost: { total_cost_usd: 0.42, total_duration_ms: 185_000 },
    },
    transcript: {
      steps: 7,
      tools: [
        { id: '1', name: 'Read', target: '/work/my-repo/src/main.ts', status: 'running', startTime: new Date(NOW - 2000) },
        { id: '2', name: 'Edit', status: 'completed', startTime: new Date(NOW - 10_000), endTime: new Date(NOW - 8000) },
      ],
      skills: ['brainstorming'],
      mcpServers: ['codegraph'],
      mcpErrors: ['tavily'],
      agents: [{ id: 'a1', type: 'reviewer', effort: 'high', description: 'check diff', status: 'running', startTime: new Date(NOW - 12_000) }],
      todos: [{ content: 'Finish tests', status: 'in_progress' }],
      sessionStart: new Date(NOW - 300_000),
      lastAssistantResponseAt: new Date(NOW - 15_000),
      sessionTokens: { inputTokens: 12_000, outputTokens: 3_000, cacheCreationTokens: 0, cacheReadTokens: 15_000 },
    },
    claudeMdCount: 1,
    memoryLabelName: 'AGENTS.md',
    rulesCount: 2,
    mcpCount: 2,
    hooksCount: 1,
    agentsCount: 2,
    costTotals: { todayUsd: 2.5, weekUsd: 12.75 },
    outputSpeed: 54.2,
    gitStatus: { branch: 'main', isDirty: true, ahead: 1, behind: 0 },
    usageData: {
      fiveHour: 20,
      sevenDay: 45,
      fiveHourResetAt: new Date(NOW + 90 * 60_000),
      sevenDayResetAt: new Date(NOW + 4 * 86400_000),
    },
    agyQuota: {
      models: [
        {
          id: 'gemini-3-pro',
          displayName: 'Gemini 3 Pro (High)',
          remainingFraction: 0.8,
          resetTime: new Date(NOW + 90 * 60_000).toISOString(),
          modelProvider: 'MODEL_PROVIDER_GOOGLE',
          windows: {
            fiveHour: { remainingFraction: 0.8, resetTime: new Date(NOW + 90 * 60_000).toISOString() },
            weekly: { remainingFraction: 0.55, resetTime: new Date(NOW + 4 * 86400_000).toISOString() },
          },
        },
        {
          id: 'gemini-3-image',
          displayName: 'Gemini 3 Image',
          remainingFraction: 0.9,
          resetTime: new Date(NOW + 180 * 60_000).toISOString(),
          modelProvider: 'MODEL_PROVIDER_GOOGLE',
        },
      ],
      providerQuota: {
        google: {
          fiveHour: { remainingFraction: 0.8, resetTime: new Date(NOW + 90 * 60_000).toISOString() },
          weekly: { remainingFraction: 0.55, resetTime: new Date(NOW + 4 * 86400_000).toISOString() },
        },
        claude: {
          fiveHour: { remainingFraction: 0.95, resetTime: new Date(NOW + 60 * 60_000).toISOString() },
          weekly: { remainingFraction: 0.7, resetTime: new Date(NOW + 5 * 86400_000).toISOString() },
        },
      },
      unavailableReason: null,
      tierName: 'Google AI Pro',
      accountEmail: 'dev@example.com',
      updateInfo: { updateAvailable: true, latestVersion: '0.5.0' },
    },
    memoryUsage: { totalBytes: 16 * 1024 ** 3, usedBytes: 8 * 1024 ** 3, freeBytes: 8 * 1024 ** 3, usedPercent: 50 },
    authInfo: { method: 'Claude Max', user: 'devuser', email: 'dev@example.com' },
    config: mergeConfig({}),
    extraLabel: extraCmdLabel('build ok'),
    unicodeSupported: true,
    ...overrides,
  };
}

describe('render / expanded, compact, i18n, colors, quota styles, wrapping', () => {
  test('default full configuration renders rich telemetry while minimal preset stays 2 lines', () => {
    const minimal = stripAnsi(renderPlain(baseCtx({
      agyQuota: { ...baseCtx().agyQuota, updateInfo: null },
      config: mergeConfig({
        language: 'en',
        gitStatus: { enabled: true, showDirty: true, showAheadBehind: false, showFileStats: false },
        display: {
          showTools: false, showSkills: false, showMcp: false, showAgents: false, showTodos: false,
          showConfigCounts: false, showCost: false, showDuration: false, showSpeed: false,
          showMemoryUsage: false, showPromptCache: false, showSessionTokens: false, showCompactions: false,
          showEffortLevel: false, showClaudeCodeVersion: false, showOutputStyle: false,
          quotaStyle: 'minimal', usageValue: 'percent', usageDecimals: false, usageCompact: false,
          sevenDayThreshold: 80,
        },
      }),
    }), 140, NOW));
    const lines = minimal.split('\n');
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^\[Gemini 3 Pro \(High\)\] │ my-repo git:\(main\*\) │ build ok$/);
    assert.match(lines[1], /^Context .* 35% │ Usage .* 20% \(resets in 1h 30m\)$/);

    const rich = stripAnsi(renderPlain(baseCtx({ agyQuota: { ...baseCtx().agyQuota, updateInfo: null } }), 160, NOW));
    assert.match(rich, /\[Gemini 3 Pro \(High\)\]/);
    assert.match(rich, /Google 5h\s+█████░\s+80\.00%/);
    assert.match(rich, /Google week\s+███░░░\s+55\.00%/);
    assert.match(rich, /Claude 5h\s+██████\s+95\.00%/);
    assert.match(rich, /Tokens 30k \(in: 12k, out: 3k, cache: 15k\)/);
    assert.match(rich, /Skills \(1\): brainstorming/);
    assert.match(rich, /MCPs \(2\): codegraph, ✗ tavily/);
    assert.match(rich, /reviewer:high/);
  });

  test('renders Gemini 4 Argon multi-provider remaining table by default and labels Argon 7d in minimal mode', () => {
    const argonStdin = {
      ...baseCtx().stdin,
      model: { id: 'gemini-4-argon-medium', display_name: 'Gemini 4 Argon (Medium)' },
      quota: {
        'gemini-5h': { remaining_fraction: 1, reset_time: new Date(NOW + 5 * 3600_000).toISOString() },
        'gemini-weekly': { remaining_fraction: 0.6063206, reset_time: new Date(NOW + 156 * 3600_000).toISOString() },
        '3p-5h': { remaining_fraction: 0.99999, reset_time: new Date(NOW + 5 * 3600_000).toISOString() },
        '3p-weekly': { remaining_fraction: 0.57, reset_time: new Date(NOW + 6 * 86400_000).toISOString() },
        'gemini-argon-wtu-weekly': { remaining_fraction: 1, reset_time: new Date(NOW + 7 * 86400_000).toISOString() },
      },
    };
    const argonProbe = {
      models: [],
      providerQuota: {
        google: {
          fiveHour: { remainingFraction: 1, resetTime: argonStdin.quota['gemini-5h'].reset_time },
          weekly: { remainingFraction: 0.6063206, resetTime: argonStdin.quota['gemini-weekly'].reset_time },
        },
        claude: {
          fiveHour: { remainingFraction: 0.99999, resetTime: argonStdin.quota['3p-5h'].reset_time },
          weekly: { remainingFraction: 0.57, resetTime: argonStdin.quota['3p-weekly'].reset_time },
        },
        argon: {
          weekly: { remainingFraction: 1, resetTime: argonStdin.quota['gemini-argon-wtu-weekly'].reset_time },
        },
      },
      unavailableReason: null,
      tierName: 'Google AI Pro',
      accountEmail: null,
      updateInfo: null,
    };
    const argonUsage = {
      fiveHour: null,
      sevenDay: 0,
      fiveHourResetAt: null,
      sevenDayResetAt: new Date(NOW + 7 * 86400_000),
      sevenDayLabel: 'Argon 7d',
      fiveHourRemainingExact: null,
      sevenDayRemainingExact: 100,
    };

    const tableOut = stripAnsi(renderPlain(baseCtx({
      stdin: argonStdin,
      agyQuota: argonProbe,
      usageData: argonUsage,
    }), 140, NOW));
    assert.doesNotMatch(tableOut, /Context .* │ .* 7d:/);
    assert.match(tableOut, /Google 5h\s+██████\s+100\.00%/);
    assert.match(tableOut, /Google week\s+████░░\s+60\.63%/);
    assert.match(tableOut, /Claude 5h\s+██████\s+99\.99%/);
    assert.match(tableOut, /Claude week\s+███░░░\s+57\.00%/);
    assert.match(tableOut, /Argon week\s+██████\s+100\.00%\s+~7d/);

    const minimalArgon = stripAnsi(renderPlain(baseCtx({
      stdin: argonStdin,
      agyQuota: argonProbe,
      usageData: argonUsage,
      config: mergeConfig({ display: { quotaStyle: 'minimal' } }),
    }), 140, NOW));
    assert.match(minimalArgon, /Argon 7d: 100\.00% \(7d\)/);
  });

  test('supports zh-Hans, zh-Hant, compact layout, and Antigravity table/models/compact quota styles', () => {
    const zhHans = stripAnsi(renderPlain(baseCtx({ config: mergeConfig({ language: 'zh-Hans', lineLayout: 'compact', display: { showCost: true, showSpeed: true } }) }), 200, NOW));
    assert.match(zhHans, /35%/);
    assert.match(zhHans, /\$0\.42/);

    const zhHant = stripAnsi(renderPlain(baseCtx({ config: mergeConfig({ language: 'zh-Hant', display: { quotaStyle: 'minimal', usageCompact: false } }) }), 140, NOW));
    assert.match(zhHant, /上下文/);
    assert.match(zhHant, /用量/);

    const table = stripAnsi(renderPlain(baseCtx({
      config: mergeConfig({ display: { quotaStyle: 'table', showImageQuota: true, showTier: true, showSessionSteps: true, showUpdateNotice: true } }),
    }), 140, NOW));
    assert.match(table, /Google AI Pro/);
    assert.match(table, /⚡7/);
    assert.match(table, /⟳ v0\.5\.0/);
    assert.match(table, /Google 5h/);
    assert.match(table, /Claude week/);
    assert.match(table, /Image Quota:/);

    const models = stripAnsi(renderPlain(baseCtx({ config: mergeConfig({ display: { quotaStyle: 'models' } }) }), 140, NOW));
    assert.match(models, /Gemini 3 Pro\(High\)/);

    const compactBars = stripAnsi(renderPlain(baseCtx({ config: mergeConfig({ display: { quotaStyle: 'compact' } }) }), 140, NOW));
    assert.match(compactBars, /Google:/);

    // Expired model quota window recovers to 100.00% instead of falling back to expired top-level 0%
    const expiredPast = new Date(NOW - 10_000).toISOString();
    const expiredModelsOut = stripAnsi(renderPlain(baseCtx({
      config: mergeConfig({ display: { quotaStyle: 'models' } }),
      agyQuota: {
        ...baseCtx().agyQuota,
        models: [
          {
            id: 'gemini-3-pro',
            displayName: 'Gemini 3 Pro (High)',
            remainingFraction: 0,
            resetTime: expiredPast,
            modelProvider: 'MODEL_PROVIDER_GOOGLE',
            windows: {
              fiveHour: { remainingFraction: 0, resetTime: expiredPast },
            },
          },
        ],
      },
    }), 140, NOW));
    assert.match(expiredModelsOut, /Gemini 3 Pro\(High\)\s+██████\s+100\.00%/);

    // imageQuotaLine renders dynamic countdown while active and clears Exhausted once resetTime <= f.now
    const activeExhaustedOut = stripAnsi(renderPlain(baseCtx({
      config: mergeConfig({ language: 'en', display: { showImageQuota: true } }),
      transcript: {
        ...baseCtx().transcript,
        imageExhausted: { exhausted: true, resetTime: new Date(NOW + 4 * 60_000).toISOString() },
      },
    }), 140, NOW));
    assert.match(activeExhaustedOut, /Image Quota: Image Quota Exhausted \(4m\)/);

    const expiredExhaustedOut = stripAnsi(renderPlain(baseCtx({
      config: mergeConfig({ language: 'en', display: { showImageQuota: true } }),
      transcript: {
        ...baseCtx().transcript,
        imageExhausted: { exhausted: true, resetTime: expiredPast },
      },
    }), 140, NOW));
    assert.doesNotMatch(expiredExhaustedOut, /Exhausted/);
    assert.match(expiredExhaustedOut, /Image Quota: Gemini 3 Image .* 90%/);
  });

  test('renders custom colors (256-color & #hex), activity lines, rightAlign, and wraps wide lines cleanly', () => {
    const colored = renderPlain(baseCtx({
      config: mergeConfig({
        colors: { model: '#ff8800', project: 141 },
        elementOrder: ['project', 'context', 'usage', 'cost', 'tools', 'skills', 'mcp', 'agents', 'todos', 'memory', 'sessionTokens', 'environment', 'sessionTime'],
        display: {
          mergeGroups: [['context', 'cost']],
          rightAlign: ['cost'],
          showTools: true,
          showSkills: true,
          showMcp: true,
          showAgents: true,
          showAgentEffort: true,
          showTodos: true,
          showCost: true,
          showMemoryUsage: true,
          showSessionTokens: true,
          showConfigCounts: true,
          showSessionStartDate: true,
          showLastResponseAt: true,
          showCacheHitRate: true,
          showPromptCache: true,
        },
      }),
    }), 120, NOW);
    assert.ok(colored.includes('\x1b[38;2;255;136;0m'));
    assert.ok(colored.includes('\x1b[38;5;141m'));
    const plain = stripAnsi(colored);
    assert.match(plain, /Read/);
    assert.match(plain, /Skills \(1\): brainstorming/);
    assert.match(plain, /MCPs \(2\): codegraph/);
    assert.match(plain, /reviewer:high/);
    assert.match(plain, /Finish tests/);
    assert.match(plain, /Approx RAM/);
    assert.match(plain, /1 AGENTS\.md/);
    assert.match(plain, /2 agents/);

    const completedAgent = stripAnsi(renderPlain(baseCtx({
      config: mergeConfig({ language: 'zh-Hans', display: { showAgentEffort: true } }),
      memoryLabelName: 'GEMINI.md',
      claudeMdCount: 2,
      transcript: {
        ...baseCtx().transcript,
        agents: [
          {
            id: 'a2',
            type: 'worker',
            model: 'gemini-4-hydrogen',
            effort: 'high',
            description: '清查配置',
            status: 'completed',
            startTime: new Date(NOW - 34_000),
            endTime: new Date(NOW),
          },
        ],
      },
    }), 160, NOW));
    assert.match(completedAgent, /2 GEMINI\.md/);
    assert.match(completedAgent, /2 Agents/);
    assert.doesNotMatch(completedAgent, /✓ worker|清查配置/);

    const mixedAgents = stripAnsi(renderPlain(baseCtx({
      config: mergeConfig({ language: 'zh-Hans', display: { showAgentEffort: true } }),
      transcript: {
        ...baseCtx().transcript,
        agents: [
          {
            id: 'a2-done',
            type: 'worker',
            model: 'gemini-4-hydrogen',
            effort: 'high',
            description: '清查配置',
            status: 'completed',
            startTime: new Date(NOW - 34_000),
            endTime: new Date(NOW),
          },
          {
            id: 'a2-live',
            type: 'coder',
            model: 'gemini-4-hydrogen',
            effort: 'high',
            description: '修复逻辑',
            status: 'running',
            startTime: new Date(NOW - 12_000),
          },
        ],
      },
    }), 160, NOW));
    assert.match(mixedAgents, /◐ coder \[Gemini 4 Hydrogen:high\] \(修复逻辑\) 12s/);
    assert.doesNotMatch(mixedAgents, /✓ worker|清查配置/);

    const inheritAgent = stripAnsi(renderPlain(baseCtx({
      config: mergeConfig({ language: 'zh-Hans', display: { showAgentEffort: true } }),
      transcript: {
        ...baseCtx().transcript,
        agents: [
          {
            id: 'a3',
            type: 'research',
            model: 'inherit',
            description: '保留继承',
            status: 'running',
            startTime: new Date(NOW - 5_000),
          },
        ],
      },
    }), 160, NOW));
    assert.match(inheritAgent, /◐ research \(保留继承\) 5s/);
    assert.doesNotMatch(inheritAgent, /\[inherit\]/);

    const wrapped = wrapToWidth('AAAA │ BBBB │ CCCC │ DDDD', 14);
    assert.ok(wrapped.length >= 2);
    assert.ok(wrapped.every((row) => visibleWidth(row) <= 14));
  });

  test('renders each running subagent on its own line in expanded and compact layouts', () => {
    const agents = [
      { id: 'b1', type: 'scout', description: 'scan repo', status: 'running', startTime: new Date(NOW - 419_000) },
      { id: 'b2', type: 'scout', description: 'scan docs', status: 'running', startTime: new Date(NOW - 419_000) },
      { id: 'b3', type: 'reviewer', description: 'check diff', status: 'running', startTime: new Date(NOW - 12_000) },
    ];
    for (const lineLayout of ['expanded', 'compact']) {
      const plain = stripAnsi(renderPlain(baseCtx({
        config: mergeConfig({ lineLayout, display: { showAgents: true } }),
        transcript: { ...baseCtx().transcript, agents },
      }), 160, NOW));
      const rows = plain.split('\n');
      const agentRows = rows.filter((row) => /◐ (scout|reviewer)/.test(row));
      assert.equal(agentRows.length, agents.length, `${lineLayout}: expected one row per subagent in ${plain}`);
      assert.equal(rows.filter((row) => row.includes('scout')).length, 2);
      assert.equal(rows.filter((row) => row.includes('reviewer')).length, 1);
      for (const row of rows) assert.ok(!row.includes('│ ◐'), `${lineLayout}: subagents must not share a row: ${row}`);
    }

    const manyRunning = Array.from({ length: 6 }, (_, i) => ({
      id: `o${i}`, type: 'coder', description: `task ${i}`, status: 'running', startTime: new Date(NOW - 5_000),
    }));
    for (const lineLayout of ['expanded', 'compact']) {
      const rendered = stripAnsi(renderPlain(baseCtx({
        config: mergeConfig({ lineLayout, display: { showAgents: true } }),
        transcript: { ...baseCtx().transcript, agents: manyRunning },
      }), 160, NOW));
      const rows = rendered.split('\n');
      const coderRows = rows.filter((row) => row.includes('◐ coder'));
      assert.equal(coderRows.length, manyRunning.length, `${lineLayout}: expected all ${manyRunning.length} running coder rows`);
      for (let i = 0; i < manyRunning.length; i += 1) {
        assert.equal(coderRows[i], `◐ coder (task ${i}) 5s`, `${lineLayout}: missing or misordered running coder row ${i}`);
        assert.ok(!coderRows[i].includes('│'), `${lineLayout}: running subagent row must not contain separator: ${coderRows[i]}`);
      }
      assert.doesNotMatch(rendered, /\+\d+\s+running/, `${lineLayout}: must not render any +N running truncation line`);
    }
  });

  test('hides completed subagents and keeps running subagents and project out of mergeGroups', () => {
    const completed = [
      { id: 'c1', type: 'scout', description: 'old scan', status: 'completed', startTime: new Date(NOW - 30_000), endTime: new Date(NOW - 20_000) },
      { id: 'c2', type: 'coder', description: 'write fix', status: 'completed', startTime: new Date(NOW - 18_000), endTime: new Date(NOW - 10_000) },
      { id: 'c3', type: 'reviewer', description: 'audit fix', status: 'completed', startTime: new Date(NOW - 9_000), endTime: new Date(NOW - 1_000) },
    ];
    for (const lineLayout of ['expanded', 'compact']) {
      const plain = stripAnsi(renderPlain(baseCtx({
        config: mergeConfig({ lineLayout, display: { showAgents: true } }),
        transcript: { ...baseCtx().transcript, agents: completed },
      }), 160, NOW));
      const rows = plain.split('\n');
      const agentRows = rows.filter((row) => /^[✓◐] (scout|coder|reviewer)\b/.test(row));
      assert.equal(agentRows.length, 0, `${lineLayout}: completed subagents must produce 0 agent rows in ${plain}`);
      assert.doesNotMatch(plain, /\b(scout|coder|reviewer)\b|old scan|write fix|audit fix/);
    }

    const agents = [
      { id: 'm0', type: 'worker', description: 'finished setup', status: 'completed', startTime: new Date(NOW - 30_000), endTime: new Date(NOW - 20_000) },
      { id: 'm1', type: 'scout', description: 'scan repo', status: 'running', startTime: new Date(NOW - 10_000) },
      { id: 'm2', type: 'scout', description: 'scan docs', status: 'running', startTime: new Date(NOW - 8_000) },
      { id: 'm3', type: 'coder', description: 'write fix', status: 'completed', startTime: new Date(NOW - 15_000), endTime: new Date(NOW - 6_000) },
      { id: 'm4', type: 'reviewer', description: 'check diff', status: 'running', startTime: new Date(NOW - 5_000) },
      { id: 'm5', type: 'planner', description: 'plan next', status: 'running', startTime: new Date(NOW - 3_000) },
    ];
    const runningCount = agents.filter((a) => a.status === 'running').length;
    const mergedCfg = mergeConfig({
      display: { showAgents: true, mergeGroups: [['agents', 'todos'], ['tools', 'agents']] },
    });
    assert.deepEqual(mergedCfg.display.mergeGroups, [['context', 'usage']]);

    const rawFrameCfg = mergeConfig({ display: { showAgents: true } });
    rawFrameCfg.display.mergeGroups = [['agents', 'todos'], ['tools', 'agents']];

    for (const [labelName, cfg] of [['normalized', mergedCfg], ['unnormalized-frame', rawFrameCfg]]) {
      const plain = stripAnsi(renderPlain(baseCtx({
        config: cfg,
        transcript: { ...baseCtx().transcript, agents },
      }), 160, NOW));
      const rows = plain.split('\n');
      const agentRows = rows.filter((row) => /^◐ (scout|reviewer|planner)\b/.test(row));
      assert.equal(agentRows.length, runningCount, `${labelName}: expected one row per running subagent in ${plain}`);
      assert.doesNotMatch(plain, /✓\s*(?:worker|coder|scout|reviewer|planner)|worker|finished setup|coder|write fix|\+\d+\s+running/);
      for (const row of agentRows) {
        assert.ok(!row.includes('│'), `${labelName}: subagent row must not contain separator: ${row}`);
        assert.ok(
          !row.includes('Finish tests') && !row.includes('Read') && !row.includes('Edit'),
          `${labelName}: subagent row must not merge with tools or todos: ${row}`,
        );
      }
      const toolsRow = rows.find((row) => row.includes('Read') && row.includes('Edit'));
      const todosRow = rows.find((row) => row.includes('Finish tests'));
      assert.ok(toolsRow, `${labelName}: expected tools row`);
      assert.ok(todosRow, `${labelName}: expected todos row`);
      assert.notEqual(toolsRow, todosRow, `${labelName}: tools and todos should remain separate`);
      assert.ok(!/\b(worker|scout|coder|reviewer|planner)\b/.test(toolsRow), `${labelName}: tools row must not include subagents`);
      assert.ok(!/\b(worker|scout|coder|reviewer|planner)\b/.test(todosRow), `${labelName}: todos row must not include subagents`);
    }

    const mixedGroupCfg = mergeConfig({
      display: { showAgents: true, mergeGroups: [['agents', 'tools', 'todos']] },
    });
    assert.deepEqual(mixedGroupCfg.display.mergeGroups, [['tools', 'todos']]);
    const mixedRawCfg = mergeConfig({ display: { showAgents: true } });
    mixedRawCfg.display.mergeGroups = [['agents', 'tools', 'todos']];
    for (const [labelName, cfg] of [['mixed-normalized', mixedGroupCfg], ['mixed-unnormalized', mixedRawCfg]]) {
      const plain = stripAnsi(renderPlain(baseCtx({
        config: cfg,
        transcript: { ...baseCtx().transcript, agents },
      }), 160, NOW));
      const rows = plain.split('\n');
      const agentRows = rows.filter((row) => /^◐ (scout|reviewer|planner)\b/.test(row));
      assert.equal(agentRows.length, runningCount, `${labelName}: expected each running subagent on its own row`);
      assert.doesNotMatch(plain, /✓\s*(?:worker|coder|scout|reviewer|planner)|worker|finished setup|coder|write fix|\+\d+\s+running/);
      for (const row of agentRows) {
        assert.ok(!row.includes('│'), `${labelName}: subagent row must not contain separator: ${row}`);
      }
      assert.ok(
        rows.some((row) => row.includes('Read') && row.includes('Finish tests') && !/\b(worker|scout|coder|reviewer|planner)\b/.test(row)),
        `${labelName}: mergeable members tools and todos should still merge without agents`,
      );
    }

    const projectGroupCfg = mergeConfig({
      language: 'en',
      display: { quotaStyle: 'minimal', mergeGroups: [['project', 'context', 'usage']] },
    });
    assert.deepEqual(projectGroupCfg.display.mergeGroups, [['context', 'usage']]);
    const projectRawCfg = mergeConfig({ language: 'en', display: { quotaStyle: 'minimal' } });
    projectRawCfg.display.mergeGroups = [['project', 'context', 'usage']];
    for (const [labelName, cfg] of [['project-normalized', projectGroupCfg], ['project-unnormalized', projectRawCfg]]) {
      const rows = stripAnsi(renderPlain(baseCtx({ config: cfg }), 160, NOW)).split('\n');
      const projectRow = rows.find((row) => row.includes('[Gemini 3 Pro (High)]'));
      const contextRow = rows.find((row) => row.includes('Context'));
      assert.ok(projectRow && !projectRow.includes('Context'), `${labelName}: project row must not merge with context`);
      assert.ok(contextRow && contextRow.includes('5h:') && !contextRow.includes('Gemini 3 Pro'), `${labelName}: context and usage should merge without project`);
    }
  });

  test('CLI entrypoint handles piped stdin, empty stdin, baseline env, and /hud subcommands cleanly', () => {
    const payload = JSON.stringify({
      model: { id: 'gemini-3-pro', display_name: 'Gemini 3 Pro' },
      cwd: projectRoot,
      context_window: { context_window_size: 200_000, used_percentage: 12 },
    });
    const res = spawnSync(process.execPath, ['hud.mjs'], {
      cwd: projectRoot,
      input: `${payload}\n`,
      encoding: 'utf8',
    });
    assert.equal(res.status, 0, res.stderr);
    const plain = stripAnsi(res.stdout).replace(/\u00A0/g, ' ');
    assert.match(plain, /\[Gemini 3 Pro\]/);
    assert.match(plain, /12%/);

    const empty = spawnSync(process.execPath, ['hud.mjs'], { cwd: projectRoot, input: '', encoding: 'utf8' });
    assert.equal(empty.status, 0);
    assert.equal(empty.stdout, '');

    const baseline = spawnSync(process.execPath, ['hud.mjs'], {
      cwd: projectRoot,
      input: '',
      env: { ...process.env, AGY_HUD_BASELINE_ON_EMPTY: '1' },
      encoding: 'utf8',
    });
    assert.equal(baseline.status, 0);
    assert.match(stripAnsi(baseline.stdout), /0%/);

    const pkgVer = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')).version;
    const doc = spawnSync(process.execPath, ['hud.mjs', 'doctor'], { cwd: projectRoot, encoding: 'utf8' });
    assert.equal(doc.status, 0);
    assert.equal(JSON.parse(doc.stdout).plugin.version, pkgVer);

    // End-to-end runCage execution with isolated fake HOME containing config/agents + brain subagent transcript
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-sub-e2e-'));
    try {
      const agyCli = path.join(fakeHome, '.gemini', 'antigravity-cli');
      const agentsDir = path.join(fakeHome, '.gemini', 'config', 'agents');
      fs.mkdirSync(path.join(agentsDir, 'worker'), { recursive: true });
      fs.writeFileSync(path.join(agentsDir, 'worker', 'agent.md'), '# worker');
      const mainConv = 'conv-main-12345678';
      const subConv = 'conv-sub-87654321';
      fs.mkdirSync(path.join(agyCli, 'brain', mainConv, '.system_generated', 'logs'), { recursive: true });
      fs.mkdirSync(path.join(agyCli, 'brain', subConv, '.system_generated', 'logs'), { recursive: true });
      fs.writeFileSync(path.join(fakeHome, '.gemini', 'GEMINI.md'), '# g');
      fs.writeFileSync(
        path.join(agyCli, 'brain', subConv, '.system_generated', 'logs', 'transcript.jsonl'),
        `${JSON.stringify({ type: 'PLANNER_RESPONSE', model: 'gemini-4-hydrogen-tiered-high' })}\n`,
      );
      const mainTranscript = path.join(agyCli, 'brain', mainConv, '.system_generated', 'logs', 'transcript.jsonl');
      fs.writeFileSync(
        mainTranscript,
        [
          JSON.stringify({
            type: 'PLANNER_RESPONSE',
            created_at: '2026-11-18T10:00:00Z',
            tool_calls: [{ name: 'invoke_subagent', args: { TypeName: '"worker"', Role: '"Scan"', Model: '"inherit"' } }],
          }),
          JSON.stringify({
            type: 'GENERIC',
            created_at: '2026-11-18T10:00:01Z',
            content: `Created the following subagent:\n{\n  "conversationId": "${subConv}"\n}`,
          }),
        ].join('\n') + '\n',
      );
      const subPayload = JSON.stringify({
        model: { id: 'gemini-4-hydrogen-xhigh', display_name: 'Gemini 4 Hydrogen (XHigh)' },
        cwd: projectRoot,
        conversation_id: mainConv,
        context_window: { context_window_size: 200_000, used_percentage: 20 },
      });
      const subEnv = { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome, AGY_HUD_DATA_DIR: agyCli, LANG: 'zh_CN.UTF-8' };
      const subRes = spawnSync(process.execPath, ['hud.mjs'], {
        cwd: projectRoot,
        input: `${subPayload}\n`,
        env: subEnv,
        encoding: 'utf8',
      });
      assert.equal(subRes.status, 0, subRes.stderr);
      const subPlain = stripAnsi(subRes.stdout).replace(/\u00A0/g, ' ');
      assert.match(subPlain, /1 GEMINI\.md/);
      assert.match(subPlain, /1 Agents/);
      assert.match(subPlain, /◐ worker \[Gemini 4 Hydrogen:high\] \(Scan\) \d+[hms]/);

      fs.appendFileSync(
        mainTranscript,
        `${JSON.stringify({
          type: 'SYSTEM_MESSAGE',
          created_at: '2026-11-18T10:00:10Z',
          content: `[Message] sender=${subConv} content=ok`,
        })}\n`,
      );
      const subDoneRes = spawnSync(process.execPath, ['hud.mjs'], {
        cwd: projectRoot,
        input: `${subPayload}\n`,
        env: subEnv,
        encoding: 'utf8',
      });
      assert.equal(subDoneRes.status, 0, subDoneRes.stderr);
      const subDonePlain = stripAnsi(subDoneRes.stdout).replace(/\u00A0/g, ' ');
      assert.match(subDonePlain, /1 GEMINI\.md/);
      assert.match(subDonePlain, /1 Agents/);
      assert.doesNotMatch(subDonePlain, /[✓◐]\s*worker|worker\s+\[Gemini 4 Hydrogen|\(Scan\)/);
    } finally {
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});
