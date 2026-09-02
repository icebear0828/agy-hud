import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import statuslineModule from '../../runtime/statusline-installer.js';

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

test('bootstrap.sh invokes bootstrap.js via curl + node', () => {
  const bootstrap = fs.readFileSync(path.join(projectRoot, 'scripts', 'bootstrap.sh'), 'utf8');

  assert.match(bootstrap, /bootstrap\.js/);
  assert.match(bootstrap, /curl/);
  assert.match(bootstrap, /exec node/);
});

test('bootstrap.js downloads runtime/* files and invokes configureStatusLine', () => {
  const bootstrap = fs.readFileSync(path.join(projectRoot, 'scripts', 'bootstrap.js'), 'utf8');
  assert.match(bootstrap, /runtime\/bin\/agy-hud\.js/);
  assert.match(bootstrap, /statusline-installer\.js/);
  assert.match(bootstrap, /configureStatusLine/);
});

test('Windows statusLine command points at the .cmd shim, not raw node invocation', () => {
  const command = createStatusLineCommand(
    'C:\\Users\\testuser\\.gemini\\antigravity-cli\\agy-hud-runtime\\runtime\\bin\\agy-hud.js',
    'C:\\Program Files\\nodejs\\node.exe',
    'win32'
  );

  assert.equal(
    command,
    'C:\\Users\\testuser\\.gemini\\antigravity-cli\\agy-hud-runtime\\runtime\\bin\\agy-hud.cmd'
  );
  // The shim path replaces .js with .cmd — no inline node invocation or outer quotes.
  assert.doesNotMatch(command, /^node /);
  assert.doesNotMatch(command, /\.js"$/);
  assert.doesNotMatch(command, /^"/);
});

test('Windows statusLine command returns unquoted shim path even with spaces', () => {
  const command = createStatusLineCommand(
    'C:\\Users\\John Doe\\.gemini\\antigravity-cli\\agy-hud-runtime\\runtime\\bin\\agy-hud.js',
    'C:\\Program Files\\nodejs\\node.exe',
    'win32'
  );

  assert.equal(
    command,
    'C:\\Users\\John Doe\\.gemini\\antigravity-cli\\agy-hud-runtime\\runtime\\bin\\agy-hud.cmd'
  );
});

test('Unix statusLine command uses absolute process.execPath', () => {
  const command = createStatusLineCommand(
    '/Users/me/.gemini/antigravity-cli/agy-hud-runtime/runtime/bin/agy-hud.js',
    '/usr/local/bin/node',
    'darwin'
  );
  assert.equal(command, '"/usr/local/bin/node" "/Users/me/.gemini/antigravity-cli/agy-hud-runtime/runtime/bin/agy-hud.js"');
});

test('buildCmdShimContents includes node-on-PATH first then Program Files fallback', () => {
  const body = buildCmdShimContents('C:\\runtime\\bin\\agy-hud.js');
  assert.match(body, /^@echo off/);
  assert.match(body, /node "%~dp0agy-hud\.js"/);
  assert.match(body, /%ProgramFiles%\\nodejs\\node\.exe/);
  // CRLF line endings for Windows .cmd files
  assert.match(body, /\r\n/);
});

test('buildShShimContents forwards agy sh -c calls to cmd.exe without broken quote manipulation', () => {
  const body = buildShShimContents();

  assert.match(body, /^@echo off/);
  assert.match(body, /"%~1"=="-c"/);
  assert.match(body, /set "CMDLINE=%~2"/);
  assert.doesNotMatch(body, /%CMDLINE:\\"="%/);
  assert.match(body, /cmd\.exe \/d \/c "%CMDLINE%"/);
  assert.match(body, /\r\n/);
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
    assert.doesNotMatch(body, /%CMDLINE:\\"="%/);
    assert.match(body, /cmd\.exe \/d \/c "%CMDLINE%"/);
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
