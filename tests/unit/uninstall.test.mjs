import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const uninstallModule = require('../../runtime/uninstall.js');
const { removeExtraFiles, removeWindowsShShims, clearStatusLine, uninstall } = uninstallModule;

test('removeExtraFiles removes agy-hud-payload.json and hud directory', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uninstall-extra-test-'));
  try {
    const payloadFile = path.join(tmp, 'agy-hud-payload.json');
    const tokenFile = path.join(tmp, 'agy-hud-token.json');
    const cacheFile = path.join(tmp, 'agy-hud-quota-cache.json');
    const errorFile = path.join(tmp, 'agy-hud-error.log');
    const dailyCostFile = path.join(tmp, 'daily-cost.json');
    const speedCacheDir = path.join(tmp, 'speed-cache');
    const hudDir = path.join(tmp, 'hud');
    const otherFile = path.join(tmp, 'other.json');

    fs.writeFileSync(payloadFile, '{}');
    fs.writeFileSync(tokenFile, '{}');
    fs.writeFileSync(cacheFile, '{}');
    fs.writeFileSync(errorFile, '{}');
    fs.writeFileSync(dailyCostFile, '{}');
    fs.mkdirSync(speedCacheDir, { recursive: true });
    fs.writeFileSync(path.join(speedCacheDir, 'cache.json'), '{}');
    fs.mkdirSync(hudDir, { recursive: true });
    fs.writeFileSync(path.join(hudDir, 'file.txt'), 'hello');
    fs.writeFileSync(otherFile, '{}');

    const removed = removeExtraFiles(tmp);

    assert.ok(removed.includes(payloadFile));
    assert.ok(removed.includes(tokenFile));
    assert.ok(removed.includes(cacheFile));
    assert.ok(removed.includes(errorFile));
    assert.ok(removed.includes(dailyCostFile));
    assert.ok(removed.includes(speedCacheDir));
    assert.ok(removed.includes(hudDir));
    assert.ok(!fs.existsSync(payloadFile));
    assert.ok(!fs.existsSync(tokenFile));
    assert.ok(!fs.existsSync(cacheFile));
    assert.ok(!fs.existsSync(errorFile));
    assert.ok(!fs.existsSync(dailyCostFile));
    assert.ok(!fs.existsSync(speedCacheDir));
    assert.ok(!fs.existsSync(hudDir));
    assert.ok(fs.existsSync(otherFile));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('clearStatusLine removes statusLine field if it points to our runtime', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uninstall-settings-test-'));
  try {
    const settingsPath = path.join(tmp, 'settings.json');
    const runtimeDir = path.join(tmp, 'agy-hud-runtime');

    const settingsObj = {
      statusLine: {
        type: 'command',
        command: `node "${runtimeDir}/runtime/bin/agy-hud.js"`,
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

test('removeWindowsShShims cleans up only our shims on Windows', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uninstall-shims-test-'));
  try {
    const installer = require('../../runtime/statusline-installer.js');
    const shimContents = installer.buildShShimContents();

    const ourShim = path.join(tmp, 'sh.cmd');
    const foreignShim = path.join(tmp, 'sh.bat');

    // Create our shim matching exact contents
    fs.writeFileSync(ourShim, shimContents, 'utf8');
    // Create foreign shim with different contents
    fs.writeFileSync(foreignShim, 'different contents', 'utf8');

    // Mock getWindowsAgyBinDirs to return our temp directory
    const originalGetDirs = installer.getWindowsAgyBinDirs;
    installer.getWindowsAgyBinDirs = () => [tmp];

    try {
      const removed = removeWindowsShShims('win32', {});
      assert.ok(removed.includes(ourShim));
      assert.ok(!removed.includes(foreignShim));
      assert.ok(!fs.existsSync(ourShim));
      assert.ok(fs.existsSync(foreignShim));
    } finally {
      installer.getWindowsAgyBinDirs = originalGetDirs;
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
