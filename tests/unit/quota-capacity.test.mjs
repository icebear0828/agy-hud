import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getQuotaCapacityLedgerPath,
  resolveQuotaBucket,
  resolveModelPricingKey,
  extractSessionTokens,
  computeWeightedUnits,
  computeUnitsPerToken,
  resolveActiveTokenMix,
  extractBucketWindows,
  detectWindowRollover,
  foldObservationIntoLedger,
  estimateWindowCapacity,
  getQuotaCapacityEstimates,
  MIN_DELTA_Q_5H,
  MIN_DELTA_Q_WEEKLY,
  WRITE_THROTTLE_MS,
} from '../../runtime/quota-capacity.js';

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-qcap-'));
}

function makeQuotaData(now, { google5h, googleWeek, claude5h, claudeWeek, argon5h, argonWeek } = {}) {
  const arr = [];
  const pq = {};
  if (google5h !== undefined || googleWeek !== undefined) {
    pq.google = {};
    if (google5h !== undefined) {
      pq.google.fiveHour = typeof google5h === 'number'
        ? { remainingFraction: google5h, resetTime: new Date(now + 4 * 3600_000).toISOString() }
        : google5h;
    }
    if (googleWeek !== undefined) {
      pq.google.weekly = typeof googleWeek === 'number'
        ? { remainingFraction: googleWeek, resetTime: new Date(now + 6 * 86400_000).toISOString() }
        : googleWeek;
    }
  }
  if (claude5h !== undefined || claudeWeek !== undefined) {
    pq.claude = {};
    if (claude5h !== undefined) {
      pq.claude.fiveHour = typeof claude5h === 'number'
        ? { remainingFraction: claude5h, resetTime: new Date(now + 4 * 3600_000).toISOString() }
        : claude5h;
    }
    if (claudeWeek !== undefined) {
      pq.claude.weekly = typeof claudeWeek === 'number'
        ? { remainingFraction: claudeWeek, resetTime: new Date(now + 6 * 86400_000).toISOString() }
        : claudeWeek;
    }
  }
  if (argon5h !== undefined || argonWeek !== undefined) {
    pq.argon = {};
    if (argon5h !== undefined) {
      pq.argon.fiveHour = typeof argon5h === 'number'
        ? { remainingFraction: argon5h, resetTime: new Date(now + 4 * 3600_000).toISOString() }
        : argon5h;
    }
    if (argonWeek !== undefined) {
      pq.argon.weekly = typeof argonWeek === 'number'
        ? { remainingFraction: argonWeek, resetTime: new Date(now + 6 * 86400_000).toISOString() }
        : argonWeek;
    }
  }
  arr.providerQuota = pq;
  return arr;
}

describe('quota-capacity / helpers & bucket resolution', () => {
  test('resolveQuotaBucket maps argon, google, claude, and excludes image models', () => {
    assert.equal(resolveQuotaBucket({ id: 'gemini-4-argon', displayName: 'Gemini 4 Argon (Medium)', modelProvider: 'MODEL_PROVIDER_GOOGLE' }), 'argon');
    assert.equal(resolveQuotaBucket({ id: 'gemini-3.5-flash-high', displayName: 'Gemini 3.5 Flash (High)', modelProvider: 'MODEL_PROVIDER_GOOGLE' }), 'google');
    assert.equal(resolveQuotaBucket({ id: 'gemini-3.1-pro-low', displayName: 'Gemini 3.1 Pro (Low)', modelProvider: 'MODEL_PROVIDER_GOOGLE' }), 'google');
    assert.equal(resolveQuotaBucket({ id: 'claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6 (Thinking)', modelProvider: 'MODEL_PROVIDER_ANTHROPIC' }), 'claude');
    assert.equal(resolveQuotaBucket({ id: 'claude-opus-4-6-thinking', displayName: 'Claude Opus 4.6 (Thinking)' }), 'claude');
    assert.equal(resolveQuotaBucket({ id: 'gpt-oss-120b-medium', displayName: 'GPT-OSS 120B (Medium)', modelProvider: 'MODEL_PROVIDER_OPENAI' }), 'claude');
    assert.equal(resolveQuotaBucket({ id: 'gemini-3.1-flash-image', displayName: 'Gemini 3.1 Flash Image', modelProvider: 'MODEL_PROVIDER_GOOGLE' }), null);
    assert.equal(resolveQuotaBucket(''), null);
  });

  test('resolveModelPricingKey identifies families including argon and gpt', () => {
    assert.equal(resolveModelPricingKey('claude-opus-4-6'), 'opus');
    assert.equal(resolveModelPricingKey('Claude Sonnet 4.6'), 'sonnet');
    assert.equal(resolveModelPricingKey('claude-haiku-4'), 'haiku');
    assert.equal(resolveModelPricingKey('gemini-4-argon'), 'argon');
    assert.equal(resolveModelPricingKey('gemini-3.1-pro-high'), 'pro');
    assert.equal(resolveModelPricingKey('gemini-3.5-flash-low'), 'flash');
    assert.equal(resolveModelPricingKey('gpt-4o'), 'gpt4');
    assert.equal(resolveModelPricingKey('gpt-oss-120b-medium'), 'gpt');
    assert.equal(resolveModelPricingKey('unknown-model'), 'default');
  });

  test('extractSessionTokens respects cache-in-input semantics', () => {
    const t = extractSessionTokens({
      model: { id: 'claude-sonnet-4-6' },
      context_window: {
        total_input_tokens: 100_000,
        total_output_tokens: 20_000,
        current_usage: { cache_read_input_tokens: 90_000 },
      },
    });
    assert.equal(t.totalIn, 100_000);
    assert.equal(t.cache, 90_000);
    assert.equal(t.uncachedIn, 10_000);
    assert.equal(t.out, 20_000);
    assert.equal(t.rawTotal, 120_000);
    assert.equal(t.includesCache, true);
  });

  test('computeWeightedUnits and computeUnitsPerToken are consistent', () => {
    const units = computeWeightedUnits({ uncachedIn: 10_000, out: 20_000, cache: 90_000 }, 'sonnet');
    const mix = { in: 10 / 120, out: 20 / 120, cache: 90 / 120 };
    const perTok = computeUnitsPerToken(mix, 'sonnet');
    assert.ok(Math.abs(units - perTok * 120_000) < 1e-12);
  });

  test('getQuotaCapacityLedgerPath uses rootDir when provided', () => {
    const p = getQuotaCapacityLedgerPath('/tmp/custom-root');
    assert.equal(p, path.join('/tmp/custom-root', 'quota-capacity.json'));
  });
});

