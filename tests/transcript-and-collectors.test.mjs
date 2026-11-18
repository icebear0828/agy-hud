import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseTranscript, addSubagentEfforts } from '../src/transcript.ts';
import { calculateTokenCost, getSessionCostUsd } from '../src/cost.ts';
import { getCostTotals } from '../src/daily-cost.ts';
import { getOutputSpeed } from '../src/speed.ts';
import { resolveUsagePaces } from '../src/usage-pace.ts';
import { getUsageFromExternalSnapshot, externalUsageSnapshot } from '../src/external-usage.ts';
import { getGitStatus, parseNumstat } from '../src/git.ts';
import { getJjStatus } from '../src/jj.ts';
import { deriveAuthInfo, formatAuthSegment, readAuthInfo } from '../src/auth.ts';
import { agyQuotaToUsageData, mergeAgyQuotaProbe } from '../src/agy-quota.ts';
import { countConfigs } from '../src/config-reader.ts';
import { mergeConfig } from '../src/config.ts';

describe('transcript / Claude + Antigravity JSONL & incremental cursor resume', () => {
  test('parses Claude transcript + incremental checkpoint append + MCP error tracking + skills + agents + todos', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tx-claude-'));
    try {
      const dataDir = path.join(tmp, 'data');
      const txPath = path.join(tmp, 'session.jsonl');
      const chunk1 = [
        JSON.stringify({ type: 'user', timestamp: '2026-11-18T10:00:00Z' }),
        JSON.stringify({
          type: 'assistant',
          timestamp: '2026-11-18T10:00:05Z',
          message: {
            id: 'm1',
            model: 'claude-sonnet-4-6',
            usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 500, cache_creation_input_tokens: 100 },
            content: [
              { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/src/a.ts' } },
              { type: 'tool_use', id: 't2', name: 'Skill', input: { skill: 'brainstorming' } },
              { type: 'tool_use', id: 't3', name: 'Agent', input: { subagent_type: 'reviewer', description: 'audit diff' } },
              { type: 'tool_use', id: 't4', name: 'TodoWrite', input: { todos: [{ content: 'Fix bug', status: 'in_progress' }] } },
              { type: 'tool_use', id: 't5', name: 'mcp__github__list_issues', input: {} },
            ],
          },
        }),
        JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: false }, { type: 'tool_result', tool_use_id: 't5', is_error: true }] } }),
      ].join('\n') + '\n';

      fs.writeFileSync(txPath, chunk1);
      const first = await parseTranscript(txPath, dataDir);
      assert.equal(first.tools[0].status, 'completed');
      assert.equal(first.tools[0].target, '/src/a.ts');
      assert.deepEqual(first.skills, ['brainstorming']);
      assert.deepEqual(first.mcpServers, ['github']);
      assert.deepEqual(first.mcpErrors, ['github']);
      assert.equal(first.agents[0].status, 'running');
      assert.equal(first.todos[0].content, 'Fix bug');
      assert.equal(first.sessionTokens.inputTokens, 1000);

      // Append new line -> resumes via saved inode+offset cursor without duplicating tokens!
      const chunk2 = JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 't3', is_error: false }] },
      }) + '\n';
      fs.appendFileSync(txPath, chunk2);
      const second = await parseTranscript(txPath, dataDir);
      assert.equal(second.agents[0].status, 'completed');
      assert.equal(second.sessionTokens.inputTokens, 1000);

      // Subagent effort lookup
      const subDir = path.join(tmp, 'subagents');
      fs.mkdirSync(subDir, { recursive: true });
      fs.writeFileSync(path.join(subDir, 'agent-a123.jsonl'), `${JSON.stringify({ type: 'assistant', effort: 'high' })}\n`);
      const agents = [{ id: '1', type: 'research', status: 'running', startTime: new Date(), agentId: 'a123' }];
      await addSubagentEfforts(subDir, agents);
      assert.equal(agents[0].effort, 'high');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('parses Antigravity transcript events (USER_INPUT, PLANNER_RESPONSE, JSON-quoted args, steps, 429 image quota)', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tx-agy-'));
    try {
      const txPath = path.join(tmp, 'transcript.jsonl');
      const futureReset = new Date(Date.now() + 252_000).toISOString();
      const lines = [
        JSON.stringify({
          type: 'USER_INPUT',
          step_index: 1,
          created_at: '2026-11-18T09:00:00Z',
          content: 'User changed setting `Model Selection` from Gemini Flash to Gemini 3 Pro (High).\nUser changed setting `Agent Mode` from Planning to accept-edits.',
        }),
        JSON.stringify({
          type: 'PLANNER_RESPONSE',
          step_index: 2,
          created_at: '2026-11-18T09:00:06Z',
          model: 'gemini-3-pro',
          input_tokens: 1200,
          output_tokens: 300,
          cache_read_input_tokens: 800,
          tool_calls: [{ name: 'read_file', args: { Path: '"/src/main.ts"' } }, { name: 'mcp_tavily_search', args: {} }],
        }),
        JSON.stringify({
          type: 'GENERIC',
          status: 'ERROR',
          error: { status: 'RESOURCE_EXHAUSTED', quotaResetTimeStamp: futureReset },
        }),
      ];
      fs.writeFileSync(txPath, `${lines.join('\n')}\n`);
      const res = await parseTranscript(txPath, path.join(tmp, 'data'));
      assert.equal(res.steps, 2);
      assert.equal(res.transcriptModelSelection, 'Gemini 3 Pro (High)');
      assert.equal(res.transcriptMode, 'accept-edits');
      assert.equal(res.mcpServers.includes('tavily'), true);
      assert.equal(res.tools[0].target, '/src/main.ts');
      assert.equal(res.imageExhausted?.exhausted, true);
      assert.equal(res.imageExhausted?.resetTime, futureReset);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('cost, daily-cost (calendar weeklyCostPeriod), speed, usage-pace, external-usage', () => {
  test('computes native and token-estimated costs + honors calendar weeklyCostPeriod reset boundaries', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cost-test-'));
    try {
      const dataDir = path.join(tmp, 'data');
      assert.equal(getSessionCostUsd({ cost: { total_cost_usd: 1.23 } }, undefined), 1.23);
      assert.ok((calculateTokenCost('claude-sonnet-4-6', { input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 0 }) ?? 0) > 2.5);

      const monMorning = Date.parse('2026-11-16T08:00:00');
      const r1 = getCostTotals(
        { session_id: 's1', cost: { total_cost_usd: 2.0 } },
        { weeklyCostPeriod: 'monday' },
        { dataDir: () => dataDir, now: () => monMorning },
      );
      assert.equal(r1?.todayUsd, 0);

      const t1 = getCostTotals(
        { session_id: 's1', cost: { total_cost_usd: 5.5 } },
        { weeklyCostPeriod: 'monday' },
        { dataDir: () => dataDir, now: () => monMorning + 60_000 },
      );
      assert.equal(t1?.todayUsd, 3.5);
      assert.equal(t1?.weekUsd, 3.5);

      // Next Monday resets previous week's $3.50 balance when tracking a new session spend!
      const nextMon = Date.parse('2026-11-23T09:00:00');
      getCostTotals(
        { session_id: 's2', cost: { total_cost_usd: 0 } },
        { weeklyCostPeriod: 'monday' },
        { dataDir: () => dataDir, now: () => nextMon },
      );
      const w2 = getCostTotals(
        { session_id: 's2', cost: { total_cost_usd: 1.0 } },
        { weeklyCostPeriod: 'monday' },
        { dataDir: () => dataDir, now: () => nextMon + 60_000 },
      );
      assert.equal(w2?.weekUsd, 1.0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('computes speed delta, usage pace warnings, and external usage snapshot R/W', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'speed-ext-'));
    try {
      const dataDir = path.join(tmp, 'data');
      const baseStdin = {
        transcript_path: '/tmp/tx.jsonl',
        cost: { total_api_duration_ms: 1000 },
        context_window: { current_usage: { input_tokens: 10, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
      };
      assert.equal(getOutputSpeed(baseStdin, dataDir), null);
      const speed2 = getOutputSpeed({
        ...baseStdin,
        cost: { total_api_duration_ms: 3000 },
        context_window: { current_usage: { input_tokens: 10, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 1 } },
      }, dataDir);
      assert.equal(speed2, 50);

      const now = Date.parse('2026-11-18T12:00:00Z');
      // 4h elapsed in 5h window? No, 1h elapsed (resets in 4h) and 80% used -> projected 400% (critical!)
      const paces = resolveUsagePaces(
        { fiveHour: 80, sevenDay: 10, fiveHourResetAt: new Date(now + 4 * 3600_000), sevenDayResetAt: new Date(now + 6 * 86400_000) },
        [],
        { usagePace: true },
        now,
      );
      assert.equal(paces.fiveHour, 'critical');
      assert.equal(paces.alert, true);

      const cfg = mergeConfig({ display: { externalUsageFreshnessMs: 60_000 } });
      const snap = externalUsageSnapshot({ text: null, mtimeMs: null }, { fiveHour: 30, sevenDay: 12, fiveHourResetAt: new Date(now + 3600_000), sevenDayResetAt: null }, now);
      assert.ok(snap);
      const parsedExt = getUsageFromExternalSnapshot(JSON.stringify(snap), cfg, now + 1000);
      assert.equal(parsedExt?.fiveHour, 30);
      assert.equal(getUsageFromExternalSnapshot(JSON.stringify(snap), cfg, now + 120_000), null);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('vcs (git/jj), auth, agy-quota, and config-reader', () => {
  test('parses git porcelain v2 + numstat + github branch URLs and jj status', async () => {
    const porcelain = '# branch.head feat/test\u0000# branch.ab +2 -1\u00001 .M N... 100644 100644 100644 h1 h2 src/a.ts\u0000? untracked.txt\u0000';
    const numstat = '5\t2\tsrc/a.ts\u0000';
    const git = await getGitStatus(async ([probe]) => {
      if (probe === 'git.status') return { 'git.status': { stdout: porcelain } };
      if (probe === 'git.numstat') return { 'git.numstat': { stdout: numstat } };
      return {};
    }, { lineDiffs: true, repo: { host: 'github.com', owner: 'yuwenlong', name: 'agy-hud' } });
    assert.equal(git?.branch, 'feat/test');
    assert.equal(git?.ahead, 2);
    assert.equal(git?.lineDiff?.added, 5);
    assert.match(git?.branchUrl ?? '', /https:\/\/github\.com\/yuwenlong\/agy-hud\/tree\/feat\/test/);
    assert.equal(parseNumstat('-\t-\tbin.png\u0000').size, 0);

    const jj = await getJjStatus(async () => ({ jj: 'abc\u001fmain\u001f1\u001f0\n' }));
    assert.deepEqual(jj, { branch: 'main', isDirty: true, ahead: 0, behind: 0, vcs: 'jj', conflict: false });
  });

  test('auth, agy-quota merge + UsageData conversion, and config-reader counts work seamlessly', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-cfg-'));
    try {
      const derived = deriveAuthInfo({ oauthAccount: { organizationType: 'claude_max', organizationRateLimitTier: 'tier_20x', emailAddress: 'alice@example.com' } }, {});
      assert.equal(derived.method, 'Claude Max 20x');
      assert.equal(formatAuthSegment(derived, { showAuth: true, showAuthUser: true, authUserLength: 3 }), 'Claude Max 20x · ali…');

      const probe = mergeAgyQuotaProbe(null, {
        model: { id: 'gemini-3-pro' },
        quota: { 'gemini-5h': { remaining_fraction: 0.75, reset_time: '2026-11-18T14:00:00Z' } },
      }, Date.parse('2026-11-18T12:00:00Z'));
      const usage = agyQuotaToUsageData(probe, { model: { id: 'gemini-3-pro' } }, Date.parse('2026-11-18T12:00:00Z'));
      assert.equal(usage?.fiveHour, 25);

      const agentsMd = path.join(tmp, 'AGENTS.md');
      fs.writeFileSync(agentsMd, '# rules');
      const rulesDir = path.join(tmp, '.gemini', 'rules');
      fs.mkdirSync(rulesDir, { recursive: true });
      fs.writeFileSync(path.join(rulesDir, 'a.md'), 'r');
      const c = countConfigs({
        user: { claudeMd: path.join(tmp, 'x'), geminiMd: path.join(tmp, 'y'), rules: path.join(tmp, 'z'), agyRules: path.join(tmp, 'w'), settings: path.join(tmp, 's'), agySettings: path.join(tmp, 'as') },
        project: {
          claudeMd: path.join(tmp, 'no1'), localMd: path.join(tmp, 'no2'), agentsMd, geminiMd: path.join(tmp, 'no3'), memoryMd: path.join(tmp, 'no4'),
          mcpJson: path.join(tmp, '.mcp.json'), localAgyHudConfig: path.join(tmp, 'no5'), dotClaudeMd: null, dotLocalMd: path.join(tmp, 'no6'),
          rules: null, geminiRules: rulesDir, agentsRules: path.join(tmp, 'ar'), cursorRules: path.join(tmp, 'cr'), githubRules: path.join(tmp, 'gr'),
          settings: null, localSettings: path.join(tmp, 'ls'),
        },
        projectMemory: null,
        claudeJson: path.join(tmp, 'cj'),
      });
      assert.equal(c.claudeMdCount, 1);
      assert.equal(c.memoryLabelName, 'AGENTS.md');
      assert.equal(c.rulesCount, 1);
      assert.equal(readAuthInfo(path.join(tmp, 'missing'), { email: 'bob@example.com', tier: 'Pro' }).email, 'bob@example.com');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
