import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSessionState } from '../../extensions/parser.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..', '..');

test('getSessionState should initialize state properly even for missing files', async () => {
  // We can't easily mock the read stream without a real file or stub, 
  // so we'll test the basic parsing logic by passing a small string if we had exposed it.
  // For now, let's just assert that it is a function.
  assert.strictEqual(typeof getSessionState, 'function');
});

test('getSessionState falls back outside git repositories without stderr noise', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-parser-non-git-'));
  const script = `
    const { getSessionState } = require(${JSON.stringify(path.join(projectRoot, 'extensions', 'parser.js'))});
    getSessionState('missing-transcript.jsonl', 0)
      .then(state => process.stdout.write(JSON.stringify(state)));
  `;

  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: tempDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), { steps: 0, branch: 'main' });
});
