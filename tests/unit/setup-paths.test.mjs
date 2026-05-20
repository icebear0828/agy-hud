import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
});
