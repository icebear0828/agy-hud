import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { quotaModule } from './_helpers/quota-test-utils.mjs';

const {
  normalizeQuotaModels,
  createUnavailableQuotaResult,
  discoverAgentModelIds,
  resolveDeprecatedIds,
} = quotaModule;

describe('quota / models', () => {
  describe('normalizeQuotaModels', () => {
    test('treats buckets with resetTime but without remainingFraction as depleted (0) and others as unlimited (1)', () => {
      const models = {
        'gemini-3-flash-agent': {
          displayName: 'Gemini 3.5 Flash (High)',
          quotaInfo: {
            resetTime: '2026-05-20T11:59:09Z'
          }
        },
        'gemini-3.5-flash-low': {
          displayName: 'Gemini 3.5 Flash (Medium)',
          quotaInfo: {}
        },
        'gemini-3.5-flash-extra-low': {
          displayName: 'Gemini 3.5 Flash (Low)',
          quotaInfo: {
            remainingFraction: 0.7,
            resetTime: '2026-05-20T11:42:20Z'
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
            id: 'gemini-3.5-flash-low',
            remainingFraction: 1,
            resetTime: null
          },
          {
            id: 'gemini-3.5-flash-extra-low',
            remainingFraction: 0.7,
            resetTime: '2026-05-20T11:42:20Z'
          },
          {
            id: 'claude-sonnet-4-6',
            remainingFraction: 0.2,
            resetTime: '2026-05-20T11:42:20Z'
          }
        ]
      );
    });
  });

  describe('createUnavailableQuotaResult', () => {
    test('keeps the quota array empty with a diagnostic reason', () => {
      const quotas = createUnavailableQuotaResult('not_logged_in');

      assert.equal(Array.isArray(quotas), true);
      assert.equal(quotas.length, 0);
      assert.equal(quotas.unavailableReason, 'not_logged_in');
      assert.deepEqual(JSON.parse(JSON.stringify(quotas)), []);
    });
  });

  describe('discoverAgentModelIds', () => {
    test('extracts model IDs from agentModelSorts', () => {
      const apiResponse = {
        agentModelSorts: [{
          groups: [{ modelIds: ['gemini-3-flash-agent', 'claude-sonnet-4-6'] }]
        }]
      };
      assert.deepEqual(discoverAgentModelIds(apiResponse), ['gemini-3-flash-agent', 'claude-sonnet-4-6']);
    });

    test('returns null when agentModelSorts is missing', () => {
      assert.equal(discoverAgentModelIds({}), null);
      assert.equal(discoverAgentModelIds({ agentModelSorts: [] }), null);
      assert.equal(discoverAgentModelIds({ agentModelSorts: [{ groups: [] }] }), null);
      assert.equal(discoverAgentModelIds({ agentModelSorts: [{ groups: [{ modelIds: [] }] }] }), null);
    });
  });

  describe('resolveDeprecatedIds', () => {
    test('swaps deprecated model IDs for their replacements', () => {
      const ids = ['gemini-3.1-pro-high', 'claude-sonnet-4-6'];
      const apiResponse = {
        deprecatedModelIds: {
          'gemini-3.1-pro-high': { newModelId: 'gemini-pro-agent' }
        }
      };
      assert.deepEqual(resolveDeprecatedIds(ids, apiResponse), ['gemini-pro-agent', 'claude-sonnet-4-6']);
    });

    test('is a no-op when no deprecations exist', () => {
      const ids = ['gemini-3-flash-agent', 'claude-sonnet-4-6'];
      assert.deepEqual(resolveDeprecatedIds(ids, {}), ids);
      assert.deepEqual(resolveDeprecatedIds(ids, { deprecatedModelIds: {} }), ids);
    });
  });
});
