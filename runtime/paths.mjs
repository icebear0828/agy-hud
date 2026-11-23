import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Return all candidate antigravity-cli data roots, ordered by priority:
 *   1. $AGY_HUD_DATA_DIR (explicit override)
 *   2. ~/.gemini/antigravity-cli
 *   3. $XDG_DATA_HOME/antigravity-cli
 *   4. $APPDATA/antigravity-cli
 *   5. $LOCALAPPDATA/antigravity-cli
 */
export function getAntigravityRoots(env = process.env, home = (process.platform === 'win32' ? env.USERPROFILE : env.HOME) || os.homedir()) {
  if (env.AGY_HUD_DATA_DIR?.trim()) {
    return [path.resolve(env.AGY_HUD_DATA_DIR.trim())];
  }

  return [
    path.join(home, '.gemini', 'antigravity-cli'),
    env.XDG_DATA_HOME ? path.join(env.XDG_DATA_HOME, 'antigravity-cli') : null,
    env.APPDATA ? path.join(env.APPDATA, 'antigravity-cli') : null,
    env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'antigravity-cli') : null,
  ].filter(Boolean);
}

/**
 * Resolve a relative path under any candidate antigravity root.
 */
export function resolveAntigravityPath(relativePath, env = process.env, home) {
  const roots = getAntigravityRoots(env, home);
  for (const root of roots) {
    const candidate = path.join(root, relativePath);
    if (fs.existsSync(candidate)) return candidate;
  }
  return path.join(roots[0], relativePath);
}

/**
 * Safely resolve the absolute path of a system executable without searching CWD.
 */
export function resolveSafeExecutable(name, env = process.env, platform = process.platform) {
  if (platform === 'win32') {
    const systemRoot = env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows';
    if (name === 'chcp') return path.join(systemRoot, 'System32', 'chcp.com');
    if (name === 'powershell') return path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  }

  const pathValue = Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] || '';
  const dirs = pathValue.split(path.delimiter).filter(Boolean);
  const extensions = platform === 'win32' ? ['.exe', '.cmd', '.bat'] : [''];

  for (const dir of dirs) {
    const trimmed = dir.trim().replace(/^"(.*)"$/, '$1');
    if (!trimmed || trimmed === '.' || !path.isAbsolute(trimmed)) continue;

    for (const ext of extensions) {
      const fullPath = path.join(trimmed, name + ext);
      try {
        if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
          return fullPath;
        }
      } catch {
        // ignore unreadable entries
      }
    }
  }
  return null;
}
