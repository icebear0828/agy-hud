import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  quotaModule,
  CACHE_PATH,
  withCacheFile,
} from './_helpers/quota-test-utils.mjs';

const {
  isCachePayloadFresh,
  readCache,
  writeCache,
  getCachedTier,
  readCacheLastRefreshed,
  readCacheFallback,
} = quotaModule;

describe('quota / cache', () => {
  describe('isCachePayloadFresh', () => {
    test('rejects old unversioned cache payloads', () => {
      assert.equal(
        isCachePayloadFresh({
          expiresAt: Date.now() + 60_000,
          data: []
        }),
        false
      );
    });
  });

  describe('readCache / writeCache', () => {
    test('reuses stable token source across access token refreshes', () => {
      const previousCache = fs.existsSync(CACHE_PATH) ? fs.readFileSync(CACHE_PATH, 'utf8') : null;
      try {
        // Wipe any prior cache so mergeQuotaWindows doesn't inject stale windows
        // from a sibling test that primed the cache earlier in this run.
        fs.rmSync(CACHE_PATH, { force: true });

        const mockData = [{ id: 'gemini-3.5-flash-low', displayName: 'Gemini 3.5 Flash (Medium)', remainingFraction: 0.5, resetTime: null }];

        writeCache(mockData, {
          accessToken: 'access-token-A',
          sourcePath: path.join('stable', 'antigravity-oauth-token'),
        });

        const cachedA = readCache({
          accessToken: 'access-token-B',
          sourcePath: path.join('stable', 'antigravity-oauth-token'),
        });
        assert.deepEqual(cachedA, [{ ...mockData[0], windows: {} }]);

        const cachedB = readCache({
          accessToken: 'access-token-B',
          sourcePath: path.join('other', 'antigravity-oauth-token'),
        });
        assert.equal(cachedB, null);
      } finally {
        if (previousCache === null) fs.rmSync(CACHE_PATH, { force: true });
        else fs.writeFileSync(CACHE_PATH, previousCache);
      }
    });

    test('merges fresh response with previously cached other-window observations', () => {
      const { readCachePayload } = quotaModule;
      const previousCache = fs.existsSync(CACHE_PATH) ? fs.readFileSync(CACHE_PATH, 'utf8') : null;
      try {
        fs.rmSync(CACHE_PATH, { force: true });

        const fiveHourReset = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString();
        const fiveHourObservation = {
          remainingFraction: 0.6,
          resetTime: fiveHourReset,
          observedAt: Date.now() - 30 * 60 * 1000,
        };
        writeCache([
          {
            id: 'gemini-3-flash-agent',
            displayName: 'Gemini 3.5 Flash (High)',
            remainingFraction: 0.6,
            resetTime: fiveHourReset,
            window: 'fiveHour',
            windows: { fiveHour: fiveHourObservation },
          },
        ], 'token');

        const weeklyReset = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
        writeCache([
          {
            id: 'gemini-3-flash-agent',
            displayName: 'Gemini 3.5 Flash (High)',
            remainingFraction: 0.2,
            resetTime: weeklyReset,
            window: 'weekly',
            windows: { weekly: { remainingFraction: 0.2, resetTime: weeklyReset, observedAt: Date.now() } },
          },
        ], 'token');

        const payload = readCachePayload('token');
        assert.equal(payload.data.length, 1);
        const windows = payload.data[0].windows;
        assert.deepEqual(windows.fiveHour, fiveHourObservation);
        assert.equal(windows.weekly.remainingFraction, 0.2);
        assert.equal(windows.weekly.resetTime, weeklyReset);
      } finally {
        if (previousCache === null) fs.rmSync(CACHE_PATH, { force: true });
        else fs.writeFileSync(CACHE_PATH, previousCache);
      }
    });

    test('preserves previously cached tier when fresh tier is null and identity matches', () => {
      const { getCachedTier } = quotaModule;
      const previousCache = fs.existsSync(CACHE_PATH) ? fs.readFileSync(CACHE_PATH, 'utf8') : null;
      try {
        fs.rmSync(CACHE_PATH, { force: true });
        const futureReset = new Date(Date.now() + 60 * 60 * 1000).toISOString();
        const data = [{ id: 'm', remainingFraction: 0.5, resetTime: futureReset, windows: {} }];

        writeCache(data, 'tok', 'Google AI Pro');
        assert.equal(getCachedTier(), 'Google AI Pro');

        // Simulate fetchTierFromCloud transient failure (returns null) while quota
        // fetch succeeds. The cached tier must survive.
        writeCache(data, 'tok', null);
        assert.equal(getCachedTier(), 'Google AI Pro');
      } finally {
        if (previousCache === null) fs.rmSync(CACHE_PATH, { force: true });
        else fs.writeFileSync(CACHE_PATH, previousCache);
      }
    });

    test('drops the previous account quota/tier/email when the email changes (account switch)', () => {
      // Same token file (same sourcePath → same cacheKeyHash) but a different
      // account email — the contamination case: a switch must not merge the
      // prior account's window or preserve its tier.
      const previousCache = fs.existsSync(CACHE_PATH) ? fs.readFileSync(CACHE_PATH, 'utf8') : null;
      try {
        fs.rmSync(CACHE_PATH, { force: true });
        const reset = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString();
        const tokenA = { accessToken: 'access-A', sourcePath: '/p/antigravity-oauth-token' };
        const tokenAfterSwitch = { accessToken: 'access-B', sourcePath: '/p/antigravity-oauth-token' };

        writeCache([{
          id: 'm', remainingFraction: 0.9, resetTime: reset,
          windows: { fiveHour: { remainingFraction: 0.9, resetTime: reset, observedAt: Date.now() } },
        }], tokenA, 'Google AI Pro', 'a@gmail.com');

        // Switch to account B; tier fetch failed (null), only a weekly window.
        writeCache([{
          id: 'm', remainingFraction: 0.1, resetTime: reset,
          windows: { weekly: { remainingFraction: 0.1, resetTime: reset, observedAt: Date.now() } },
        }], tokenAfterSwitch, null, 'b@gmail.com');

        const raw = quotaModule.readCachePayload(tokenAfterSwitch);
        assert.equal(raw.accountEmail, 'b@gmail.com');
        assert.equal(raw.tier, null, 'must not preserve account A tier across a switch');
        assert.equal(raw.data[0].windows.fiveHour, undefined, "account A's window must not leak in");
        assert.ok(raw.data[0].windows.weekly, "account B's own window is kept");
      } finally {
        if (previousCache === null) fs.rmSync(CACHE_PATH, { force: true });
        else fs.writeFileSync(CACHE_PATH, previousCache);
      }
    });

    test('still preserves the other window and tier across a token rotation (same account)', () => {
      const previousCache = fs.existsSync(CACHE_PATH) ? fs.readFileSync(CACHE_PATH, 'utf8') : null;
      try {
        fs.rmSync(CACHE_PATH, { force: true });
        const reset = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString();
        const tokenA = { accessToken: 'access-A', sourcePath: '/p/antigravity-oauth-token' };
        const tokenRotated = { accessToken: 'access-A2', sourcePath: '/p/antigravity-oauth-token' };

        writeCache([{
          id: 'm', remainingFraction: 0.9, resetTime: reset,
          windows: { fiveHour: { remainingFraction: 0.9, resetTime: reset, observedAt: Date.now() } },
        }], tokenA, 'Google AI Pro', 'a@gmail.com');

        // Same account (same email), rotated access token, tier fetch null.
        writeCache([{
          id: 'm', remainingFraction: 0.1, resetTime: reset,
          windows: { weekly: { remainingFraction: 0.1, resetTime: reset, observedAt: Date.now() } },
        }], tokenRotated, null, 'a@gmail.com');

        const raw = quotaModule.readCachePayload(tokenRotated);
        assert.equal(raw.accountEmail, 'a@gmail.com');
        assert.equal(raw.tier, 'Google AI Pro', 'tier survives a rotation');
        assert.ok(raw.data[0].windows.fiveHour, 'prior window survives a rotation');
        assert.ok(raw.data[0].windows.weekly);
      } finally {
        if (previousCache === null) fs.rmSync(CACHE_PATH, { force: true });
        else fs.writeFileSync(CACHE_PATH, previousCache);
      }
    });

    test('expiresAt accounts for the soonest resetTime across merged windows', () => {
      const { readCachePayload } = quotaModule;
      const previousCache = fs.existsSync(CACHE_PATH) ? fs.readFileSync(CACHE_PATH, 'utf8') : null;
      try {
        fs.rmSync(CACHE_PATH, { force: true });
        const fiveHourReset = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // ~10min
        const weeklyReset = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString(); // 5d

        // Step 1: prime cache with a 5-hour observation that resets in 10 minutes.
        writeCache([{
          id: 'm', remainingFraction: 0.6, resetTime: fiveHourReset,
          windows: { fiveHour: { remainingFraction: 0.6, resetTime: fiveHourReset, observedAt: Date.now() } },
        }], 'tok');

        // Step 2: fresh response carries a weekly window only (resetTime 5 days out).
        writeCache([{
          id: 'm', remainingFraction: 0.2, resetTime: weeklyReset,
          windows: { weekly: { remainingFraction: 0.2, resetTime: weeklyReset, observedAt: Date.now() } },
        }], 'tok');

        const raw = readCachePayload('tok');
        // expiresAt must be capped to the 10-minute fiveHour reset, NOT the
        // 5-day weekly top-level — otherwise we'd serve a stale fiveHour past
        // its real reset time.
        const tenMinutesFromNow = Date.now() + 10 * 60 * 1000 + 5000;
        assert.ok(raw.expiresAt <= tenMinutesFromNow,
          `expiresAt ${new Date(raw.expiresAt).toISOString()} must be <= 10min from now, not the 5-day weekly reset`);
      } finally {
        if (previousCache === null) fs.rmSync(CACHE_PATH, { force: true });
        else fs.writeFileSync(CACHE_PATH, previousCache);
      }
    });

    test('writeCache limits fresh cache TTL to maximum 30 seconds even with long resetTime', () => {
      const previousCache = fs.existsSync(CACHE_PATH) ? fs.readFileSync(CACHE_PATH, 'utf8') : null;
      try {
        assert.equal(quotaModule.MAX_CACHE_FRESH_MS, 30 * 1000);
        const longResetTime = new Date(Date.now() + 3600 * 1000).toISOString(); // 1 hour later
        const mockData = [{ id: 'gemini-3.5-flash-low', remainingFraction: 0.5, resetTime: longResetTime }];

        writeCache(mockData, {
          accessToken: 'test-token',
        });

        const raw = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
        const maxAllowedExpiry = Date.now() + quotaModule.MAX_CACHE_FRESH_MS + 5000; // 30s + 5s buffer
        const minAllowedExpiry = Date.now() + quotaModule.MAX_CACHE_FRESH_MS - 5000;
        assert.ok(raw.expiresAt >= minAllowedExpiry && raw.expiresAt <= maxAllowedExpiry, `expiresAt ${raw.expiresAt} must be close to 30 seconds from now`);
      } finally {
        if (previousCache === null) fs.rmSync(CACHE_PATH, { force: true });
        else fs.writeFileSync(CACHE_PATH, previousCache);
      }
    });

    test('readCachePayload returns stale payload when token matches even if expired', () => {
      const { readCachePayload } = quotaModule;
      const previousCache = fs.existsSync(CACHE_PATH) ? fs.readFileSync(CACHE_PATH, 'utf8') : null;
      try {
        fs.rmSync(CACHE_PATH, { force: true });
        const data = [{ id: 'm', remainingFraction: 0.5, resetTime: null, windows: {} }];
        writeCache(data, 'tok');

        // Artificially expire the cache payload
        const rawOnDisk = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
        rawOnDisk.expiresAt = Date.now() - 10_000;
        rawOnDisk.providerQuota = {
          google: { weekly: { remainingFraction: 0.95, resetTime: '2026-09-10T00:00:00Z' } },
        };
        fs.writeFileSync(CACHE_PATH, JSON.stringify(rawOnDisk));

        // readCache requires fresh data -> must return null
        assert.equal(readCache('tok'), null);

        // readCachePayload is for SWR and token rotation checks -> must return payload even if stale
        const stalePayload = readCachePayload('tok');
        assert.ok(stalePayload, 'stale payload must not be null');
        assert.equal(stalePayload.data.providerQuota, stalePayload.providerQuota);
        assert.equal(stalePayload.data[0].id, 'm');
      } finally {
        if (previousCache === null) fs.rmSync(CACHE_PATH, { force: true });
        else fs.writeFileSync(CACHE_PATH, previousCache);
      }
    });

    test('writeCache preserves existing provider quota when new response omits a provider', () => {
      const { readCachePayload } = quotaModule;
      const previousCache = fs.existsSync(CACHE_PATH) ? fs.readFileSync(CACHE_PATH, 'utf8') : null;
      try {
        fs.rmSync(CACHE_PATH, { force: true });
        const futureReset = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
        const data = [{ id: 'm', remainingFraction: 0.5, resetTime: null, windows: {} }];
        const fullProviderQuota = {
          google: {
            fiveHour: { remainingFraction: 0.9, resetTime: futureReset },
            weekly: { remainingFraction: 0.9, resetTime: futureReset },
          },
          claude: { weekly: { remainingFraction: 0.8, resetTime: futureReset } },
        };
        writeCache(data, 'tok', null, null, fullProviderQuota);

        // Second write only carries google fiveHour (claude missing, google weekly omitted)
        const partialProviderQuota = {
          google: { fiveHour: { remainingFraction: 0.85, resetTime: futureReset } },
        };
        writeCache(data, 'tok', null, null, partialProviderQuota);

        const payload = readCachePayload('tok');
        assert.ok(payload);
        assert.equal(payload.providerQuota.google.fiveHour.remainingFraction, 0.85);
        assert.equal(payload.providerQuota.google.weekly.remainingFraction, 0.9, 'sibling window inside same provider must be preserved');
        assert.equal(payload.providerQuota.claude.weekly.remainingFraction, 0.8, 'claude provider quota must be preserved');
      } finally {
        if (previousCache === null) fs.rmSync(CACHE_PATH, { force: true });
        else fs.writeFileSync(CACHE_PATH, previousCache);
      }
    });

    test('writeCache drops expired providerQuota windows, sanitizes expired model resetTime, and bounds expiresAt by providerQuota', () => {
      const { readCachePayload } = quotaModule;
      const previousCache = fs.existsSync(CACHE_PATH) ? fs.readFileSync(CACHE_PATH, 'utf8') : null;
      try {
        fs.rmSync(CACHE_PATH, { force: true });
        const expiredReset = new Date(Date.now() - 60_000).toISOString();
        const soonReset = new Date(Date.now() + 10_000).toISOString();
        const farReset = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

        // Seed expired claude weekly + valid google fiveHour
        writeCache(
          [{ id: 'm', remainingFraction: 0.5, resetTime: farReset, windows: {} }],
          'tok-exp',
          null,
          null,
          {
            claude: { weekly: { remainingFraction: 0.2, resetTime: expiredReset } },
            google: { fiveHour: { remainingFraction: 0.6, resetTime: farReset } },
          },
        );

        // Model carries an expired top-level resetTime while live weekly window is in future; providerQuota bounds expiresAt to soonReset (<30s)
        writeCache(
          [
            {
              id: 'm',
              remainingFraction: 0.4,
              resetTime: expiredReset,
              windows: {
                fiveHour: { remainingFraction: 0.4, resetTime: expiredReset },
                weekly: { remainingFraction: 0.7, resetTime: farReset },
              },
            },
          ],
          'tok-exp',
          null,
          null,
          {
            argon: { fiveHour: { remainingFraction: 0.5, resetTime: soonReset } },
          },
        );

        const payload = readCachePayload('tok-exp');
        assert.ok(payload);
        assert.equal(payload.providerQuota.claude, undefined, 'expired cached providerQuota windows must be dropped');
        assert.equal(payload.providerQuota.google.fiveHour.remainingFraction, 0.6);
        assert.equal(payload.data[0].resetTime, farReset, 'expired top-level model resetTime must fall back to live window');
        assert.equal(payload.data[0].remainingFraction, 0.7);
        assert.ok(payload.expiresAt > Date.now(), 'expired top-level resetTime must not pull expiresAt into the past');
        assert.ok(payload.expiresAt <= Date.parse(soonReset) + 50, 'providerQuota sooner resetTime must bound expiresAt');
      } finally {
        if (previousCache === null) fs.rmSync(CACHE_PATH, { force: true });
        else fs.writeFileSync(CACHE_PATH, previousCache);
      }
    });

    test('writeCache drops previous account identity and quota when accessToken rotates without resolved email', () => {
      const { readCachePayload } = quotaModule;
      const previousCache = fs.existsSync(CACHE_PATH) ? fs.readFileSync(CACHE_PATH, 'utf8') : null;
      try {
        fs.rmSync(CACHE_PATH, { force: true });
        const farReset = new Date(Date.now() + 60 * 60 * 1000).toISOString();
        const sharedSource = path.join('stable', 'antigravity-shared-token');
        writeCache(
          [{ id: 'm', remainingFraction: 0.9, resetTime: farReset, windows: {} }],
          { accessToken: 'tok-acct-1', sourcePath: sharedSource, email: 'user1@example.com' },
          'Pro',
          'user1@example.com',
          { claude: { weekly: { remainingFraction: 0.9, resetTime: farReset } } },
        );

        // Access token rotated (e.g. account switched) and new token has no email claim yet
        writeCache(
          [{ id: 'm', remainingFraction: 0.3, resetTime: farReset, windows: {} }],
          { accessToken: 'tok-acct-2', sourcePath: sharedSource },
          null,
          null,
          { google: { weekly: { remainingFraction: 0.3, resetTime: farReset } } },
        );

        const payload = readCachePayload({ accessToken: 'tok-acct-2', sourcePath: sharedSource });
        assert.ok(payload);
        assert.equal(payload.accountEmail, null, 'must not inherit accountEmail after rotated token lacking email');
        assert.equal(payload.tier, null, 'must not inherit tier after rotated token lacking email');
        assert.equal(payload.providerQuota.claude, undefined, 'must not inherit previous account quota on unverified token rotation');
        assert.equal(payload.providerQuota.google.weekly.remainingFraction, 0.3);
      } finally {
        if (previousCache === null) fs.rmSync(CACHE_PATH, { force: true });
        else fs.writeFileSync(CACHE_PATH, previousCache);
      }
    });

    test('readCacheRaw and readCachePayload reject payloads with mismatched CACHE_VERSION', () => {
      const { readCachePayload, readCacheRaw, CACHE_VERSION } = quotaModule;
      const previousCache = fs.existsSync(CACHE_PATH) ? fs.readFileSync(CACHE_PATH, 'utf8') : null;
      try {
        fs.rmSync(CACHE_PATH, { force: true });
        writeCache([{ id: 'm', remainingFraction: 0.5, resetTime: null, windows: {} }], 'tok-ver');
        const wrongVer = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
        wrongVer.version = CACHE_VERSION - 1;
        fs.writeFileSync(CACHE_PATH, JSON.stringify(wrongVer));

        assert.equal(readCacheRaw(), null);
        assert.equal(readCachePayload('tok-ver'), null);
      } finally {
        if (previousCache === null) fs.rmSync(CACHE_PATH, { force: true });
        else fs.writeFileSync(CACHE_PATH, previousCache);
      }
    });
  });

  describe('getCachedAccountEmail', () => {
    const { getCachedAccountEmail } = quotaModule;

    test('returns the email only when the cache matches the current token', () => {
      const previousCache = fs.existsSync(CACHE_PATH) ? fs.readFileSync(CACHE_PATH, 'utf8') : null;
      try {
        fs.rmSync(CACHE_PATH, { force: true });
        const futureReset = new Date(Date.now() + 60 * 60 * 1000).toISOString();
        const data = [{ id: 'm', remainingFraction: 0.5, resetTime: futureReset, windows: {} }];

        writeCache(data, 'tok-A', 'Google AI Pro', 'a@gmail.com');
        // Same token → authoritative email surfaces.
        assert.equal(getCachedAccountEmail('tok-A'), 'a@gmail.com');
        // Different token (account switched) → no stale email, caller falls back.
        assert.equal(getCachedAccountEmail('tok-B'), null);
      } finally {
        if (previousCache === null) fs.rmSync(CACHE_PATH, { force: true });
        else fs.writeFileSync(CACHE_PATH, previousCache);
      }
    });

    test('preserves the cached email on a null refresh for the same identity', () => {
      const { getCachedAccountEmail } = quotaModule;
      const previousCache = fs.existsSync(CACHE_PATH) ? fs.readFileSync(CACHE_PATH, 'utf8') : null;
      try {
        fs.rmSync(CACHE_PATH, { force: true });
        const futureReset = new Date(Date.now() + 60 * 60 * 1000).toISOString();
        const data = [{ id: 'm', remainingFraction: 0.5, resetTime: futureReset, windows: {} }];

        writeCache(data, 'tok', 'Google AI Pro', 'a@gmail.com');
        // userinfo transient failure (email null) must not wipe a known email.
        writeCache(data, 'tok', null, null);
        assert.equal(getCachedAccountEmail('tok'), 'a@gmail.com');
      } finally {
        if (previousCache === null) fs.rmSync(CACHE_PATH, { force: true });
        else fs.writeFileSync(CACHE_PATH, previousCache);
      }
    });

    test('returns null when cache has no accountEmail field', () => {
      withCacheFile(JSON.stringify({ data: [], version: 3, tokenHash: 'x' }), () => {
        assert.equal(getCachedAccountEmail('tok'), null);
      });
    });
  });

  describe('getCachedTier', () => {
    test('returns tier string from cache file', () => {
      withCacheFile(JSON.stringify({ tier: 'Google AI Pro', data: [], version: 3 }), () => {
        assert.equal(getCachedTier(), 'Google AI Pro');
      });
    });

    test('returns null when cache has no tier field', () => {
      withCacheFile(JSON.stringify({ data: [], version: 3 }), () => {
        assert.equal(getCachedTier(), null);
      });
    });

    test('returns null when cache file does not exist', () => {
      withCacheFile(null, () => {
        assert.equal(getCachedTier(), null);
      });
    });

    test('returns null when cache file has invalid JSON', () => {
      withCacheFile('not json {{{', () => {
        assert.equal(getCachedTier(), null);
      });
    });
  });

  describe('readCacheLastRefreshed', () => {
    test('returns timestamp from cache regardless of token', () => {
      const previousCache = fs.existsSync(CACHE_PATH) ? fs.readFileSync(CACHE_PATH, 'utf8') : null;
      try {
        const ts = Date.now() - 10000;
        fs.writeFileSync(CACHE_PATH, JSON.stringify({ version: 3, lastRefreshed: ts, data: [] }), { mode: 0o600 });
        assert.equal(readCacheLastRefreshed(), ts);

        fs.rmSync(CACHE_PATH, { force: true });
        assert.equal(readCacheLastRefreshed(), 0);
      } finally {
        if (previousCache === null) fs.rmSync(CACHE_PATH, { force: true });
        else fs.writeFileSync(CACHE_PATH, previousCache);
      }
    });
  });

  describe('readCacheFallback', () => {
    test('returns payload without token matching', () => {
      const previousCache = fs.existsSync(CACHE_PATH) ? fs.readFileSync(CACHE_PATH, 'utf8') : null;
      try {
        const payload = {
          version: 3,
          expiresAt: Date.now() + 60000,
          lastRefreshed: Date.now(),
          cacheKeyHash: 'any',
          tokenHash: 'any',
          data: [{ id: 'test', remainingFraction: 0.8 }],
        };
        fs.writeFileSync(CACHE_PATH, JSON.stringify(payload), { mode: 0o600 });
        const result = readCacheFallback();
        assert.deepEqual(result.data, payload.data);

        fs.writeFileSync(CACHE_PATH, 'corrupt{{{', { mode: 0o600 });
        assert.equal(readCacheFallback(), null);

        fs.rmSync(CACHE_PATH, { force: true });
        assert.equal(readCacheFallback(), null);
      } finally {
        if (previousCache === null) fs.rmSync(CACHE_PATH, { force: true });
        else fs.writeFileSync(CACHE_PATH, previousCache);
      }
    });

    test('attaches providerQuota to result.data when present in raw payload', () => {
      const previousCache = fs.existsSync(CACHE_PATH) ? fs.readFileSync(CACHE_PATH, 'utf8') : null;
      try {
        const payload = {
          version: 3,
          expiresAt: Date.now() + 60000,
          lastRefreshed: Date.now(),
          cacheKeyHash: 'any',
          tokenHash: 'any',
          providerQuota: {
            google: { weekly: { remainingFraction: 0.85, resetTime: '2026-09-10T00:00:00Z' } },
          },
          data: [{ id: 'test', remainingFraction: 0.8 }],
        };
        fs.writeFileSync(CACHE_PATH, JSON.stringify(payload), { mode: 0o600 });
        const result = readCacheFallback();
        assert.ok(result);
        assert.deepEqual(result.data.providerQuota, payload.providerQuota);
      } finally {
        if (previousCache === null) fs.rmSync(CACHE_PATH, { force: true });
        else fs.writeFileSync(CACHE_PATH, previousCache);
      }
    });
  });
});
