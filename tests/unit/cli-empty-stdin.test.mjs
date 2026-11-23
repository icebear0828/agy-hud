import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..', '..');

const { resolveVerifiedAccountKey, downloadToFile } = require('../../runtime/bin/agy-hud.js');

function runHud(stdinText, envOverrides, cwd = projectRoot) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(projectRoot, 'runtime', 'bin', 'agy-hud.js')], {
      cwd,
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
    if (stdinText) child.stdin.write(stdinText);
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

    const result = await runHud('', {
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

test('CLI exits cleanly with empty stdout when config.enabled is false', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-disabled-'));
  try {
    const workspace = path.join(tmp, 'workspace');
    const dataDir = path.join(tmp, 'data');
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(workspace, 'agy-hud.config.json'), JSON.stringify({ enabled: false }));

    const result = await runHud(
      JSON.stringify({ workspace: { current_dir: workspace }, model: { id: 'gemini-3-flash' } }),
      { AGY_HUD_DATA_DIR: dataDir },
      workspace
    );

    assert.equal(result.code, 0);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, '');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('resolveVerifiedAccountKey uses verified email hash or tokenHash and ignores stale oauth-creds email', () => {
  const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

  // 1. Live non-oauth-creds token email -> lowercased sha256
  assert.equal(
    resolveVerifiedAccountKey({ accessToken: 'tok-1', sourceFormat: 'macos-keychain', email: 'Alice@Example.COM' }, null),
    sha('alice@example.com')
  );

  // 2. oauth-creds token with stale email -> must NOT trust tok.email; uses tokenHash when cache has no match
  assert.equal(
    resolveVerifiedAccountKey({ accessToken: 'tok-2', sourceFormat: 'oauth-creds', email: 'stale@example.com' }, null),
    sha('tok-2')
  );

  // 3. Matched cache payload accountEmail takes precedence when tok has no live email
  const matchedCache = {
    version: 3,
    data: [],
    tokenHash: sha('tok-3'),
    accountEmail: 'Verified@Example.com',
  };
  assert.equal(
    resolveVerifiedAccountKey({ accessToken: 'tok-3', sourceFormat: 'oauth-creds', email: 'stale@example.com' }, matchedCache),
    sha('verified@example.com')
  );

  // 4. Null token -> null
  assert.equal(resolveVerifiedAccountKey(null, matchedCache), null);
});

test('downloadToFile follows redirects and rejects non-200 responses cleanly', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-download-'));
  const server = http.createServer((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { Location: '/final' });
      res.end();
    } else if (req.url === '/final') {
      res.writeHead(200, { 'Content-Type': 'text/javascript' });
      res.end('console.log("ok");');
    } else {
      res.writeHead(404);
      res.end('not found');
    }
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const okDest = path.join(tmp, 'ok.js');
    await downloadToFile(`http://127.0.0.1:${port}/redirect`, okDest);
    assert.equal(fs.readFileSync(okDest, 'utf8'), 'console.log("ok");');

    const failDest = path.join(tmp, 'fail.js');
    await assert.rejects(
      downloadToFile(`http://127.0.0.1:${port}/missing`, failDest),
      /Failed to fetch bootstrap: 404/
    );
  } finally {
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
