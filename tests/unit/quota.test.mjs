import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import quotaModule from '../../runtime/quota.js';

const { CACHE_PATH } = quotaModule;
try {
  fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
} catch {}

const {
  getQuota,
  getCachedTier,
  fetchQuotaFromCloud,
  fetchTierFromCloud,
  extractTierName,
  normalizeQuotaModels,
  classifyQuotaWindow,
  mergeQuotaWindows,
  pickCriticalWindow,
  discoverAgentModelIds,
  resolveDeprecatedIds,
  isCachePayloadFresh,
  createUnavailableQuotaResult,
  selectUsableTokens,
  isTokenExpired,
  parseTokenPayload,
  readToken
} = quotaModule;

function withEnv(overrides, fn) {
  const snapshot = {};
  for (const key of Object.keys(overrides)) {
    snapshot[key] = process.env[key];
    if (overrides[key] === undefined) delete process.env[key];
    else process.env[key] = overrides[key];
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(snapshot)) {
      if (snapshot[key] === undefined) delete process.env[key];
      else process.env[key] = snapshot[key];
    }
  }
}

test('normalizeQuotaModels treats quota buckets with resetTime but without remainingFraction as depleted (0) and others as unlimited (1)', () => {
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

test('selectUsableTokens keeps Windows temp tokens until token expiry', () => {
  const now = Date.parse('2026-05-20T20:00:00Z');
  const oldWrittenAt = now - 60 * 60 * 1000;

  const tokens = selectUsableTokens([
    { accessToken: 'valid-with-expiry', expiry: '2026-05-20T20:10:00Z' },
    { accessToken: 'nearly-expired', expiry: '2026-05-20T20:00:30Z' },
    { accessToken: 'no-expiry-old-cache' },
    { accessToken: 'no-expiry-fresh-cache' },
  ], oldWrittenAt, now);

  assert.deepEqual(tokens.map(t => t.accessToken), ['valid-with-expiry']);

  const freshNoExpiry = selectUsableTokens([
    { accessToken: 'no-expiry-fresh-cache' },
  ], now - 1000, now);
  assert.deepEqual(freshNoExpiry.map(t => t.accessToken), ['no-expiry-fresh-cache']);
});

test('isTokenExpired detects expired file tokens with expiry skew', () => {
  const now = Date.parse('2026-05-21T20:00:00Z');

  assert.equal(
    isTokenExpired({ accessToken: 'old-token', expiry: '2026-05-21T19:59:30Z' }, now),
    true
  );
  assert.equal(
    isTokenExpired({ accessToken: 'fresh-token', expiry: '2026-05-21T20:05:00Z' }, now),
    false
  );
  assert.equal(
    isTokenExpired({ accessToken: 'no-expiry-token' }, now),
    false
  );
});

test('parseTokenPayload supports antigravity-cli and oauth_creds token shapes', () => {
  assert.deepEqual(
    parseTokenPayload({
      token: {
        access_token: 'cli-token',
        expiry: '2026-05-20T20:10:00Z'
      }
    }),
    {
      accessToken: 'cli-token',
      expiry: '2026-05-20T20:10:00Z',
      sourceFormat: 'antigravity-cli'
    }
  );

  assert.deepEqual(
    parseTokenPayload({
      access_token: 'oauth-creds-token',
      expiry_date: Date.parse('2026-05-20T12:10:00Z')
    }),
    {
      accessToken: 'oauth-creds-token',
      expiry: '2026-05-20T12:10:00.000Z',
      sourceFormat: 'oauth-creds'
    }
  );
});

test('readToken only accepts Antigravity token files from configured data roots', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-token-roots-'));
  try {
    const home = path.join(tmp, 'home');
    const xdg = path.join(tmp, 'xdg');
    fs.mkdirSync(path.join(home, '.gemini'), { recursive: true });
    fs.mkdirSync(path.join(xdg, 'antigravity-cli'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.gemini', 'jetski-standalone-oauth-token'),
      JSON.stringify({ access_token: 'legacy-token' })
    );
    const antigravityTokenPath = path.join(xdg, 'antigravity-cli', 'antigravity-oauth-token');
    fs.writeFileSync(
      antigravityTokenPath,
      JSON.stringify({ token: { access_token: 'antigravity-token' } })
    );

    withEnv({
      HOME: home,
      USERPROFILE: home,
      XDG_DATA_HOME: xdg,
      APPDATA: undefined,
      LOCALAPPDATA: undefined,
    }, () => {
      assert.equal(readToken({ platform: 'linux' }).accessToken, 'antigravity-token');

      fs.rmSync(antigravityTokenPath);
      assert.equal(readToken({ platform: 'linux' }), null);
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('readToken falls back to ~/.gemini/oauth_creds.json when antigravity-cli token is missing', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-oauth-creds-'));
  try {
    const home = path.join(tmp, 'home');
    fs.mkdirSync(path.join(home, '.gemini'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.gemini', 'oauth_creds.json'),
      JSON.stringify({
        access_token: 'oauth-creds-token',
        expiry_date: Date.parse('2026-05-20T12:10:00Z'),
        refresh_token: 'refresh-token'
      })
    );

    withEnv({
      HOME: home,
      USERPROFILE: home,
      XDG_DATA_HOME: undefined,
      APPDATA: undefined,
      LOCALAPPDATA: undefined,
    }, () => {
      const token = readToken({ platform: 'linux' });
      assert.equal(token.accessToken, 'oauth-creds-token');
      assert.equal(token.sourceFormat, 'oauth-creds');
      assert.equal(token.sourcePath.endsWith(path.join('.gemini', 'oauth_creds.json')), true);
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('readToken can skip Windows Credential Manager for statusline fast path', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-token-fast-'));
  try {
    const home = path.join(tmp, 'home');
    fs.mkdirSync(path.join(home, '.gemini'), { recursive: true });

    withEnv({
      HOME: home,
      USERPROFILE: home,
      XDG_DATA_HOME: undefined,
      APPDATA: undefined,
      LOCALAPPDATA: undefined,
    }, () => {
      assert.equal(readToken({ platform: 'win32', skipWindowsCredential: true }), null);
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('readToken can read Windows Credential Manager when the fast path is not requested', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-token-credential-'));
  try {
    const home = path.join(tmp, 'home');
    fs.mkdirSync(path.join(home, '.gemini'), { recursive: true });
    let credentialReads = 0;

    withEnv({
      HOME: home,
      USERPROFILE: home,
      XDG_DATA_HOME: undefined,
      APPDATA: undefined,
      LOCALAPPDATA: undefined,
    }, () => {
      const token = readToken({
        platform: 'win32',
        credentialReader: () => {
          credentialReads += 1;
          return { accessToken: 'credential-token' };
        },
      });

      assert.equal(token.accessToken, 'credential-token');
      assert.equal(credentialReads, 1);
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('getQuota fast path returns cached quota without background refresh', async () => {
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

test('getQuota fast path preserves fresh cache when the access token rotates', async () => {
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

test('getQuota fast path starts background refresh when no cache exists', async () => {
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

test('getQuota reports expired tokens without spawning quota refresh', async () => {
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

test('getQuota fast path wakes Windows Credential Manager refresh when no token is visible', async () => {
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

test('getQuota fast path wakes Windows Credential Manager refresh when file token is expired', async () => {
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

test('fetchQuotaFromCloud passes AbortSignal to fetch and handles timeout aborts', async () => {
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


test('readCache / writeCache reuses stable token source across access token refreshes', () => {
  const { readCache, writeCache } = quotaModule;
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

test('writeCache limits fresh cache TTL to maximum 2 minutes even with long resetTime', () => {
  const { writeCache } = quotaModule;
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


test('fetchQuotaFromCloud respects AGY_HUD_ENDPOINTS and AGY_HUD_INTERESTING_MODELS env overrides', async () => {
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

    // Should fetch from the custom endpoint
    assert.ok(requestedUrls.length > 0);
    assert.ok(requestedUrls[0].startsWith('https://custom-endpoint.com'));
    
    // Should filter only interesting models specified in env var
    assert.equal(quotas.length, 1);
    assert.equal(quotas[0].id, 'custom-model-id-1');
    assert.equal(quotas[0].remainingFraction, 0.8);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.AGY_HUD_ENDPOINTS;
    delete process.env.AGY_HUD_INTERESTING_MODELS;
  }
});

// --- extractTierName ---

test('extractTierName returns paidTier.name when present', () => {
  assert.equal(
    extractTierName({ paidTier: { name: 'Google AI Pro' }, allowedTiers: [{ id: 'free-tier', name: 'Free' }] }),
    'Google AI Pro'
  );
});

test('extractTierName returns first non-free allowedTier name when no paidTier', () => {
  assert.equal(
    extractTierName({ allowedTiers: [{ id: 'free-tier', name: 'Free' }, { id: 'pro-tier', name: 'Pro' }] }),
    'Pro'
  );
});

test('extractTierName falls back to free-tier name when only free-tier exists', () => {
  assert.equal(
    extractTierName({ allowedTiers: [{ id: 'free-tier', name: 'Free' }] }),
    'Free'
  );
});

test('extractTierName returns null for empty allowedTiers', () => {
  assert.equal(extractTierName({ allowedTiers: [] }), null);
});

test('extractTierName returns null when no paidTier and no allowedTiers', () => {
  assert.equal(extractTierName({}), null);
});

test('extractTierName prioritizes paidTier over allowedTiers', () => {
  assert.equal(
    extractTierName({
      paidTier: { name: 'Enterprise' },
      allowedTiers: [{ id: 'pro-tier', name: 'Pro' }],
    }),
    'Enterprise'
  );
});

// --- getCachedTier ---

function withCacheFile(content, fn) {
  const prev = fs.existsSync(CACHE_PATH) ? fs.readFileSync(CACHE_PATH, 'utf8') : null;
  try {
    if (content === null) {
      fs.rmSync(CACHE_PATH, { force: true });
    } else {
      fs.writeFileSync(CACHE_PATH, content);
    }
    return fn();
  } finally {
    if (prev === null) fs.rmSync(CACHE_PATH, { force: true });
    else fs.writeFileSync(CACHE_PATH, prev);
  }
}

test('getCachedTier returns tier string from cache file', () => {
  withCacheFile(JSON.stringify({ tier: 'Google AI Pro', data: [], version: 3 }), () => {
    assert.equal(getCachedTier(), 'Google AI Pro');
  });
});

test('getCachedTier returns null when cache has no tier field', () => {
  withCacheFile(JSON.stringify({ data: [], version: 3 }), () => {
    assert.equal(getCachedTier(), null);
  });
});

test('getCachedTier returns null when cache file does not exist', () => {
  withCacheFile(null, () => {
    assert.equal(getCachedTier(), null);
  });
});

test('getCachedTier returns null when cache file has invalid JSON', () => {
  withCacheFile('not json {{{', () => {
    assert.equal(getCachedTier(), null);
  });
});

// --- fetchTierFromCloud ---

test('fetchTierFromCloud returns tier name from paidTier in response', async () => {
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

test('fetchTierFromCloud returns null when all endpoints fail', async () => {
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

test('fetchTierFromCloud passes AbortSignal to fetch and handles timeout aborts', async () => {
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


test('fetchTierFromCloud returns null when response ok but no tier data', async () => {
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

test('discoverAgentModelIds extracts model IDs from agentModelSorts', () => {
  const apiResponse = {
    agentModelSorts: [{
      groups: [{ modelIds: ['gemini-3-flash-agent', 'claude-sonnet-4-6'] }]
    }]
  };
  assert.deepEqual(discoverAgentModelIds(apiResponse), ['gemini-3-flash-agent', 'claude-sonnet-4-6']);
});

test('discoverAgentModelIds returns null when agentModelSorts is missing', () => {
  assert.equal(discoverAgentModelIds({}), null);
  assert.equal(discoverAgentModelIds({ agentModelSorts: [] }), null);
  assert.equal(discoverAgentModelIds({ agentModelSorts: [{ groups: [] }] }), null);
  assert.equal(discoverAgentModelIds({ agentModelSorts: [{ groups: [{ modelIds: [] }] }] }), null);
});

test('resolveDeprecatedIds swaps deprecated model IDs for their replacements', () => {
  const ids = ['gemini-3.1-pro-high', 'claude-sonnet-4-6'];
  const apiResponse = {
    deprecatedModelIds: {
      'gemini-3.1-pro-high': { newModelId: 'gemini-pro-agent' }
    }
  };
  assert.deepEqual(resolveDeprecatedIds(ids, apiResponse), ['gemini-pro-agent', 'claude-sonnet-4-6']);
});

test('resolveDeprecatedIds is a no-op when no deprecations exist', () => {
  const ids = ['gemini-3-flash-agent', 'claude-sonnet-4-6'];
  assert.deepEqual(resolveDeprecatedIds(ids, {}), ids);
  assert.deepEqual(resolveDeprecatedIds(ids, { deprecatedModelIds: {} }), ids);
});

// --- 5-hour vs weekly quota window classification + merging ---

test('classifyQuotaWindow tags short resets as fiveHour and long resets as weekly', () => {
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

test('normalizeQuotaModels tags each model with its observed window', () => {
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

test('mergeQuotaWindows keeps the previously observed window when the response only covers the other one', () => {
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

test('mergeQuotaWindows drops expired window observations from the previous cache', () => {
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

test('mergeQuotaWindows carries forward models present in previous but missing from fresh', () => {
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

test('pickCriticalWindow skips expired observations even when they have the lower remainingFraction', () => {
  const now = Date.parse('2026-05-20T20:00:00Z');
  const expired = { remainingFraction: 0.05, resetTime: new Date(now - 1000).toISOString(), observedAt: now - 10_000 };
  const live = { remainingFraction: 0.8, resetTime: new Date(now + 5 * 24 * 60 * 60 * 1000).toISOString(), observedAt: now };

  const picked = pickCriticalWindow({ fiveHour: expired, weekly: live }, now);
  assert.equal(picked.window, 'weekly');
  assert.equal(picked.remainingFraction, 0.8);

  // Both expired → null so callers can fall back gracefully.
  assert.equal(pickCriticalWindow({ fiveHour: expired, weekly: expired }, now), null);
});

test('classifyQuotaWindow returns null for resetTimes in the past', () => {
  const now = Date.parse('2026-05-20T20:00:00Z');
  assert.equal(classifyQuotaWindow(new Date(now - 1000).toISOString(), now), null);
  assert.equal(classifyQuotaWindow(new Date(now).toISOString(), now), null); // exactly now: already-elapsed
  assert.equal(classifyQuotaWindow(new Date(now + 1000).toISOString(), now), 'fiveHour');
});

test('pickCriticalWindow returns the lower-remaining window', () => {
  const fiveHour = { remainingFraction: 0.6, resetTime: 'x', observedAt: 1 };
  const weekly = { remainingFraction: 0.2, resetTime: 'y', observedAt: 2 };
  assert.equal(pickCriticalWindow({ fiveHour, weekly }).window, 'weekly');
  assert.equal(pickCriticalWindow({ fiveHour: weekly, weekly: fiveHour }).window, 'fiveHour');
  assert.equal(pickCriticalWindow({ fiveHour }).window, 'fiveHour');
  assert.equal(pickCriticalWindow({ weekly }).window, 'weekly');
  assert.equal(pickCriticalWindow({}), null);
  assert.equal(pickCriticalWindow(null), null);
});

test('writeCache merges fresh response with previously cached other-window observations', () => {
  const { writeCache, readCachePayload } = quotaModule;
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

test('writeCache preserves previously cached tier when fresh tier is null and identity matches', () => {
  const { writeCache, getCachedTier } = quotaModule;
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

test('writeCache expiresAt accounts for the soonest resetTime across merged windows', () => {
  const { writeCache, readCachePayload } = quotaModule;
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
    // its real reset time. Allow 2-min cap to fire below 10min anyway.
    const tenMinutesFromNow = Date.now() + 10 * 60 * 1000 + 5000;
    assert.ok(raw.expiresAt <= tenMinutesFromNow,
      `expiresAt ${new Date(raw.expiresAt).toISOString()} must be <= 10min from now, not the 5-day weekly reset`);
  } finally {
    if (previousCache === null) fs.rmSync(CACHE_PATH, { force: true });
    else fs.writeFileSync(CACHE_PATH, previousCache);
  }
});

// --- Fix: token-null fallback to fresh cache (with file-existence check) ---

test('getQuota returns fresh cache when token file exists but is temporarily unreadable', async () => {
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

test('getQuota reports not_logged_in when genuinely logged out despite fresh cache', async () => {
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

test('getQuota reports not_logged_in when token is null and cache is expired', async () => {
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

// --- Fix: refresh dedup via readCacheLastRefreshed ---

test('getQuota debounces background refresh using cache lastRefreshed even without token match', async () => {
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

// --- Fix: readCacheLastRefreshed / readCacheFallback ---

test('readCacheLastRefreshed returns timestamp from cache regardless of token', () => {
  const { readCacheLastRefreshed } = quotaModule;
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

test('readCacheFallback returns payload without token matching', () => {
  const { readCacheFallback } = quotaModule;
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

test('getQuota falls back to readCacheFallback and returns data when token is unmatched', async () => {
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

test('getQuota reports expired_token when token is expired, even if fallback cache exists', async () => {
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

