import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  addSubagentEfforts,
  parseTranscript,
  pruneCursors,
  reconcileAgentsWithStdin,
  writeCursor,
} from '../src/transcript.ts';
import { renderStdin } from '../src/main.ts';

function makeTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function emptyPaths(dataDir, transcriptPath = null) {
  return {
    data: dataDir,
    config: path.join(dataDir, 'nonexistent-config.json'),
    override: path.join(dataDir, 'nonexistent-override.json'),
    legacyConfig: path.join(dataDir, 'nonexistent-legacy.json'),
    heartbeat: path.join(dataDir, 'heartbeat.json'),
    claudeJson: path.join(dataDir, 'nonexistent-claude.json'),
    user: {
      claudeMd: path.join(dataDir, 'CLAUDE.md'),
      geminiMd: path.join(dataDir, 'GEMINI.md'),
      rules: path.join(dataDir, 'rules'),
      agyRules: path.join(dataDir, 'agy-rules'),
      settings: path.join(dataDir, 'settings.json'),
      agySettings: path.join(dataDir, 'agy-settings.json'),
    },
    project: null,
    projectMemory: null,
    transcript: transcriptPath,
    subagents: null,
  };
}

describe('transcript / subagents & cursors', () => {
  test('marks Antigravity subagents completed on idle/finished/completed/stopped/exited messages', async () => {
    const tmp = makeTmpDir('agy-hud-tx-idle-');
    try {
      const dataDir = path.join(tmp, 'data');
      const transcriptPath = path.join(tmp, 'transcript.jsonl');
      const lines = [
        JSON.stringify({
          type: 'PLANNER_RESPONSE',
          timestamp: '2026-11-19T09:00:00.000Z',
          tool_calls: [{ name: 'invoke_subagent', args: { TypeName: 'scout', Role: 'scan repo' } }],
        }),
        JSON.stringify({
          type: 'GENERIC',
          timestamp: '2026-11-19T09:00:01.000Z',
          content: 'Launched subagent conversationId: sub-idle-123456',
        }),
        JSON.stringify({
          type: 'SYSTEM_MESSAGE',
          timestamp: '2026-11-19T09:00:05.000Z',
          content: 'Subagent sub-idle-123456 has gone idle.',
        }),
        JSON.stringify({
          type: 'PLANNER_RESPONSE',
          timestamp: '2026-11-19T09:00:06.000Z',
          tool_calls: [{ name: 'invoke_subagent', args: { TypeName: 'coder', Role: 'fix bug' } }],
        }),
        JSON.stringify({
          type: 'GENERIC',
          timestamp: '2026-11-19T09:00:07.000Z',
          content: '{"conversationId":"sub-fin-98765432"}',
        }),
        JSON.stringify({
          type: 'USER_INPUT',
          timestamp: '2026-11-19T09:00:10.000Z',
          content: 'Subagent sub-fin-98765432 finished',
        }),
        JSON.stringify({
          type: 'PLANNER_RESPONSE',
          timestamp: '2026-11-19T09:00:11.000Z',
          tool_calls: [{ name: 'invoke_subagent', args: { TypeName: 'reviewer', Role: 'review pr' } }],
        }),
        JSON.stringify({
          type: 'GENERIC',
          timestamp: '2026-11-19T09:00:12.000Z',
          content: 'Created the following subagent: conversationId=sub-sender-112233',
        }),
        JSON.stringify({
          type: 'USER_INPUT',
          timestamp: '2026-11-19T09:00:15.000Z',
          content: '[Message] sender=sub-sender-112233 content=done',
        }),
      ];
      fs.writeFileSync(transcriptPath, `${lines.join('\n')}\n`);

      const data = await parseTranscript(transcriptPath, dataDir);
      assert.equal(data.agents.length, 3);
      assert.equal(data.agents[0].status, 'completed');
      assert.equal(data.agents[0].endTime?.toISOString(), '2026-11-19T09:00:05.000Z');
      assert.equal(data.agents[1].status, 'completed');
      assert.equal(data.agents[1].endTime?.toISOString(), '2026-11-19T09:00:10.000Z');
      assert.equal(data.agents[2].status, 'completed');
      assert.equal(data.agents[2].endTime?.toISOString(), '2026-11-19T09:00:15.000Z');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('reconcileAgentsWithStdin safely reconciles exact (name, role) and unambiguous single-side missing role', () => {
    const now = Date.parse('2026-11-19T10:00:00.000Z');

    // 1. Exact (name, role): keeps newest stillRunning and completes earlier excess
    const exactAgents = [
      { id: '1', type: 'coder', description: 'task A', status: 'running', startTime: new Date(now - 30_000) },
      { id: '2', type: 'coder', description: 'task A', status: 'running', startTime: new Date(now - 10_000) },
      { id: '3', type: 'coder', description: 'task B', status: 'running', startTime: new Date(now - 20_000) },
    ];
    reconcileAgentsWithStdin(
      exactAgents,
      [
        { name: 'coder', role: 'task A', status: 'idle' },
        { name: 'coder', role: 'task A', status: 'working' },
        { name: 'coder', role: 'task B', status: 'completed' },
      ],
      now,
    );
    assert.equal(exactAgents[0].status, 'completed');
    assert.equal(exactAgents[0].endTime?.getTime(), now);
    assert.equal(exactAgents[1].status, 'running');
    assert.equal(exactAgents[2].status, 'completed');

    // 2. Single-side missing role (stdin missing role, transcript has single unambiguous role)
    const stdinMissingRoleAgents = [
      { id: '1', type: 'scout', description: 'scan auth', status: 'running', startTime: new Date(now - 20_000) },
    ];
    reconcileAgentsWithStdin(stdinMissingRoleAgents, [{ name: 'scout', status: 'stopped' }], now);
    assert.equal(stdinMissingRoleAgents[0].status, 'completed');

    // 3. Single-side missing role (transcript missing role, stdin has single unambiguous role)
    const txMissingRoleAgents = [
      { id: '1', type: 'reviewer', status: 'running', startTime: new Date(now - 20_000) },
    ];
    reconcileAgentsWithStdin(txMissingRoleAgents, [{ name: 'reviewer', role: 'audit', status: 'done' }], now);
    assert.equal(txMissingRoleAgents[0].status, 'completed');

    // 4. Ambiguous roles on either side or role mismatch -> refuses unsafe fallback
    const ambiguousAgents = [
      { id: '1', type: 'coder', description: 'task X', status: 'running', startTime: new Date(now - 20_000) },
      { id: '2', type: 'coder', description: 'task Y', status: 'running', startTime: new Date(now - 10_000) },
    ];
    reconcileAgentsWithStdin(ambiguousAgents, [{ name: 'coder', status: 'completed' }], now);
    assert.equal(ambiguousAgents[0].status, 'running');
    assert.equal(ambiguousAgents[1].status, 'running');

    // 5. Unknown status or absence of terminal status -> refuses reconciliation
    const unsafeStatusAgents = [
      { id: '1', type: 'coder', description: 'u', status: 'running', startTime: new Date(now - 30_000) },
      { id: '2', type: 'coder', description: 'u', status: 'running', startTime: new Date(now - 10_000) },
      { id: '3', type: 'scout', description: 'r', status: 'running', startTime: new Date(now - 30_000) },
      { id: '4', type: 'scout', description: 'r', status: 'running', startTime: new Date(now - 10_000) },
    ];
    reconcileAgentsWithStdin(
      unsafeStatusAgents,
      [
        { name: 'coder', role: 'u', status: 'completed' },
        { name: 'coder', role: 'u', status: 'paused' }, // unknown status blocks group
        { name: 'scout', role: 'r', status: 'running' }, // no terminal entry in group
      ],
      now,
    );
    assert.equal(unsafeStatusAgents[0].status, 'running');
    assert.equal(unsafeStatusAgents[1].status, 'running');
    assert.equal(unsafeStatusAgents[2].status, 'running');
    assert.equal(unsafeStatusAgents[3].status, 'running');
  });

  test('renderStdin invokes reconcileAgentsWithStdin so reconciled completed subagents are hidden', async () => {
    const tmp = makeTmpDir('agy-hud-main-reconcile-');
    try {
      const dataDir = path.join(tmp, 'data');
      fs.mkdirSync(dataDir, { recursive: true });
      const transcriptPath = path.join(tmp, 'transcript.jsonl');
      fs.writeFileSync(
        transcriptPath,
        `${JSON.stringify({
          type: 'PLANNER_RESPONSE',
          timestamp: '2026-11-19T09:00:00.000Z',
          tool_calls: [{ name: 'invoke_subagent', args: { TypeName: 'coder', Role: 'fix bug' } }],
        })}\n`,
      );

      const now = Date.parse('2026-11-19T09:00:30.000Z');
      const runningOut = await renderStdin(
        {
          model: { id: 'gemini-3-pro', display_name: 'Gemini 3 Pro' },
          context_window: { context_window_size: 200_000, used_percentage: 20 },
          subagents: [{ name: 'coder', role: 'fix bug', status: 'running' }],
        },
        emptyPaths(dataDir, transcriptPath),
        async () => ({ 'agy.unicode': true }),
        now,
      );

      const runningJoined = runningOut.lines.join('\n').replace(/\x1b\[[0-9;]*m/g, '').replace(/\u00A0/g, ' ');
      assert.match(runningJoined, /◐ coder \(fix bug\) 30s/, `expected running subagent line in ${runningJoined}`);

      const out = await renderStdin(
        {
          model: { id: 'gemini-3-pro', display_name: 'Gemini 3 Pro' },
          context_window: { context_window_size: 200_000, used_percentage: 20 },
          subagents: [{ name: 'coder', role: 'fix bug', status: 'idle' }],
        },
        emptyPaths(dataDir, transcriptPath),
        async () => ({ 'agy.unicode': true }),
        now,
      );

      const joined = out.lines.join('\n').replace(/\x1b\[[0-9;]*m/g, '').replace(/\u00A0/g, ' ');
      assert.equal(joined.includes('◐'), false, `should not render running icon ◐ in ${joined}`);
      assert.equal(joined.includes('✓'), false, `should not render completed icon ✓ in ${joined}`);
      assert.doesNotMatch(joined, /coder|fix bug/, `should hide reconciled completed subagent in ${joined}`);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('readSubagentDetails stops early for PLANNER_RESPONSE (model+effort, max 2 followups, max 200 lines)', async () => {
    const tmp = makeTmpDir('agy-hud-subagent-early-');
    try {
      const dir = path.join(tmp, 'subagents');
      fs.mkdirSync(dir, { recursive: true });

      // (a) Immediate stop when model and effort are both extracted
      fs.writeFileSync(
        path.join(dir, 'agent-both-fast.jsonl'),
        [
          JSON.stringify({ type: 'PLANNER_RESPONSE', model: 'gemini-3-pro', thinking_level: 'HIGH' }),
          JSON.stringify({ type: 'PLANNER_RESPONSE', model: 'claude-sonnet-4-6', effort: 'low' }),
        ].join('\n') + '\n',
      );

      // (b) Model only -> checks at most 2 subsequent PLANNER_RESPONSE entries
      fs.writeFileSync(
        path.join(dir, 'agent-followup-hit.jsonl'),
        [
          JSON.stringify({ type: 'PLANNER_RESPONSE', model: 'gemini-3-pro' }),
          JSON.stringify({ type: 'PLANNER_RESPONSE', text: 'thinking' }),
          JSON.stringify({ type: 'PLANNER_RESPONSE', effort: 'medium' }),
          JSON.stringify({ type: 'PLANNER_RESPONSE', effort: 'max' }),
        ].join('\n') + '\n',
      );

      fs.writeFileSync(
        path.join(dir, 'agent-followup-cap.jsonl'),
        [
          JSON.stringify({ type: 'PLANNER_RESPONSE', model: 'gemini-3-pro' }),
          JSON.stringify({ type: 'PLANNER_RESPONSE', text: 'step 1' }),
          JSON.stringify({ type: 'PLANNER_RESPONSE', text: 'step 2' }),
          JSON.stringify({ type: 'PLANNER_RESPONSE', effort: 'max' }),
        ].join('\n') + '\n',
      );

      // (c) Model found -> stops by 200 lines without reading tail
      const manyLines = [
        JSON.stringify({ type: 'PLANNER_RESPONSE', model: 'gemini-3-flash' }),
        ...Array.from({ length: 210 }, (_, i) => JSON.stringify({ type: 'GENERIC', content: `line-${i}` })),
        JSON.stringify({ type: 'PLANNER_RESPONSE', effort: 'xhigh' }),
      ];
      fs.writeFileSync(path.join(dir, 'agent-line-cap.jsonl'), `${manyLines.join('\n')}\n`);

      const agents = [
        { id: '1', type: 'a', agentId: 'both-fast', status: 'running', startTime: new Date() },
        { id: '2', type: 'b', agentId: 'followup-hit', status: 'running', startTime: new Date() },
        { id: '3', type: 'c', agentId: 'followup-cap', status: 'running', startTime: new Date() },
        { id: '4', type: 'd', agentId: 'line-cap', status: 'running', startTime: new Date() },
      ];

      await addSubagentEfforts(dir, agents);

      assert.equal(agents[0].model, 'gemini-3-pro');
      assert.equal(agents[0].effort, 'high');

      assert.equal(agents[1].model, 'gemini-3-pro');
      assert.equal(agents[1].effort, 'medium');

      assert.equal(agents[2].model, 'gemini-3-pro');
      assert.equal(agents[2].effort, undefined);

      assert.equal(agents[3].model, 'gemini-3-flash');
      assert.equal(agents[3].effort, undefined);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('writeCursor removes .tmp on error and pruneCursors preserves recent .tmp while pruning stale .tmp & excess .json', () => {
    const tmp = makeTmpDir('agy-hud-cursor-tmp-');
    try {
      const cursorDir = path.join(tmp, 'transcript-cursors');
      fs.mkdirSync(cursorDir, { recursive: true });

      // 1. Force writeCursor failure by creating target path as a directory (renameSync throws)
      const failingTarget = path.join(cursorDir, 'dir-collision.json');
      fs.mkdirSync(failingTarget);
      writeCursor(failingTarget, { version: '0.4.8', ino: 1, offset: 0, state: {} });
      const leftoverTmp = fs.readdirSync(cursorDir).filter((f) => f.endsWith('.tmp'));
      assert.deepEqual(leftoverTmp, [], 'writeCursor must delete .tmp file on rename failure');
      fs.rmSync(failingTarget, { recursive: true, force: true });

      // 2. pruneCursors: 33 .json cursors + 1 recent .tmp + 1 stale (>60s) .tmp
      const now = Date.now();
      for (let i = 0; i < 33; i++) {
        const f = path.join(cursorDir, `c-${String(i).padStart(2, '0')}.json`);
        fs.writeFileSync(f, '{}');
        const ts = new Date(now - (40 - i) * 1000);
        fs.utimesSync(f, ts, ts);
      }
      const recentTmp = path.join(cursorDir, 'active.123.tmp');
      fs.writeFileSync(recentTmp, '{}');
      fs.utimesSync(recentTmp, new Date(now - 5_000), new Date(now - 5_000));

      const staleTmp = path.join(cursorDir, 'crashed.999.tmp');
      fs.writeFileSync(staleTmp, '{}');
      fs.utimesSync(staleTmp, new Date(now - 120_000), new Date(now - 120_000));

      pruneCursors(cursorDir, now);

      const remaining = fs.readdirSync(cursorDir).sort();
      const remainingJson = remaining.filter((f) => f.endsWith('.json'));
      assert.equal(remainingJson.length, 32, 'should keep exactly 32 .json cursors');
      assert.equal(remaining.includes('c-00.json'), false, 'oldest .json cursor should be pruned');
      assert.equal(remaining.includes('active.123.tmp'), true, 'recent .tmp must be ignored/preserved');
      assert.equal(remaining.includes('crashed.999.tmp'), false, 'stale .tmp (>60s) must be deleted');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('writeCursor sweeps stale .tmp files even when overwriting an existing cursor file', () => {
    const tmp = makeTmpDir('agy-hud-cursor-update-');
    try {
      const cursorDir = path.join(tmp, 'transcript-cursors');
      const cursorFile = path.join(cursorDir, 'session.json');
      writeCursor(cursorFile, { version: '0.4.8', ino: 1, offset: 10, state: {} });

      const now = Date.now();
      const staleTmp = path.join(cursorDir, 'dead.4242.tmp');
      const activeTmp = path.join(cursorDir, 'live.5353.tmp');
      fs.writeFileSync(staleTmp, '{}');
      fs.writeFileSync(activeTmp, '{}');
      fs.utimesSync(staleTmp, new Date(now - 120_000), new Date(now - 120_000));
      fs.utimesSync(activeTmp, new Date(now - 2_000), new Date(now - 2_000));

      // Existing cursor (!isNew) update should still clean stale .tmp while keeping active .tmp
      writeCursor(cursorFile, { version: '0.4.8', ino: 1, offset: 20, state: {} });

      assert.equal(fs.existsSync(staleTmp), false, 'stale .tmp must be removed on cursor update');
      assert.equal(fs.existsSync(activeTmp), true, 'recent .tmp must be preserved on cursor update');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('ignores false-positive exit notices in tool outputs, plain prose, and substring collisions while keeping pendingAgyToolIds aligned', async () => {
    const tmp = makeTmpDir('agy-hud-tx-false-pos-');
    try {
      const dataDir = path.join(tmp, 'data');
      const transcriptPath = path.join(tmp, 'transcript.jsonl');
      const lines = [
        JSON.stringify({
          type: 'PLANNER_RESPONSE',
          timestamp: '2026-11-19T09:00:00.000Z',
          tool_calls: [{ name: 'invoke_subagent', args: { TypeName: 'coder', Role: 'task 1' } }],
        }),
        JSON.stringify({
          type: 'GENERIC',
          timestamp: '2026-11-19T09:00:01.000Z',
          content: '{"conversationId":"sub-live-11111111"}',
        }),
        JSON.stringify({
          type: 'PLANNER_RESPONSE',
          timestamp: '2026-11-19T09:00:02.000Z',
          tool_calls: [{ name: 'read_file', args: { TargetFile: '/repo/src/a.ts' } }],
        }),
        JSON.stringify({
          type: 'GENERIC',
          timestamp: '2026-11-19T09:00:03.000Z',
          content:
            'Showing lines 1 to 5 in /repo/src/a.ts\n' +
            '1: Subagent sub-live-11111111 has gone idle.\n' +
            '2: [Message] sender=sub-live-11111111\n' +
            '3: conversation://sub-live-11111111\n' +
            '4: {"conversationId":"fake-other-2222"}',
        }),
        // Unlinked subagent + regular tool whose plain-text response mentions conversation://
        JSON.stringify({
          type: 'PLANNER_RESPONSE',
          timestamp: '2026-11-19T09:00:04.000Z',
          tool_calls: [
            { name: 'invoke_subagent', args: { TypeName: 'scout', Role: 'unlinked task' } },
            { name: 'grep_search', args: { Query: 'conversation://' } },
          ],
        }),
        JSON.stringify({
          type: 'GENERIC',
          timestamp: '2026-11-19T09:00:05.000Z',
          content: 'Matched mention of conversation://sub-unlinked-doc in notes',
        }),
        JSON.stringify({
          type: 'GENERIC',
          timestamp: '2026-11-19T09:00:05.500Z',
          content: '{"conversationId":"sub-scout-22222222"}',
        }),
        // Pending normal tool before structured subagent completion GENERIC notice
        JSON.stringify({
          type: 'PLANNER_RESPONSE',
          timestamp: '2026-11-19T09:00:06.000Z',
          tool_calls: [{ name: 'run_command', args: { CommandLine: 'npm test' } }],
        }),
        JSON.stringify({
          type: 'GENERIC',
          timestamp: '2026-11-19T09:00:07.000Z',
          content: '<SYSTEM_MESSAGE>\n  Subagent sub-live-11111111 has gone idle.\nReport:\nsrc/a.ts:1: checked\n1: ok\n</SYSTEM_MESSAGE>',
        }),
        // Exact-match check & USER_INPUT prose protection on a third subagent
        JSON.stringify({
          type: 'PLANNER_RESPONSE',
          timestamp: '2026-11-19T09:00:08.000Z',
          tool_calls: [{ name: 'invoke_subagent', args: { TypeName: 'reviewer', Role: 'exact check' } }],
        }),
        JSON.stringify({
          type: 'GENERIC',
          timestamp: '2026-11-19T09:00:09.000Z',
          content: 'Launched subagent conversationId=sub-exact-33333333',
        }),
        JSON.stringify({
          type: 'USER_INPUT',
          timestamp: '2026-11-19T09:00:10.000Z',
          content: 'Quoted log: Subagent sub-exact-33333333 has gone idle. [Message] sender=sub-exact-33333333',
        }),
        JSON.stringify({
          type: 'SYSTEM_MESSAGE',
          timestamp: '2026-11-19T09:00:11.000Z',
          content: 'Subagent prefix-sub-exact-33333333-suffix has gone idle.',
        }),
        JSON.stringify({
          type: 'GENERIC',
          timestamp: '2026-11-19T09:00:12.000Z',
          content: 'Command output:\nok',
        }),
      ];
      fs.writeFileSync(transcriptPath, `${lines.join('\n')}\n`);

      const data = await parseTranscript(transcriptPath, dataDir);
      assert.equal(data.agents.length, 3);
      assert.equal(data.agents[0].agentId, 'sub-live-11111111');
      assert.equal(data.agents[0].status, 'completed', 'structured GENERIC notice completes linked agent');
      assert.equal(data.agents[0].endTime?.toISOString(), '2026-11-19T09:00:07.000Z');
      assert.equal(data.agents[1].agentId, 'sub-scout-22222222');
      assert.equal(data.agents[1].status, 'running', 'plain tool result with conversation:// must not kill unlinked agent');
      assert.equal(data.agents[2].agentId, 'sub-exact-33333333');
      assert.equal(data.agents[2].status, 'running', 'mid-line USER_INPUT prose and substring ID must not kill exact agent');

      assert.equal(data.tools.length, 3);
      assert.equal(data.tools[0].status, 'completed');
      assert.equal(data.tools[1].status, 'completed');
      assert.equal(data.tools[2].name, 'run_command');
      assert.equal(data.tools[2].status, 'completed', 'pendingAgyToolIds must not be shifted by structured subagent notice');
      assert.equal(data.tools[2].endTime?.toISOString(), '2026-11-19T09:00:12.000Z');

      // Explicit <SYSTEM_MESSAGE> inside USER_INPUT completes sub-exact-33333333
      fs.appendFileSync(
        transcriptPath,
        `${JSON.stringify({
          type: 'USER_INPUT',
          timestamp: '2026-11-19T09:00:15.000Z',
          content: 'Please proceed.\n<SYSTEM_MESSAGE>\nSubagent sub-exact-33333333 has gone idle.\n</SYSTEM_MESSAGE>',
        })}\n`,
      );
      const updated = await parseTranscript(transcriptPath, dataDir);
      assert.equal(updated.agents[2].status, 'completed');
      assert.equal(updated.agents[2].endTime?.toISOString(), '2026-11-19T09:00:15.000Z');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('reconcileAgentsWithStdin accounts for already completed transcript agents and historical roles', () => {
    const now = Date.parse('2026-11-19T10:00:00.000Z');

    // 1. Existing completed agent in transcript already satisfies stdin's 1 terminal entry -> keep new running agent alive
    const withExistingCompleted = [
      { id: '1', type: 'coder', description: 'task A', status: 'completed', startTime: new Date(now - 30_000), endTime: new Date(now - 20_000) },
      { id: '2', type: 'coder', description: 'task A', status: 'running', startTime: new Date(now - 5_000) },
    ];
    reconcileAgentsWithStdin(
      withExistingCompleted,
      [{ name: 'coder', role: 'task A', status: 'completed' }],
      now,
    );
    assert.equal(withExistingCompleted[1].status, 'running');

    // 2. Bounded by terminalCount - completedCount (2 running, 1 terminal in stdin -> complete oldest 1 only)
    const twoRunningOneTerminal = [
      { id: '1', type: 'coder', description: 'task X', status: 'running', startTime: new Date(now - 20_000) },
      { id: '2', type: 'coder', description: 'task X', status: 'running', startTime: new Date(now - 5_000) },
    ];
    reconcileAgentsWithStdin(
      twoRunningOneTerminal,
      [{ name: 'coder', role: 'task X', status: 'done' }],
      now,
    );
    assert.equal(twoRunningOneTerminal[0].status, 'completed');
    assert.equal(twoRunningOneTerminal[1].status, 'running');

    // 3. Historical completed agent with another role blocks ambiguous name-only fallback
    const historicalRoleConflict = [
      { id: '1', type: 'coder', description: 'role-alpha', status: 'completed', startTime: new Date(now - 30_000), endTime: new Date(now - 20_000) },
      { id: '2', type: 'coder', description: 'role-beta', status: 'running', startTime: new Date(now - 10_000) },
    ];
    reconcileAgentsWithStdin(
      historicalRoleConflict,
      [{ name: 'coder', role: '', status: 'completed' }],
      now,
    );
    assert.equal(historicalRoleConflict[1].status, 'running');
  });

  test('send_message reopens a completed subagent to running across incremental parses and completes again on next idle', async () => {
    const tmp = makeTmpDir('agy-hud-tx-reopen-');
    try {
      const dataDir = path.join(tmp, 'data');
      const transcriptPath = path.join(tmp, 'transcript.jsonl');

      const round1 = [
        JSON.stringify({
          type: 'PLANNER_RESPONSE',
          timestamp: '2026-11-19T09:00:00.000Z',
          tool_calls: [{ name: 'invoke_subagent', args: { TypeName: 'coder', Role: 'fix bug', Prompt: 'Fix the issue' } }],
        }),
        JSON.stringify({
          type: 'GENERIC',
          timestamp: '2026-11-19T09:00:01.000Z',
          content: '{"conversationId":"sub-reopen-77778888"}',
        }),
        JSON.stringify({
          type: 'SYSTEM_MESSAGE',
          timestamp: '2026-11-19T09:00:10.000Z',
          content: 'Subagent sub-reopen-77778888 has gone idle.',
        }),
      ];
      fs.writeFileSync(transcriptPath, `${round1.join('\n')}\n`);

      const afterRound1 = await parseTranscript(transcriptPath, dataDir);
      assert.equal(afterRound1.agents.length, 1);
      assert.equal(afterRound1.agents[0].status, 'completed');
      assert.equal(afterRound1.agents[0].endTime?.toISOString(), '2026-11-19T09:00:10.000Z');

      // Main agent dispatches rework via send_message
      const round2 = [
        JSON.stringify({
          type: 'PLANNER_RESPONSE',
          timestamp: '2026-11-19T09:00:20.000Z',
          tool_calls: [{ name: 'send_message', args: { Recipient: 'sub-reopen-77778888', Message: 'Please handle edge cases' } }],
        }),
        JSON.stringify({
          type: 'GENERIC',
          timestamp: '2026-11-19T09:00:21.000Z',
          content: 'Command output:\nMessage delivered',
        }),
      ];
      fs.appendFileSync(transcriptPath, `${round2.join('\n')}\n`);

      const afterReopen = await parseTranscript(transcriptPath, dataDir);
      assert.equal(afterReopen.agents[0].status, 'running', 'send_message must reopen completed subagent back to running');
      assert.equal(afterReopen.agents[0].endTime, undefined);
      assert.equal(afterReopen.tools.length, 1);
      assert.equal(afterReopen.tools[0].name, 'send_message');
      assert.equal(afterReopen.tools[0].status, 'completed');

      // Subagent finishes rework round
      fs.appendFileSync(
        transcriptPath,
        `${JSON.stringify({
          type: 'SYSTEM_MESSAGE',
          timestamp: '2026-11-19T09:00:30.000Z',
          content: 'Subagent sub-reopen-77778888 has gone idle.',
        })}\n`,
      );

      const afterRound2Idle = await parseTranscript(transcriptPath, dataDir);
      assert.equal(afterRound2Idle.agents[0].status, 'completed');
      assert.equal(afterRound2Idle.agents[0].endTime?.toISOString(), '2026-11-19T09:00:30.000Z');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('reconcileAgentsWithStdin matches parallel same-name subagents via promptKey against full Prompt roles and converges safely on stillRunning === 0', async () => {
    const tmp = makeTmpDir('agy-hud-tx-promptkey-');
    try {
      const dataDir = path.join(tmp, 'data');
      const transcriptPath = path.join(tmp, 'transcript.jsonl');
      const promptA =
        'Investigate authentication token refresh race conditions across Linux keyring and Windows credential cache paths in runtime/quota/token.mjs.';
      const promptB =
        'Audit subagent cursor pruning and temporary file cleanup under concurrent SIGKILL interruption scenarios in src/transcript.ts and collector.mjs.';

      const lines = [
        JSON.stringify({
          type: 'PLANNER_RESPONSE',
          timestamp: '2026-11-19T10:00:00.000Z',
          tool_calls: [
            { name: 'invoke_subagent', args: { TypeName: 'scout', Role: 'Auth scan', Prompt: promptA } },
            { name: 'invoke_subagent', args: { TypeName: 'scout', Role: 'Cache scan', Prompt: promptB } },
          ],
        }),
      ];
      fs.writeFileSync(transcriptPath, `${lines.join('\n')}\n`);

      const data = await parseTranscript(transcriptPath, dataDir);
      assert.equal(data.agents.length, 2);
      assert.equal(data.agents[0].promptKey?.length, 64);
      assert.equal(data.agents[0].promptKey?.endsWith(' '), true, 'preserve 64th char word-boundary trailing space');
      assert.equal(data.agents[1].promptKey?.length, 64);

      const now = Date.parse('2026-11-19T10:05:00.000Z');
      reconcileAgentsWithStdin(
        data.agents,
        [
          { name: 'scout', role: promptA.toUpperCase(), status: 'completed' },
          { name: 'scout', role: promptB, status: 'working' },
        ],
        now,
      );

      assert.equal(data.agents[0].status, 'completed', 'promptKey prefix match must complete Auth scan');
      assert.equal(data.agents[0].endTime?.getTime(), now);
      assert.equal(data.agents[1].status, 'running', 'working promptB scout must stay running');

      // All-terminal fallback (stillRunning === 0, !hasUnknown, terminalCount - alreadyCompleted >= runningItems.length) converges unmatched agents
      const unmatchedBothRunning = [
        { id: '1', type: 'scout', description: 'role-1', status: 'running', startTime: new Date(now - 20_000) },
        { id: '2', type: 'scout', description: 'role-2', status: 'running', startTime: new Date(now - 10_000) },
      ];
      reconcileAgentsWithStdin(
        unmatchedBothRunning,
        [
          { name: 'scout', role: promptA, status: 'completed' },
          { name: 'scout', role: promptB, status: 'stopped' },
        ],
        now,
      );
      assert.equal(unmatchedBothRunning[0].status, 'completed');
      assert.equal(unmatchedBothRunning[1].status, 'completed');

      // Partial terminal boundary: 2 unmatched running + only 1 terminal stdin entry -> refuses partial ambiguous kill
      const partialUnmatchedRunning = [
        { id: '1', type: 'scout', description: 'role-1', status: 'running', startTime: new Date(now - 20_000) },
        { id: '2', type: 'scout', description: 'role-2', status: 'running', startTime: new Date(now - 10_000) },
      ];
      reconcileAgentsWithStdin(
        partialUnmatchedRunning,
        [{ name: 'scout', role: promptA, status: 'completed' }],
        now,
      );
      assert.equal(partialUnmatchedRunning[0].status, 'running');
      assert.equal(partialUnmatchedRunning[1].status, 'running');

      // Safe boundary: 1 already completed + 1 newly spawned running agent with only 1 terminal stdin entry stays running
      const oneCompletedOneNew = [
        { id: '1', type: 'scout', description: 'role-1', status: 'completed', startTime: new Date(now - 20_000), endTime: new Date(now - 15_000) },
        { id: '2', type: 'scout', description: 'role-2', status: 'running', startTime: new Date(now - 2_000) },
      ];
      reconcileAgentsWithStdin(
        oneCompletedOneNew,
        [{ name: 'scout', role: promptA, status: 'completed' }],
        now,
      );
      assert.equal(oneCompletedOneNew[1].status, 'running');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('reconcileAgentsWithStdin restricts prefix matching to truncated 64-char promptKey and forbids Stage 4 cross-group budget borrowing', () => {
    const now = Date.parse('2026-11-19T11:00:00.000Z');

    // 1. Short promptKey (< 64 chars) only matches exact role, never a longer role sharing its prefix
    const shortPromptAgents = [
      { id: '1', type: 'scout', description: 'short', promptKey: 'audit auth flow', status: 'running', startTime: new Date(now - 20_000) },
      { id: '2', type: 'scout', description: 'other', promptKey: 'check cache', status: 'running', startTime: new Date(now - 10_000) },
    ];
    reconcileAgentsWithStdin(
      shortPromptAgents,
      [
        { name: 'scout', role: 'audit auth flow with oauth2 refresh', status: 'completed' },
        { name: 'scout', role: 'check cache', status: 'working' },
      ],
      now,
    );
    assert.equal(shortPromptAgents[0].status, 'running', 'non-truncated short promptKey must not prefix-match a longer stdin role');
    assert.equal(shortPromptAgents[1].status, 'running');

    // Exact match with short promptKey works cleanly
    reconcileAgentsWithStdin(
      shortPromptAgents,
      [
        { name: 'scout', role: 'audit auth flow', status: 'completed' },
        { name: 'scout', role: 'check cache', status: 'working' },
      ],
      now,
    );
    assert.equal(shortPromptAgents[0].status, 'completed');
    assert.equal(shortPromptAgents[1].status, 'running');

    // 2. Stage 4 never borrows redundant historical terminal slots from an already-matched group (e.g. evicted by AGENTS_KEPT = 10)
    const crossGroupAgents = [
      { id: '1', type: 'coder', description: 'task A', status: 'completed', startTime: new Date(now - 60_000), endTime: new Date(now - 50_000) },
      { id: '2', type: 'coder', description: 'task B', status: 'running', startTime: new Date(now - 5_000) },
    ];
    reconcileAgentsWithStdin(
      crossGroupAgents,
      [
        { name: 'coder', role: 'task A', status: 'completed' },
        { name: 'coder', role: 'task A', status: 'completed' },
        { name: 'coder', role: 'task A', status: 'completed' },
      ],
      now,
    );
    assert.equal(crossGroupAgents[1].status, 'running', 'unmatched task B must not consume matched task A surplus terminal count');
  });

  test('send_message returning ERROR rolls back reopened agent status and preserves prior endTime across incremental parses', async () => {
    const tmp = makeTmpDir('agy-hud-tx-reopen-err-');
    try {
      const dataDir = path.join(tmp, 'data');
      const transcriptPath = path.join(tmp, 'transcript.jsonl');
      const prevEndIso = '2026-11-19T09:00:10.000Z';

      fs.writeFileSync(
        transcriptPath,
        [
          JSON.stringify({
            type: 'PLANNER_RESPONSE',
            timestamp: '2026-11-19T09:00:00.000Z',
            tool_calls: [{ name: 'invoke_subagent', args: { TypeName: 'coder', Role: 'fix' } }],
          }),
          JSON.stringify({
            type: 'GENERIC',
            timestamp: '2026-11-19T09:00:01.000Z',
            content: '{"conversationId":"sub-rollback-5566"}',
          }),
          JSON.stringify({
            type: 'SYSTEM_MESSAGE',
            timestamp: prevEndIso,
            content: 'Subagent sub-rollback-5566 has gone idle.',
          }),
          JSON.stringify({
            type: 'PLANNER_RESPONSE',
            timestamp: '2026-11-19T09:00:20.000Z',
            tool_calls: [{ name: 'send_message', args: { Recipient: 'sub-rollback-5566', Message: 'retry' } }],
          }),
        ].join('\n') + '\n',
      );

      // Cursor saved while send_message is in flight (agent optimistically reopened to running)
      const midParse = await parseTranscript(transcriptPath, dataDir);
      assert.equal(midParse.agents[0].status, 'running');
      assert.equal(midParse.agents[0].endTime, undefined);

      // send_message fails with ERROR in next incremental read
      fs.appendFileSync(
        transcriptPath,
        `${JSON.stringify({
          type: 'GENERIC',
          timestamp: '2026-11-19T09:00:22.000Z',
          status: 'ERROR',
          content: 'Recipient subagent is unavailable',
        })}\n`,
      );

      const rolledBack = await parseTranscript(transcriptPath, dataDir);
      assert.equal(rolledBack.tools[0].name, 'send_message');
      assert.equal(rolledBack.tools[0].status, 'error');
      assert.equal(rolledBack.agents[0].status, 'completed', 'ERROR response must roll back reopened agent to completed');
      assert.equal(rolledBack.agents[0].endTime?.toISOString(), prevEndIso, 'rollback must restore previous endTime');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('Parser.addAgent never evicts running subagents past AGENTS_KEPT=10, evicts only oldest completed entries, and renderStdin only reads efforts for running subagents', async () => {
    const tmp = makeTmpDir('agy-hud-tx-keep-running-');
    try {
      const dataDir = path.join(tmp, 'data');
      const transcriptPath = path.join(tmp, 'transcript.jsonl');

      // Spawn 12 concurrent running subagents (> AGENTS_KEPT = 10)
      const lines = [];
      for (let i = 0; i < 12; i++) {
        lines.push(
          JSON.stringify({
            type: 'PLANNER_RESPONSE',
            timestamp: `2026-11-19T09:00:${String(i * 2).padStart(2, '0')}.000Z`,
            tool_calls: [{ name: 'invoke_subagent', args: { TypeName: 'scout', Role: `scan-${i}` } }],
          }),
          JSON.stringify({
            type: 'GENERIC',
            timestamp: `2026-11-19T09:00:${String(i * 2 + 1).padStart(2, '0')}.000Z`,
            content: `{"conversationId":"sub-run-${String(i).padStart(2, '0')}-123456"}`,
          }),
        );
      }
      fs.writeFileSync(transcriptPath, `${lines.join('\n')}\n`);

      const allRunning = await parseTranscript(transcriptPath, dataDir);
      assert.equal(allRunning.agents.length, 12, 'must retain all 12 running subagents past AGENTS_KEPT=10');
      assert.equal(allRunning.agents.every((a) => a.status === 'running'), true);

      // Complete sub-run-02 and sub-run-05, then spawn a 13th running subagent -> only completed sub-run-02 and sub-run-05 are evicted first
      fs.appendFileSync(
        transcriptPath,
        [
          JSON.stringify({
            type: 'SYSTEM_MESSAGE',
            timestamp: '2026-11-19T09:01:00.000Z',
            content: 'Subagent sub-run-02-123456 has gone idle.\nSubagent sub-run-05-123456 has gone idle.',
          }),
          JSON.stringify({
            type: 'PLANNER_RESPONSE',
            timestamp: '2026-11-19T09:01:05.000Z',
            tool_calls: [{ name: 'invoke_subagent', args: { TypeName: 'coder', Role: 'task-12' } }],
          }),
          JSON.stringify({
            type: 'GENERIC',
            timestamp: '2026-11-19T09:01:06.000Z',
            content: '{"conversationId":"sub-run-12-123456"}',
          }),
        ].join('\n') + '\n',
      );

      const after13 = await parseTranscript(transcriptPath, dataDir);
      assert.equal(after13.agents.length, 11, '2 completed evicted, all 11 running preserved');
      assert.equal(after13.agents.some((a) => a.agentId === 'sub-run-02-123456'), false);
      assert.equal(after13.agents.some((a) => a.agentId === 'sub-run-05-123456'), false);
      assert.equal(after13.agents[0].agentId, 'sub-run-00-123456', 'oldest running subagent must not be evicted');

      // Completing sub-run-00 still works because its agentIdToToolUseId mapping was never evicted
      fs.appendFileSync(
        transcriptPath,
        `${JSON.stringify({
          type: 'SYSTEM_MESSAGE',
          timestamp: '2026-11-19T09:01:10.000Z',
          content: 'Subagent sub-run-00-123456 has gone idle.',
        })}\n`,
      );
      const afterComplete00 = await parseTranscript(transcriptPath, dataDir);
      assert.equal(afterComplete00.agents[0].status, 'completed');

      // renderStdin skips reading subagent detail files for completed subagents
      const poisonCompletedFile = path.join(tmp, 'completed-sub.jsonl');
      fs.writeFileSync(poisonCompletedFile, `${JSON.stringify({ type: 'PLANNER_RESPONSE', model: 'claude-opus-4-6', effort: 'max' })}\n`);
      const liveSubFile = path.join(tmp, 'live-sub.jsonl');
      fs.writeFileSync(liveSubFile, `${JSON.stringify({ type: 'PLANNER_RESPONSE', model: 'gemini-3-flash', effort: 'low' })}\n`);

      const paths = {
        ...emptyPaths(dataDir, transcriptPath),
        agySubagentTranscripts: {
          'sub-run-00-123456': poisonCompletedFile,
          'sub-run-01-123456': liveSubFile,
        },
      };
      const out = await renderStdin(
        {
          model: { id: 'gemini-3-pro', display_name: 'Gemini 3 Pro' },
          context_window: { context_window_size: 200_000, used_percentage: 20 },
        },
        paths,
        async () => ({ 'agy.unicode': true }),
        Date.parse('2026-11-19T09:01:15.000Z'),
      );
      const plain = out.lines.join('\n').replace(/\x1b\[[0-9;]*m/g, '').replace(/\u00a0/g, ' ');
      assert.match(plain, /◐ scout \[Gemini 3 Flash:low\] \(scan-1\)/);
      assert.doesNotMatch(plain, /Opus|scan-0/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
