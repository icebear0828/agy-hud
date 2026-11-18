import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SHELLS = ['posix', 'gitbash', 'powershell'];
const LAUNCHER = fileURLToPath(new URL('./scripts/statusline.mjs', import.meta.url));

export function detectShell(env = process.env, platform = process.platform) {
  if (platform !== 'win32') return 'posix';
  return env.MSYSTEM || /bash/i.test(env.SHELL ?? '') ? 'gitbash' : 'powershell';
}

const quote = (value) => `'${value.replaceAll("'", `'\\''`)}'`;

export function buildCmdShimContents(targetScriptPath, nodePath = process.execPath) {
  const scriptName = path.win32.basename(targetScriptPath);
  const lines = ['@echo off', 'setlocal'];
  if (typeof nodePath === 'string' && /^[A-Za-z]:\\/.test(nodePath) && !/["&|<>^%!]/.test(nodePath)) {
    lines.push(
      `if exist "${nodePath}" (`,
      `  "${nodePath}" "%~dp0${scriptName}" %*`,
      '  exit /b %ERRORLEVEL%',
      ')',
    );
  }
  lines.push(
    `node "%~dp0${scriptName}" %* 2>nul`,
    'if %ERRORLEVEL%==0 exit /b 0',
    `if exist "%ProgramFiles%\\nodejs\\node.exe" "%ProgramFiles%\\nodejs\\node.exe" "%~dp0${scriptName}" %*`,
    '',
  );
  return lines.join('\r\n');
}

export const LEGACY_SH_SHIM_BODY = [
  '@echo off',
  'setlocal EnableExtensions',
  'if /I "%~1"=="-c" (',
  '  set "CMDLINE=%~2"',
  ') else (',
  '  set "CMDLINE=%*"',
  ')',
  'cmd.exe /d /c "%CMDLINE%"',
  'exit /b %ERRORLEVEL%',
  '',
].join('\r\n');

export function buildShShimContents() {
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

export function isOurShShimContents(content) {
  return content === buildShShimContents() || content === LEGACY_SH_SHIM_BODY;
}

export function getWindowsAgyBinDirs(env = process.env) {
  const dirs = [];
  if (env.LOCALAPPDATA) dirs.push(path.join(env.LOCALAPPDATA, 'agy', 'bin'));
  const pathEntries = (env.PATH || env.Path || '').split(path.delimiter).map((e) => e.trim()).filter(Boolean);
  for (const dir of pathEntries) {
    if (fs.existsSync(path.join(dir, 'agy.exe'))) dirs.push(dir);
  }
  return [...new Set(dirs.map((dir) => path.resolve(dir)))];
}

export function ensureWindowsShShim(platform = process.platform, env = process.env) {
  if (platform !== 'win32') return [];
  const body = buildShShimContents();
  const written = [];
  for (const dir of getWindowsAgyBinDirs(env)) {
    try {
      if (!fs.existsSync(dir)) continue;
      if (fs.existsSync(path.join(dir, 'sh.exe'))) continue;
      for (const name of ['sh.cmd', 'sh.bat']) {
        const target = path.join(dir, name);
        let existing = null;
        try { existing = fs.readFileSync(target, 'utf8'); } catch {}
        if (existing === body) continue;
        if (existing !== null && existing !== LEGACY_SH_SHIM_BODY) continue;
        fs.writeFileSync(target, body, 'utf8');
        written.push(target);
      }
    } catch {}
  }
  return written;
}

export function writeCmdShim(scriptPath, platform = process.platform) {
  if (platform !== 'win32') return null;
  const shimPath = scriptPath.replace(/\.m?js$/i, '.cmd');
  const contents = buildCmdShimContents(scriptPath);
  fs.mkdirSync(path.dirname(shimPath), { recursive: true });
  let existing = null;
  try { existing = fs.readFileSync(shimPath, 'utf8'); } catch {}
  if (existing !== contents) fs.writeFileSync(shimPath, contents, 'utf8');
  return shimPath;
}

export function createStatusLineCommand(scriptPath, nodePath = process.execPath || 'node', platform = process.platform) {
  if (platform === 'win32') return scriptPath.replace(/\.m?js$/i, '.cmd');
  return `"${nodePath}" "${scriptPath}"`;
}

function hasShExeOnPath(env = process.env) {
  const pathValue = env.PATH || env.Path || '';
  for (const dir of pathValue.split(';').map((entry) => entry.trim()).filter(Boolean)) {
    try {
      if (fs.existsSync(path.join(dir, 'sh.exe'))) return true;
    } catch {}
  }
  return false;
}

export function buildCommand(shell, launcher, env = process.env) {
  if (shell === 'gitbash') {
    const cmd = launcher.replace(/\.m?js$/i, '.cmd');
    return `exec "${cmd}"`;
  }
  if (shell === 'powershell') {
    const cmd = launcher.replace(/\.m?js$/i, '.cmd');
    return cmd.includes(' ') || hasShExeOnPath(env) ? `"${cmd}"` : cmd;
  }
  return `${quote(process.execPath)} ${quote(launcher)}`;
}

function readSettings(file) {
  if (!fs.existsSync(file)) return {};
  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  if (text.trim() === '') return {};
  const settings = JSON.parse(text);
  if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new Error(`${file} does not contain a JSON object`);
  }
  return settings;
}

/**
 * Installs launcher next to HUD's persistent dir and writes statusLine into settings.json.
 * argv: [--shell posix|gitbash|powershell] [--replace]
 */
export function install({ configDir, hudDir, argv = [], env = process.env, launcherTarget }) {
  const flag = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
  const shell = flag('--shell') ?? detectShell(env);
  if (!SHELLS.includes(shell)) throw new Error(`--shell must be one of ${SHELLS.join(', ')}`);

  const targetHudDir = hudDir ?? path.join(configDir, 'agy-hud');
  const launcher = launcherTarget ?? path.join(targetHudDir, 'statusline.mjs');
  const settingsPath = path.join(configDir, 'settings.json');
  const settings = readSettings(settingsPath);
  const command = launcherTarget
    ? createStatusLineCommand(launcherTarget, process.execPath, process.platform)
    : buildCommand(shell, launcher, env);

  const existing = typeof settings.statusLine?.command === 'string' ? settings.statusLine.command : '';
  const replaced = existing === '' ? 'none' : existing.includes('agy-hud') ? 'agy-hud' : 'other';
  if (replaced === 'other' && !argv.includes('--replace')) {
    throw new Error('statusLine already runs another command. Ask the user, then run install --replace (settings.json is backed up first).');
  }
  const report = { settingsPath, shell, command, replaced };

  fs.mkdirSync(path.dirname(launcher), { recursive: true });
  if (!launcherTarget) {
    fs.copyFileSync(LAUNCHER, launcher);
  }
  if (process.platform === 'win32') {
    writeCmdShim(launcher, process.platform);
    ensureWindowsShShim(process.platform, env);
  }

  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  if (fs.existsSync(settingsPath)) {
    report.backupPath = `${settingsPath}.bak.${new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '')}`;
    fs.copyFileSync(settingsPath, report.backupPath);
  }
  if (replaced === 'other') {
    fs.mkdirSync(targetHudDir, { recursive: true });
    report.previousCommandPath = path.join(targetHudDir, 'previous-statusline.txt');
    fs.writeFileSync(report.previousCommandPath, existing, { mode: 0o600 });
  }

  const statusLine = { ...(replaced === 'agy-hud' ? settings.statusLine : {}), type: 'command', command };
  const target = fs.existsSync(settingsPath) ? fs.realpathSync(settingsPath) : settingsPath;
  const mode = fs.existsSync(target) ? fs.statSync(target).mode & 0o777 : 0o600;
  const temp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify({ ...settings, statusLine }, null, 2)}\n`, { mode });
  fs.chmodSync(temp, mode);
  fs.renameSync(temp, target);
  return report;
}
