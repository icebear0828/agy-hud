import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_CONFIG,
  loadConfig,
  getBundledConfigPath,
  getLocalConfigPath,
  getGlobalConfigPath,
  saveConfig,
} from '../../runtime/config.js';

function withEnv(overrides, fn) {
  const snapshot = {};
  for (const key of Object.keys(overrides)) {
    snapshot[key] = process.env[key];
    if (overrides[key] === undefined) delete process.env[key];
    else process.env[key] = overrides[key];
  }
  const restore = () => {
    for (const key of Object.keys(snapshot)) {
      if (snapshot[key] === undefined) delete process.env[key];
      else process.env[key] = snapshot[key];
    }
  };
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result.finally(restore);
    }
    restore();
    return result;
  } catch (err) {
    restore();
    throw err;
  }
}

function withCwd(cwd, fn) {
  const previous = process.cwd();
  process.chdir(cwd);
  const restore = () => process.chdir(previous);
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result.finally(restore);
    }
    restore();
    return result;
  } catch (err) {
    restore();
    throw err;
  }
}

test('DEFAULT_CONFIG uses theme object and includes showQuotaCapacity', () => {
  assert.equal(typeof DEFAULT_CONFIG.theme, 'object');
  assert.notEqual(DEFAULT_CONFIG.theme, null);
  assert.equal(DEFAULT_CONFIG.theme.primary, 'green');
  assert.equal(DEFAULT_CONFIG.display.showQuotaCapacity, true);
  assert.equal(DEFAULT_CONFIG.display.unicode, undefined);
});

test('bundled plugin config omits display.unicode and enables display.showQuotaCapacity', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-config-bundled-'));
  const dataDir = path.join(tmp, 'data');
  const workspace = path.join(tmp, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  try {
    const rawBundled = JSON.parse(fs.readFileSync(getBundledConfigPath(), 'utf8'));
    assert.equal(rawBundled.display.unicode, undefined);
    assert.equal(rawBundled.display.showQuotaCapacity, true);

    const config = await withEnv({ AGY_HUD_DATA_DIR: dataDir }, () => loadConfig(workspace));
    assert.equal(config.display.unicode, undefined);
    assert.equal(config.display.showQuotaCapacity, true);
    assert.equal(config.enabled, true);
    assert.equal(config.thresholds.warning, 0.7);
    assert.equal(config.thresholds.critical, 0.9);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('loadConfig accepts explicit cwd and deep-merges bundled, global, and local overrides', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-config-merge-'));
  const dataDir = path.join(tmp, 'data');
  const workspace = path.join(tmp, 'workspace');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  try {
    fs.writeFileSync(path.join(dataDir, 'agy-hud.config.json'), JSON.stringify({
      theme: { primary: 'blue' },
      display: { quotaStyle: 'compact', showSpeed: true },
      language: 'zh',
    }));

    fs.writeFileSync(path.join(workspace, 'agy-hud.config.json'), JSON.stringify({
      display: { columnWidth: 45 },
      enabled: false,
    }));

    const config = await withEnv({ AGY_HUD_DATA_DIR: dataDir }, () => loadConfig(workspace));

    assert.equal(config.enabled, false);
    assert.equal(config.language, 'zh');
    assert.equal(config.theme.primary, 'blue');
    assert.equal(config.theme.secondary, 'gray');
    assert.equal(config.display.columnWidth, 45);
    assert.equal(config.display.quotaStyle, 'compact');
    assert.equal(config.display.showSpeed, true);
    assert.equal(config.display.showQuotaCapacity, true);
    assert.equal(config.display.showTokenBar, true);
    assert.equal(config.display.unicode, undefined);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('loadConfig falls back to merged global config when local JSON is corrupt', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-config-corrupt-local-'));
  const dataDir = path.join(tmp, 'data');
  const workspace = path.join(tmp, 'workspace');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  try {
    fs.writeFileSync(path.join(dataDir, 'agy-hud.config.json'), JSON.stringify({
      theme: { primary: 'magenta' },
      display: { quotaStyle: 'models', showCost: true },
    }));
    fs.writeFileSync(path.join(workspace, 'agy-hud.config.json'), '{not valid json');

    const config = await withEnv({ AGY_HUD_DATA_DIR: dataDir }, () => loadConfig(workspace));

    assert.equal(config.enabled, true);
    assert.equal(config.theme.primary, 'magenta');
    assert.equal(config.theme.critical, 'red');
    assert.equal(config.display.quotaStyle, 'models');
    assert.equal(config.display.showCost, true);
    assert.equal(config.display.showQuotaCapacity, true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('global config path resolves outside agy-hud-runtime so upgrades preserve user settings', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-config-persistent-'));
  const home = path.join(tmp, 'home');
  const env = {
    HOME: home,
    USERPROFILE: home,
    AGY_HUD_DATA_DIR: undefined,
    XDG_DATA_HOME: undefined,
    APPDATA: undefined,
    LOCALAPPDATA: undefined,
  };
  try {
    const globalPath = getGlobalConfigPath(env, home);
    const expected = path.join(home, '.gemini', 'antigravity-cli', 'agy-hud.config.json');
    assert.equal(globalPath, expected);
    assert.equal(globalPath.includes('agy-hud-runtime'), false);

    await saveConfig({ display: { showCost: true } }, true, { env, homeDir: home });
    assert.ok(fs.existsSync(expected));

    const runtimeDir = path.join(home, '.gemini', 'antigravity-cli', 'agy-hud-runtime');
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.rmSync(runtimeDir, { recursive: true, force: true });

    const loaded = await loadConfig(tmp, { env, homeDir: home });
    assert.equal(loaded.display.showCost, true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('saveConfig writes config to local path', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-config-save-'));
  try {
    await withCwd(tmp, async () => {
      const localPath = getLocalConfigPath();
      assert.equal(fs.realpathSync(path.dirname(localPath)), fs.realpathSync(tmp));

      const newConfig = { theme: 'yellow', display: { useNerdFonts: true } };
      await saveConfig(newConfig, false);

      const read = JSON.parse(fs.readFileSync(localPath, 'utf8'));
      assert.deepEqual(read, newConfig);
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('saveConfig writes config to global path without touching real HOME', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-config-global-'));
  const dataDir = path.join(tmp, 'antigravity-cli');
  try {
    await withEnv({ AGY_HUD_DATA_DIR: dataDir }, async () => {
      const globalPath = getGlobalConfigPath();
      assert.equal(globalPath, path.join(dataDir, 'agy-hud.config.json'));

      const newConfig = { display: { quotaStyle: 'compact' } };
      await saveConfig(newConfig, true);

      const read = JSON.parse(fs.readFileSync(globalPath, 'utf8'));
      assert.deepEqual(read, newConfig);
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('saveConfig throws on write failure', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-config-err-'));
  try {
    await withCwd(tmp, async () => {
      const localPath = getLocalConfigPath();
      fs.mkdirSync(localPath);
      await assert.rejects(() => saveConfig({ enabled: true }, false));
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
