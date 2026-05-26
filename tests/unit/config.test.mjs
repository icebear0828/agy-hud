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

// Regression: when the bundled config hardcodes display.unicode=true, the
// renderer's `unicode = config.display.unicode ?? supportsUnicode()` short-
// circuits and ignores the terminal capability check. Windows cp936 users
// then see garbled glyphs because we force-emit UTF-8 box-drawing chars.
// The bundled config must NOT set display.unicode so the renderer can fall
// back to encoding.js detection.
test('bundled plugin config does not hardcode display.unicode (lets encoding.js decide)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-config-unicode-'));
  try {
    const config = await withCwd(tmp, () => loadConfig());

    assert.equal(
      config.display.unicode,
      undefined,
      'bundled config must omit display.unicode so renderer can auto-detect; ' +
      `hardcoding 'true' breaks ASCII fallback on cp936/cp1252 Windows consoles`
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
      assert.equal(localPath, path.join(tmp, 'agy-hud.config.json'));
      
      const newConfig = { theme: 'yellow', display: { useNerdFonts: true } };
      await saveConfig(newConfig, false);
      
      const read = JSON.parse(fs.readFileSync(localPath, 'utf8'));
      assert.deepEqual(read, newConfig);
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

