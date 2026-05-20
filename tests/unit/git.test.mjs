import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..', '..');

test('getGitInfo falls back outside git repositories without stderr noise', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-non-git-'));
  const script = `
    const { getGitInfo } = require(${JSON.stringify(path.join(projectRoot, 'extensions', 'git.js'))});
    getGitInfo().then(info => process.stdout.write(JSON.stringify(info)));
  `;

  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: tempDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), { branch: 'non-git' });
});
