import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-test-data-'));
process.env.AGY_HUD_DATA_DIR = testDataDir;
fs.mkdirSync(testDataDir, { recursive: true });

const quotaModule = await import('../../runtime/quota.mjs');
export { quotaModule };
export const CACHE_PATH = quotaModule.CACHE_PATH;

process.on('exit', () => {
  try {
    fs.rmSync(testDataDir, { recursive: true, force: true });
  } catch {}
});

export function withEnv(overrides, fn) {
  const fullOverrides = {
    AGY_HUD_DATA_DIR: undefined,
    ...overrides,
  };
  const snapshot = {};
  for (const key of Object.keys(fullOverrides)) {
    snapshot[key] = process.env[key];
    if (fullOverrides[key] === undefined) delete process.env[key];
    else process.env[key] = fullOverrides[key];
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(snapshot)) {
      if (snapshot[key] === undefined) delete process.env[key];
      else process.env[key] = snapshot[key];
    }
  }
}

export function withCacheFile(content, fn) {
  const prev = fs.existsSync(CACHE_PATH) ? fs.readFileSync(CACHE_PATH, 'utf8') : null;
  try {
    if (content === null) {
      fs.rmSync(CACHE_PATH, { force: true });
    } else {
      fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
      fs.writeFileSync(CACHE_PATH, content);
    }
    return fn();
  } finally {
    if (prev === null) fs.rmSync(CACHE_PATH, { force: true });
    else fs.writeFileSync(CACHE_PATH, prev);
  }
}
