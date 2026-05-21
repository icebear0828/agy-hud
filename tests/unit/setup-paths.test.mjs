import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import statuslineModule from '../../extensions/statusline.js';

const {
  createStatusLineCommand,
  buildCmdShimContents,
  buildShShimContents,
  writeCmdShim,
  ensureWindowsShShim,
  getWindowsAgyBinDirs,
} = statuslineModule;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..', '..');

test('setup.sh runs install-statusline.js', () => {
  const setupScript = fs.readFileSync(path.join(projectRoot, 'setup.sh'), 'utf8');

  assert.match(setupScript, /extensions\/install-statusline\.js/);
});

test('setup.ps1 runs install-statusline.js', () => {
  const setupScript = fs.readFileSync(path.join(projectRoot, 'setup.ps1'), 'utf8');

  assert.match(setupScript, /extensions\/install-statusline\.js/);
});

test('install-statusline.js requires statusline.js and configures statusLine', () => {
  const installScript = fs.readFileSync(path.join(projectRoot, 'extensions', 'install-statusline.js'), 'utf8');
  assert.match(installScript, /configureStatusLine\(__dirname\)/);
});

test('Windows statusLine command points at the .cmd shim, not raw node invocation', () => {
  const command = createStatusLineCommand(
    'C:\\Users\\testuser\\.gemini\\antigravity-cli\\agy-hud-runtime\\extensions\\bin\\agy-hud.js',
    'C:\\Program Files\\nodejs\\node.exe',
    'win32'
  );

  assert.equal(
    command,
    '"C:\\Users\\testuser\\.gemini\\antigravity-cli\\agy-hud-runtime\\extensions\\bin\\agy-hud.cmd"'
  );
  // The shim path replaces .js with .cmd — no inline node invocation.
  assert.doesNotMatch(command, /^node /);
  assert.doesNotMatch(command, /\.js"$/);
});

test('Unix statusLine command uses absolute process.execPath', () => {
  const command = createStatusLineCommand(
    '/Users/me/.gemini/antigravity-cli/agy-hud-runtime/extensions/bin/agy-hud.js',
    '/usr/local/bin/node',
    'darwin'
  );
  assert.equal(command, '"/usr/local/bin/node" "/Users/me/.gemini/antigravity-cli/agy-hud-runtime/extensions/bin/agy-hud.js"');
});

test('buildCmdShimContents includes node-on-PATH first then Program Files fallback', () => {
  const body = buildCmdShimContents('C:\\runtime\\extensions\\bin\\agy-hud.js');
  assert.match(body, /^@echo off/);
  assert.match(body, /node "%~dp0agy-hud\.js"/);
  assert.match(body, /%ProgramFiles%\\nodejs\\node\.exe/);
  // CRLF line endings for Windows .cmd files
  assert.match(body, /\r\n/);
});

test('buildShShimContents forwards agy sh -c calls to cmd.exe', () => {
  const body = buildShShimContents();

  assert.match(body, /^@echo off/);
  assert.match(body, /"%~1"=="-c"/);
  assert.match(body, /set "CMDLINE=%~2"/);
  assert.ok(body.includes('set "CMDLINE=%CMDLINE:\\"="%"'));
  assert.match(body, /cmd\.exe \/d \/s \/c "%CMDLINE%"/);
  assert.match(body, /\r\n/);
});

test('buildShShimContents normalizes agy escaped command quotes', () => {
  const body = buildShShimContents();

  assert.ok(body.includes('set "CMDLINE=%CMDLINE:\\"="%"'));
  assert.doesNotMatch(body, /cmd\.exe \/d \/s \/c "%~2"/);
});

test('getWindowsAgyBinDirs only returns LOCALAPPDATA agy bin and PATH dirs with agy.exe', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-bin-dirs-'));
  try {
    const localAppData = path.join(tmp, 'local');
    const appData = path.join(tmp, 'roaming');
    const userProfile = path.join(tmp, 'home');
    const pathAgyBin = path.join(tmp, 'path-bin');
    const pathOther = path.join(tmp, 'path-other');
    fs.mkdirSync(path.join(localAppData, 'agy', 'bin'), { recursive: true });
    fs.mkdirSync(pathAgyBin, { recursive: true });
    fs.mkdirSync(pathOther, { recursive: true });
    fs.writeFileSync(path.join(pathAgyBin, 'agy.exe'), '');

    const dirs = getWindowsAgyBinDirs({
      LOCALAPPDATA: localAppData,
      APPDATA: appData,
      USERPROFILE: userProfile,
      PATH: [pathAgyBin, pathOther].join(path.delimiter),
    });

    // Must include LOCALAPPDATA\agy\bin and the PATH dir that contains agy.exe.
    assert.deepEqual(dirs, [
      path.resolve(localAppData, 'agy', 'bin'),
      path.resolve(pathAgyBin),
    ]);
    // Must NOT include risky shared locations.
    assert.ok(!dirs.includes(path.resolve(localAppData, 'Microsoft', 'WindowsApps')));
    assert.ok(!dirs.includes(path.resolve(appData, 'npm')));
    assert.ok(!dirs.includes(path.resolve(userProfile, 'App')));
    // PATH dirs without agy.exe are skipped.
    assert.ok(!dirs.includes(path.resolve(pathOther)));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('ensureWindowsShShim writes sh.cmd into discovered agy bin dirs', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-sh-shim-'));
  try {
    const localAppData = path.join(tmp, 'local');
    const agyBin = path.join(localAppData, 'agy', 'bin');
    fs.mkdirSync(agyBin, { recursive: true });

    const written = ensureWindowsShShim('win32', {
      LOCALAPPDATA: localAppData,
      PATH: '',
    });

    assert.ok(written.includes(path.join(agyBin, 'sh.cmd')));
    assert.ok(written.includes(path.join(agyBin, 'sh.bat')));
    const body = fs.readFileSync(path.join(agyBin, 'sh.cmd'), 'utf8');
    assert.ok(body.includes('set "CMDLINE=%CMDLINE:\\"="%"'));
    assert.match(body, /cmd\.exe \/d \/s \/c "%CMDLINE%"/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('ensureWindowsShShim does not shadow a real sh.exe in the same dir', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-sh-real-'));
  try {
    const localAppData = path.join(tmp, 'local');
    const agyBin = path.join(localAppData, 'agy', 'bin');
    fs.mkdirSync(agyBin, { recursive: true });
    fs.writeFileSync(path.join(agyBin, 'sh.exe'), 'real-sh-binary');

    const written = ensureWindowsShShim('win32', {
      LOCALAPPDATA: localAppData,
      PATH: '',
    });

    assert.deepEqual(written, []);
    assert.ok(!fs.existsSync(path.join(agyBin, 'sh.cmd')));
    assert.ok(!fs.existsSync(path.join(agyBin, 'sh.bat')));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('ensureWindowsShShim does not overwrite a third-party sh.cmd', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-sh-tp-'));
  try {
    const localAppData = path.join(tmp, 'local');
    const agyBin = path.join(localAppData, 'agy', 'bin');
    fs.mkdirSync(agyBin, { recursive: true });
    const thirdParty = '@echo off\r\necho some other sh shim\r\n';
    fs.writeFileSync(path.join(agyBin, 'sh.cmd'), thirdParty);

    const written = ensureWindowsShShim('win32', {
      LOCALAPPDATA: localAppData,
      PATH: '',
    });

    assert.ok(!written.includes(path.join(agyBin, 'sh.cmd')));
    assert.equal(fs.readFileSync(path.join(agyBin, 'sh.cmd'), 'utf8'), thirdParty);
    // sh.bat was missing, so it is safe to create.
    assert.ok(written.includes(path.join(agyBin, 'sh.bat')));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('ensureWindowsShShim skips writes when on-disk content already matches', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-sh-idem-'));
  try {
    const localAppData = path.join(tmp, 'local');
    const agyBin = path.join(localAppData, 'agy', 'bin');
    fs.mkdirSync(agyBin, { recursive: true });

    const first = ensureWindowsShShim('win32', { LOCALAPPDATA: localAppData, PATH: '' });
    assert.ok(first.length > 0);

    const second = ensureWindowsShShim('win32', { LOCALAPPDATA: localAppData, PATH: '' });
    assert.deepEqual(second, []);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('writeCmdShim is a no-op on non-Windows', () => {
  const result = writeCmdShim('/tmp/whatever/agy-hud.js', 'linux');
  assert.equal(result, null);
});

test('remote install hook writes a Windows-safe statusLine command', () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(projectRoot, 'hooks', 'hooks.json'), 'utf8'));
  const command = hooks.post_invocation_hooks[0].command;

  // Hook generates .cmd shim on Windows + branches on process.platform
  assert.match(command, /process\.platform/);
  assert.match(command, /isWin/);
  // ".cmd" shim path is referenced in the inline script
  assert.match(command, /\.cmd/);
  // agy 1.0.0 launches statusLine through `sh -c` on Windows, so the hook
  // must also install the compatibility shim and normalize escaped quotes.
  assert.match(command, /shShimBody/);
  assert.match(command, /CMDLINE=%CMDLINE/);
  assert.match(command, /cmd\.exe \/d \/s \/c/);
  assert.match(command, /CredRead/);
  assert.match(command, /gemini:antigravity/);
  assert.match(command, /Text\.Encoding\]::UTF8/);
  // Regression: never write into WindowsApps or %APPDATA%\npm — those shadow
  // unrelated tools' `sh` on PATH.
  assert.doesNotMatch(command, /WindowsApps/);
  assert.doesNotMatch(command, /APPDATA[^A-Za-z0-9_]+.*npm/);
  // Guard against shadowing a real sh.exe.
  assert.match(command, /sh\.exe/);
});

test('remote install hook implements rename-with-retry for Windows file locks', () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(projectRoot, 'hooks', 'hooks.json'), 'utf8'));
  const command = hooks.post_invocation_hooks[0].command;

  assert.match(command, /renameWithRetry/);
  // Backoff loop runs multiple attempts
  assert.match(command, /i < 4/);
});
