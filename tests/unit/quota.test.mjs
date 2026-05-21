import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import quotaModule from '../../extensions/quota.js';

const {
  fetchQuotaFromCloud,
  normalizeQuotaModels,
  isCachePayloadFresh,
  createUnavailableQuotaResult,
  selectUsableTokens
} = quotaModule;

test('normalizeQuotaModels treats quota buckets without remainingFraction as unlimited (1)', () => {
  const models = {
    'gemini-3-flash-agent': {
      displayName: 'Gemini 3.5 Flash (High)',
      quotaInfo: {
        resetTime: '2026-05-20T11:59:09Z'
      }
    },
    'claude-sonnet-4-6': {
      displayName: 'Claude Sonnet 4.6 (Thinking)',
      quotaInfo: {
        remainingFraction: 0.2,
        resetTime: '2026-05-20T11:42:20Z'
      }
    }
  };

  const quotas = normalizeQuotaModels(models);

  assert.deepEqual(
    quotas.map(q => ({ id: q.id, remainingFraction: q.remainingFraction, resetTime: q.resetTime })),
    [
      {
        id: 'gemini-3-flash-agent',
        remainingFraction: 1,
        resetTime: '2026-05-20T11:59:09Z'
      },
      {
        id: 'claude-sonnet-4-6',
        remainingFraction: 0.2,
        resetTime: '2026-05-20T11:42:20Z'
      }
    ]
  );
});

test('isCachePayloadFresh rejects old unversioned cache payloads', () => {
  assert.equal(
    isCachePayloadFresh({
      expiresAt: Date.now() + 60_000,
      data: []
    }),
    false
  );
});

test('createUnavailableQuotaResult keeps the quota array empty with a diagnostic reason', () => {
  const quotas = createUnavailableQuotaResult('not_logged_in');

  assert.equal(Array.isArray(quotas), true);
  assert.equal(quotas.length, 0);
  assert.equal(quotas.unavailableReason, 'not_logged_in');
  assert.deepEqual(JSON.parse(JSON.stringify(quotas)), []);
});

test('selectUsableTokens keeps Windows temp tokens until token expiry', () => {
  const now = Date.parse('2026-05-20T20:00:00Z');
  const oldWrittenAt = now - 60 * 60 * 1000;

  const tokens = selectUsableTokens([
    { accessToken: 'valid-with-expiry', expiry: '2026-05-20T20:10:00Z' },
    { accessToken: 'nearly-expired', expiry: '2026-05-20T20:00:30Z' },
    { accessToken: 'no-expiry-old-cache' },
    { accessToken: 'no-expiry-fresh-cache' },
  ], oldWrittenAt, now);

  assert.deepEqual(tokens.map(t => t.accessToken), ['valid-with-expiry']);

  const freshNoExpiry = selectUsableTokens([
    { accessToken: 'no-expiry-fresh-cache' },
  ], now - 1000, now);
  assert.deepEqual(freshNoExpiry.map(t => t.accessToken), ['no-expiry-fresh-cache']);
});

test('fetchQuotaFromCloud returns an auth diagnostic for auth failures', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('loadCodeAssist')) {
      return {
        ok: true,
        json: async () => ({ cloudaicompanionProject: 'test-project' })
      };
    }
    return {
      ok: false,
      status: 401,
      json: async () => ({})
    };
  };

  try {
    const quotas = await fetchQuotaFromCloud('expired-token');

    assert.equal(quotas.length, 0);
    assert.equal(quotas.unavailableReason, 'auth_failed');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchQuotaFromCloud returns a fetch diagnostic for transport failures', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('network down');
  };

  try {
    const quotas = await fetchQuotaFromCloud('token');

    assert.equal(quotas.length, 0);
    assert.equal(quotas.unavailableReason, 'quota_fetch_failed');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('readCache / writeCache respects token changes', () => {
  const { readCache, writeCache } = quotaModule;
  const mockData = [{ id: 'gemini-3.5-flash-low', displayName: 'Gemini 3.5 Flash (Medium)', remainingFraction: 0.5, resetTime: null }];
  
  // Write cache with token A
  writeCache(mockData, 'token-A');
  
  // Reading with token A should succeed
  const cachedA = readCache('token-A');
  assert.deepEqual(cachedA, mockData);
  
  // Reading with token B should return null (token change detected)
  const cachedB = readCache('token-B');
  assert.equal(cachedB, null);
  
  // Clean up
  const cachePath = path.join(os.tmpdir(), 'agy-hud-quota-cache.json');
  try {
    fs.unlinkSync(cachePath);
  } catch {}
});

test('fetchQuotaFromCloud respects AGY_HUD_ENDPOINTS and AGY_HUD_INTERESTING_MODELS env overrides', async () => {
  const originalFetch = globalThis.fetch;
  const requestedUrls = [];
  globalThis.fetch = async (url) => {
    requestedUrls.push(String(url));
    return {
      ok: true,
      status: 200,
      json: async () => ({
        models: {
          'custom-model-id-1': {
            displayName: 'Custom Model 1',
            quotaInfo: { remainingFraction: 0.8, resetTime: null }
          },
          'gemini-3-flash-agent': {
            displayName: 'Gemini 3.5 Flash',
            quotaInfo: { remainingFraction: 0.9, resetTime: null }
          }
        }
      })
    };
  };

  process.env.AGY_HUD_ENDPOINTS = 'https://custom-endpoint.com,https://another-endpoint.com';
  process.env.AGY_HUD_INTERESTING_MODELS = 'custom-model-id-1';

  try {
    const quotas = await fetchQuotaFromCloud('token');

    // Should fetch from the custom endpoint
    assert.ok(requestedUrls.length > 0);
    assert.ok(requestedUrls[0].startsWith('https://custom-endpoint.com'));
    
    // Should filter only interesting models specified in env var
    assert.equal(quotas.length, 1);
    assert.equal(quotas[0].id, 'custom-model-id-1');
    assert.equal(quotas[0].remainingFraction, 0.8);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.AGY_HUD_ENDPOINTS;
    delete process.env.AGY_HUD_INTERESTING_MODELS;
  }
});


