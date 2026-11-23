import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { CACHE_PATH } from './_helpers/quota-test-utils.mjs';

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-test-bootstrap-'));
process.env.AGY_HUD_DATA_DIR = testDataDir;

try {
  fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
} catch {}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..', '..');
const require = createRequire(import.meta.url);
const bootstrapModule = require(path.join(projectRoot, 'scripts', 'bootstrap.js'));
const { RUNTIME_FILES, installRuntime, cleanStalePluginFiles } = bootstrapModule;

// Build a staging source directory only if a planned RUNTIME_FILES entry
// (e.g. runtime/quota-capacity.js prior to branch integration) is not yet on disk.
let stagedSourceDir = null;
function getCompleteSourceDir() {
  const missing = RUNTIME_FILES.filter(rel =>
    !fs.existsSync(path.join(projectRoot, ...rel.split('/')))
  );
  if (missing.length === 0) return projectRoot;
  if (stagedSourceDir) return stagedSourceDir;

  stagedSourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-staged-src-'));
  for (const rel of RUNTIME_FILES) {
    const src = path.join(projectRoot, ...rel.split('/'));
    const dst = path.join(stagedSourceDir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dst);
    } else {
      fs.writeFileSync(dst, "'use strict';\nmodule.exports = {};\n", 'utf8');
    }
  }
  return stagedSourceDir;
}

process.on('exit', () => {
  try {
    fs.rmSync(testDataDir, { recursive: true, force: true });
  } catch {}
  if (stagedSourceDir) {
    try {
      fs.rmSync(stagedSourceDir, { recursive: true, force: true });
    } catch {}
  }
});

function walkRuntimeFiles(dir, baseDir = projectRoot) {
  const entries = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      entries.push(...walkRuntimeFiles(full, baseDir));
    } else if (entry.isFile() && (entry.name.endsWith('.js') || entry.name === 'agy-hud.config.json')) {
      entries.push(path.relative(baseDir, full).replace(/\\/g, '/'));
    }
  }
  return entries.sort();
}

test('RUNTIME_FILES includes every runtime/**/*.js and runtime/agy-hud.config.json on disk plus config-wizard and quota-capacity', () => {
  const onDisk = walkRuntimeFiles(path.join(projectRoot, 'runtime'));
  assert.ok(onDisk.length > 0);
  for (const rel of onDisk) {
    assert.ok(
      RUNTIME_FILES.includes(rel),
      `runtime file missing from RUNTIME_FILES: ${rel}`
    );
  }
  assert.ok(RUNTIME_FILES.includes('runtime/config-wizard.js'));
  assert.ok(RUNTIME_FILES.includes('runtime/quota-capacity.js'));
});

