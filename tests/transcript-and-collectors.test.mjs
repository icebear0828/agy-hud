import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseTranscript, addSubagentEfforts, extractMarkdownTodos } from '../src/transcript.ts';
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
          tool_calls: [
            { name: 'read_file', args: { Path: '"/src/main.ts"' } },
            { name: 'read_file', args: { Path: '"/home/u/.gemini/config/plugins/superpowers/skills/brainstorming/SKILL.md"' } },
            { name: 'mcp_tavily_search', args: {} },
            { name: 'invoke_subagent', args: { TypeName: 'reviewer', Role: 'Audit code', Model: 'gemini-3-pro' } },
            { name: 'write_file', args: { Path: '"/tmp/ai-tasks/todo.md"', Content: '"- [x] Step 1\\n- [/] Step 2"' } },
          ],
        }),
        JSON.stringify({
          type: 'GENERIC',
          status: 'DONE',
          content: 'Launched subagent conversationId: sub-uuid-1234',
        }),
        JSON.stringify({
          type: 'SYSTEM_MESSAGE',
          step_index: 3,
          created_at: '2026-11-18T09:00:20Z',
          content: '<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-18T09:00:20Z sender=sub-uuid-1234 content=finished',
        }),
        JSON.stringify({
          type: 'GENERIC',
          status: 'ERROR',
          error: { status: 'RESOURCE_EXHAUSTED', quotaResetTimeStamp: futureReset },
        }),
      ];
      fs.writeFileSync(txPath, `${lines.join('\n')}\n`);
      const res = await parseTranscript(txPath, path.join(tmp, 'data'));
      assert.equal(res.steps, 3);
      assert.equal(res.transcriptModelSelection, 'Gemini 3 Pro (High)');
      assert.equal(res.transcriptMode, 'accept-edits');
      assert.equal(res.mcpServers.includes('tavily'), true);
      assert.equal(res.skills.includes('superpowers:brainstorming'), true);
      assert.equal(res.agents[0]?.type, 'reviewer');
      assert.equal(res.agents[0]?.status, 'completed');
      assert.equal(res.todos.length, 2);
      assert.equal(res.tools[0].target, '/src/main.ts');
      assert.equal(res.imageExhausted?.exhausted, true);
      assert.equal(res.imageExhausted?.resetTime, futureReset);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('pairs concurrent Antigravity subagents FIFO, ignores file reads containing conversationId, and extracts agy subagent model/effort', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tx-agy-multi-'));
    try {
      const txPath = path.join(tmp, 'transcript.jsonl');
      const workerTx = path.join(tmp, 'worker-transcript.jsonl');
      fs.writeFileSync(workerTx, `${JSON.stringify({
        type: 'PLANNER_RESPONSE',
        step_index: 1,
        created_at: '2026-11-18T09:00:05Z',
        model: 'gemini-4-hydrogen-tiered-high',
      })}\n`);

      const lines = [
        JSON.stringify({
          type: 'PLANNER_RESPONSE',
          step_index: 1,
          created_at: '2026-11-18T09:00:00Z',
          tool_calls: [
            { name: 'invoke_subagent', args: { TypeName: '"worker"', Role: '"Scan configs"', Model: '"inherit"' } },
            { name: 'read_file', args: { Path: '"/src/transcript.ts"' } },
            { name: 'invoke_subagent', args: { TypeName: '"reviewer"', Role: '"Audit changes"', Model: '"flash"' } },
          ],
        }),
        JSON.stringify({
          type: 'GENERIC',
          status: 'DONE',
          content: 'Created At: 2026-11-18T15:00:51+08:00\nCreated the following subagent:\n{\n  "conversationId":  "sub-worker-11111111",\n  "logAbsoluteUri":  "file:///tmp/x"\n}',
        }),
        JSON.stringify({
          type: 'GENERIC',
          status: 'DONE',
          content: 'Created At: 2026-11-18T15:00:52+08:00\nShowing lines 1-5 of 5\n1: const x = "conversationId: fake";',
        }),
        JSON.stringify({
          type: 'GENERIC',
          status: 'DONE',
          content: 'Created At: 2026-11-18T15:00:53+08:00\nCreated the following subagent:\n{\n  "conversationId":  "sub-review-22222222"\n}',
        }),
        JSON.stringify({
          type: 'SYSTEM_MESSAGE',
          step_index: 2,
          created_at: '2026-11-18T09:00:12Z',
          content: '<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-18T09:00:12Z sender=sub-worker-11111111 priority=MESSAGE_PRIORITY_HIGH content=done',
        }),
      ];
      fs.writeFileSync(txPath, `${lines.join('\n')}\n`);
      const res = await parseTranscript(txPath, path.join(tmp, 'data'));
      assert.equal(res.tools[0]?.name, 'read_file');
      assert.equal(res.tools[0]?.status, 'completed');
      assert.equal(res.agents.length, 2);
      assert.equal(res.agents[0]?.agentId, 'sub-worker-11111111');
      assert.equal(res.agents[0]?.status, 'completed');
      assert.equal(res.agents[0]?.model, undefined);
      assert.equal(res.agents[1]?.agentId, 'sub-review-22222222');
      assert.equal(res.agents[1]?.status, 'running');
      assert.equal(res.agents[1]?.model, 'flash');

      await addSubagentEfforts('', res.agents, { 'sub-worker-11111111': workerTx });
      assert.equal(res.agents[0]?.model, 'gemini-4-hydrogen');
      assert.equal(res.agents[0]?.effort, 'high');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('extractMarkdownTodos ignores fenced code blocks, splits top-level sections, aggregates ### subheadings, and selects active section', () => {
    const md = [
      '# 历史任务：版本 0.4.9',
      '### 执行清单',
      '- [x] 旧任务 A',
      '- [x] 旧任务 B',
      '```markdown',
      '# 伪造章节',
      '- [ ] 代码块里的假未完成项',
      '```',
      '---',
      '## 当前任务：版本 0.4.10',
      '### 阶段一',
      '- [x] 修复 collector 授权',
      '- [/] 修复 transcript 解析',
      '### 阶段二',
      '* [ ] 补充单元测试',
      '* [ ] 运行回归校验',
    ].join('\n');

    const active = extractMarkdownTodos(md);
    assert.deepEqual(active, [
      { content: '修复 collector 授权', status: 'completed' },
      { content: '修复 transcript 解析', status: 'in_progress' },
      { content: '补充单元测试', status: 'pending' },
      { content: '运行回归校验', status: 'pending' },
    ]);

    // When all sections are completed, picks the last section containing todos (never mixes historical [x])
    const allDoneMd = md.replace('- [/]', '- [x]').replaceAll('* [ ]', '* [x]');
    const allDone = extractMarkdownTodos(allDoneMd);
    assert.equal(allDone.length, 4);
    assert.equal(allDone.every((t) => t.status === 'completed'), true);
    assert.equal(allDone[0].content, '修复 collector 授权');

    // When a hint matches an earlier section, selects the last matching section
    const hinted = extractMarkdownTodos(md, '- [x] 旧任务 B');
    assert.deepEqual(hinted, [
      { content: '旧任务 A', status: 'completed' },
      { content: '旧任务 B', status: 'completed' },
    ]);
  });

  test('parseTranscript updates todos from edit_file/replace_file_content/multi_replace_file_content, disk fallback on truncated_fields, and respects TodoWrite tool source', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tx-todo-e2e-'));
    try {
      const dataDir = path.join(tmp, 'data');
      const txPath = path.join(tmp, 'transcript.jsonl');
      const diskTodoPath = path.join(tmp, 'todo.md');

      // 1. write_file with truncated_fields in transcript, while real todo.md exists on disk
      fs.writeFileSync(
        diskTodoPath,
        [
          '# 历史章节',
          '- [x] 历史 1',
          '---',
          '## 本轮任务',
          '- [ ] 任务 1',
          '- [ ] 任务 2',
          '- [ ] 任务 3',
          '- [ ] 任务 4',
        ].join('\n') + '\n',
      );

      fs.writeFileSync(
        txPath,
        `${JSON.stringify({
          type: 'PLANNER_RESPONSE',
          step_index: 1,
          created_at: '2026-11-18T10:00:00Z',
          tool_calls: [{ name: 'write_file', args: { Path: JSON.stringify(diskTodoPath), Content: '"... [truncated]"' } }],
        })}\n`,
      );

      const r1 = await parseTranscript(txPath, dataDir);
      assert.equal(r1.todos.length, 4);
      assert.equal(r1.todos.filter((t) => t.status === 'completed').length, 0);

      // 2. edit_file updates disk todo.md to (2/4) and transcript logs edit_file
      fs.writeFileSync(
        diskTodoPath,
        [
          '# 历史章节',
          '- [x] 历史 1',
          '---',
          '## 本轮任务',
          '- [x] 任务 1',
          '- [x] 任务 2',
          '- [/] 任务 3',
          '- [ ] 任务 4',
        ].join('\n') + '\n',
      );
      fs.appendFileSync(
        txPath,
        `${JSON.stringify({
          type: 'PLANNER_RESPONSE',
          step_index: 2,
          created_at: '2026-11-18T10:00:10Z',
          tool_calls: [
            {
              name: 'edit_file',
              args: {
                Path: JSON.stringify(diskTodoPath),
                Target: '"- [ ] 任务 1\\n- [ ] 任务 2\\n- [ ] 任务 3"',
                Replacement: '"- [x] 任务 1\\n- [x] 任务 2\\n- [/] 任务 3"',
              },
            },
          ],
        })}\n`,
      );

      const r2 = await parseTranscript(txPath, dataDir);
      assert.equal(r2.todos.length, 4);
      assert.equal(r2.todos.filter((t) => t.status === 'completed').length, 2);
      assert.equal(r2.todos[2].status, 'in_progress');

      // 3. Even when transcript.jsonl has 0 new bytes (cursor hit), disk change to (4/4) is picked up before return
      fs.writeFileSync(
        diskTodoPath,
        [
          '# 历史章节',
          '- [x] 历史 1',
          '---',
          '## 本轮任务',
          '- [x] 任务 1',
          '- [x] 任务 2',
          '- [x] 任务 3',
          '- [x] 任务 4',
        ].join('\n') + '\n',
      );
      const r3 = await parseTranscript(txPath, dataDir);
      assert.equal(r3.todos.length, 4);
      assert.equal(r3.todos.every((t) => t.status === 'completed'), true);

      // 4. Pure in-memory fallback when disk file does not exist (ENOENT) across edit_file, replace_file_content, multi_replace_file_content
      const ghostTodoPath = path.join(tmp, 'nonexistent-dir', 'task.md');
      fs.appendFileSync(
        txPath,
        [
          JSON.stringify({
            type: 'PLANNER_RESPONSE',
            step_index: 3,
            tool_calls: [
              {
                name: 'write_to_file',
                args: { TargetFile: ghostTodoPath, CodeContent: '"- [ ] Mem 1\\n- [ ] Mem 2\\n- [ ] Mem 3"' },
              },
              {
                name: 'replace_file_content',
                args: { TargetFile: ghostTodoPath, TargetContent: '"- [ ] Mem 1"', ReplacementContent: '"- [x] Mem 1"' },
              },
              {
                name: 'multi_replace_file_content',
                args: {
                  TargetFile: ghostTodoPath,
                  ReplacementChunks: JSON.stringify([
                    { TargetContent: '- [ ] Mem 2', ReplacementContent: '- [/] Mem 2' },
                    { TargetContent: '- [ ] Mem 3', ReplacementContent: '- [x] Mem 3' },
                  ]),
                },
              },
            ],
          }),
        ].join('\n') + '\n',
      );

      const r4 = await parseTranscript(txPath, dataDir);
      assert.deepEqual(r4.todos, [
        { content: 'Mem 1', status: 'completed' },
        { content: 'Mem 2', status: 'in_progress' },
        { content: 'Mem 3', status: 'completed' },
      ]);

      // 5. Claude TodoWrite sets lastTodoSource = 'tool' and persists across cursor resume so old disk .md does not overwrite it
      fs.appendFileSync(
        txPath,
        `${JSON.stringify({
          type: 'assistant',
          message: {
            id: 'm-todo-tool',
            content: [{ type: 'tool_use', id: 'tu-1', name: 'TodoWrite', input: { todos: [{ content: 'Tool task', status: 'in_progress' }] } }],
          },
        })}\n`,
      );
      const r5 = await parseTranscript(txPath, dataDir);
      assert.deepEqual(r5.todos, [{ content: 'Tool task', status: 'in_progress' }]);

      // 6. Claude tool_use block invoking write_file/edit_file with relative path 'ai-tasks/todo.md' or '~/ai-tasks/todo.md' resolves via todoFiles parameter
      const resolvedWorkspaceTodo = path.join(tmp, 'workspace', 'ai-tasks', 'todo.md');
      fs.mkdirSync(path.dirname(resolvedWorkspaceTodo), { recursive: true });
      fs.writeFileSync(resolvedWorkspaceTodo, '- [x] Resolved 1\n- [/] Resolved 2\n');

      fs.appendFileSync(
        txPath,
        `${JSON.stringify({
          type: 'assistant',
          message: {
            id: 'm-claude-write-file',
            content: [
              {
                type: 'tool_use',
                id: 'tu-2',
                name: 'write_file',
                input: { Path: 'ai-tasks/todo.md', Content: '...truncated...' },
              },
            ],
          },
        })}\n`,
      );
      const r6 = await parseTranscript(txPath, dataDir, [fs.realpathSync(resolvedWorkspaceTodo)]);
      assert.deepEqual(r6.todos, [
        { content: 'Resolved 1', status: 'completed' },
        { content: 'Resolved 2', status: 'in_progress' },
      ]);

      // Claude tool_use edit_file with '~/ai-tasks/todo.md' also resolves via todoFiles
      fs.writeFileSync(resolvedWorkspaceTodo, '- [x] Resolved 1\n- [x] Resolved 2\n');
      fs.appendFileSync(
        txPath,
        `${JSON.stringify({
          type: 'assistant',
          message: {
            id: 'm-claude-edit-file',
            content: [
              {
                type: 'tool_use',
                id: 'tu-3',
                name: 'edit_file',
                input: { Path: '~/ai-tasks/todo.md', Target: '- [/] Resolved 2', Replacement: '- [x] Resolved 2' },
              },
            ],
          },
        })}\n`,
      );
      const r7 = await parseTranscript(txPath, dataDir, [fs.realpathSync(resolvedWorkspaceTodo)]);
      assert.deepEqual(r7.todos, [
        { content: 'Resolved 1', status: 'completed' },
        { content: 'Resolved 2', status: 'completed' },
      ]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('detectRateLimits extracts resetTime from string entry.content (quotaResetTimeStamp, quotaResetDelay/retryDelay, Resets in / try again in)', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tx-ratelimit-str-'));
    try {
      const dataDir = path.join(tmp, 'data');
      const txPath = path.join(tmp, 'transcript.jsonl');
      const baseIso = '2026-11-18T09:00:00.000Z';
      const baseMs = Date.parse(baseIso);

      // 1. String content with quotaResetDelay
      fs.writeFileSync(
        txPath,
        `${JSON.stringify({
          type: 'GENERIC',
          status: 'ERROR',
          created_at: baseIso,
          content: 'Error: HTTP 429 RESOURCE_EXHAUSTED {"quotaResetDelay":"2m30s"}',
        })}\n`,
      );
      const r1 = await parseTranscript(txPath, dataDir);
      assert.equal(r1.imageExhausted?.exhausted, true);
      assert.equal(r1.imageExhausted?.resetTime, new Date(baseMs + 150_000).toISOString());

      // 2. String content with "Resets in 1h 5m" advances resetTime
      fs.appendFileSync(
        txPath,
        `${JSON.stringify({
          type: 'GENERIC',
          status: 'ERROR',
          created_at: baseIso,
          content: 'HTTP 429 Too Many Requests. Resets in 1h 5m.',
        })}\n`,
      );
      const r2 = await parseTranscript(txPath, dataDir);
      assert.equal(r2.imageExhausted?.resetTime, new Date(baseMs + (60 + 5) * 60_000).toISOString());

      // 3. String content with explicit quotaResetTimeStamp advances resetTime
      const explicitIso = new Date(baseMs + 2 * 3600_000).toISOString();
      fs.appendFileSync(
        txPath,
        `${JSON.stringify({
          type: 'GENERIC',
          status: 'ERROR',
          created_at: baseIso,
          content: `RESOURCE_EXHAUSTED: {"quotaResetTimeStamp": "${explicitIso}"}`,
        })}\n`,
      );
      const r3 = await parseTranscript(txPath, dataDir);
      assert.equal(r3.imageExhausted?.resetTime, explicitIso);
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
    }, { lineDiffs: true, repo: { host: 'github.com', owner: 'icebear0828', name: 'agy-hud' } });
    assert.equal(git?.branch, 'feat/test');
    assert.equal(git?.ahead, 2);
    assert.equal(git?.lineDiff?.added, 5);
    assert.match(git?.branchUrl ?? '', /https:\/\/github\.com\/icebear0828\/agy-hud\/tree\/feat\/test/);
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

      const argonProbe = mergeAgyQuotaProbe(null, {
        model: { id: 'gemini-4-argon-medium', display_name: 'Gemini 4 Argon (Medium)' },
        quota: {
          'gemini-5h': { remaining_fraction: 1, reset_time: '2026-11-18T17:00:00Z' },
          'gemini-weekly': { remaining_fraction: 0.6063206, reset_time: '2026-11-25T02:14:46Z' },
          'gemini-argon-wtu-weekly': { remaining_fraction: 1, reset_time: '2026-11-25T14:13:08Z' },
        },
      }, Date.parse('2026-11-18T12:00:00Z'));
      const argonUsage = agyQuotaToUsageData(argonProbe, {
        model: { id: 'gemini-4-argon-medium', display_name: 'Gemini 4 Argon (Medium)' },
      }, Date.parse('2026-11-18T12:00:00Z'));
      assert.equal(argonUsage?.fiveHour, null);
      assert.equal(argonUsage?.sevenDay, 0);
      assert.equal(argonUsage?.sevenDayRemainingExact, 100);
      assert.equal(argonUsage?.sevenDayLabel, 'Argon 7d');

      const agentsMd = path.join(tmp, 'AGENTS.md');
      fs.writeFileSync(agentsMd, '# rules');
      const rulesDir = path.join(tmp, '.gemini', 'rules');
      fs.mkdirSync(rulesDir, { recursive: true });
      fs.writeFileSync(path.join(rulesDir, 'a.md'), 'r');
      const agyMcp = path.join(tmp, 'agy_mcp.json');
      fs.writeFileSync(agyMcp, JSON.stringify({ mcpServers: { codegraph: {}, tavily: {} } }));
      const hookFile = path.join(tmp, 'hooks.json');
      fs.writeFileSync(hookFile, JSON.stringify({ 'rtk-rewrite': { enabled: true } }));

      const agyConfigAgents = path.join(tmp, '.gemini', 'config', 'agents');
      fs.mkdirSync(path.join(agyConfigAgents, 'reviewer'), { recursive: true });
      fs.mkdirSync(path.join(agyConfigAgents, 'worker'), { recursive: true });
      fs.writeFileSync(path.join(agyConfigAgents, 'reviewer', 'agent.md'), '# reviewer');
      fs.writeFileSync(path.join(agyConfigAgents, 'worker', 'agent.md'), '# worker');
      const claudeAgents = path.join(tmp, '.claude', 'agents');
      fs.mkdirSync(claudeAgents, { recursive: true });
      fs.writeFileSync(path.join(claudeAgents, 'reviewer.md'), '# duplicate name');

      const c = countConfigs({
        user: {
          claudeMd: path.join(tmp, 'x'), geminiMd: path.join(tmp, 'y'), rules: path.join(tmp, 'z'), agyRules: path.join(tmp, 'w'),
          agents: claudeAgents, agyConfigAgents,
          settings: path.join(tmp, 's'), agySettings: path.join(tmp, 'as'), agyMcpConfig: agyMcp, agyHookFiles: [hookFile],
        },
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
      assert.equal(c.mcpCount, 2);
      assert.equal(c.hooksCount, 1);
      assert.equal(c.agentsCount, 2);

      // When user has ~/.gemini/GEMINI.md + ~/.claude/CLAUDE.md and project has no memory files, GEMINI.md label wins
      const userClaudeMd = path.join(tmp, 'CLAUDE.md');
      const userGeminiMd = path.join(tmp, 'GEMINI.md');
      fs.writeFileSync(userClaudeMd, '# c');
      fs.writeFileSync(userGeminiMd, '# g');
      const cGem = countConfigs({
        user: {
          claudeMd: userClaudeMd, geminiMd: userGeminiMd, rules: path.join(tmp, 'z'), agyRules: path.join(tmp, 'w'),
          agyConfigAgents, settings: path.join(tmp, 's'), agySettings: path.join(tmp, 'as'),
        },
        project: {
          claudeMd: path.join(tmp, 'no1'), localMd: path.join(tmp, 'no2'), agentsMd: path.join(tmp, 'no0'), geminiMd: path.join(tmp, 'no3'), memoryMd: path.join(tmp, 'no4'),
          mcpJson: path.join(tmp, '.mcp.json'), localAgyHudConfig: path.join(tmp, 'no5'), dotClaudeMd: null, dotLocalMd: path.join(tmp, 'no6'),
          rules: null, geminiRules: path.join(tmp, 'no7'), agentsRules: path.join(tmp, 'ar'), cursorRules: path.join(tmp, 'cr'), githubRules: path.join(tmp, 'gr'),
          settings: null, localSettings: path.join(tmp, 'ls'),
        },
        projectMemory: null,
        claudeJson: path.join(tmp, 'cj'),
      });
      assert.equal(cGem.claudeMdCount, 2);
      assert.equal(cGem.memoryLabelName, 'GEMINI.md');
      assert.equal(cGem.agentsCount, 2);
      assert.equal(readAuthInfo(path.join(tmp, 'missing'), { email: 'bob@example.com', tier: 'Pro' }).email, 'bob@example.com');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
