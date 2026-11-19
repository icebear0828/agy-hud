import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyQuotaProvider,
  mergeAgyQuotaProbe,
  parseAgyStdinQuota,
  pickFresherQuotaWindow,
} from '../src/agy-quota.ts';

describe('agy-quota / pickFresherQuotaWindow & mergeAgyQuotaProbe', () => {
  const now = Date.parse('2026-11-19T10:00:00.000Z');
  const fiveHourReset = new Date(now + 4 * 60 * 60 * 1000).toISOString();
  const weeklyReset = new Date(now + 5 * 24 * 60 * 60 * 1000).toISOString();

  test('pickFresherQuotaWindow prevents stale higher snapshot from overwriting lower quota in same cycle', () => {
    const cloud = { remainingFraction: 0.62, resetTime: fiveHourReset };
    const staleStdinSameTime = { remainingFraction: 0.91, resetTime: fiveHourReset };
    const staleStdinWithinSkew = {
      remainingFraction: 0.91,
      resetTime: new Date(Date.parse(fiveHourReset) + 30_000).toISOString(),
    };
    const fresherLowerStdin = { remainingFraction: 0.45, resetTime: fiveHourReset };

    assert.equal(pickFresherQuotaWindow(cloud, staleStdinSameTime, now)?.remainingFraction, 0.62);
    assert.equal(pickFresherQuotaWindow(cloud, staleStdinWithinSkew, now)?.remainingFraction, 0.62);
    assert.equal(pickFresherQuotaWindow(cloud, fresherLowerStdin, now)?.remainingFraction, 0.45);
  });

  test('pickFresherQuotaWindow updates to newer reset cycle when resetTime advances > 60_000ms', () => {
    const oldCycle = { remainingFraction: 0.15, resetTime: fiveHourReset };
    const nextCycleReset = new Date(Date.parse(fiveHourReset) + 5 * 60 * 60 * 1000).toISOString();
    const newCycle = { remainingFraction: 1.0, resetTime: nextCycleReset };

    const picked = pickFresherQuotaWindow(oldCycle, newCycle, now);
    assert.equal(picked?.remainingFraction, 1.0);
    assert.equal(picked?.resetTime, nextCycleReset);

    // Reverse: stale older cycle from stdin must not overwrite newer cloud cycle
    assert.equal(pickFresherQuotaWindow(newCycle, oldCycle, now)?.remainingFraction, 1.0);
  });

  test('pickFresherQuotaWindow handles missing resetTime without locking a reset full window', () => {
    const withReset = { remainingFraction: 0.55, resetTime: fiveHourReset };
    const higherWithoutReset = { remainingFraction: 0.85, resetTime: null };
    const lowerWithoutReset = { remainingFraction: 0.35, resetTime: null };

    assert.equal(pickFresherQuotaWindow(withReset, higherWithoutReset, now)?.remainingFraction, 0.55);
    assert.equal(pickFresherQuotaWindow(withReset, lowerWithoutReset, now)?.remainingFraction, 0.35);

    const resetFull = { remainingFraction: 1.0, resetTime: fiveHourReset };
    const unTimestampedDepleted = { remainingFraction: 0.1, resetTime: null };
    assert.equal(pickFresherQuotaWindow(resetFull, unTimestampedDepleted, now)?.remainingFraction, 1.0);
    assert.equal(pickFresherQuotaWindow(unTimestampedDepleted, resetFull, now)?.remainingFraction, 1.0);
  });

  test('parseAgyStdinQuota filters NaN/Infinity buckets and mergeAgyQuotaProbe uses stdinPq, skips image models, and tracks observedAt', () => {
    assert.equal(
      parseAgyStdinQuota({
        'gemini-5h': { remaining_fraction: Number.NaN, reset_time: fiveHourReset },
        '3p-5h': { remaining_fraction: Number.POSITIVE_INFINITY },
      }),
      null,
    );

    const oldObservedAt = now - 60_000;
    const prevCycleReset = new Date(now + 30 * 60 * 1000).toISOString();
    const nextClaudeCycleReset = new Date(Date.parse(fiveHourReset) + 5 * 60 * 60 * 1000).toISOString();
    const probe = {
      models: [
        {
          id: 'gemini-3-flash-agent',
          displayName: 'Gemini 3.5 Flash',
          modelProvider: 'MODEL_PROVIDER_GOOGLE',
          remainingFraction: 0.58,
          resetTime: fiveHourReset,
          windows: {
            fiveHour: { remainingFraction: 0.58, resetTime: fiveHourReset, observedAt: oldObservedAt },
            weekly: { remainingFraction: 0.7, resetTime: weeklyReset, observedAt: oldObservedAt },
          },
        },
        {
          id: 'claude-sonnet-4-6',
          displayName: 'Claude Sonnet 4.6',
          modelProvider: 'MODEL_PROVIDER_ANTHROPIC',
          remainingFraction: 0.25,
          resetTime: fiveHourReset,
          windows: {
            fiveHour: { remainingFraction: 0.25, resetTime: fiveHourReset, observedAt: oldObservedAt },
          },
        },
        {
          id: 'gemini-3-pro-image',
          displayName: 'Gemini 3 Pro Image',
          modelProvider: 'MODEL_PROVIDER_GOOGLE',
          remainingFraction: 0.9,
          resetTime: prevCycleReset,
          windows: {
            fiveHour: { remainingFraction: 0.9, resetTime: prevCycleReset, observedAt: oldObservedAt },
          },
        },
      ],
      providerQuota: {
        google: {
          fiveHour: { remainingFraction: 0.58, resetTime: fiveHourReset },
          weekly: { remainingFraction: 0.4, resetTime: weeklyReset },
        },
        claude: {
          fiveHour: { remainingFraction: 0.25, resetTime: fiveHourReset },
        },
      },
      unavailableReason: null,
      tierName: 'Pro',
      accountEmail: null,
      updateInfo: null,
    };

    const merged = mergeAgyQuotaProbe(
      probe,
      {
        quota: {
          // Higher stdin snapshot -> loses against 0.58; weekly 0.7 on model stays untouched (not poisoned by prevPq 0.4)
          'gemini-5h': { remaining_fraction: 0.92, reset_time: fiveHourReset },
          // Newer reset cycle -> updates claude to 1.00 and refreshes top-level + observedAt
          '3p-5h': { remaining_fraction: 1.0, reset_time: nextClaudeCycleReset },
        },
      },
      now,
    );

    assert.equal(merged.providerQuota.google.fiveHour.remainingFraction, 0.58);
    assert.equal(merged.providerQuota.google.weekly.remainingFraction, 0.4);
    assert.equal(merged.models[0].windows.fiveHour.remainingFraction, 0.58);
    assert.equal(merged.models[0].windows.fiveHour.observedAt, oldObservedAt, 'losing model window must keep original observedAt');
    assert.equal(merged.models[0].windows.weekly.remainingFraction, 0.7, 'models must merge against incoming stdinPq, not stale prevPq');

    assert.equal(merged.providerQuota.claude.fiveHour.remainingFraction, 1.0);
    assert.equal(merged.providerQuota.claude.fiveHour.resetTime, nextClaudeCycleReset);
    assert.equal(merged.models[1].windows.fiveHour.remainingFraction, 1.0);
    assert.equal(merged.models[1].windows.fiveHour.observedAt, now);
    assert.equal(merged.models[1].remainingFraction, 1.0);
    assert.equal(merged.models[1].resetTime, nextClaudeCycleReset);

    // Image model must never be rewritten
    assert.equal(merged.models[2].windows.fiveHour.remainingFraction, 0.9);
    assert.equal(merged.models[2].windows.fiveHour.observedAt, oldObservedAt);
  });

  test('classifyQuotaProvider classifies argon, google, and claude consistently', () => {
    assert.equal(classifyQuotaProvider('gemini-3-argon', 'Argon', 'MODEL_PROVIDER_GOOGLE'), 'argon');
    assert.equal(classifyQuotaProvider('gemini-3-flash', 'Gemini 3.5 Flash', 'MODEL_PROVIDER_GOOGLE'), 'google');
    assert.equal(classifyQuotaProvider('gpt-oss-120b', 'GPT-OSS 120B', null), 'claude');
    assert.equal(classifyQuotaProvider('claude-sonnet-4-6', null, 'MODEL_PROVIDER_ANTHROPIC'), 'claude');
  });
});
