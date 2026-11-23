import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverAgySubagentTranscripts, logicPaths, readGrants, stripLogic } from '../collector.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function createSubagentFile(configDir, id) {
  const file = path.join(configDir, 'brain', id, '.system_generated', 'logs', 'transcript.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{"type":"PLANNER_RESPONSE"}\n');
  return fs.realpathSync(file);
}

describe('collector / subagent map cache, stripLogic tmp guard & version sync', () => {
  test('discoverAgySubagentTranscripts caches by (realpath, ino, size) and scans incremental slice on append', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-collector-cache-'));
    try {
      const configDir = path.join(tmp, 'config');
      const dataDir = path.join(tmp, 'data');
      const transcriptPath = path.join(tmp, 'main-transcript.jsonl');

      const id1 = 'subagent-alpha-1111';
      const id2 = 'subagent-bravo-2222';
      const id3 = 'subagent-charlie-3333';
      const sub1 = createSubagentFile(configDir, id1);

      // Pad past 512 bytes so the overlap window [cachedSize - 512 .. size] excludes the beginning
      const initialLine = JSON.stringify({
        type: 'GENERIC',
        content: `Launched subagent conversationId: ${id1} and conversation://${id3}`,
      });
      const padding = JSON.stringify({ type: 'GENERIC', content: 'x'.repeat(800) });
      fs.writeFileSync(transcriptPath, `${initialLine}\n${padding}\n`);

      // 1. Cold scan populates dataDir/agy-subagent-map.json (id3 not materialized yet)
      const first = discoverAgySubagentTranscripts(configDir, transcriptPath, dataDir);
      assert.equal(first[id1], sub1);
      assert.equal(first[id3], undefined);
      const mapFile = path.join(dataDir, 'agy-subagent-map.json');
      assert.equal(fs.existsSync(mapFile), true);

      // 2. Unchanged (realpath, ino, size) skips reading transcript, yet still re-checks disk candidates
      const sub2 = createSubagentFile(configDir, id2);
      const sub3 = createSubagentFile(configDir, id3);
      const origSize = fs.statSync(transcriptPath).size;
      // Overwrite first bytes in-place (preserving ino & size) to prove read/regex are skipped on cache hit
      const fd = fs.openSync(transcriptPath, 'r+');
      try {
        const blank = Buffer.alloc(initialLine.length, ' ');
        fs.writeSync(fd, blank, 0, blank.length, 0);
      } finally {
        fs.closeSync(fd);
      }
      assert.equal(fs.statSync(transcriptPath).size, origSize);

      const second = discoverAgySubagentTranscripts(configDir, transcriptPath, dataDir);
      assert.equal(second[id1], sub1, 'cache hit must preserve cached id without re-reading file');
      assert.equal(second[id3], sub3, 'cache hit must still re-check candidate files on disk');

      // 3. Append on same inode only scans [cachedSize - 512 .. size], keeping cached id1 and finding new id2
      fs.appendFileSync(transcriptPath, `${JSON.stringify({ type: 'GENERIC', content: `conversation://${id2}` })}\n`);
      const third = discoverAgySubagentTranscripts(configDir, transcriptPath, dataDir);
      assert.equal(third[id1], sub1);
      assert.equal(third[id2], sub2);

      // 4. Missing dataDir or unwritable/failing cache path falls back gracefully without leaving .tmp
      const unwritableDataDir = path.join(tmp, 'not-a-dir');
      fs.writeFileSync(unwritableDataDir, 'blocker');
      const badCacheDataDir = path.join(tmp, 'bad-cache-dir');
      fs.mkdirSync(path.join(badCacheDataDir, 'agy-subagent-map.json'), { recursive: true });
      const fallbackNoDir = discoverAgySubagentTranscripts(configDir, transcriptPath);
      const fallbackBadDir = discoverAgySubagentTranscripts(configDir, transcriptPath, unwritableDataDir);
      const fallbackRenameFail = discoverAgySubagentTranscripts(configDir, transcriptPath, badCacheDataDir);
      assert.equal(fallbackNoDir[id2], sub2);
      assert.equal(fallbackBadDir[id2], sub2);
      assert.equal(fallbackRenameFail[id2], sub2);
      assert.equal(fs.readdirSync(tmp).some((f) => f.endsWith('.tmp')), false);
      assert.equal(fs.readdirSync(badCacheDataDir).some((f) => f.endsWith('.tmp')), false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('logicPaths passes paths.dataDir into discoverAgySubagentTranscripts', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-logic-paths-'));
    try {
      const configDir = path.join(tmp, 'config');
      const dataDir = path.join(tmp, 'data');
      const transcriptPath = path.join(tmp, 'main.jsonl');
      const id = 'subagent-logic-9999';
      const subFile = createSubagentFile(configDir, id);
      fs.writeFileSync(transcriptPath, `{"conversationId":"${id}"}\n`);

      const out = logicPaths(
        {
          home: tmp,
          configDir,
          claudeConfigDir: path.join(tmp, '.claude'),
          hudDir: path.join(tmp, 'hud'),
          claudeJson: path.join(tmp, '.claude.json'),
          dataDir,
          strippedDir: path.join(tmp, 'stripped'),
          configPath: path.join(tmp, 'config.json'),
          overridePath: path.join(tmp, 'override.json'),
          legacyConfigPath: path.join(tmp, 'legacy.json'),
          heartbeat: path.join(tmp, 'heartbeat.json'),
        },
        { transcript_path: transcriptPath },
      );

      assert.equal(out.agySubagentTranscripts[id], subFile);
      assert.equal(fs.existsSync(path.join(dataDir, 'agy-subagent-map.json')), true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('discoverAgySubagentTranscripts orders duplicate IDs by latest offset, ignores missing bogus IDs before slicing, and clears cache when truncated', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-collector-order-'));
    try {
      const configDir = path.join(tmp, 'config');
      const dataDir = path.join(tmp, 'data');
      const transcriptPath = path.join(tmp, 'main.jsonl');

      const realIds = Array.from({ length: 65 }, (_, i) => `subagent-real-${String(i).padStart(2, '0')}`);
      const subFiles = Object.fromEntries(realIds.map((id) => [id, createSubagentFile(configDir, id)]));

      // Mention all 65 real IDs, mention real-00 again later (moves to tail so real-01 is evicted instead of real-00),
      // then append 25 bogus conversation:// IDs that do NOT exist on disk.
      const lines = [
        ...realIds.map((id) => JSON.stringify({ type: 'GENERIC', content: `conversation://${id}` })),
        JSON.stringify({ type: 'GENERIC', content: `Re-referencing conversation://${realIds[0]} later in session` }),
        ...Array.from({ length: 25 }, (_, i) => JSON.stringify({ type: 'GENERIC', content: `conversation://bogus-id-${i}` })),
      ];
      fs.writeFileSync(transcriptPath, `${lines.join('\n')}\n`);

      const mapped = discoverAgySubagentTranscripts(configDir, transcriptPath, dataDir);
      assert.equal(Object.keys(mapped).length, 64, 'should keep 64 real existing subagents despite 25 trailing bogus IDs');
      assert.equal(mapped[realIds[0]], subFiles[realIds[0]], 'repeated real-00 moved to tail and must not be evicted');
      assert.equal(mapped[realIds[1]], undefined, 'real-01 is now oldest after real-00 moved to tail and gets evicted');
      assert.equal(mapped[realIds[64]], subFiles[realIds[64]]);

      // Truncate transcript to 0 bytes -> clears stale cache file and returns {}
      fs.truncateSync(transcriptPath, 0);
      const afterTruncate = discoverAgySubagentTranscripts(configDir, transcriptPath, dataDir);
      assert.deepEqual(afterTruncate, {});
      assert.equal(fs.existsSync(path.join(dataDir, 'agy-subagent-map.json')), false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('stripLogic skips recent .tmp files (<60s) and removes stale .tmp and obsolete files', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-strip-tmp-'));
    try {
      const strippedDir = path.join(tmp, 'stripped');
      fs.mkdirSync(strippedDir, { recursive: true });

      const now = Date.now();
      const recentTmp = path.join(strippedDir, 'concurrent.1234.tmp');
      fs.writeFileSync(recentTmp, '// active');
      fs.utimesSync(recentTmp, new Date(now - 5_000), new Date(now - 5_000));

      const staleTmp = path.join(strippedDir, 'stale.5678.tmp');
      fs.writeFileSync(staleTmp, '// stale');
      fs.utimesSync(staleTmp, new Date(now - 120_000), new Date(now - 120_000));

      const obsoleteJs = path.join(strippedDir, 'old-hash.js');
      fs.writeFileSync(obsoleteJs, '// old');

      const res = stripLogic(strippedDir, ROOT);
      assert.ok(res);
      assert.equal(fs.existsSync(recentTmp), true, 'recent .tmp must not be removed by concurrent stripLogic');
      assert.equal(fs.existsSync(staleTmp), false, 'stale .tmp (>60s) must be removed');
      assert.equal(fs.existsSync(obsoleteJs), false, 'obsolete .js must be removed');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('logicPaths discovers and grants only verified single todo/task.md files from write/edit tools', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-todo-grants-'));
    try {
      const home = path.join(tmp, 'home');
      const configDir = path.join(home, '.gemini', 'antigravity-cli');
      const dataDir = path.join(configDir, 'agy-hud', 'data');
      const cwd = path.join(home, 'workspace', 'repo');
      const convId = 'conv-todo-12345678';
      const convBrainDir = path.join(configDir, 'brain', convId);
      const homeAiTasksDir = path.join(home, 'ai-tasks');
      const forbiddenDir = path.join(home, 'secret-vault');

      fs.mkdirSync(cwd, { recursive: true });
      fs.mkdirSync(path.join(convBrainDir, '.system_generated', 'logs'), { recursive: true });
      fs.mkdirSync(homeAiTasksDir, { recursive: true });
      fs.mkdirSync(forbiddenDir, { recursive: true });

      const cwdTodo = path.join(cwd, 'ai-tasks', 'todo.md');
      fs.mkdirSync(path.dirname(cwdTodo), { recursive: true });
      fs.writeFileSync(cwdTodo, '- [ ] task 1\n');

      const brainTask = path.join(convBrainDir, 'task.md');
      fs.writeFileSync(brainTask, '- [x] task 2\n');

      const homeTodo = path.join(homeAiTasksDir, 'todo.md');
      fs.writeFileSync(homeTodo, '- [/] task 3\n');

      const readOnlyTodo = path.join(cwd, 'readonly-todo.md');
      fs.writeFileSync(readOnlyTodo, '- [ ] should not be granted via read_file\n');

      const outsideTodo = path.join(forbiddenDir, 'todo.md');
      fs.writeFileSync(outsideTodo, '- [ ] outside safe roots\n');

      const secretToken = path.join(configDir, 'antigravity-oauth-token');
      fs.writeFileSync(secretToken, 'SECRET');
      const symlinkTodo = path.join(cwd, 'evil-todo.md');
      try {
        fs.symlinkSync(secretToken, symlinkTodo);
      } catch {}

      const transcriptPath = path.join(convBrainDir, '.system_generated', 'logs', 'transcript.jsonl');
      const lines = [
        JSON.stringify({
          type: 'PLANNER_RESPONSE',
          tool_calls: [
            { name: 'write_file', args: { Path: JSON.stringify(cwdTodo), Content: '"- [ ] task 1"' } },
            { name: 'replace_file_content', args: { TargetFile: brainTask, TargetContent: 'a', ReplacementContent: 'b' } },
            { name: 'edit_file', args: { path: homeTodo, Target: 'a', Replacement: 'b' } },
            { name: 'read_file', args: { Path: readOnlyTodo } },
            { name: 'write_file', args: { Path: outsideTodo, Content: '"- [ ] no"' } },
            { name: 'edit_file', args: { file_path: symlinkTodo, Target: 'a', Replacement: 'b' } },
          ],
        }),
      ];
      fs.writeFileSync(transcriptPath, `${lines.join('\n')}\n`);

      const named = logicPaths(
        {
          home,
          configDir,
          claudeConfigDir: path.join(home, '.claude'),
          hudDir: path.join(configDir, 'agy-hud'),
          claudeJson: path.join(home, '.claude.json'),
          dataDir,
          strippedDir: path.join(configDir, 'agy-hud', 'stripped'),
          configPath: path.join(configDir, 'agy-hud', 'config.json'),
          overridePath: path.join(configDir, 'agy-hud.json'),
          legacyConfigPath: path.join(configDir, 'legacy.json'),
          heartbeat: path.join(configDir, 'agy-hud', 'heartbeat.json'),
        },
        { cwd, conversation_id: convId, transcript_path: transcriptPath },
      );

      assert.deepEqual(named.todoFiles, [
        fs.realpathSync(cwdTodo),
        fs.realpathSync(brainTask),
        fs.realpathSync(homeTodo),
      ]);
      const grants = readGrants(ROOT, named);
      assert.equal(grants.includes(fs.realpathSync(cwdTodo)), true);
      assert.equal(grants.includes(fs.realpathSync(brainTask)), true);
      assert.equal(grants.includes(fs.realpathSync(homeTodo)), true);
      assert.equal(grants.includes(path.dirname(fs.realpathSync(cwdTodo))), false, 'must never grant parent directory');
      assert.equal(grants.includes(fs.realpathSync(readOnlyTodo)), false, 'must never grant read_file todo.md');
      assert.equal(grants.includes(fs.realpathSync(outsideTodo)), false, 'must reject todo.md outside safe roots');
      assert.equal(grants.includes(fs.realpathSync(secretToken)), false, 'must reject symlink resolving to non-todo file');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('manifest versions are synchronized at 0.4.10', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
    const plugin = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugin.json'), 'utf8'));
    const ext = JSON.parse(fs.readFileSync(path.join(ROOT, 'gemini-extension.json'), 'utf8'));

    assert.equal(pkg.version, '0.4.10');
    assert.equal(lock.version, '0.4.10');
    assert.equal(lock.packages?.['']?.version, '0.4.10');
    assert.equal(plugin.version, pkg.version);
    assert.equal(ext.version, pkg.version);
  });
});
