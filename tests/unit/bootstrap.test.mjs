import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..', '..');
const require = createRequire(import.meta.url);

test('bootstrap installs runtime files and writes statusLine from a source directory', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-setup-home-'));
  try {
    const result = spawnSync(process.execPath, ['scripts/bootstrap.js'], {
      cwd: projectRoot,
      env: {
        ...process.env,
        HOME: home,
        AGY_HUD_SETUP_SOURCE_DIR: projectRoot,
      },
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);

    const base = path.join(home, '.gemini', 'antigravity-cli');
    const runtime = path.join(base, 'agy-hud-runtime');
    const settingsPath = path.join(base, 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));

    assert.ok(fs.existsSync(path.join(runtime, 'package.json')));
    assert.ok(fs.existsSync(path.join(runtime, 'runtime', 'bin', 'agy-hud.js')));
    assert.ok(fs.existsSync(path.join(runtime, 'runtime', 'statusline-installer.js')));
    assert.equal(settings.statusLine.type, 'command');
    assert.match(settings.statusLine.command, /agy-hud-runtime/);
    assert.match(settings.statusLine.command, /runtime[/\\]bin[/\\]agy-hud\.js/);
    assert.match(result.stdout, /AGY-HUD bootstrap complete/);
    // Regression: command must point inside the isolated tmp HOME, not the real
    // user's antigravity-cli (configureStatusLine used to ignore homeDir).
    assert.ok(
      settings.statusLine.command.includes(home),
      `statusLine leaked outside tmp HOME: ${settings.statusLine.command}`
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('bootstrap does not require git clone as its runtime source', () => {
  const script = fs.readFileSync(path.join(projectRoot, 'scripts', 'bootstrap.js'), 'utf8');

  assert.match(script, /RUNTIME_FILES/);
  assert.match(script, /AGY_HUD_SETUP_SOURCE_BASE/);
  assert.doesNotMatch(script, /git clone/);
});

test('bootstrap refreshes quota cache during setup when a token is available', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-setup-quota-home-'));
  const cachePath = path.join(os.tmpdir(), 'agy-hud-quota-cache.json');
  const previousCache = fs.existsSync(cachePath) ? fs.readFileSync(cachePath, 'utf8') : null;
  const previousFetch = globalThis.fetch;
  try {
    const base = path.join(home, '.gemini', 'antigravity-cli');
    const tokenPath = path.join(base, 'antigravity-oauth-token');
    fs.mkdirSync(base, { recursive: true });
    fs.writeFileSync(tokenPath, JSON.stringify({
      token: {
        access_token: 'setup-token',
        expiry: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      },
    }));

    globalThis.fetch = async (url) => {
      if (String(url).includes('loadCodeAssist')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            paidTier: { id: 'g1-pro-tier', name: 'Google AI Pro' },
            allowedTiers: [{ id: 'standard-tier', name: 'Antigravity', isDefault: true }],
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          models: {
            'gemini-3-flash-agent': {
              displayName: 'Gemini 3.5 Flash (High)',
              quotaInfo: {
                remainingFraction: 0.64,
                resetTime: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
              },
            },
          },
        }),
      };
    };

    const { installRuntime } = require(path.join(projectRoot, 'scripts', 'bootstrap.js'));
    const result = await installRuntime({
      homeDir: home,
      sourceDir: projectRoot,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        XDG_DATA_HOME: '',
        APPDATA: '',
        LOCALAPPDATA: '',
      },
    });

    assert.deepEqual(result.quotaRefresh, { status: 'refreshed', count: 1, tier: 'Google AI Pro' });

    const quotaModule = require(path.join(result.runtimeDir, 'runtime', 'quota.js'));
    const cached = quotaModule.readCache({
      accessToken: 'rotated-setup-token',
      sourcePath: tokenPath,
    });

    assert.equal(cached.length, 1);
    assert.equal(cached[0].id, 'gemini-3-flash-agent');
    assert.equal(cached[0].remainingFraction, 0.64);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousCache === null) fs.rmSync(cachePath, { force: true });
    else fs.writeFileSync(cachePath, previousCache);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('bootstrap skips quota refresh when the available token is expired', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-setup-expired-home-'));
  const previousFetch = globalThis.fetch;
  try {
    const base = path.join(home, '.gemini', 'antigravity-cli');
    fs.mkdirSync(base, { recursive: true });
    fs.writeFileSync(path.join(base, 'antigravity-oauth-token'), JSON.stringify({
      token: {
        access_token: 'expired-setup-token',
        expiry: '2000-01-01T00:00:00.000Z',
      },
    }));

    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      return { ok: false, status: 401, json: async () => ({}) };
    };

    const { installRuntime } = require(path.join(projectRoot, 'scripts', 'bootstrap.js'));
    const result = await installRuntime({
      homeDir: home,
      sourceDir: projectRoot,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        XDG_DATA_HOME: '',
        APPDATA: '',
        LOCALAPPDATA: '',
      },
    });

    assert.deepEqual(result.quotaRefresh, { status: 'skipped', reason: 'expired_token' });
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = previousFetch;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
