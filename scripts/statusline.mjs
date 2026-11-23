// Runs the newest installed agy-hud. `hud install` copies this file so statusLine survives updates.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const columns = Number.parseInt(process.env.COLUMNS ?? '', 10);
if (columns > 0) process.env.COLUMNS = String(Math.max(1, columns - 4));

const envDir = (name) => {
  const dir = process.env[name]?.trim();
  if (!dir) return undefined;
  if (dir === '~') return os.homedir();
  if (dir.startsWith('~/') || dir.startsWith('~\\')) return path.join(os.homedir(), dir.slice(2));
  return dir;
};

const home = os.homedir();
const entry = process.versions.bun ? path.join('src', 'index.ts') : path.join('dist', 'index.js');

const candidates = [
  envDir('AGY_HUD_DATA_DIR') ? path.join(envDir('AGY_HUD_DATA_DIR'), 'agy-hud-runtime') : null,
  envDir('AGY_CONFIG_DIR') ? path.join(envDir('AGY_CONFIG_DIR'), 'agy-hud-runtime') : null,
  path.join(home, '.gemini', 'antigravity-cli', 'agy-hud-runtime'),
  path.join(home, '.gemini', 'config', 'plugins', 'agy-hud'),
  envDir('XDG_DATA_HOME') ? path.join(envDir('XDG_DATA_HOME'), 'antigravity-cli', 'agy-hud-runtime') : null,
  envDir('XDG_CONFIG_HOME') ? path.join(envDir('XDG_CONFIG_HOME'), 'gemini', 'plugins', 'agy-hud') : null,
  envDir('APPDATA') ? path.join(envDir('APPDATA'), 'antigravity-cli', 'agy-hud-runtime') : null,
  envDir('LOCALAPPDATA') ? path.join(envDir('LOCALAPPDATA'), 'antigravity-cli', 'agy-hud-runtime') : null,
].filter(Boolean);

const parseVersion = (v) => /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v ?? ''))?.slice(1).map(Number);
const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

let best = null;
for (const root of candidates) {
  const file = path.join(root, entry);
  const pkgFile = path.join(root, 'package.json');
  if (!fs.existsSync(file) || !fs.existsSync(pkgFile)) continue;
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
    const ver = parseVersion(pkg?.version) ?? [0, 0, 0];
    if (!best || compare(ver, best.ver) > 0) best = { ver, file };
  } catch {}
}

if (best) {
  const hud = await import(pathToFileURL(best.file).href);
  await hud.main();
}
