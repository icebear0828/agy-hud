import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, getLocalConfigPath, getGlobalConfigPath, saveConfig } from '../../runtime/config.js';

function withCwd(cwd, fn) {
  const previous = process.cwd();
  process.chdir(cwd);
  try {
    return fn();
  } finally {
    process.chdir(previous);
  }
}

test('loadConfig reads project-local config before plugin defaults', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-config-local-'));
  try {
    fs.writeFileSync(path.join(tmp, 'agy-hud.config.json'), JSON.stringify({
      display: { columnWidth: 45 },
      enabled: false,
    }));

    const config = await withCwd(tmp, () => loadConfig());

    assert.equal(config.enabled, false);
    assert.deepEqual(config.display, { columnWidth: 45 });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('loadConfig falls back to bundled plugin config when local config is absent', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-config-plugin-'));
  try {
    const config = await withCwd(tmp, () => loadConfig());

    assert.equal(config.enabled, true);
    assert.equal(config.thresholds.warning, 0.7);
    assert.equal(config.thresholds.critical, 0.9);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('bundled plugin config sets display.unicode to true by default', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-config-unicode-'));
  try {
    const config = await withCwd(tmp, () => loadConfig());

    assert.equal(
      config.display.unicode,
      true,
      'bundled config defaults to unicode: true'
    );
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

test('saveConfig writes config to global path', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-config-global-'));
  const globalPath = getGlobalConfigPath();
  const backup = fs.existsSync(globalPath) ? fs.readFileSync(globalPath) : null;
  try {
    const newConfig = { display: { quotaStyle: 'compact' } };
    await saveConfig(newConfig, true);

    const read = JSON.parse(fs.readFileSync(globalPath, 'utf8'));
    assert.deepEqual(read, newConfig);
  } finally {
    if (backup !== null) {
      fs.writeFileSync(globalPath, backup);
    } else if (fs.existsSync(globalPath)) {
      fs.unlinkSync(globalPath);
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('saveConfig throws on write failure', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-config-err-'));
  try {
    await withCwd(tmp, async () => {
      // Make a directory at the config path so writeFileSync fails
      const localPath = getLocalConfigPath();
      fs.mkdirSync(localPath);
      await assert.rejects(() => saveConfig({ enabled: true }, false));
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

