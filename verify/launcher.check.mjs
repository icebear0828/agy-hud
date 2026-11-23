// Verifies install.mjs atomic install + backup + --replace guard + statusline.mjs launcher resolution.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { install } from '../install.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-launcher-')));
const errors = [];

try {
  const configDir = path.join(tmp, 'antigravity-cli');
  const hudDir = path.join(configDir, 'agy-hud');
  const settingsPath = path.join(configDir, 'settings.json');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify({ theme: 'dark', statusLine: { type: 'command', command: 'echo third-party' } }));

  // 1. Refuse overwrite of foreign statusLine without --replace
  let threw = false;
  try {
    install({ configDir, hudDir, argv: [], env: { HOME: tmp } });
  } catch {
    threw = true;
  }
  if (!threw) errors.push('install() overwrote foreign statusLine without --replace');

  // 2. With --replace, backup original settings + save previous-statusline.txt + install launcher
  const report = install({ configDir, hudDir, argv: ['--replace'], env: { HOME: tmp } });
  if (!report.backupPath || !fs.existsSync(report.backupPath)) errors.push('install --replace did not back up settings.json');
  if (!report.previousCommandPath || fs.readFileSync(report.previousCommandPath, 'utf8') !== 'echo third-party') {
    errors.push('install --replace did not record previous statusLine');
  }
  const copiedLauncher = path.join(hudDir, 'statusline.mjs');
  if (!fs.existsSync(copiedLauncher)) errors.push('install did not copy statusline.mjs');

  const writtenSettings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  if (writtenSettings.theme !== 'dark') errors.push('install dropped unrelated settings keys');

  // 3. Version resolution in statusline.mjs picks highest semver runtime
  const runtimeDir = path.join(configDir, 'agy-hud-runtime');
  fs.mkdirSync(path.join(runtimeDir, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(runtimeDir, 'package.json'), JSON.stringify({ name: 'agy-hud', version: '99.0.0', type: 'module' }));
  fs.writeFileSync(path.join(runtimeDir, 'dist', 'index.js'), "export function main() { process.stdout.write('MOCK_99_MAIN\\n'); }\n");

  const pluginFallback = path.join(tmp, '.gemini', 'config', 'plugins', 'agy-hud');
  fs.mkdirSync(path.join(pluginFallback, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(pluginFallback, 'package.json'), JSON.stringify({ name: 'agy-hud', version: '0.1.0', type: 'module' }));
  fs.writeFileSync(path.join(pluginFallback, 'dist', 'index.js'), "export function main() { process.stdout.write('MOCK_OLD_MAIN\\n'); }\n");

  const out = execFileSync(process.execPath, [copiedLauncher], {
    env: { ...process.env, HOME: tmp, USERPROFILE: tmp, AGY_HUD_DATA_DIR: configDir },
    encoding: 'utf8',
  });
  if (out.trim() !== 'MOCK_99_MAIN') {
    errors.push(`statusline.mjs picked wrong version: ${JSON.stringify(out)}`);
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

if (errors.length > 0) {
  for (const e of errors) console.log(`FAIL ${e}`);
  process.exit(1);
}
console.log('  ok launcher: install backup/--replace guard and statusline.mjs version resolution hold');
