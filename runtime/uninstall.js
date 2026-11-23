#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveAntigravityPath, getAntigravityRoots } = require('./paths.js');

function normalizeForMatch(value) {
  return String(value).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function isOurStatusLineCommand(command, runtimeDir) {
  if (!command || !runtimeDir) return false;
  // Normalize slashes & case so Windows backslash/drive-letter casing mismatches
  // still recognize our statusLine entry while leaving foreign commands alone.
  const normalizedCommand = normalizeForMatch(command);
  const normalizedRuntime = normalizeForMatch(runtimeDir);
  if (!normalizedRuntime) return false;
  return normalizedCommand.includes(normalizedRuntime);
}

function clearStatusLine(settingsPath, runtimeDir) {
  if (!fs.existsSync(settingsPath)) {
    return { changed: false, reason: 'no_settings' };
  }
  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch {
    return { changed: false, reason: 'parse_error' };
  }
  const current = settings && settings.statusLine && settings.statusLine.command;
  if (!current) return { changed: false, reason: 'no_status_line' };
  if (!isOurStatusLineCommand(current, runtimeDir)) {
    return { changed: false, reason: 'foreign_status_line' };
  }
  fs.copyFileSync(settingsPath, settingsPath + '.bak');
  delete settings.statusLine;
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
  return { changed: true };
}

function removeRuntimeDir(runtimeDir) {
  if (!fs.existsSync(runtimeDir)) return { removed: false, reason: 'not_present' };
  fs.rmSync(runtimeDir, { recursive: true, force: true });
  return { removed: true };
}

function removeTokenMirrors(tmpDir = os.tmpdir()) {
  const removed = [];
  const candidates = [
    path.join(tmpDir, 'agy-hud-token.json'),
    path.join(tmpDir, 'agy-hud-quota-cache.json'),
  ];
  for (const file of candidates) {
    if (fs.existsSync(file)) {
      try {
        fs.unlinkSync(file);
        removed.push(file);
      } catch {
        // best-effort
      }
    }
  }
  return removed;
}

/**
 * Remove extra files written by the bootstrap/runtime that uninstall.js
 * previously missed: agy-hud-payload.json, update status, quota capacity,
 * refresh lock, persistent global config (unless preserveConfig is true),
 * and the hud/ directory.
 *
 * @param {string} root  antigravity-cli data root
 * @param {{ preserveConfig?: boolean }} [options]
 * @returns {string[]}   list of paths actually removed
 */
function removeExtraFiles(root, options = {}) {
  const removed = [];
  const targets = [
    path.join(root, 'agy-hud-payload.json'),
    path.join(root, 'agy-hud-token.json'),
    path.join(root, 'agy-hud-quota-cache.json'),
    path.join(root, 'agy-hud-update-status.json'),
    path.join(root, 'quota-capacity.json'),
    path.join(root, 'agy-hud-refresh.lock'),
    path.join(root, 'agy-hud-error.log'),
    path.join(root, 'daily-cost.json'),
    path.join(root, 'speed-cache'),
    path.join(root, 'hud'),
  ];
  if (!options.preserveConfig) {
    targets.push(path.join(root, 'agy-hud.config.json'));
  }
  for (const target of targets) {
    if (fs.existsSync(target)) {
      try {
        fs.rmSync(target, { recursive: true, force: true });
        removed.push(target);
      } catch {
        // best-effort
      }
    }
  }
  return removed;
}

function removeWindowsShShims(platform = process.platform, env = process.env) {
  if (platform !== 'win32') return [];
  try {
    const installer = require('./statusline-installer.js');
    const body = installer.buildShShimContents();
    const isOurs = typeof installer.isOurShShim === 'function'
      ? installer.isOurShShim
      : (contents => contents === body || contents.includes(':: agy-hud-shim'));
    const dirs = installer.getWindowsAgyBinDirs(env);
    const removed = [];
    for (const dir of dirs) {
      for (const name of ['sh.cmd', 'sh.bat']) {
        const target = path.join(dir, name);
        try {
          if (fs.existsSync(target)) {
            const contents = fs.readFileSync(target, 'utf8');
            if (isOurs(contents)) {
              fs.unlinkSync(target);
              removed.push(target);
            }
          }
        } catch {}
      }
    }
    return removed;
  } catch {
    return [];
  }
}

function uninstall(options = {}) {
  const env = options.env || process.env;
  const homeDir = options.homeDir || os.homedir();
  const platform = options.platform || process.platform;
  // Search all candidate roots — uninstall should clean any root we may have
  // touched, not just the first one we'd pick today.
  const roots = options.roots || getAntigravityRoots(env, homeDir);
  const settingsPath = options.settingsPath || resolveAntigravityPath('settings.json', env, homeDir);

  const results = { settingsPath, statusLine: null, runtimes: [], tokenMirrors: [], extraFiles: [] };

  for (const root of roots) {
    const runtimeDir = path.join(root, 'agy-hud-runtime');
    const runtimeResult = removeRuntimeDir(runtimeDir);
    results.runtimes.push({ runtimeDir, ...runtimeResult });
    // Best-effort clear for each root's settings.json (most installs only have one).
    const rootSettings = path.join(root, 'settings.json');
    if (rootSettings !== settingsPath) {
      results.runtimes.push({ runtimeDir: rootSettings, ...clearStatusLine(rootSettings, runtimeDir) });
    }
    // Remove extra files (payload cache, hud dir) that earlier versions left behind.
    results.extraFiles.push(...removeExtraFiles(root, { preserveConfig: options.preserveConfig }));
  }

  // Primary settings.json cleared against the active runtime path.
  const activeRuntimeDir = path.join(path.dirname(settingsPath), 'agy-hud-runtime');
  results.statusLine = clearStatusLine(settingsPath, activeRuntimeDir);
  results.tokenMirrors = removeTokenMirrors(options.tmpDir || os.tmpdir());
  results.shShims = removeWindowsShShims(platform, env);

  return results;
}

if (require.main === module) {
  const result = uninstall();
  process.stdout.write(`AGY-HUD uninstall complete\n`);
  process.stdout.write(`settings: ${result.settingsPath} (${result.statusLine.changed ? 'cleared' : result.statusLine.reason})\n`);
  for (const r of result.runtimes) {
    if (r.removed) process.stdout.write(`runtime removed: ${r.runtimeDir}\n`);
  }
  for (const f of result.tokenMirrors) {
    process.stdout.write(`token mirror removed: ${f}\n`);
  }
  for (const f of result.extraFiles) {
    process.stdout.write(`extra file removed: ${f}\n`);
  }
  for (const f of result.shShims) {
    process.stdout.write(`Windows sh shim removed: ${f}\n`);
  }
}

module.exports = {
  isOurStatusLineCommand,
  clearStatusLine,
  removeRuntimeDir,
  removeTokenMirrors,
  removeExtraFiles,
  removeWindowsShShims,
  uninstall,
};
