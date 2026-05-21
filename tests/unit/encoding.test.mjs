import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectUnicodeSupport } from '../../extensions/encoding.js';

function fakeEnv(overrides) {
  const env = { ...process.env, ...overrides };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
  }
  return env;
}

test('respects AGY_HUD_FORCE_ASCII=1 — disables Unicode', () => {
  assert.equal(
    detectUnicodeSupport({
      env: fakeEnv({ AGY_HUD_FORCE_ASCII: '1' }),
      platform: 'darwin',
    }),
    false
  );
});

test('respects AGY_HUD_FORCE_UNICODE=1 — enables Unicode', () => {
  assert.equal(
    detectUnicodeSupport({
      env: fakeEnv({ AGY_HUD_FORCE_UNICODE: '1' }),
      platform: 'win32',
      readCodepage: () => '936',
    }),
    true
  );
});

test('Windows cp936 console without env override → ASCII', () => {
  assert.equal(
    detectUnicodeSupport({
      env: fakeEnv({ AGY_HUD_FORCE_ASCII: undefined, AGY_HUD_FORCE_UNICODE: undefined, WT_SESSION: undefined }),
      platform: 'win32',
      readCodepage: () => '936',
    }),
    false
  );
});

test('Windows codepage 65001 (UTF-8) → Unicode', () => {
  assert.equal(
    detectUnicodeSupport({
      env: fakeEnv({ AGY_HUD_FORCE_ASCII: undefined, AGY_HUD_FORCE_UNICODE: undefined, WT_SESSION: undefined }),
      platform: 'win32',
      readCodepage: () => '65001',
    }),
    true
  );
});

test('Windows Terminal with cp936 still falls back to ASCII', () => {
  assert.equal(
    detectUnicodeSupport({
      env: fakeEnv({ WT_SESSION: 'abc' }),
      platform: 'win32',
      readCodepage: () => '936',
    }),
    false
  );
});

test('Linux LANG=en_US.UTF-8 → Unicode', () => {
  assert.equal(
    detectUnicodeSupport({
      env: { LANG: 'en_US.UTF-8' },
      platform: 'linux',
    }),
    true
  );
});

test('Linux LANG=POSIX without UTF-8 → ASCII', () => {
  assert.equal(
    detectUnicodeSupport({
      env: { LANG: 'POSIX' },
      platform: 'linux',
    }),
    false
  );
});

test('macOS defaults to Unicode even with empty env', () => {
  assert.equal(
    detectUnicodeSupport({
      env: {},
      platform: 'darwin',
    }),
    true
  );
});
