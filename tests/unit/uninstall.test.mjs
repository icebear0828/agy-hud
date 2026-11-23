import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const uninstallModule = require('../../runtime/uninstall.js');
const {
  isOurStatusLineCommand,
  removeExtraFiles,
  removeWindowsShShims,
  clearStatusLine,
  uninstall,
} = uninstallModule;

test('removeExtraFiles removes runtime caches, update status, capacity ledger, lock, and global config', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uninstall-extra-test-'));
  try {
    const payloadFile = path.join(tmp, 'agy-hud-payload.json');
    const tokenFile = path.join(tmp, 'agy-hud-token.json');
    const cacheFile = path.join(tmp, 'agy-hud-quota-cache.json');
    const updateStatusFile = path.join(tmp, 'agy-hud-update-status.json');
    const quotaCapacityFile = path.join(tmp, 'quota-capacity.json');
    const refreshLockFile = path.join(tmp, 'agy-hud-refresh.lock');
    const globalConfigFile = path.join(tmp, 'agy-hud.config.json');
    const errorFile = path.join(tmp, 'agy-hud-error.log');
    const dailyCostFile = path.join(tmp, 'daily-cost.json');
    const speedCacheDir = path.join(tmp, 'speed-cache');
    const hudDir = path.join(tmp, 'hud');
    const otherFile = path.join(tmp, 'other.json');

    fs.writeFileSync(payloadFile, '{}');
    fs.writeFileSync(tokenFile, '{}');
    fs.writeFileSync(cacheFile, '{}');
    fs.writeFileSync(updateStatusFile, '{}');
    fs.writeFileSync(quotaCapacityFile, '{}');
    fs.writeFileSync(refreshLockFile, '12345');
    fs.writeFileSync(globalConfigFile, '{}');
    fs.writeFileSync(errorFile, '{}');
    fs.writeFileSync(dailyCostFile, '{}');
    fs.mkdirSync(speedCacheDir, { recursive: true });
    fs.writeFileSync(path.join(speedCacheDir, 'cache.json'), '{}');
    fs.mkdirSync(hudDir, { recursive: true });
    fs.writeFileSync(path.join(hudDir, 'file.txt'), 'hello');
    fs.writeFileSync(otherFile, '{}');

    const removed = removeExtraFiles(tmp);

    for (const target of [
      payloadFile,
      tokenFile,
      cacheFile,
      updateStatusFile,
      quotaCapacityFile,
      refreshLockFile,
      globalConfigFile,
      errorFile,
      dailyCostFile,
      speedCacheDir,
      hudDir,
    ]) {
      assert.ok(removed.includes(target), `expected ${path.basename(target)} to be removed`);
      assert.ok(!fs.existsSync(target), `expected ${path.basename(target)} to not exist`);
    }
    assert.ok(fs.existsSync(otherFile));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('removeExtraFiles can preserve persistent global config when preserveConfig is true', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uninstall-preserve-cfg-'));
  try {
    const globalConfigFile = path.join(tmp, 'agy-hud.config.json');
    const updateStatusFile = path.join(tmp, 'agy-hud-update-status.json');
    fs.writeFileSync(globalConfigFile, '{"language":"zh"}');
    fs.writeFileSync(updateStatusFile, '{}');

    const removed = removeExtraFiles(tmp, { preserveConfig: true });

    assert.ok(removed.includes(updateStatusFile));
    assert.ok(!removed.includes(globalConfigFile));
    assert.ok(fs.existsSync(globalConfigFile));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('isOurStatusLineCommand normalizes slashes and case for Windows paths', () => {
  const runtimeDir = 'C:\\Users\\Alice\\.gemini\\antigravity-cli\\agy-hud-runtime';
  assert.equal(
    isOurStatusLineCommand(
      'c:/users/alice/.gemini/antigravity-cli/agy-hud-runtime/runtime/bin/agy-hud.cmd',
      runtimeDir
    ),
    true
  );
  assert.equal(
    isOurStatusLineCommand(
      'C:\\USERS\\ALICE\\.GEMINI\\ANTIGRAVITY-CLI\\AGY-HUD-RUNTIME\\runtime\\bin\\agy-hud.cmd',
      runtimeDir
    ),
    true
  );
  assert.equal(
    isOurStatusLineCommand('C:\\Other\\Tool\\statusline.cmd', runtimeDir),
    false
  );
});

test('clearStatusLine removes statusLine field if it points to our runtime (including Windows casing/slashes)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uninstall-settings-test-'));
  try {
    const settingsPath = path.join(tmp, 'settings.json');
    const runtimeDir = path.join(tmp, 'agy-hud-runtime');

    const settingsObj = {
      statusLine: {
        type: 'command',
        command: `node "${runtimeDir.replace(/\//g, '\\').toUpperCase()}\\runtime\\bin\\agy-hud.js"`,
        enabled: true
      },
      otherField: 'value'
    };
    fs.writeFileSync(settingsPath, JSON.stringify(settingsObj, null, 2));

    const result = clearStatusLine(settingsPath, runtimeDir);
    assert.equal(result.changed, true);

    const updatedSettings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.equal(updatedSettings.statusLine, undefined);
    assert.equal(updatedSettings.otherField, 'value');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('clearStatusLine leaves foreign statusLine commands untouched', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uninstall-foreign-test-'));
  try {
    const settingsPath = path.join(tmp, 'settings.json');
    const runtimeDir = path.join(tmp, 'agy-hud-runtime');

    const settingsObj = {
      statusLine: {
        type: 'command',
        command: 'node "/other/path/bin/script.js"',
        enabled: true
      }
    };
    fs.writeFileSync(settingsPath, JSON.stringify(settingsObj, null, 2));

    const result = clearStatusLine(settingsPath, runtimeDir);
    assert.equal(result.changed, false);
    assert.equal(result.reason, 'foreign_status_line');

    const updatedSettings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.equal(updatedSettings.statusLine.command, 'node "/other/path/bin/script.js"');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('removeWindowsShShims cleans up current and older marker-tagged shims but keeps third-party shims', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uninstall-shims-test-'));
  try {
    const installer = require('../../runtime/statusline-installer.js');
    const shimContents = installer.buildShShimContents();

    const ourShim = path.join(tmp, 'sh.cmd');
    const olderMarkedShim = path.join(tmp, 'sh.bat');

    fs.writeFileSync(ourShim, shimContents, 'utf8');
    fs.writeFileSync(olderMarkedShim, `@echo off\r\n${installer.SH_SHIM_MARKER}\r\ncmd /c %*\r\n`, 'utf8');

    const originalGetDirs = installer.getWindowsAgyBinDirs;
    installer.getWindowsAgyBinDirs = () => [tmp];

    try {
      const removed = removeWindowsShShims('win32', {});
      assert.ok(removed.includes(ourShim));
      assert.ok(removed.includes(olderMarkedShim));
      assert.ok(!fs.existsSync(ourShim));
      assert.ok(!fs.existsSync(olderMarkedShim));

      // Third-party shim without marker must remain untouched
      const foreignShim = path.join(tmp, 'sh.bat');
      fs.writeFileSync(foreignShim, 'different contents', 'utf8');
      const removedSecond = removeWindowsShShims('win32', {});
      assert.deepEqual(removedSecond, []);
      assert.ok(fs.existsSync(foreignShim));
    } finally {
      installer.getWindowsAgyBinDirs = originalGetDirs;
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('top-level uninstall({ env, homeDir }) operates only inside isolated tmp home', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uninstall-isolated-home-'));
  const fakeHome = path.join(tmp, 'home');
  const fakeTmp = path.join(tmp, 'tmp');
  const root = path.join(fakeHome, '.gemini', 'antigravity-cli');
  const runtimeDir = path.join(root, 'agy-hud-runtime');
  const settingsPath = path.join(root, 'settings.json');
  try {
    fs.mkdirSync(path.join(runtimeDir, 'runtime', 'bin'), { recursive: true });
    fs.mkdirSync(fakeTmp, { recursive: true });
    fs.writeFileSync(path.join(runtimeDir, 'runtime', 'bin', 'agy-hud.js'), '// stub');
    fs.writeFileSync(path.join(root, 'agy-hud-update-status.json'), '{}');
    fs.writeFileSync(path.join(root, 'quota-capacity.json'), '{}');
    fs.writeFileSync(path.join(root, 'agy-hud-refresh.lock'), '1');
    fs.writeFileSync(path.join(fakeTmp, 'agy-hud-token.json'), '{}');
    fs.writeFileSync(settingsPath, JSON.stringify({
      statusLine: {
        type: 'command',
        command: `"node" "${path.join(runtimeDir, 'runtime', 'bin', 'agy-hud.js')}"`,
      },
      keepMe: true,
    }, null, 2));

    const result = uninstall({
      env: {},
      homeDir: fakeHome,
      tmpDir: fakeTmp,
      platform: 'linux',
    });

    assert.equal(result.settingsPath, settingsPath);
    assert.equal(result.statusLine.changed, true);
    assert.equal(fs.existsSync(runtimeDir), false);
    assert.equal(fs.existsSync(path.join(root, 'agy-hud-update-status.json')), false);
    assert.equal(fs.existsSync(path.join(root, 'quota-capacity.json')), false);
    assert.equal(fs.existsSync(path.join(root, 'agy-hud-refresh.lock')), false);
    assert.equal(fs.existsSync(path.join(fakeTmp, 'agy-hud-token.json')), false);

    const updatedSettings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.equal(updatedSettings.statusLine, undefined);
    assert.equal(updatedSettings.keepMe, true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
