import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..', '..');

function runHudWithEmptyStdin(envOverrides) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(projectRoot, 'runtime', 'bin', 'agy-hud.js')], {
      cwd: projectRoot,
      env: {
        ...process.env,
        ...envOverrides,
        AGY_HUD_FORCE_ASCII: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end();
  });
}

test('CLI renders a baseline HUD when agy sends empty stdin', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-empty-stdin-'));
  try {
    const home = path.join(tmp, 'home');
    const appData = path.join(tmp, 'appdata');
    const localAppData = path.join(tmp, 'localappdata');
    fs.mkdirSync(path.join(home, '.gemini', 'antigravity-cli'), { recursive: true });

    const result = await runHudWithEmptyStdin({
      HOME: home,
      USERPROFILE: home,
      APPDATA: appData,
      LOCALAPPDATA: localAppData,
      XDG_DATA_HOME: path.join(tmp, 'xdg'),
    });

    assert.equal(result.code, 0);
    assert.equal(result.stderr, '');
    assert.match(result.stdout, /Unknown Model/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
