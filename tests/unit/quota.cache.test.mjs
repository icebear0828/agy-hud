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
        const mockData = [{ id: 'gemini-3.5-flash-low', displayName: 'Gemini 3.5 Flash (Medium)', remainingFraction: 0.5, resetTime: null }];

        writeCache(mockData, {
          accessToken: 'access-token-A',
          sourcePath: path.join('stable', 'antigravity-oauth-token'),
        });

        const cachedA = readCache({
          accessToken: 'access-token-B',
          sourcePath: path.join('stable', 'antigravity-oauth-token'),
        });
        assert.deepEqual(cachedA, mockData);

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

    test('writeCache limits fresh cache TTL to maximum 2 minutes even with long resetTime', () => {
      const previousCache = fs.existsSync(CACHE_PATH) ? fs.readFileSync(CACHE_PATH, 'utf8') : null;
      try {
        const longResetTime = new Date(Date.now() + 3600 * 1000).toISOString(); // 1 hour later
        const mockData = [{ id: 'gemini-3.5-flash-low', remainingFraction: 0.5, resetTime: longResetTime }];

        writeCache(mockData, {
          accessToken: 'test-token',
        });

        const raw = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
        const maxAllowedExpiry = Date.now() + 2 * 60 * 1000 + 5000; // 2m + 5s buffer
        const minAllowedExpiry = Date.now() + 2 * 60 * 1000 - 5000;
        assert.ok(raw.expiresAt >= minAllowedExpiry && raw.expiresAt <= maxAllowedExpiry, `expiresAt ${raw.expiresAt} must be close to 2 minutes from now`);
      } finally {
        if (previousCache === null) fs.rmSync(CACHE_PATH, { force: true });
        else fs.writeFileSync(CACHE_PATH, previousCache);
      }
    });
  });

  describe('getCachedTier', () => {
    test('returns tier string from cache file', () => {
      withCacheFile(JSON.stringify({ tier: 'Google AI Pro', data: [], version: 2 }), () => {
        assert.equal(getCachedTier(), 'Google AI Pro');
      });
    });

    test('returns null when cache has no tier field', () => {
      withCacheFile(JSON.stringify({ data: [], version: 2 }), () => {
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
        fs.writeFileSync(CACHE_PATH, JSON.stringify({ version: 2, lastRefreshed: ts, data: [] }), { mode: 0o600 });
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
          version: 2,
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
  });
});
