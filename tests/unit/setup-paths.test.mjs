import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import statuslineModule from '../../extensions/statusline.js';

const { createStatusLineCommand } = statuslineModule;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..', '..');

test('setup.sh configures statusLine to the relocated HUD binary', () => {
  const setupScript = fs.readFileSync(path.join(projectRoot, 'setup.sh'), 'utf8');

  assert.match(setupScript, /extensions\/bin\/agy-hud\.js/);
  assert.doesNotMatch(setupScript, /\$PROJECT_DIR\/bin\/agy-hud\.js/);
});

test('setup.ps1 configures statusLine to the relocated HUD binary', () => {
  const setupScript = fs.readFileSync(path.join(projectRoot, 'setup.ps1'), 'utf8');

  assert.match(setupScript, /extensions\\bin\\agy-hud\.js/);
  assert.doesNotMatch(setupScript, /EscapedProjectDir\\bin\\agy-hud\.js/);
  assert.match(setupScript, /UTF8Encoding\(\$false\)/);
  assert.doesNotMatch(setupScript, /Set-Content \$SettingsFile/);
});

test('Windows statusLine command avoids Program Files quoting and PATH lookup', () => {
  const command = createStatusLineCommand(
    'C:\\Users\\30435\\.gemini\\antigravity-cli\\agy-hud-runtime\\extensions\\bin\\agy-hud.js',
    'C:\\Program Files\\nodejs\\node.exe',
    'win32'
  );

  assert.equal(
    command,
    'C:\\Progra~1\\nodejs\\node.exe "C:\\Users\\30435\\.gemini\\antigravity-cli\\agy-hud-runtime\\extensions\\bin\\agy-hud.js"'
  );
  assert.doesNotMatch(command, /C:\\Program Files/);
  assert.doesNotMatch(command, /^node /);
});

test('remote install hook writes a Windows-safe statusLine command', () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(projectRoot, 'hooks', 'hooks.json'), 'utf8'));
  const command = hooks.post_invocation_hooks[0].command;

  assert.match(command, /process\.platform==='win32'/);
  assert.match(command, /Progra~1/);
  assert.doesNotMatch(command, /'node \\\\"'\+hud\+'\\\\"'/);
});

test('remote install hook self-updates the installed hook file', () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(projectRoot, 'hooks', 'hooks.json'), 'utf8'));
  const command = hooks.post_invocation_hooks[0].command;

  assert.match(command, /plugins','agy-hud','hooks\.json/);
  assert.match(command, /copyFileSync/);
});
