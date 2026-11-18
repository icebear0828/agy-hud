import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
          showEffortLevel: false, showClaudeCodeVersion: false, showOutputStyle: false, usageCompact: false,
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
    assert.match(rich, /Tokens 30k \(in: 12k, out: 3k, cache: 15k\)/);
    assert.match(rich, /Skills \(1\): brainstorming/);
    assert.match(rich, /MCPs \(2\): codegraph, ✗ tavily/);
    assert.match(rich, /reviewer:high/);
  });

  test('supports zh-Hans, zh-Hant, compact layout, and Antigravity table/models/compact quota styles', () => {
    const zhHans = stripAnsi(renderPlain(baseCtx({ config: mergeConfig({ language: 'zh-Hans', lineLayout: 'compact', display: { showCost: true, showSpeed: true } }) }), 200, NOW));
    assert.match(zhHans, /35%/);
    assert.match(zhHans, /\$0\.42/);

    const zhHant = stripAnsi(renderPlain(baseCtx({ config: mergeConfig({ language: 'zh-Hant', display: { usageCompact: false } }) }), 140, NOW));
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

    const wrapped = wrapToWidth('AAAA │ BBBB │ CCCC │ DDDD', 14);
    assert.ok(wrapped.length >= 2);
    assert.ok(wrapped.every((row) => visibleWidth(row) <= 14));
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

    const doc = spawnSync(process.execPath, ['hud.mjs', 'doctor'], { cwd: projectRoot, encoding: 'utf8' });
    assert.equal(doc.status, 0);
    assert.equal(JSON.parse(doc.stdout).plugin.version, '0.4.1');
  });
});
