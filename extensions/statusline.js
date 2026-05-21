'use strict';

const fs = require('fs');
const path = require('path');
const { resolveAntigravityPath } = require('./paths.js');

function getSettingsPath() {
  return resolveAntigravityPath('settings.json');
}

/**
 * Build the Windows .cmd shim that the statusLine command points to.
 *
 * Single string commands can't both (a) call `node` from PATH and (b) fall back
 * to `C:\Program Files\nodejs\node.exe` — the second path's space breaks any
 * outer quoting that antigravity-cli applies. A `.cmd` file sidesteps quoting
 * entirely: `||` shorts-circuits, and `%~dp0` resolves to the shim's own dir
 * so the script keeps working when the runtime is relocated.
 *
 * @param {string} hudScriptPath  absolute path to agy-hud.js
 */
function buildCmdShimContents(hudScriptPath) {
  // Use win32 basename so the shim works correctly even when generated on a
  // non-Windows host (e.g. tests on macOS pass Windows-style paths).
  const scriptName = path.win32.basename(hudScriptPath);
  return [
    '@echo off',
    'setlocal',
    `node "%~dp0${scriptName}" %* 2>nul`,
    'if %ERRORLEVEL%==0 exit /b 0',
    `if exist "%ProgramFiles%\\nodejs\\node.exe" "%ProgramFiles%\\nodejs\\node.exe" "%~dp0${scriptName}" %*`,
    '',
  ].join('\r\n');
}

function buildShShimContents() {
  return [
    '@echo off',
    'setlocal EnableExtensions',
    'if /I "%~1"=="-c" (',
    '  set "CMDLINE=%~2"',
    ') else (',
    '  set "CMDLINE=%*"',
    ')',
    'set "CMDLINE=%CMDLINE:\\"="%"',
    'cmd.exe /d /s /c "%CMDLINE%"',
    'exit /b %ERRORLEVEL%',
    '',
  ].join('\r\n');
}

function getWindowsAgyBinDirs(env = process.env) {
  const dirs = [];

  if (env.LOCALAPPDATA) {
    dirs.push(path.join(env.LOCALAPPDATA, 'agy', 'bin'));
    dirs.push(path.join(env.LOCALAPPDATA, 'Microsoft', 'WindowsApps'));
  }

  if (env.APPDATA) {
    dirs.push(path.join(env.APPDATA, 'npm'));
  }

  if (env.USERPROFILE) {
    dirs.push(path.join(env.USERPROFILE, 'App'));
  }

  const pathEntries = (env.PATH || env.Path || '')
    .split(path.delimiter)
    .map(entry => entry.trim())
    .filter(Boolean);

  for (const dir of pathEntries) {
    if (fs.existsSync(path.join(dir, 'agy.exe'))) {
      dirs.push(dir);
    }
  }

  return [...new Set(dirs.map(dir => path.resolve(dir)))];
}

function ensureWindowsShShim(platform = process.platform, env = process.env) {
  if (platform !== 'win32') return [];

  const body = buildShShimContents();
  const written = [];
  for (const dir of getWindowsAgyBinDirs(env)) {
    try {
      if (!fs.existsSync(dir)) continue;
      for (const name of ['sh.cmd', 'sh.bat']) {
        fs.writeFileSync(path.join(dir, name), body, 'utf8');
        written.push(path.join(dir, name));
      }
    } catch {
      // Best-effort: statusline still gets configured, and agy logs the failure.
    }
  }
  return written;
}

/**
 * Write the .cmd shim next to agy-hud.js on Windows. No-op on other platforms.
 * Returns the shim path (or null if not on Windows).
 *
 * @param {string} hudScriptPath
 * @param {NodeJS.Platform} platform
 * @returns {string|null}
 */
function writeCmdShim(hudScriptPath, platform = process.platform) {
  if (platform !== 'win32') return null;
  const shimPath = hudScriptPath.replace(/\.js$/i, '.cmd');
  const contents = buildCmdShimContents(hudScriptPath);
  fs.mkdirSync(path.dirname(shimPath), { recursive: true });
  fs.writeFileSync(shimPath, contents, 'utf8');
  return shimPath;
}

/**
 * Build the statusLine command string written into settings.json.
 *
 * On Windows we point at a `.cmd` shim generated alongside the HUD entrypoint.
 * On Unix we use the absolute `process.execPath` so the user's PATH doesn't
 * matter.
 */
function createStatusLineCommand(hudScriptPath, nodePath = process.execPath || 'node', platform = process.platform) {
  if (platform === 'win32') {
    const shimPath = hudScriptPath.replace(/\.js$/i, '.cmd');
    return `"${shimPath}"`;
  }
  return `"${nodePath}" "${hudScriptPath}"`;
}

function configureStatusLine(baseDir = __dirname) {
  const settingsPath = getSettingsPath();
  const hudScriptPath = path.resolve(baseDir, 'bin', 'agy-hud.js');

  // Generate the Windows .cmd shim alongside the HUD script (no-op on Unix).
  writeCmdShim(hudScriptPath);
  ensureWindowsShShim();

  const targetCommand = createStatusLineCommand(hudScriptPath);

  let settings = {};
  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    } catch {
      settings = {};
    }
  }

  if (!settings.statusLine || settings.statusLine.command !== targetCommand) {
    settings.statusLine = {
      type: 'command',
      command: targetCommand,
    };
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
  }

  return { settingsPath, command: targetCommand };
}

module.exports = {
  buildCmdShimContents,
  buildShShimContents,
  writeCmdShim,
  ensureWindowsShShim,
  getWindowsAgyBinDirs,
  createStatusLineCommand,
  configureStatusLine,
  getSettingsPath,
};
