import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import statuslineModule from '../../extensions/statusline.js';

const { createStatusLineCommand, buildCmdShimContents, writeCmdShim } = statuslineModule;

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
});

test('remote install hook implements rename-with-retry for Windows file locks', () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(projectRoot, 'hooks', 'hooks.json'), 'utf8'));
  const command = hooks.post_invocation_hooks[0].command;

  assert.match(command, /renameWithRetry/);
  // Backoff loop runs multiple attempts
  assert.match(command, /i < 4/);
});
