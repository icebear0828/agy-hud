import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { quotaModule, CACHE_PATH } from './_helpers/quota-test-utils.mjs';

const { getQuota, refreshQuotaCache, REFRESH_LOCK_PATH, createUnavailableQuotaResult } = quotaModule;

describe('quota / getQuota orchestrator', () => {
  beforeEach(() => {
    fs.rmSync(REFRESH_LOCK_PATH, { force: true });
  });

  afterEach(() => {
    fs.rmSync(REFRESH_LOCK_PATH, { force: true });
  });
  describe('fast path with cache', () => {
    test('returns cached quota without background refresh', async () => {
      const previousCache = fs.existsSync(CACHE_PATH) ? fs.readFileSync(CACHE_PATH, 'utf8') : null;
      try {
        fs.rmSync(CACHE_PATH, { force: true });
        const cachedQuota = [{
          id: 'gemini-3-flash-agent',
          displayName: 'Gemini 3.5 Flash (High)',
          remainingFraction: 0.42,
          resetTime: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        }];
        quotaModule.writeCache(cachedQuota, 'cached-token');

        let refreshes = 0;
        const quota = await getQuota({
          fast: true,
          tokenReader: () => ({ accessToken: 'cached-token' }),
          backgroundRefresh: () => { refreshes += 1; },
        });

        assert.deepEqual(quota, [{ ...cachedQuota[0], windows: {} }]);
        assert.equal(refreshes, 0);
      } finally {
        if (previousCache === null) fs.rmSync(CACHE_PATH, { force: true });
        else fs.writeFileSync(CACHE_PATH, previousCache);
      }
    });

    test('preserves fresh cache when the access token rotates', async () => {
      const previousCache = fs.existsSync(CACHE_PATH) ? fs.readFileSync(CACHE_PATH, 'utf8') : null;
      try {
        fs.rmSync(CACHE_PATH, { force: true });
        const tokenSourcePath = path.join('same-user', 'antigravity-oauth-token');
        const cachedQuota = [{
          id: 'gemini-3-flash-agent',
          displayName: 'Gemini 3.5 Flash (High)',
          remainingFraction: 0.77,
          resetTime: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        }];
        quotaModule.writeCache(cachedQuota, {
          accessToken: 'old-access-token',
          sourcePath: tokenSourcePath,
        });

        let refreshes = 0;
        const quota = await getQuota({
          fast: true,
          tokenReader: () => ({
            accessToken: 'new-access-token',
            sourcePath: tokenSourcePath,
          }),
          backgroundRefresh: () => { refreshes += 1; },
        });

        assert.deepEqual(quota, [{ ...cachedQuota[0], windows: {} }]);
        assert.equal(refreshes, 1);
      } finally {
        if (previousCache === null) fs.rmSync(CACHE_PATH, { force: true });
        else fs.writeFileSync(CACHE_PATH, previousCache);
      }
    });

    test('starts background refresh when no cache exists', async () => {
      const previousCache = fs.existsSync(CACHE_PATH) ? fs.readFileSync(CACHE_PATH, 'utf8') : null;
      try {
        fs.rmSync(CACHE_PATH, { force: true });
        let refreshes = 0;

        const quota = await getQuota({
          fast: true,
          tokenReader: () => ({ accessToken: 'uncached-token' }),
          backgroundRefresh: () => { refreshes += 1; },
        });

        assert.deepEqual(quota, []);
        assert.equal(refreshes, 1);
      } finally {
        if (previousCache !== null) fs.writeFileSync(CACHE_PATH, previousCache);
        else fs.rmSync(CACHE_PATH, { force: true });
      }
    });
  });

  describe('expired tokens', () => {
    test('reports expired tokens without spawning quota refresh', async () => {
      const previousCache = fs.existsSync(CACHE_PATH) ? fs.readFileSync(CACHE_PATH, 'utf8') : null;
      try {
        fs.rmSync(CACHE_PATH, { force: true });
        let refreshes = 0;

        const quota = await getQuota({
          fast: true,
          platform: 'linux',
          tokenReader: () => ({
            accessToken: 'expired-token',
            expiry: '2000-01-01T00:00:00.000Z',
            sourcePath: path.join('expired', 'oauth_creds.json'),
          }),
          backgroundRefresh: () => { refreshes += 1; },
        });

        assert.equal(quota.length, 0);
        assert.equal(quota.unavailableReason, 'expired_token');
        assert.equal(refreshes, 0);
      } finally {
        if (previousCache !== null) fs.writeFileSync(CACHE_PATH, previousCache);
        else fs.rmSync(CACHE_PATH, { force: true });
      }
    });

    test('reports expired_token when token is expired, even if fallback cache exists', async () => {
      const previousCache = fs.existsSync(CACHE_PATH) ? fs.readFileSync(CACHE_PATH, 'utf8') : null;
      try {
        const payload = {
          version: 3,
          expiresAt: Date.now() + 60000,
          lastRefreshed: Date.now() - 50000,
          cacheKeyHash: 'token-A-hash',
          tokenHash: 'token-A-hash',
          data: [{ id: 'gemini-3-flash-agent', remainingFraction: 0.77 }],
        };
        fs.writeFileSync(CACHE_PATH, JSON.stringify(payload), { mode: 0o600 });

        const result = await getQuota({
          fast: true,
          tokenReader: () => ({
            accessToken: 'token-B',
            sourcePath: '/token/B',
            expiry: new Date(Date.now() - 10000).toISOString(), // expired 10s ago
          }),
          backgroundRefresh: () => {},
        });

        assert.equal(result.unavailableReason, 'expired_token');
        assert.equal(result.length, 0);
      } finally {
        if (previousCache === null) fs.rmSync(CACHE_PATH, { force: true });
        else fs.writeFileSync(CACHE_PATH, previousCache);
      }
    });
  });

  describe('Windows Credential Manager refresh', () => {
    test('fast path wakes credential refresh when no token is visible', async () => {
      const previousCache = fs.existsSync(CACHE_PATH) ? fs.readFileSync(CACHE_PATH, 'utf8') : null;
      try {
        fs.rmSync(CACHE_PATH, { force: true });
        let refreshes = 0;

        const quota = await getQuota({
          fast: true,
          platform: 'win32',
          tokenReader: () => null,
          backgroundRefresh: () => { refreshes += 1; },
          windowsCredentialRefreshDebounceMs: 0,
        });

        assert.equal(quota.length, 0);
        assert.equal(quota.unavailableReason, 'not_logged_in');
        assert.equal(refreshes, 1);
      } finally {
        if (previousCache !== null) fs.writeFileSync(CACHE_PATH, previousCache);
        else fs.rmSync(CACHE_PATH, { force: true });
      }
    });

    test('fast path wakes credential refresh when file token is expired', async () => {
      const previousCache = fs.existsSync(CACHE_PATH) ? fs.readFileSync(CACHE_PATH, 'utf8') : null;
      try {
        fs.rmSync(CACHE_PATH, { force: true });
        let refreshes = 0;

        const quota = await getQuota({
          fast: true,
          platform: 'win32',
          tokenReader: () => ({
            accessToken: 'expired-file-token',
            expiry: '2000-01-01T00:00:00.000Z',
            sourcePath: path.join('expired', 'oauth_creds.json'),
          }),
          backgroundRefresh: () => { refreshes += 1; },
          windowsCredentialRefreshDebounceMs: 0,
        });

        assert.equal(quota.length, 0);
        assert.equal(quota.unavailableReason, 'expired_token');
        assert.equal(refreshes, 1);
      } finally {
        if (previousCache !== null) fs.writeFileSync(CACHE_PATH, previousCache);
        else fs.rmSync(CACHE_PATH, { force: true });
      }
    });
  });

  describe('token-null fallback to fresh cache (with file-existence check)', () => {
    test('returns fresh cache when token file exists but is temporarily unreadable', async () => {
      const previousCache = fs.existsSync(CACHE_PATH) ? fs.readFileSync(CACHE_PATH, 'utf8') : null;
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-token-transient-'));
      try {
        const tokenDir = path.join(tmp, 'antigravity-cli');
        fs.mkdirSync(tokenDir, { recursive: true });
        // Token file exists but contains garbage (simulates mid-write)
        fs.writeFileSync(path.join(tokenDir, 'antigravity-oauth-token'), '{corrupt');

        const cachedQuota = [{
          id: 'gemini-3-flash-agent',
          displayName: 'Gemini 3.5 Flash (High)',
          remainingFraction: 0.55,
          resetTime: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        }];
        quotaModule.writeCache(cachedQuota, 'some-token');

        const quota = await getQuota({
          fast: true,
          tokenReader: () => null,
          backgroundRefresh: () => {},
          roots: [tokenDir],
        });

        assert.deepEqual(quota, [{ ...cachedQuota[0], windows: {} }]);
      } finally {
        if (previousCache === null) fs.rmSync(CACHE_PATH, { force: true });
        else fs.writeFileSync(CACHE_PATH, previousCache);
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    test('reports not_logged_in when genuinely logged out despite fresh cache', async () => {
      const previousCache = fs.existsSync(CACHE_PATH) ? fs.readFileSync(CACHE_PATH, 'utf8') : null;
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-no-token-'));
      try {
        // Empty root — no token file exists at all
        const emptyDir = path.join(tmp, 'antigravity-cli');
        fs.mkdirSync(emptyDir, { recursive: true });

        const freshPayload = {
          version: 3,
          expiresAt: Date.now() + 60_000,
          lastRefreshed: Date.now(),
          cacheKeyHash: 'abc',
          tokenHash: 'def',
          data: [{ id: 'test', remainingFraction: 0.5, resetTime: null }],
        };
        fs.writeFileSync(CACHE_PATH, JSON.stringify(freshPayload), { mode: 0o600 });

        const quota = await getQuota({
          fast: true,
          tokenReader: () => null,
          backgroundRefresh: () => {},
          roots: [emptyDir],
        });

        assert.equal(quota.length, 0);
        assert.equal(quota.unavailableReason, 'not_logged_in');
      } finally {
        if (previousCache === null) fs.rmSync(CACHE_PATH, { force: true });
        else fs.writeFileSync(CACHE_PATH, previousCache);
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    test('reports not_logged_in when token is null and cache is expired', async () => {
      const previousCache = fs.existsSync(CACHE_PATH) ? fs.readFileSync(CACHE_PATH, 'utf8') : null;
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-expired-'));
      try {
        const tokenDir = path.join(tmp, 'antigravity-cli');
        fs.mkdirSync(tokenDir, { recursive: true });
        fs.writeFileSync(path.join(tokenDir, 'antigravity-oauth-token'), '{corrupt');

        const expiredPayload = {
          version: 3,
          expiresAt: Date.now() - 1000,
          lastRefreshed: Date.now() - 600_000,
          cacheKeyHash: 'abc',
          tokenHash: 'def',
          data: [{ id: 'test', remainingFraction: 0.5 }],
        };
        fs.writeFileSync(CACHE_PATH, JSON.stringify(expiredPayload), { mode: 0o600 });

        const quota = await getQuota({
          fast: true,
          tokenReader: () => null,
          backgroundRefresh: () => {},
          roots: [tokenDir],
        });

        assert.equal(quota.length, 0);
        assert.equal(quota.unavailableReason, 'not_logged_in');
      } finally {
        if (previousCache === null) fs.rmSync(CACHE_PATH, { force: true });
        else fs.writeFileSync(CACHE_PATH, previousCache);
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  });

  describe('refresh dedup', () => {
    test('debounces background refresh using cache lastRefreshed even without token match', async () => {
      const previousCache = fs.existsSync(CACHE_PATH) ? fs.readFileSync(CACHE_PATH, 'utf8') : null;
      try {
        const recentPayload = {
          version: 3,
          expiresAt: Date.now() - 1000,
          lastRefreshed: Date.now() - 5000,
          cacheKeyHash: 'different-user',
          tokenHash: 'different-token',
          data: [{ id: 'test', remainingFraction: 0.5, resetTime: null }],
        };
        fs.writeFileSync(CACHE_PATH, JSON.stringify(recentPayload), { mode: 0o600 });

        let refreshes = 0;
        await getQuota({
          fast: true,
          tokenReader: () => ({ accessToken: 'new-unmatched-token', sourcePath: '/new/path' }),
          backgroundRefresh: () => { refreshes += 1; },
        });

        assert.equal(refreshes, 0, 'should not refresh when cache was recently refreshed');
      } finally {
        if (previousCache === null) fs.rmSync(CACHE_PATH, { force: true });
        else fs.writeFileSync(CACHE_PATH, previousCache);
      }
    });

    test('falls back to readCacheFallback and returns data when token is unmatched', async () => {
      const previousCache = fs.existsSync(CACHE_PATH) ? fs.readFileSync(CACHE_PATH, 'utf8') : null;
      try {
        const payload = {
          version: 3,
          expiresAt: Date.now() + 60000,
          lastRefreshed: Date.now() - 50000,
          cacheKeyHash: 'token-A-hash',
          tokenHash: 'token-A-hash',
          data: [{ id: 'gemini-3-flash-agent', remainingFraction: 0.77 }],
        };
        fs.writeFileSync(CACHE_PATH, JSON.stringify(payload), { mode: 0o600 });

        let refreshes = 0;
        const result = await getQuota({
          fast: true,
          tokenReader: () => ({ accessToken: 'token-B', sourcePath: '/token/B' }),
          backgroundRefresh: () => { refreshes += 1; },
        });

        assert.equal(refreshes, 1, 'should trigger background refresh due to token rotation');
        assert.deepEqual(result, payload.data, 'should fall back and return the cached data to avoid Quota loading flicker');
      } finally {
        if (previousCache === null) fs.rmSync(CACHE_PATH, { force: true });
        else fs.writeFileSync(CACHE_PATH, previousCache);
      }
    });

    test('prevents refresh storms via on-disk lock across repeated rotated-token or failed-refresh calls', async () => {
      const previousCache = fs.existsSync(CACHE_PATH) ? fs.readFileSync(CACHE_PATH, 'utf8') : null;
      try {
        fs.rmSync(CACHE_PATH, { force: true });
        const tokenSourcePath = path.join('storm-user', 'antigravity-oauth-token');
        const cachedQuota = [{
          id: 'gemini-3-flash-agent',
          displayName: 'Gemini 3.5 Flash (High)',
          remainingFraction: 0.77,
          resetTime: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        }];
        quotaModule.writeCache(cachedQuota, {
          accessToken: 'old-access-token',
          sourcePath: tokenSourcePath,
        });

        let refreshes = 0;
        const baseNow = Date.now();
        await getQuota({
          fast: true,
          now: baseNow,
          tokenReader: () => ({ accessToken: 'rotated-access-token', sourcePath: tokenSourcePath }),
          backgroundRefresh: () => { refreshes += 1; },
        });
        await getQuota({
          fast: true,
          now: baseNow + 2000,
          tokenReader: () => ({ accessToken: 'rotated-access-token', sourcePath: tokenSourcePath }),
          backgroundRefresh: () => { refreshes += 1; },
        });
        assert.equal(refreshes, 1, 'second call within 30s TTL must be debounced by on-disk lock');
      } finally {
        if (previousCache === null) fs.rmSync(CACHE_PATH, { force: true });
        else fs.writeFileSync(CACHE_PATH, previousCache);
      }
    });

    test('returns expired_token (and triggers win32 refresh) when token is expired and matching cache is stale', async () => {
      const previousCache = fs.existsSync(CACHE_PATH) ? fs.readFileSync(CACHE_PATH, 'utf8') : null;
      try {
        fs.rmSync(CACHE_PATH, { force: true });
        const tok = {
          accessToken: 'stale-matching-token',
          sourcePath: path.join('expired-match', 'oauth_creds.json'),
          expiry: '2000-01-01T00:00:00.000Z',
        };
        quotaModule.writeCache(
          [{ id: 'gemini-3-flash-agent', remainingFraction: 0.5, resetTime: null }],
          tok
        );
        // Expire the matching cache on disk
        const raw = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
        raw.expiresAt = Date.now() - 60_000;
        fs.writeFileSync(CACHE_PATH, JSON.stringify(raw), { mode: 0o600 });

        let refreshes = 0;
        const result = await getQuota({
          fast: true,
          platform: 'win32',
          tokenReader: () => tok,
          backgroundRefresh: () => { refreshes += 1; },
          windowsCredentialRefreshDebounceMs: 0,
        });

        assert.equal(result.unavailableReason, 'expired_token');
        assert.equal(result.length, 0);
        assert.equal(refreshes, 1, 'must fall through to refreshWindowsCredential when tokenExpired && !isFresh');
      } finally {
        if (previousCache === null) fs.rmSync(CACHE_PATH, { force: true });
        else fs.writeFileSync(CACHE_PATH, previousCache);
      }
    });

    test('fast: true skips credentialReader on win32 and keyringReader on linux, and supports preloadedToken', async () => {
      const previousCache = fs.existsSync(CACHE_PATH) ? fs.readFileSync(CACHE_PATH, 'utf8') : null;
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-fast-skip-'));
      try {
        fs.rmSync(CACHE_PATH, { force: true });
        const emptyRoot = path.join(tmp, 'antigravity-cli');
        fs.mkdirSync(emptyRoot, { recursive: true });

        let credCalls = 0;
        let keyringCalls = 0;
        let readerCalls = 0;

        await getQuota({
          fast: true,
          platform: 'win32',
          roots: [emptyRoot],
          credentialReader: () => { credCalls += 1; return null; },
          backgroundRefresh: () => {},
        });
        fs.rmSync(REFRESH_LOCK_PATH, { force: true });
        let linuxRefreshes = 0;
        await getQuota({
          fast: true,
          platform: 'linux',
          roots: [emptyRoot],
          keyringReader: () => { keyringCalls += 1; return null; },
          backgroundRefresh: () => { linuxRefreshes += 1; },
        });
        await getQuota({
          fast: true,
          preloadedToken: null,
          roots: [emptyRoot],
          tokenReader: () => { readerCalls += 1; return null; },
          backgroundRefresh: () => {},
        });

        assert.equal(credCalls, 0, 'fast: true must never invoke Windows credentialReader');
        assert.equal(keyringCalls, 0, 'fast: true must never invoke Linux keyringReader');
        assert.equal(linuxRefreshes, 1, 'fast: true on linux should delegate missing token to background refresh');
        assert.equal(readerCalls, 0, 'preloadedToken must skip tokenReader');
      } finally {
        if (previousCache === null) fs.rmSync(CACHE_PATH, { force: true });
        else fs.writeFileSync(CACHE_PATH, previousCache);
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  });

  describe('refreshQuotaCache (--refresh)', () => {
    test('does NOT call writeCache when fetchQuotaFromCloud fails (quota_fetch_failed) even if accountEmail succeeds', async () => {
      let writeCalls = 0;
      const ok = await refreshQuotaCache({
        readTokenFn: () => ({ accessToken: 'live-tok' }),
        fetchQuotaFn: async () => createUnavailableQuotaResult('quota_fetch_failed'),
        fetchTierFn: async () => 'Google AI Pro',
        fetchEmailFn: async () => 'a@b.com',
        writeCacheFn: () => { writeCalls += 1; },
        clearTokenTempFn: () => {},
      });

      assert.equal(ok, false);
      assert.equal(writeCalls, 0, 'must NOT overwrite cache on quota_fetch_failed');
    });

    test('clears temp token only after all candidate tokens fail with auth_failed', async () => {
      let cleared = 0;
      let writtenToken = null;
      const ok = await refreshQuotaCache({
        readTokenFn: () => ({
          accessToken: 'bad-tok',
          all: [{ accessToken: 'bad-tok' }, { accessToken: 'good-tok' }],
        }),
        fetchQuotaFn: async (tok) => (
          tok === 'bad-tok'
            ? createUnavailableQuotaResult('auth_failed')
            : [{ id: 'gemini-3-flash-agent', remainingFraction: 0.9 }]
        ),
        fetchTierFn: async () => 'Google AI Pro',
        fetchEmailFn: async () => 'good@example.com',
        writeCacheFn: (_data, tok) => { writtenToken = tok.accessToken; },
        clearTokenTempFn: () => { cleared += 1; },
      });

      assert.equal(ok, true);
      assert.equal(writtenToken, 'good-tok');
      assert.equal(cleared, 0);
    });
  });
});
