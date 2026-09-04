import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { quotaModule, withEnv } from './_helpers/quota-test-utils.mjs';

const {
  fetchQuotaFromCloud,
  fetchTierFromCloud,
  fetchAccountEmail,
  extractTierName,
  parseQuotaSummary,
  enrichModelsWithQuotaSummary,
} = quotaModule;

describe('quota / cloud', () => {
  describe('fetchAccountEmail', () => {
    test('returns the email from the userinfo response', async () => {
      const originalFetch = globalThis.fetch;
      let calledUrl = null;
      globalThis.fetch = async (url) => {
        calledUrl = String(url);
        return { ok: true, json: async () => ({ sub: '1', email: 'who@gmail.com' }) };
      };
      try {
        assert.equal(await fetchAccountEmail('tok'), 'who@gmail.com');
        assert.match(calledUrl, /userinfo/);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    test('falls through to the next endpoint when the first fails', async () => {
      const originalFetch = globalThis.fetch;
      let calls = 0;
      globalThis.fetch = async () => {
        calls += 1;
        if (calls === 1) throw new Error('connect timeout');
        return { ok: true, json: async () => ({ email: 'who@gmail.com' }) };
      };
      try {
        assert.equal(await fetchAccountEmail('tok'), 'who@gmail.com');
        assert.equal(calls, 2);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    test('returns null when every endpoint is unavailable', async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () => { throw new Error('network down'); };
      try {
        assert.equal(await fetchAccountEmail('tok'), null);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    test('returns null on a non-ok response with no usable body', async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => ({}) });
      try {
        assert.equal(await fetchAccountEmail('tok'), null);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe('fetchQuotaFromCloud', () => {
    test('returns an auth diagnostic for auth failures', async () => {
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

    test('returns a fetch diagnostic for transport failures', async () => {
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

    test('passes AbortSignal to fetch and handles timeout aborts', async () => {
      const originalFetch = globalThis.fetch;
      let signalPassed = null;
      globalThis.fetch = async (url, options) => {
        signalPassed = options?.signal;
        throw new Error('simulate instant network failure');
      };

      try {
        await fetchQuotaFromCloud('token');
        assert.ok(signalPassed, 'AbortSignal must be passed to fetch');
        assert.equal(typeof signalPassed.aborted, 'boolean');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    test('respects AGY_HUD_ENDPOINTS and AGY_HUD_INTERESTING_MODELS env overrides', async () => {
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

        assert.ok(requestedUrls.length > 0);
        assert.ok(requestedUrls[0].startsWith('https://custom-endpoint.com'));

        assert.equal(quotas.length, 1);
        assert.equal(quotas[0].id, 'custom-model-id-1');
        assert.equal(quotas[0].remainingFraction, 0.8);
      } finally {
        globalThis.fetch = originalFetch;
        delete process.env.AGY_HUD_ENDPOINTS;
        delete process.env.AGY_HUD_INTERESTING_MODELS;
      }
    });

    test('preserves the authoritative providerQuota summary on the returned models', async () => {
      const originalFetch = globalThis.fetch;
      const resetTime = new Date(Date.now() + 6 * 24 * 60 * 60 * 1000).toISOString();
      const summary = {
        groups: [{
          displayName: 'Gemini Models',
          buckets: [{ bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.9906, resetTime }],
        }],
      };
      globalThis.fetch = async (url) => {
        if (String(url).includes('retrieveUserQuotaSummary')) {
          return { ok: true, status: 200, json: async () => summary };
        }
        if (String(url).includes('fetchAvailableModels')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              models: {
                'gemini-3-flash-agent': {
                  displayName: 'Gemini 3 Flash Agent',
                  modelProvider: 'MODEL_PROVIDER_GOOGLE',
                  quotaInfo: { remainingFraction: 0.9, resetTime },
                },
              },
            }),
          };
        }
        return { ok: false, status: 404, json: async () => ({}) };
      };

      try {
        const quotas = await fetchQuotaFromCloud('token');
        assert.equal(quotas.length, 1);
        assert.equal(quotas.providerQuota.google.weekly.remainingFraction, 0.9906);
        assert.equal(quotas.providerQuota.google.weekly.resetTime, resetTime);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe('extractTierName', () => {
    test('returns paidTier.name when present', () => {
      assert.equal(
        extractTierName({ paidTier: { name: 'Google AI Pro' }, allowedTiers: [{ id: 'free-tier', name: 'Free' }] }),
        'Google AI Pro'
      );
    });

    test('returns first non-free allowedTier name when no paidTier', () => {
      assert.equal(
        extractTierName({ allowedTiers: [{ id: 'free-tier', name: 'Free' }, { id: 'pro-tier', name: 'Pro' }] }),
        'Pro'
      );
    });

    test('falls back to free-tier name when only free-tier exists', () => {
      assert.equal(
        extractTierName({ allowedTiers: [{ id: 'free-tier', name: 'Free' }] }),
        'Free'
      );
    });

    test('returns null for empty allowedTiers', () => {
      assert.equal(extractTierName({ allowedTiers: [] }), null);
    });

    test('returns null when no paidTier and no allowedTiers', () => {
      assert.equal(extractTierName({}), null);
    });

    test('prioritizes paidTier over allowedTiers', () => {
      assert.equal(
        extractTierName({
          paidTier: { name: 'Enterprise' },
          allowedTiers: [{ id: 'pro-tier', name: 'Pro' }],
        }),
        'Enterprise'
      );
    });
  });

  describe('fetchTierFromCloud', () => {
    test('returns tier name from paidTier in response', async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (url) => {
        if (String(url).includes('loadCodeAssist')) {
          return { ok: true, json: async () => ({ paidTier: { name: 'Google AI Pro' } }) };
        }
        return { ok: false, status: 500 };
      };
      try {
        const tier = await withEnv({ AGY_HUD_ENDPOINTS: 'https://mock.test' }, () =>
          fetchTierFromCloud('test-token')
        );
        assert.equal(tier, 'Google AI Pro');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    test('returns null when all endpoints fail', async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () => { throw new Error('network down'); };
      try {
        const tier = await withEnv({ AGY_HUD_ENDPOINTS: 'https://mock.test' }, () =>
          fetchTierFromCloud('test-token')
        );
        assert.equal(tier, null);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    test('passes AbortSignal to fetch and handles timeout aborts', async () => {
      const originalFetch = globalThis.fetch;
      let signalPassed = null;
      globalThis.fetch = async (url, options) => {
        signalPassed = options?.signal;
        throw new Error('simulate instant network failure');
      };

      try {
        await withEnv({ AGY_HUD_ENDPOINTS: 'https://mock.test' }, () =>
          fetchTierFromCloud('test-token')
        );
        assert.ok(signalPassed, 'AbortSignal must be passed to fetch');
        assert.equal(typeof signalPassed.aborted, 'boolean');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    test('returns null when response ok but no tier data', async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (url) => {
        if (String(url).includes('loadCodeAssist')) {
          return { ok: true, json: async () => ({}) };
        }
        return { ok: false, status: 500 };
      };
      try {
        const tier = await withEnv({ AGY_HUD_ENDPOINTS: 'https://mock.test' }, () =>
          fetchTierFromCloud('test-token')
        );
        assert.equal(tier, null);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe('parseQuotaSummary', () => {
    test('parses standard retrieveUserQuotaSummary response correctly', () => {
      const sample = {
        groups: [
          {
            displayName: 'Gemini Models',
            buckets: [
              { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.94, resetTime: '2026-09-10T08:00:00Z' },
              { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.65, resetTime: '2026-09-03T17:00:00Z' },
            ],
          },
          {
            displayName: 'Claude and GPT models',
            buckets: [
              { bucketId: '3p-weekly', window: 'weekly', remainingFraction: 1.0, resetTime: '2026-09-10T08:00:00Z' },
              { bucketId: '3p-5h', window: '5h', remainingFraction: 0.8, resetTime: '2026-09-03T18:00:00Z' },
            ],
          },
        ],
      };
      const parsed = parseQuotaSummary(sample);
      assert.ok(parsed, 'should parse summary');
      assert.equal(parsed.google.weekly.remainingFraction, 0.94);
      assert.equal(parsed.google.weekly.resetTime, '2026-09-10T08:00:00Z');
      assert.equal(parsed.google.fiveHour.remainingFraction, 0.65);
      assert.equal(parsed.google.fiveHour.resetTime, '2026-09-03T17:00:00Z');

      assert.equal(parsed.claude.weekly.remainingFraction, 1.0);
      assert.equal(parsed.claude.fiveHour.remainingFraction, 0.8);
    });

    test('returns null for empty or invalid data', () => {
      assert.equal(parseQuotaSummary(null), null);
      assert.equal(parseQuotaSummary({}), null);
      assert.equal(parseQuotaSummary({ groups: [] }), null);
      assert.equal(parseQuotaSummary({ groups: [{ displayName: 'Unknown', buckets: [] }] }), null);
    });

    test('preserves explicit and omitted Proto3 zero remainingFraction values', () => {
      const resetTime = '2026-09-10T08:00:00Z';
      const parsed = parseQuotaSummary({
        groups: [{
          displayName: 'Claude and GPT models',
          buckets: [
            { bucketId: '3p-weekly', window: 'weekly', remainingFraction: 0, resetTime },
            { bucketId: '3p-5h', window: '5h', resetTime },
          ],
        }],
      });

      assert.equal(parsed.claude.weekly.remainingFraction, 0);
      assert.equal(parsed.claude.fiveHour.remainingFraction, 0);
    });
  });

  describe('enrichModelsWithQuotaSummary', () => {
    test('enriches models with provider weekly and 5h windows', () => {
      const models = [
        { id: 'gemini-3.6-flash', modelProvider: 'MODEL_PROVIDER_GOOGLE', windows: {} },
        { id: 'claude-sonnet-4-6', modelProvider: 'MODEL_PROVIDER_ANTHROPIC', windows: {} },
        { id: 'other-model', modelProvider: 'MODEL_PROVIDER_OTHER', windows: {} },
      ];
      const summary = {
        google: {
          weekly: { remainingFraction: 0.92, resetTime: '2026-09-10T00:00:00Z' },
          fiveHour: { remainingFraction: 0.55, resetTime: '2026-09-03T17:00:00Z' },
        },
        claude: {
          weekly: { remainingFraction: 1.0, resetTime: '2026-09-10T00:00:00Z' },
        },
      };
      const enriched = enrichModelsWithQuotaSummary(models, summary, 123456);
      assert.equal(enriched[0].windows.weekly.remainingFraction, 0.92);
      assert.equal(enriched[0].windows.weekly.observedAt, 123456);
      assert.equal(enriched[0].windows.fiveHour.remainingFraction, 0.55);

      assert.equal(enriched[1].windows.weekly.remainingFraction, 1.0);
      assert.equal(enriched[1].windows.fiveHour, undefined);

      assert.deepEqual(enriched[2].windows, {});
    });

    test('returns original models when summary is null', () => {
      const models = [{ id: 'm1' }];
      assert.equal(enrichModelsWithQuotaSummary(models, null), models);
    });
  });
});
