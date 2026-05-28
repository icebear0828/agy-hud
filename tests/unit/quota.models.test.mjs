import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { quotaModule } from './_helpers/quota-test-utils.mjs';

const {
  normalizeQuotaModels,
  createUnavailableQuotaResult,
  discoverAgentModelIds,
  resolveDeprecatedIds,
  classifyQuotaWindow,
  mergeQuotaWindows,
  pickCriticalWindow,
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

  describe('classifyQuotaWindow', () => {
    test('tags short resets as fiveHour and long resets as weekly', () => {
      const now = Date.parse('2026-05-20T20:00:00Z');
      const fiveHourReset = new Date(now + 4 * 60 * 60 * 1000).toISOString();
      const weeklyReset = new Date(now + 5 * 24 * 60 * 60 * 1000).toISOString();
      const edgeReset = new Date(now + 12 * 60 * 60 * 1000).toISOString();

      assert.equal(classifyQuotaWindow(fiveHourReset, now), 'fiveHour');
      assert.equal(classifyQuotaWindow(weeklyReset, now), 'weekly');
      // 12h boundary is inclusive on the weekly side.
      assert.equal(classifyQuotaWindow(edgeReset, now), 'weekly');
      assert.equal(classifyQuotaWindow(null, now), null);
      assert.equal(classifyQuotaWindow('not-a-date', now), null);
    });

    test('returns null for resetTimes in the past', () => {
      const now = Date.parse('2026-05-20T20:00:00Z');
      assert.equal(classifyQuotaWindow(new Date(now - 1000).toISOString(), now), null);
      assert.equal(classifyQuotaWindow(new Date(now).toISOString(), now), null); // exactly now: already-elapsed
      assert.equal(classifyQuotaWindow(new Date(now + 1000).toISOString(), now), 'fiveHour');
    });
  });

  describe('normalizeQuotaModels (window tagging)', () => {
    test('tags each model with its observed window', () => {
      const now = Date.parse('2026-05-20T20:00:00Z');
      const fiveHourReset = new Date(now + 4 * 60 * 60 * 1000).toISOString();
      const weeklyReset = new Date(now + 5 * 24 * 60 * 60 * 1000).toISOString();

      const quotas = normalizeQuotaModels(
        {
          'short-bucket': {
            displayName: 'Short',
            quotaInfo: { remainingFraction: 0.8, resetTime: fiveHourReset },
          },
          'long-bucket': {
            displayName: 'Long',
            quotaInfo: { remainingFraction: 0.2, resetTime: weeklyReset },
          },
          'unlimited': {
            displayName: 'Unlimited',
            quotaInfo: { remainingFraction: 1 },
          },
        },
        ['short-bucket', 'long-bucket', 'unlimited'],
        now
      );

      assert.equal(quotas[0].window, 'fiveHour');
      assert.deepEqual(quotas[0].windows, {
        fiveHour: { remainingFraction: 0.8, resetTime: fiveHourReset, observedAt: now },
      });

      assert.equal(quotas[1].window, 'weekly');
      assert.deepEqual(quotas[1].windows, {
        weekly: { remainingFraction: 0.2, resetTime: weeklyReset, observedAt: now },
      });

      assert.equal(quotas[2].window, null);
      assert.deepEqual(quotas[2].windows, {});
    });
  });

  describe('mergeQuotaWindows', () => {
    test('keeps the previously observed window when the response only covers the other one', () => {
      const now = Date.parse('2026-05-20T20:00:00Z');
      const earlier = now - 30 * 60 * 1000;
      const previousFiveHour = {
        remainingFraction: 0.6,
        resetTime: new Date(earlier + 4 * 60 * 60 * 1000).toISOString(),
        observedAt: earlier,
      };
      const previous = [{
        id: 'gemini-3-flash-agent',
        displayName: 'Gemini 3.5 Flash (High)',
        remainingFraction: previousFiveHour.remainingFraction,
        resetTime: previousFiveHour.resetTime,
        window: 'fiveHour',
        windows: { fiveHour: previousFiveHour },
      }];

      const weeklyResetTime = new Date(now + 5 * 24 * 60 * 60 * 1000).toISOString();
      const fresh = [{
        id: 'gemini-3-flash-agent',
        displayName: 'Gemini 3.5 Flash (High)',
        remainingFraction: 0.2,
        resetTime: weeklyResetTime,
        window: 'weekly',
        windows: { weekly: { remainingFraction: 0.2, resetTime: weeklyResetTime, observedAt: now } },
      }];

      const merged = mergeQuotaWindows(fresh, previous, now);
      assert.equal(merged.length, 1);
      assert.deepEqual(merged[0].windows, {
        fiveHour: previousFiveHour,
        weekly: { remainingFraction: 0.2, resetTime: weeklyResetTime, observedAt: now },
      });
      // Top-level remainingFraction/resetTime still reflect the latest response.
      assert.equal(merged[0].remainingFraction, 0.2);
      assert.equal(merged[0].resetTime, weeklyResetTime);
    });

    test('drops expired window observations from the previous cache', () => {
      const now = Date.parse('2026-05-20T20:00:00Z');
      const expiredFiveHour = {
        remainingFraction: 0.05,
        resetTime: new Date(now - 60 * 60 * 1000).toISOString(), // 1h in the past
        observedAt: now - 5 * 60 * 60 * 1000,
      };
      const freshWeeklyReset = new Date(now + 5 * 24 * 60 * 60 * 1000).toISOString();
      const previous = [{
        id: 'gemini-3-flash-agent',
        windows: { fiveHour: expiredFiveHour },
      }];
      const fresh = [{
        id: 'gemini-3-flash-agent',
        remainingFraction: 0.8,
        resetTime: freshWeeklyReset,
        windows: { weekly: { remainingFraction: 0.8, resetTime: freshWeeklyReset, observedAt: now } },
      }];

      const merged = mergeQuotaWindows(fresh, previous, now);
      // Expired fiveHour observation must NOT survive — would otherwise dominate
      // pickCriticalWindow with a stale 5% reading forever.
      assert.equal(merged[0].windows.fiveHour, undefined);
      assert.equal(merged[0].windows.weekly.remainingFraction, 0.8);
    });

    test('carries forward models present in previous but missing from fresh', () => {
      const now = Date.parse('2026-05-20T20:00:00Z');
      const futureReset = new Date(now + 4 * 60 * 60 * 1000).toISOString();
      const liveObservation = { remainingFraction: 0.5, resetTime: futureReset, observedAt: now };
      const previous = [
        { id: 'kept-model', remainingFraction: 0.5, resetTime: futureReset, windows: { fiveHour: liveObservation } },
        { id: 'fully-expired', windows: { fiveHour: { remainingFraction: 0.1, resetTime: new Date(now - 1000).toISOString(), observedAt: now - 10_000 } } },
      ];
      const fresh = []; // API temporarily returned nothing for our interesting models

      const merged = mergeQuotaWindows(fresh, previous, now);
      // The model with at least one non-expired observation must survive.
      const kept = merged.find(m => m.id === 'kept-model');
      assert.ok(kept, 'kept-model with a live observation should be preserved');
      assert.deepEqual(kept.windows.fiveHour, liveObservation);
      // The fully-expired model is dropped (nothing useful remains to display).
      assert.equal(merged.find(m => m.id === 'fully-expired'), undefined);
    });
  });

  describe('pickCriticalWindow', () => {
    test('skips expired observations even when they have the lower remainingFraction', () => {
      const now = Date.parse('2026-05-20T20:00:00Z');
      const expired = { remainingFraction: 0.05, resetTime: new Date(now - 1000).toISOString(), observedAt: now - 10_000 };
      const live = { remainingFraction: 0.8, resetTime: new Date(now + 5 * 24 * 60 * 60 * 1000).toISOString(), observedAt: now };

      const picked = pickCriticalWindow({ fiveHour: expired, weekly: live }, now);
      assert.equal(picked.window, 'weekly');
      assert.equal(picked.remainingFraction, 0.8);

      // Both expired → null so callers can fall back gracefully.
      assert.equal(pickCriticalWindow({ fiveHour: expired, weekly: expired }, now), null);
    });

    test('returns the lower-remaining window', () => {
      const fiveHour = { remainingFraction: 0.6, resetTime: 'x', observedAt: 1 };
      const weekly = { remainingFraction: 0.2, resetTime: 'y', observedAt: 2 };
      assert.equal(pickCriticalWindow({ fiveHour, weekly }).window, 'weekly');
      assert.equal(pickCriticalWindow({ fiveHour: weekly, weekly: fiveHour }).window, 'fiveHour');
      assert.equal(pickCriticalWindow({ fiveHour }).window, 'fiveHour');
      assert.equal(pickCriticalWindow({ weekly }).window, 'weekly');
      assert.equal(pickCriticalWindow({}), null);
      assert.equal(pickCriticalWindow(null), null);
    });
  });
});
