import { test } from 'node:test';
import assert from 'node:assert/strict';
import quotaModule from '../../extensions/quota.js';

const {
  fetchQuotaFromCloud,
  normalizeQuotaModels,
  isCachePayloadFresh,
  createUnavailableQuotaResult
} = quotaModule;

test('normalizeQuotaModels treats quota buckets without remainingFraction as exhausted', () => {
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
        remainingFraction: 0,
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
