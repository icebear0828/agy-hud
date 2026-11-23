import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  agyQuotaToUsageData,
  classifyQuotaProvider,
  mergeAgyQuotaProbe,
  parseAgyStdinQuota,
  pickFresherQuotaWindow,
} from '../src/agy-quota.ts';
import { readCacheRaw, writeCache } from '../runtime/quota/cache.mjs';
import { mergeQuotaWindows } from '../runtime/quota/models.mjs';

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

  test('pickFresherQuotaWindow & quota cache anchor earlier non-expired resetTime for full windows (>= 1) instead of sliding 5h/7d forward', () => {
    const anchoredReset = new Date(now + 3 * 60 * 60 * 1000).toISOString();
    const floatingCloudReset = new Date(now + 5 * 60 * 60 * 1000).toISOString();
    const expiredReset = new Date(now - 10_000).toISOString();

    const anchoredFull = { remainingFraction: 1, resetTime: anchoredReset };
    const floatingFull = { remainingFraction: 1, resetTime: floatingCloudReset };
    const expiredFull = { remainingFraction: 1, resetTime: expiredReset };

    // Both full & non-expired -> keeps earlier anchored resetTime
    assert.equal(pickFresherQuotaWindow(anchoredFull, floatingFull, now)?.resetTime, anchoredReset);
    assert.equal(pickFresherQuotaWindow(floatingFull, anchoredFull, now)?.resetTime, anchoredReset);

    // Expired full vs non-expired full -> advances to non-expired
    assert.equal(pickFresherQuotaWindow(expiredFull, floatingFull, now)?.resetTime, floatingCloudReset);
    assert.equal(pickFresherQuotaWindow(floatingFull, expiredFull, now)?.resetTime, floatingCloudReset);

    // mergeQuotaWindows & writeCache preserve earlier anchored resetTime on full windows for same account
    const prevModels = [
      {
        id: 'gemini-3-pro',
        remainingFraction: 1,
        resetTime: anchoredReset,
        window: 'fiveHour',
        windows: { fiveHour: { remainingFraction: 1, resetTime: anchoredReset, observedAt: now - 30_000 } },
      },
    ];
    const freshModels = [
      {
        id: 'gemini-3-pro',
        remainingFraction: 1,
        resetTime: floatingCloudReset,
        window: 'fiveHour',
        windows: { fiveHour: { remainingFraction: 1, resetTime: floatingCloudReset, observedAt: now } },
      },
    ];
    const mergedModels = mergeQuotaWindows(freshModels, prevModels, now);
    assert.equal(mergedModels[0].windows.fiveHour.resetTime, anchoredReset);
    assert.equal(mergedModels[0].resetTime, anchoredReset);

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-quota-cache-anchor-'));
    try {
      const cachePath = path.join(tmp, 'quota-cache.json');
      const realNow = Date.now();
      const realAnchored = new Date(realNow + 2 * 3600_000).toISOString();
      const realFloating = new Date(realNow + 5 * 3600_000).toISOString();
      const tok = { accessToken: 'tok-same', email: 'user@example.com' };

      writeCache(
        [
          {
            id: 'gemini-3-pro',
            remainingFraction: 1,
            resetTime: realAnchored,
            window: 'fiveHour',
            windows: { fiveHour: { remainingFraction: 1, resetTime: realAnchored, observedAt: realNow } },
          },
        ],
        tok,
        'Pro',
        'user@example.com',
        { google: { fiveHour: { remainingFraction: 1, resetTime: realAnchored } } },
        cachePath,
      );

      writeCache(
        [
          {
            id: 'gemini-3-pro',
            remainingFraction: 1,
            resetTime: realFloating,
            window: 'fiveHour',
            windows: { fiveHour: { remainingFraction: 1, resetTime: realFloating, observedAt: realNow + 1000 } },
          },
        ],
        tok,
        'Pro',
        'user@example.com',
        { google: { fiveHour: { remainingFraction: 1, resetTime: realFloating } } },
        cachePath,
      );

      const saved = readCacheRaw(cachePath);
      assert.equal(saved.data[0].resetTime, realAnchored);
      assert.equal(saved.data[0].windows.fiveHour.resetTime, realAnchored);
      assert.equal(saved.providerQuota.google.fiveHour.resetTime, realAnchored);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('ignores expired stdin.quota buckets, supports reset_in_seconds, and resets expired top-level 0% in agyQuotaToUsageData', () => {
    const pastIso = new Date(now - 5_000).toISOString();

    // 1. reset_in_seconds populates resetTime when reset_time is absent; expired reset_time or <= 0 reset_in_seconds are ignored
    const parsedStdin = parseAgyStdinQuota(
      {
        'gemini-5h': { remaining_fraction: 0, reset_time: pastIso },
        'gemini-weekly': { remaining_fraction: 0.5, reset_in_seconds: 3600 },
        '3p-5h': { remaining_fraction: 0, reset_in_seconds: 0 },
      },
      now,
    );
    assert.equal(parsedStdin?.google?.fiveHour, undefined, 'expired 0% stdin bucket must be ignored');
    assert.equal(parsedStdin?.google?.weekly?.remainingFraction, 0.5);
    assert.equal(parsedStdin?.google?.weekly?.resetTime, new Date(now + 3600_000).toISOString());
    assert.equal(parsedStdin?.claude, undefined);

    // 2. Frozen expired 0% stdin.quota does not overwrite live cloud quota in mergeAgyQuotaProbe
    const liveProbe = {
      models: [
        {
          id: 'gemini-3-pro',
          displayName: 'Gemini 3 Pro',
          modelProvider: 'MODEL_PROVIDER_GOOGLE',
          remainingFraction: 1,
          resetTime: fiveHourReset,
          windows: { fiveHour: { remainingFraction: 1, resetTime: fiveHourReset } },
        },
      ],
      providerQuota: {
        google: { fiveHour: { remainingFraction: 1, resetTime: fiveHourReset } },
      },
      unavailableReason: null,
      tierName: 'Pro',
      accountEmail: null,
      updateInfo: null,
    };
    const afterMerge = mergeAgyQuotaProbe(
      liveProbe,
      { quota: { 'gemini-5h': { remaining_fraction: 0, reset_time: pastIso } } },
      now,
    );
    assert.equal(afterMerge?.providerQuota?.google?.fiveHour?.remainingFraction, 1);
    assert.equal(afterMerge?.models[0].remainingFraction, 1);

    // 3. When both providerQuota and matchedModel windows have expired, agyQuotaToUsageData treats top-level expired 0% as reset (fiveHour: 0)
    const expiredLimitProbe = {
      models: [
        {
          id: 'gemini-3-pro',
          displayName: 'Gemini 3 Pro',
          modelProvider: 'MODEL_PROVIDER_GOOGLE',
          remainingFraction: 0,
          resetTime: pastIso,
          windows: {
            fiveHour: { remainingFraction: 0, resetTime: pastIso },
          },
        },
      ],
      providerQuota: {
        google: {
          fiveHour: { remainingFraction: 0, resetTime: pastIso },
        },
      },
      unavailableReason: null,
      tierName: 'Pro',
      accountEmail: null,
      updateInfo: null,
    };
    const usage = agyQuotaToUsageData(expiredLimitProbe, { model: { id: 'gemini-3-pro' } }, now);
    assert.equal(usage?.fiveHour, 0, 'expired limit cycle must recover to 0% used instead of 100% Limit reached');
    assert.equal(usage?.fiveHourResetAt, null);
    assert.equal(usage?.fiveHourRemainingExact, 100);
  });
});