test('bootstrap installs runtime files and writes statusLine from a source directory', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-setup-home-'));
  try {
    const result = spawnSync(process.execPath, ['scripts/bootstrap.js'], {
      cwd: projectRoot,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        AGY_HUD_SETUP_SOURCE_DIR: getCompleteSourceDir(),
        APPDATA: '',
        LOCALAPPDATA: '',
        XDG_DATA_HOME: '',
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
    assert.ok(fs.existsSync(path.join(runtime, 'runtime', 'config-wizard.js')));
    assert.ok(fs.existsSync(path.join(runtime, 'runtime', 'quota-capacity.js')));
    assert.ok(fs.existsSync(path.join(runtime, 'runtime', 'cost.js')));
    assert.ok(fs.existsSync(path.join(runtime, 'runtime', 'daily-cost.js')));
    assert.ok(fs.existsSync(path.join(runtime, 'runtime', 'speed.js')));
    assert.ok(fs.existsSync(path.join(runtime, 'runtime', 'statusline-installer.js')));
    assert.equal(settings.statusLine.type, 'command');
    assert.match(settings.statusLine.command, /agy-hud-runtime/);
    assert.match(settings.statusLine.command, /runtime[/\\]bin[/\\]agy-hud\.(?:js|cmd)/);
    assert.match(result.stdout, /AGY-HUD bootstrap complete/);
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
  const cachePath = CACHE_PATH;
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

    const result = await installRuntime({
      homeDir: home,
      sourceDir: getCompleteSourceDir(),
      platform: 'linux',
      keyringReader: () => null,
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

    const result = await installRuntime({
      homeDir: home,
      sourceDir: getCompleteSourceDir(),
      platform: 'linux',
      keyringReader: () => null,
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

test('bootstrap cleans stale plugin files from current agy config plugin root', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-plugin-root-'));
  try {
    const antigravityRoot = path.join(home, '.gemini', 'antigravity-cli');
    const configPluginDir = path.join(home, '.gemini', 'config', 'plugins', 'agy-hud');
    fs.mkdirSync(configPluginDir, { recursive: true });
    const staleHook = path.join(configPluginDir, 'hooks.json');
    const staleAgents = path.join(configPluginDir, 'agents');
    fs.writeFileSync(staleHook, '{}');
    fs.mkdirSync(staleAgents);

    const removed = cleanStalePluginFiles(antigravityRoot, {
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
      },
      homeDir: home,
    });

    assert.equal(fs.existsSync(staleHook), false);
    assert.equal(fs.existsSync(staleAgents), false);
    assert.deepEqual(
      removed.map(entry => path.relative(home, entry)).sort(),
      [
        path.join('.gemini', 'config', 'plugins', 'agy-hud', 'agents'),
        path.join('.gemini', 'config', 'plugins', 'agy-hud', 'hooks.json'),
      ].sort()
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('bootstrap migrates legacy runtime config and preserves persistent global config across upgrades', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-config-migrate-'));
  try {
    const root = path.join(home, '.gemini', 'antigravity-cli');
    const runtimeDir = path.join(root, 'agy-hud-runtime');
    const legacyConfigPath = path.join(runtimeDir, 'runtime', 'agy-hud.config.json');
    const persistentConfigPath = path.join(root, 'agy-hud.config.json');

    fs.mkdirSync(path.dirname(legacyConfigPath), { recursive: true });
    fs.writeFileSync(legacyConfigPath, JSON.stringify({
      theme: { primary: 'magenta' },
      display: { quotaStyle: 'compact', showCost: true },
    }, null, 2));

    const commonOpts = {
      homeDir: home,
      sourceDir: getCompleteSourceDir(),
      platform: 'linux',
      keyringReader: () => null,
      env: {
        HOME: home,
        USERPROFILE: home,
        XDG_DATA_HOME: '',
        APPDATA: '',
        LOCALAPPDATA: '',
      },
    };

    // First upgrade migrates legacy config out of agy-hud-runtime/
    const first = await installRuntime(commonOpts);
    assert.equal(first.migratedConfig, persistentConfigPath);
    assert.ok(fs.existsSync(persistentConfigPath));
    const migrated = JSON.parse(fs.readFileSync(persistentConfigPath, 'utf8'));
    assert.equal(migrated.theme.primary, 'magenta');
    assert.equal(migrated.display.quotaStyle, 'compact');

    // User edits persistent global config; subsequent upgrade must NOT overwrite it
    fs.writeFileSync(persistentConfigPath, JSON.stringify({
      theme: { primary: 'yellow' },
      display: { showSpeed: true },
    }, null, 2));

    const second = await installRuntime(commonOpts);
    assert.equal(second.migratedConfig, null);
    const preserved = JSON.parse(fs.readFileSync(persistentConfigPath, 'utf8'));
    assert.equal(preserved.theme.primary, 'yellow');
    assert.equal(preserved.display.showSpeed, true);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('bootstrap clears stale agy-hud-update-status.json on successful install', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-clear-update-status-'));
  try {
    const root = path.join(home, '.gemini', 'antigravity-cli');
    const updateStatusPath = path.join(root, 'agy-hud-update-status.json');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(updateStatusPath, JSON.stringify({
      lastCheck: Date.now(),
      updateAvailable: true,
      latestVersion: '9.9.9',
      localVersion: '0.3.2',
    }));

    await installRuntime({
      homeDir: home,
      sourceDir: getCompleteSourceDir(),
      platform: 'linux',
      keyringReader: () => null,
      env: {
        HOME: home,
        USERPROFILE: home,
        XDG_DATA_HOME: '',
        APPDATA: '',
        LOCALAPPDATA: '',
      },
    });

    assert.equal(fs.existsSync(updateStatusPath), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('bootstrap downloads RUNTIME_FILES with bounded concurrency and rolls back on single-file failure', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-concurrent-dl-'));
  const srcRoot = getCompleteSourceDir();
  let inFlight = 0;
  let maxInFlight = 0;
  let failPath = null;

  const server = http.createServer((req, res) => {
    const rel = req.url.replace(/^\/+/, '');
    inFlight += 1;
    if (inFlight > maxInFlight) maxInFlight = inFlight;

    setTimeout(() => {
      inFlight -= 1;
      if (failPath && rel === failPath) {
        res.statusCode = 500;
        res.end('boom');
        return;
      }
      const filePath = path.join(srcRoot, ...rel.split('/'));
      if (!fs.existsSync(filePath)) {
        res.statusCode = 404;
        res.end('not found');
        return;
      }
      res.statusCode = 200;
      res.end(fs.readFileSync(filePath));
    }, 15);
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const result = await installRuntime({
      homeDir: home,
      sourceBase: baseUrl,
      concurrency: 4,
      maxAttempts: 1,
      platform: 'linux',
      keyringReader: () => null,
      env: {
        HOME: home,
        USERPROFILE: home,
        XDG_DATA_HOME: '',
        APPDATA: '',
        LOCALAPPDATA: '',
      },
    });

    assert.ok(maxInFlight > 1, `expected concurrent downloads (>1), got maxInFlight=${maxInFlight}`);
    assert.ok(maxInFlight <= 4, `expected bounded concurrency (<=4), got maxInFlight=${maxInFlight}`);

    // Mark installed runtime and trigger a single-file failure -> existing runtime must survive
    const sentinel = path.join(result.runtimeDir, 'runtime', 'bin', 'agy-hud.js');
    fs.writeFileSync(sentinel, 'known-good-runtime', 'utf8');
    failPath = 'runtime/speed.js';

    await assert.rejects(
      () => installRuntime({
        homeDir: home,
        sourceBase: baseUrl,
        concurrency: 4,
        maxAttempts: 1,
        platform: 'linux',
        keyringReader: () => null,
        env: {
          HOME: home,
          USERPROFILE: home,
          XDG_DATA_HOME: '',
          APPDATA: '',
          LOCALAPPDATA: '',
        },
      }),
      /download failed \(500\)/
    );

    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'known-good-runtime');
    // No leftover temp directories
    const leftoverTmp = fs.readdirSync(result.antigravityRoot).filter(n => n.startsWith('agy-hud-runtime.tmp-'));
    assert.deepEqual(leftoverTmp, []);
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('bootstrap preserves existing runtime when replacement download fails', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-bootstrap-atomic-'));
  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-incomplete-source-'));
  try {
    const antigravityRoot = path.join(home, '.gemini', 'antigravity-cli');
    const runtimeDir = path.join(antigravityRoot, 'agy-hud-runtime');
    const sentinel = path.join(runtimeDir, 'runtime', 'bin', 'agy-hud.js');
    fs.mkdirSync(path.dirname(sentinel), { recursive: true });
    fs.writeFileSync(sentinel, 'old working runtime');

    await assert.rejects(
      () => installRuntime({
        homeDir: home,
        sourceDir: source,
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          XDG_DATA_HOME: '',
          APPDATA: '',
          LOCALAPPDATA: '',
        },
      }),
      /ENOENT/
    );

    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'old working runtime');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(source, { recursive: true, force: true });
  }
});