describe('quota-capacity / core math & model switching', () => {
  test('single-model exact cancellation: 120k tokens / 0.10 deltaQ = 1.2M total exactly', () => {
    const dir = makeTmpDir();
    try {
      const t0 = 1_700_000_000_000;
      const deps = { rootDir: () => dir, now: () => t0 };
      const state = { accountKey: 'acct-1', sessionStartedAt: t0 };

      // Turn 0: baseline at 100%
      getQuotaCapacityEstimates(
        {
          session_id: 's1',
          model: { id: 'claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6 (Thinking)' },
          context_window: { total_input_tokens: 0, total_output_tokens: 0 },
        },
        state,
        makeQuotaData(t0, { claude5h: 1.0, claudeWeek: 1.0 }),
        {},
        deps
      );

      // Turn 1: burn 120k tokens (10k uncached in, 90k cache read, 20k out) and drop 10%
      const est = getQuotaCapacityEstimates(
        {
          session_id: 's1',
          model: { id: 'claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6 (Thinking)' },
          context_window: {
            total_input_tokens: 100_000,
            total_output_tokens: 20_000,
            current_usage: { cache_read_input_tokens: 90_000 },
          },
        },
        state,
        makeQuotaData(t0, { claude5h: 0.90, claudeWeek: 0.98 }),
        {},
        { rootDir: () => dir, now: () => t0 + 10_000 }
      );

      assert.equal(est.bucket, 'claude');
      assert.equal(est.modelName, 'Sonnet 4.6');
      assert.equal(est.fiveHour.status, 'ready');
      assert.equal(est.fiveHour.confidence, 'high');
      assert.equal(est.fiveHour.totalTokens, 1_200_000);
      assert.equal(est.fiveHour.remainingTokens, 1_080_000);
      assert.equal(est.weekly.status, 'ready');
      assert.equal(est.weekly.totalTokens, 6_000_000);
      assert.equal(est.weekly.remainingTokens, 5_880_000);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('shared-bucket model switch: Sonnet -> Opus scales capacity by exact 5x', () => {
    const dir = makeTmpDir();
    try {
      const t0 = 1_700_000_000_000;
      const state = { accountKey: 'acct-1', sessionStartedAt: t0 };

      getQuotaCapacityEstimates(
        { session_id: 's1', model: { id: 'claude-sonnet-4-6' }, context_window: { total_input_tokens: 0, total_output_tokens: 0 } },
        state,
        makeQuotaData(t0, { claude5h: 1.0 }),
        {},
        { rootDir: () => dir, now: () => t0 }
      );

      const sonnetEst = getQuotaCapacityEstimates(
        {
          session_id: 's1',
          model: { id: 'claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6 (Thinking)' },
          context_window: { total_input_tokens: 100_000, total_output_tokens: 20_000, current_usage: { cache_read_input_tokens: 90_000 } },
        },
        state,
        makeQuotaData(t0, { claude5h: 0.90 }),
        {},
        { rootDir: () => dir, now: () => t0 + 5_000 }
      );

      // Switch to Opus in a fresh session (no new tokens yet)
      const opusEst = getQuotaCapacityEstimates(
        {
          session_id: 's2',
          model: { id: 'claude-opus-4-6-thinking', display_name: 'Claude Opus 4.6 (Thinking)' },
          context_window: { total_input_tokens: 0, total_output_tokens: 0 },
        },
        { accountKey: 'acct-1', sessionStartedAt: t0 + 10_000 },
        makeQuotaData(t0, { claude5h: 0.90 }),
        {},
        { rootDir: () => dir, now: () => t0 + 10_000 }
      );

      assert.equal(sonnetEst.fiveHour.totalTokens, 1_200_000);
      assert.equal(opusEst.fiveHour.totalTokens, 240_000); // exact 5x ratio
      assert.equal(opusEst.fiveHour.remainingTokens, 216_000);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('shared-bucket model switch: Flash -> Pro scales capacity by ~16.67x (exact 50/3)', () => {
    const dir = makeTmpDir();
    try {
      const t0 = 1_700_000_000_000;
      const state = { accountKey: 'acct-1', sessionStartedAt: t0 };

      getQuotaCapacityEstimates(
        { session_id: 's1', model: { id: 'gemini-3.5-flash-high' }, context_window: { total_input_tokens: 0, total_output_tokens: 0 } },
        state,
        makeQuotaData(t0, { google5h: 1.0 }),
        {},
        { rootDir: () => dir, now: () => t0 }
      );

      const flashEst = getQuotaCapacityEstimates(
        {
          session_id: 's1',
          model: { id: 'gemini-3.5-flash-high', display_name: 'Gemini 3.5 Flash (High)' },
          context_window: { total_input_tokens: 400_000, total_output_tokens: 100_000, current_usage: { cache_read_input_tokens: 300_000 } },
        },
        state,
        makeQuotaData(t0, { google5h: 0.95 }),
        {},
        { rootDir: () => dir, now: () => t0 + 5_000 }
      );

      const proEst = getQuotaCapacityEstimates(
        {
          session_id: 's2',
          model: { id: 'gemini-3.1-pro-high', display_name: 'Gemini 3.1 Pro (High)' },
          context_window: { total_input_tokens: 0, total_output_tokens: 0 },
        },
        { accountKey: 'acct-1', sessionStartedAt: t0 + 10_000 },
        makeQuotaData(t0, { google5h: 0.95 }),
        {},
        { rootDir: () => dir, now: () => t0 + 10_000 }
      );

      assert.equal(flashEst.fiveHour.totalTokens, 10_000_000);
      const ratio = flashEst.fiveHour.totalTokens / proEst.fiveHour.totalTokens;
      assert.ok(Math.abs(ratio - (50 / 3)) < 0.01, `expected ratio ~16.67, got ${ratio}`);
      assert.equal(proEst.fiveHour.totalTokens, 600_000);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('dedicated argon isolation & cross-bucket isolation', () => {
    const dir = makeTmpDir();
    try {
      const t0 = 1_700_000_000_000;
      const state = { accountKey: 'acct-1', sessionStartedAt: t0 };

      // Initialize all 3 buckets
      getQuotaCapacityEstimates(
        { session_id: 's-g', model: { id: 'gemini-3.5-flash-high' }, context_window: { total_input_tokens: 0, total_output_tokens: 0 } },
        state,
        makeQuotaData(t0, { google5h: 1.0, claude5h: 1.0, argonWeek: 1.0 }),
        {},
        { rootDir: () => dir, now: () => t0 }
      );

      // Burn Google Flash
      const gEst = getQuotaCapacityEstimates(
        { session_id: 's-g', model: { id: 'gemini-3.5-flash-high' }, context_window: { total_input_tokens: 100_000, total_output_tokens: 20_000 } },
        state,
        makeQuotaData(t0, { google5h: 0.90, claude5h: 1.0, argonWeek: 1.0 }),
        {},
        { rootDir: () => dir, now: () => t0 + 1_000 }
      );
      assert.equal(gEst.fiveHour.status, 'ready');

      // Claude and Argon must remain completely isolated (idle)
      const cEst = getQuotaCapacityEstimates(
        { session_id: 's-c', model: { id: 'claude-sonnet-4-6' }, context_window: { total_input_tokens: 0, total_output_tokens: 0 } },
        state,
        makeQuotaData(t0, { google5h: 0.90, claude5h: 1.0, argonWeek: 1.0 }),
        {},
        { rootDir: () => dir, now: () => t0 + 2_000 }
      );
      assert.equal(cEst.fiveHour.status, 'idle');

      const aEst0 = getQuotaCapacityEstimates(
        { session_id: 's-a', model: { id: 'gemini-4-argon' }, context_window: { total_input_tokens: 0, total_output_tokens: 0 } },
        state,
        makeQuotaData(t0, { google5h: 0.90, claude5h: 1.0, argonWeek: 1.0 }),
        {},
        { rootDir: () => dir, now: () => t0 + 3_000 }
      );
      assert.equal(aEst0.weekly.status, 'idle');

      // Burn Argon separately -> exact cancellation on argon bucket
      const aEst1 = getQuotaCapacityEstimates(
        { session_id: 's-a', model: { id: 'gemini-4-argon', display_name: 'Gemini 4 Argon (Medium)' }, context_window: { total_input_tokens: 50_000, total_output_tokens: 10_000 } },
        state,
        makeQuotaData(t0, { google5h: 0.90, claude5h: 1.0, argonWeek: 0.95 }),
        {},
        { rootDir: () => dir, now: () => t0 + 4_000 }
      );
      assert.equal(aEst1.bucket, 'argon');
      assert.equal(aEst1.weekly.status, 'ready');
      assert.equal(aEst1.weekly.totalTokens, 1_200_000);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('cache-heavy (90% cacheRead) weighting reduces unitsPerToken dramatically vs uncached', () => {
    const cacheHeavy = computeUnitsPerToken({ in: 0.05, out: 0.05, cache: 0.90 }, 'sonnet');
    const uncached = computeUnitsPerToken({ in: 0.50, out: 0.50, cache: 0.00 }, 'sonnet');
    assert.ok(cacheHeavy < uncached / 5, `expected cache-heavy ${cacheHeavy} << uncached ${uncached}`);
  });
});

describe('quota-capacity / cache-lag, external burn & noise floor', () => {
  test('cache-lag matched-endpoint sampling avoids overestimation and subtracts unreconciled units', () => {
    const dir = makeTmpDir();
    try {
      const t0 = 1_700_000_000_000;
      const state = { accountKey: 'acct-1', sessionStartedAt: t0 };

      // Baseline at 1.0
      getQuotaCapacityEstimates(
        { session_id: 's1', model: { id: 'claude-sonnet-4-6' }, context_window: { total_input_tokens: 0, total_output_tokens: 0 } },
        state,
        makeQuotaData(t0, { claude5h: 1.0 }),
        {},
        { rootDir: () => dir, now: () => t0 }
      );

      // Turn 1: burn 60k tokens, cache lags (quota STILL 1.0)
      const lag1 = getQuotaCapacityEstimates(
        { session_id: 's1', model: { id: 'claude-sonnet-4-6' }, context_window: { total_input_tokens: 50_000, total_output_tokens: 10_000 } },
        state,
        makeQuotaData(t0, { claude5h: 1.0 }),
        {},
        { rootDir: () => dir, now: () => t0 + 1_000 }
      );
      assert.equal(lag1.fiveHour.status, 'idle');

      // Turn 2: burn another 60k tokens (120k cumulative), quota refreshes to 0.90
      const synced = getQuotaCapacityEstimates(
        { session_id: 's1', model: { id: 'claude-sonnet-4-6' }, context_window: { total_input_tokens: 100_000, total_output_tokens: 20_000 } },
        state,
        makeQuotaData(t0, { claude5h: 0.90 }),
        {},
        { rootDir: () => dir, now: () => t0 + 2_000 }
      );
      assert.equal(synced.fiveHour.totalTokens, 1_200_000);
      assert.equal(synced.fiveHour.remainingTokens, 1_080_000);

      // Turn 3: burn another 60k tokens while cache lags (quota still 0.90)
      // Total stays 1.2M (no inflation!), remaining smoothly drops by 60k -> 1.02M
      const lag2 = getQuotaCapacityEstimates(
        { session_id: 's1', model: { id: 'claude-sonnet-4-6' }, context_window: { total_input_tokens: 150_000, total_output_tokens: 30_000 } },
        state,
        makeQuotaData(t0, { claude5h: 0.90 }),
        {},
        { rootDir: () => dir, now: () => t0 + 3_000 }
      );
      assert.equal(lag2.fiveHour.totalTokens, 1_200_000);
      assert.equal(lag2.fiveHour.remainingTokens, 1_020_000);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('external zero-token burn advances lastRemaining without polluting observedDeltaQ', () => {
    const dir = makeTmpDir();
    try {
      const t0 = 1_700_000_000_000;
      const state = { accountKey: 'acct-1', sessionStartedAt: t0 };

      getQuotaCapacityEstimates(
        { session_id: 's1', model: { id: 'claude-sonnet-4-6' }, context_window: { total_input_tokens: 0, total_output_tokens: 0 } },
        state,
        makeQuotaData(t0, { claude5h: 1.0 }),
        {},
        { rootDir: () => dir, now: () => t0 }
      );

      // External IDE drops quota 1.0 -> 0.70 while this CLI session burned 0 tokens
      const afterExternal = getQuotaCapacityEstimates(
        { session_id: 's1', model: { id: 'claude-sonnet-4-6' }, context_window: { total_input_tokens: 0, total_output_tokens: 0 } },
        state,
        makeQuotaData(t0, { claude5h: 0.70 }),
        {},
        { rootDir: () => dir, now: () => t0 + 1_000 }
      );
      assert.equal(afterExternal.fiveHour.status, 'idle');
      assert.equal(afterExternal.fiveHour.observedDeltaQ, 0);

      // Now burn 120k tokens and drop 0.70 -> 0.60 (dQ = 0.10) -> total must still be 1.2M, remaining 720k
      const calibrated = getQuotaCapacityEstimates(
        { session_id: 's1', model: { id: 'claude-sonnet-4-6' }, context_window: { total_input_tokens: 100_000, total_output_tokens: 20_000 } },
        state,
        makeQuotaData(t0, { claude5h: 0.60 }),
        {},
        { rootDir: () => dir, now: () => t0 + 2_000 }
      );
      assert.equal(calibrated.fiveHour.status, 'ready');
      assert.equal(calibrated.fiveHour.totalTokens, 1_200_000);
      assert.equal(calibrated.fiveHour.remainingTokens, 720_000);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('noise floor: <2% 5h calibrates; fine weekly ready at >=1% while coarse weekly requires >=2%', () => {
    const dir = makeTmpDir();
    try {
      const t0 = 1_700_000_000_000;
      const state = { accountKey: 'acct-1', sessionStartedAt: t0 };

      // 1. Sub-percent weekly precision (0.9950 -> 0.9830, dQ = 0.012 >= 0.01) + 5h dQ = 0.012 (< 0.02)
      getQuotaCapacityEstimates(
        { session_id: 's1', model: { id: 'claude-sonnet-4-6' }, context_window: { total_input_tokens: 0, total_output_tokens: 0 } },
        state,
        makeQuotaData(t0, { claude5h: 0.9950, claudeWeek: 0.9950 }),
        {},
        { rootDir: () => dir, now: () => t0 }
      );
      const estFine = getQuotaCapacityEstimates(
        { session_id: 's1', model: { id: 'claude-sonnet-4-6' }, context_window: { total_input_tokens: 10_000, total_output_tokens: 2_000 } },
        state,
        makeQuotaData(t0, { claude5h: 0.9830, claudeWeek: 0.9830 }),
        {},
        { rootDir: () => dir, now: () => t0 + 1_000 }
      );
      assert.equal(estFine.fiveHour.status, 'calibrating');
      assert.equal(estFine.fiveHour.minDeltaQ, MIN_DELTA_Q_5H);
      assert.equal(estFine.weekly.status, 'ready');
      assert.equal(estFine.weekly.minDeltaQ, MIN_DELTA_Q_WEEKLY);

      // 2. Coarse weekly (1.00 -> 0.99, integer percent only, dQ = 0.01 < 0.02) -> calibrating
      const dir2 = makeTmpDir();
      try {
        getQuotaCapacityEstimates(
          { session_id: 's2', model: { id: 'claude-sonnet-4-6' }, context_window: { total_input_tokens: 0, total_output_tokens: 0 } },
          state,
          makeQuotaData(t0, { claudeWeek: 1.0 }),
          {},
          { rootDir: () => dir2, now: () => t0 }
        );
        const estCoarse = getQuotaCapacityEstimates(
          { session_id: 's2', model: { id: 'claude-sonnet-4-6' }, context_window: { total_input_tokens: 10_000, total_output_tokens: 2_000 } },
          state,
          makeQuotaData(t0, { claudeWeek: 0.99 }),
          {},
          { rootDir: () => dir2, now: () => t0 + 1_000 }
        );
        assert.equal(estCoarse.weekly.status, 'calibrating');
        assert.equal(estCoarse.weekly.minDeltaQ, MIN_DELTA_Q_5H);

        // With custom minDeltaQ override = 0.005 -> ready
        const estCustom = getQuotaCapacityEstimates(
          { session_id: 's2', model: { id: 'claude-sonnet-4-6' }, context_window: { total_input_tokens: 10_000, total_output_tokens: 2_000 } },
          state,
          makeQuotaData(t0, { claudeWeek: 0.99 }),
          { minDeltaQ: 0.005 },
          { rootDir: () => dir2, now: () => t0 + 2_000 }
        );
        assert.equal(estCustom.weekly.status, 'ready');
      } finally {
        fs.rmSync(dir2, { recursive: true, force: true });
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('quota-capacity / rollover, jitter, priors & shrinkage blending', () => {
  test('detectWindowRollover handles resetTime shift, remainingFraction jump, deadline, and jitter immunity', () => {
    const now = 1_700_000_000_000;
    const prev5h = { resetMs: now + 3 * 3600_000, lastRemaining: 0.50 };

    // Small resetTime jitter (<= 5m) and small upward jitter (<= 0.02): NOT a rollover
    assert.equal(detectWindowRollover(prev5h, { resetTime: new Date(prev5h.resetMs + 4 * 60_000).toISOString(), remainingFraction: 0.51 }, 'fiveHour', now), false);
    // ResetTime shifted > 5m: rollover
    assert.equal(detectWindowRollover(prev5h, { resetTime: new Date(prev5h.resetMs + 6 * 60_000).toISOString(), remainingFraction: 0.50 }, 'fiveHour', now), true);
    // Remaining jumped > +0.02: rollover
    assert.equal(detectWindowRollover(prev5h, { resetTime: new Date(prev5h.resetMs).toISOString(), remainingFraction: 0.55 }, 'fiveHour', now), true);
    // Now past prevResetMs: rollover
    assert.equal(detectWindowRollover(prev5h, { resetTime: new Date(prev5h.resetMs).toISOString(), remainingFraction: 0.50 }, 'fiveHour', prev5h.resetMs + 1000), true);

    // Weekly jitter tolerance is 30m
    const prevWeek = { resetMs: now + 5 * 86400_000, lastRemaining: 0.80 };
    assert.equal(detectWindowRollover(prevWeek, { resetTime: new Date(prevWeek.resetMs + 25 * 60_000).toISOString(), remainingFraction: 0.80 }, 'weekly', now), false);
    assert.equal(detectWindowRollover(prevWeek, { resetTime: new Date(prevWeek.resetMs + 35 * 60_000).toISOString(), remainingFraction: 0.80 }, 'weekly', now), true);
  });

  test('rollover archives EMA prior (alpha = 0.4), serves prior immediately, and applies shrinkage < 5%', () => {
    const dir = makeTmpDir();
    try {
      const t0 = 1_700_000_000_000;
      const state = { accountKey: 'acct-1', sessionStartedAt: t0 };
      const reset1 = new Date(t0 + 5 * 3600_000).toISOString();
      const reset2 = new Date(t0 + 10 * 3600_000).toISOString();
      const reset3 = new Date(t0 + 15 * 3600_000).toISOString();

      // Cycle 1: 120k tokens / 0.10 = 1.2M total
      getQuotaCapacityEstimates(
        { session_id: 's1', model: { id: 'claude-sonnet-4-6' }, context_window: { total_input_tokens: 0, total_output_tokens: 0 } },
        state,
        makeQuotaData(t0, { claude5h: { remainingFraction: 1.0, resetTime: reset1 } }),
        {},
        { rootDir: () => dir, now: () => t0 }
      );
      getQuotaCapacityEstimates(
        { session_id: 's1', model: { id: 'claude-sonnet-4-6' }, context_window: { total_input_tokens: 100_000, total_output_tokens: 20_000 } },
        state,
        makeQuotaData(t0, { claude5h: { remainingFraction: 0.90, resetTime: reset1 } }),
        {},
        { rootDir: () => dir, now: () => t0 + 1_000 }
      );

      // Rollover to Cycle 2 (no tokens burned yet post-reset): serves prior with isPrior=true
      const postReset = getQuotaCapacityEstimates(
        { session_id: 's1', model: { id: 'claude-sonnet-4-6' }, context_window: { total_input_tokens: 100_000, total_output_tokens: 20_000 } },
        state,
        makeQuotaData(t0 + 6 * 3600_000, { claude5h: { remainingFraction: 1.0, resetTime: reset2 } }),
        {},
        { rootDir: () => dir, now: () => t0 + 6 * 3600_000 }
      );
      assert.equal(postReset.fiveHour.status, 'ready');
      assert.equal(postReset.fiveHour.confidence, 'prior');
      assert.equal(postReset.fiveHour.isPrior, true);
      assert.equal(postReset.fiveHour.totalTokens, 1_200_000);
      assert.equal(postReset.fiveHour.remainingTokens, 1_200_000);

      // Early Cycle 2 burn: 2.5% (dQ = 0.025 < 0.05) at 2x rate (60k / 0.025 = 2.4M live vs 1.2M prior)
      // Shrinkage weight w = 0.025 / 0.05 = 0.5 -> blended = 0.5 * 2.4M + 0.5 * 1.2M = 1.8M
      const blended = getQuotaCapacityEstimates(
        { session_id: 's1', model: { id: 'claude-sonnet-4-6' }, context_window: { total_input_tokens: 150_000, total_output_tokens: 30_000 } },
        state,
        makeQuotaData(t0 + 6 * 3600_000, { claude5h: { remainingFraction: 0.975, resetTime: reset2 } }),
        {},
        { rootDir: () => dir, now: () => t0 + 6 * 3600_000 + 1_000 }
      );
      assert.equal(blended.fiveHour.confidence, 'high');
      assert.equal(blended.fiveHour.isPrior, false);
      assert.equal(blended.fiveHour.totalTokens, 1_800_000);

      // Rollover to Cycle 3 -> EMA prior = 0.4 * 2.4M + 0.6 * 1.2M = 1.68M
      const cycle3 = getQuotaCapacityEstimates(
        { session_id: 's1', model: { id: 'claude-sonnet-4-6' }, context_window: { total_input_tokens: 150_000, total_output_tokens: 30_000 } },
        state,
        makeQuotaData(t0 + 11 * 3600_000, { claude5h: { remainingFraction: 1.0, resetTime: reset3 } }),
        {},
        { rootDir: () => dir, now: () => t0 + 11 * 3600_000 }
      );
      assert.equal(cycle3.fiveHour.isPrior, true);
      assert.equal(cycle3.fiveHour.totalTokens, 1_680_000);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('quota-capacity / multi-session, resumed-session, regression, multi-account & persistence', () => {
  test('multi-session summing + new-session vs resumed-session baselining + regressive token clamping', () => {
    const dir = makeTmpDir();
    try {
      const t0 = 1_700_000_000_000;
      const reset1 = new Date(t0 + 5 * 3600_000).toISOString(); // openedAt = t0

      // Session 1 starts inside window, baselines at 0 -> burns 60k (dQ = 0.05)
      getQuotaCapacityEstimates(
        { session_id: 's1', model: { id: 'claude-sonnet-4-6' }, context_window: { total_input_tokens: 0, total_output_tokens: 0 } },
        { accountKey: 'acct-1', sessionStartedAt: t0 + 1000 },
        makeQuotaData(t0, { claude5h: { remainingFraction: 1.0, resetTime: reset1 } }),
        {},
        { rootDir: () => dir, now: () => t0 + 1_000 }
      );
      getQuotaCapacityEstimates(
        { session_id: 's1', model: { id: 'claude-sonnet-4-6' }, context_window: { total_input_tokens: 50_000, total_output_tokens: 10_000 } },
        { accountKey: 'acct-1', sessionStartedAt: t0 + 1000 },
        makeQuotaData(t0, { claude5h: { remainingFraction: 0.95, resetTime: reset1 } }),
        {},
        { rootDir: () => dir, now: () => t0 + 2_000 }
      );

      // Regressive token report on s1 (drops from 50k to 20k): clamped, no negative delta
      const afterRegress = getQuotaCapacityEstimates(
        { session_id: 's1', model: { id: 'claude-sonnet-4-6' }, context_window: { total_input_tokens: 20_000, total_output_tokens: 5_000 } },
        { accountKey: 'acct-1', sessionStartedAt: t0 + 1000 },
        makeQuotaData(t0, { claude5h: { remainingFraction: 0.95, resetTime: reset1 } }),
        {},
        { rootDir: () => dir, now: () => t0 + 3_000 }
      );
      assert.equal(afterRegress.fiveHour.totalTokens, 1_200_000);

      // Resumed old session (started 2 days BEFORE openedAt) with 500k historical tokens:
      // Must be baselined at 500k (delta = 0), NOT inject 500k into current window!
      const afterResume = getQuotaCapacityEstimates(
        { session_id: 's-old', model: { id: 'claude-sonnet-4-6' }, context_window: { total_input_tokens: 400_000, total_output_tokens: 100_000 } },
        { accountKey: 'acct-1', sessionStartedAt: t0 - 2 * 86400_000 },
        makeQuotaData(t0, { claude5h: { remainingFraction: 0.95, resetTime: reset1 } }),
        {},
        { rootDir: () => dir, now: () => t0 + 4_000 }
      );
      assert.equal(afterResume.fiveHour.totalTokens, 1_200_000);

      // Brand-new session s2 started INSIDE window (sessionStartedAt >= openedAt) already showing 60k on first sighting + 0.05 drop
      // Total across s1 (60k) + s2 (60k) = 120k / 0.10 = 1.2M
      const afterNewSess = getQuotaCapacityEstimates(
        { session_id: 's2', model: { id: 'claude-sonnet-4-6' }, context_window: { total_input_tokens: 50_000, total_output_tokens: 10_000 } },
        { accountKey: 'acct-1', sessionStartedAt: t0 + 5_000 },
        makeQuotaData(t0, { claude5h: { remainingFraction: 0.90, resetTime: reset1 } }),
        {},
        { rootDir: () => dir, now: () => t0 + 6_000 }
      );
      assert.equal(afterNewSess.fiveHour.totalTokens, 1_200_000);
      assert.equal(afterNewSess.fiveHour.remainingTokens, 1_080_000);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('multi-account switching & tier-change prior invalidation', () => {
    const dir = makeTmpDir();
    try {
      const t0 = 1_700_000_000_000;
      const reset1 = new Date(t0 + 5 * 3600_000).toISOString();
      const reset2 = new Date(t0 + 10 * 3600_000).toISOString();

      // Account A calibrates and rolls over -> creates prior
      getQuotaCapacityEstimates(
        { session_id: 's1', model: { id: 'claude-sonnet-4-6' }, context_window: { total_input_tokens: 0, total_output_tokens: 0 } },
        { accountKey: 'alice@example.com', sessionStartedAt: t0 },
        makeQuotaData(t0, { claude5h: { remainingFraction: 1.0, resetTime: reset1 } }),
        { tierName: 'Google AI Pro' },
        { rootDir: () => dir, now: () => t0 }
      );
      getQuotaCapacityEstimates(
        { session_id: 's1', model: { id: 'claude-sonnet-4-6' }, context_window: { total_input_tokens: 100_000, total_output_tokens: 20_000 } },
        { accountKey: 'alice@example.com', sessionStartedAt: t0 },
        makeQuotaData(t0, { claude5h: { remainingFraction: 0.90, resetTime: reset1 } }),
        { tierName: 'Google AI Pro' },
        { rootDir: () => dir, now: () => t0 + 1_000 }
      );
      const alicePrior = getQuotaCapacityEstimates(
        { session_id: 's1', model: { id: 'claude-sonnet-4-6' }, context_window: { total_input_tokens: 100_000, total_output_tokens: 20_000 } },
        { accountKey: 'alice@example.com', sessionStartedAt: t0 },
        makeQuotaData(t0 + 6 * 3600_000, { claude5h: { remainingFraction: 1.0, resetTime: reset2 } }),
        { tierName: 'Google AI Pro' },
        { rootDir: () => dir, now: () => t0 + 6 * 3600_000 }
      );
      assert.equal(alicePrior.fiveHour.isPrior, true);

      // Account B is completely isolated (idle, does NOT see Alice's prior)
      const bobEst = getQuotaCapacityEstimates(
        { session_id: 's-bob', model: { id: 'claude-sonnet-4-6' }, context_window: { total_input_tokens: 0, total_output_tokens: 0 } },
        { accountKey: 'bob@example.com', sessionStartedAt: t0 + 6 * 3600_000 },
        makeQuotaData(t0 + 6 * 3600_000, { claude5h: { remainingFraction: 1.0, resetTime: reset2 } }),
        { tierName: 'Google AI Pro' },
        { rootDir: () => dir, now: () => t0 + 6 * 3600_000 + 1_000 }
      );
      assert.equal(bobEst.fiveHour.status, 'idle');

      // Verify raw email is never persisted in ledger JSON
      const ledgerText = fs.readFileSync(getQuotaCapacityLedgerPath(dir), 'utf8');
      assert.doesNotMatch(ledgerText, /alice@example\.com/);
      assert.doesNotMatch(ledgerText, /bob@example\.com/);

      // Alice upgrades tier -> Google AI Ultra invalidates prior immediately
      const aliceUpgraded = getQuotaCapacityEstimates(
        { session_id: 's1', model: { id: 'claude-sonnet-4-6' }, context_window: { total_input_tokens: 100_000, total_output_tokens: 20_000 } },
        { accountKey: 'alice@example.com', sessionStartedAt: t0 },
        makeQuotaData(t0 + 6 * 3600_000, { claude5h: { remainingFraction: 1.0, resetTime: reset2 } }),
        { tierName: 'Google AI Ultra' },
        { rootDir: () => dir, now: () => t0 + 6 * 3600_000 + 2_000 }
      );
      assert.equal(aliceUpgraded.fiveHour.status, 'idle');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('corrupt JSON recovery, 30s write throttle, exhausted 0%, and expired/unavailable guards', () => {
    const dir = makeTmpDir();
    try {
      const ledgerPath = getQuotaCapacityLedgerPath(dir);
      fs.writeFileSync(ledgerPath, '{corrupt json!!!', 'utf8');

      const t0 = 1_700_000_000_000;
      const state = { accountKey: 'acct-1', sessionStartedAt: t0 };

      // Corrupt JSON recovers cleanly
      getQuotaCapacityEstimates(
        { session_id: 's1', model: { id: 'claude-sonnet-4-6' }, context_window: { total_input_tokens: 0, total_output_tokens: 0 } },
        state,
        makeQuotaData(t0, { claude5h: 1.0 }),
        {},
        { rootDir: () => dir, now: () => t0 }
      );
      const mtime1 = fs.statSync(ledgerPath).mtimeMs;
      assert.equal(mtime1, t0);

      // Timestamp-only repeat within 30s is throttled (mtime unchanged)
      getQuotaCapacityEstimates(
        { session_id: 's1', model: { id: 'claude-sonnet-4-6' }, context_window: { total_input_tokens: 0, total_output_tokens: 0 } },
        state,
        makeQuotaData(t0, { claude5h: 1.0 }),
        {},
        { rootDir: () => dir, now: () => t0 + 10_000 }
      );
      assert.equal(fs.statSync(ledgerPath).mtimeMs, t0);

      // After > WRITE_THROTTLE_MS (30s), timestamp-only refresh writes
      getQuotaCapacityEstimates(
        { session_id: 's1', model: { id: 'claude-sonnet-4-6' }, context_window: { total_input_tokens: 0, total_output_tokens: 0 } },
        state,
        makeQuotaData(t0, { claude5h: 1.0 }),
        {},
        { rootDir: () => dir, now: () => t0 + WRITE_THROTTLE_MS + 1_000 }
      );
      assert.equal(fs.statSync(ledgerPath).mtimeMs, t0 + WRITE_THROTTLE_MS + 1_000);

      // Exhausted 0% -> remainingTokens = 0, exhausted = true, totalTokens still computed
      const exhausted = getQuotaCapacityEstimates(
        { session_id: 's1', model: { id: 'claude-sonnet-4-6' }, context_window: { total_input_tokens: 500_000, total_output_tokens: 100_000 } },
        state,
        makeQuotaData(t0, { claude5h: 0.0 }),
        {},
        { rootDir: () => dir, now: () => t0 + WRITE_THROTTLE_MS + 2_000 }
      );
      assert.equal(exhausted.fiveHour.status, 'ready');
      assert.equal(exhausted.fiveHour.remainingTokens, 0);
      assert.equal(exhausted.fiveHour.totalTokens, 600_000);
      assert.equal(exhausted.fiveHour.exhausted, true);

      // Unavailable quota returns null without mutating
      const unavail = [];
      Object.defineProperty(unavail, 'unavailableReason', { value: 'not_logged_in', enumerable: false });
      assert.equal(extractBucketWindows(unavail, t0), null);
      assert.equal(getQuotaCapacityEstimates(
        { session_id: 's1', model: { id: 'claude-sonnet-4-6' }, context_window: { total_input_tokens: 600_000, total_output_tokens: 100_000 } },
        state,
        unavail,
        {},
        { rootDir: () => dir, now: () => t0 + WRITE_THROTTLE_MS + 3_000 }
      ), null);

      // Expired observation returns null
      const expiredQuota = makeQuotaData(t0, { claude5h: { remainingFraction: 0.5, resetTime: new Date(t0 - 10_000).toISOString() } });
      assert.equal(extractBucketWindows(expiredQuota, t0), null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('prunes sessions older than 8 days and enforces caps (10 accounts / 50 sessions)', () => {
    const t0 = 1_700_000_000_000;
    const ledger = { version: 1, accounts: {} };
    for (let i = 0; i < 12; i++) {
      ledger.accounts[`acct-${i}`] = {
        tier: 'Pro',
        lastSeenAt: t0 - i * 1000,
        sessions: {},
        buckets: {},
      };
    }
    for (let s = 0; s < 55; s++) {
      ledger.accounts['acct-0'].sessions[`s-${s}`] = {
        totalIn: 100,
        out: 10,
        cache: 0,
        modelKey: 'sonnet',
        ts: t0 - s * 1000,
      };
    }
    // Add an expired 9-day-old session
    ledger.accounts['acct-0'].sessions['s-expired'] = {
      totalIn: 100,
      out: 10,
      cache: 0,
      modelKey: 'sonnet',
      ts: t0 - 9 * 86400_000,
    };

    const res = foldObservationIntoLedger(ledger, {
      now: t0,
      accountKey: 'acct-0',
      bucket: 'claude',
      modelKey: 'sonnet',
      modelNameOrId: 'claude-sonnet-4-6',
      sessionId: 's-new',
      tokens: { totalIn: 0, out: 0, cache: 0, includesCache: true },
      bucketWindows: null,
    });

    assert.equal(Object.keys(res.ledger.accounts).length, 10);
    assert.equal(res.ledger.accounts['acct-0'].sessions['s-expired'], undefined);
    assert.ok(Object.keys(res.ledger.accounts['acct-0'].sessions).length <= 51);
  });

  test('resolveActiveTokenMix follows 4-level fallback priority', () => {
    const win = {
      byModel: {
        sonnet: { in: 2000, out: 2000, cache: 6000 },
      },
    };
    // 1. Active model in window
    const m1 = resolveActiveTokenMix(win, 'sonnet');
    assert.ok(Math.abs(m1.cache - 0.6) < 1e-9);

    // 2. Same-family session mix when model not yet in window
    const m2 = resolveActiveTokenMix(win, 'opus', { modelKey: 'opus', uncachedIn: 500, out: 500, cache: 1000 });
    assert.ok(Math.abs(m2.cache - 0.5) < 1e-9);

    // 3. Bucket window aggregate when active model & session both < 1000
    const m3 = resolveActiveTokenMix(win, 'opus', { modelKey: 'opus', uncachedIn: 100, out: 0, cache: 0 });
    assert.ok(Math.abs(m3.cache - 0.6) < 1e-9);

    // 4. Default coding-agent mix when everything < 1000
    const m4 = resolveActiveTokenMix({ byModel: {} }, 'opus', null);
    assert.deepEqual(m4, { in: 0.15, out: 0.15, cache: 0.70 });
  });

  test('estimateWindowCapacity handles null/idle gracefully', () => {
    const est = estimateWindowCapacity(null, null, 'sonnet', null, 'fiveHour');
    assert.equal(est.status, 'idle');
    assert.equal(est.remainingTokens, null);
    assert.equal(est.totalTokens, null);
  });
});
