import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-test-data-'));
process.env.AGY_HUD_DATA_DIR = testDataDir;

const require = createRequire(import.meta.url);
delete require.cache[require.resolve('../../../runtime/quota.js')];
const quotaModule = require('../../../runtime/quota.js');

process.on('exit', () => {
  try {
    fs.rmSync(testDataDir, { recursive: true, force: true });
  } catch {}
});

export { quotaModule };
export const { CACHE_PATH } = quotaModule;

try {
  fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
} catch {}

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
      fs.writeFileSync(CACHE_PATH, content);
    }
    return fn();
  } finally {
    if (prev === null) fs.rmSync(CACHE_PATH, { force: true });
    else fs.writeFileSync(CACHE_PATH, prev);
  }
}
