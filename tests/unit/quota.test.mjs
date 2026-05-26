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
      assert.equal(readToken().accessToken, 'antigravity-token');

      fs.rmSync(antigravityTokenPath);
      assert.equal(readToken(), null);
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
      const token = readToken();
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

    assert.deepEqual(quota, cachedQuota);
    assert.equal(refreshes, 0);
  } finally {
    if (previousCache === null) fs.rmSync(CACHE_PATH, { force: true });
    else fs.writeFileSync(CACHE_PATH, previousCache);
  }
});

test('getQuota fast path preserves fresh cache when the access token rotates', async () => {
  const previousCache = fs.existsSync(CACHE_PATH) ? fs.readFileSync(CACHE_PATH, 'utf8') : null;
  try {
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

    assert.deepEqual(quota, cachedQuota);
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

test('readCache / writeCache reuses stable token source across access token refreshes', () => {
  const { readCache, writeCache } = quotaModule;
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

  const cachePath = path.join(os.tmpdir(), 'agy-hud-quota-cache.json');
  try {
    fs.unlinkSync(cachePath);
  } catch {}
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
  withCacheFile(JSON.stringify({ tier: 'Google AI Pro', data: [], version: 2 }), () => {
    assert.equal(getCachedTier(), 'Google AI Pro');
  });
});

test('getCachedTier returns null when cache has no tier field', () => {
  withCacheFile(JSON.stringify({ data: [], version: 2 }), () => {
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

    assert.deepEqual(quota, cachedQuota);
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
      version: 2,
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
      version: 2,
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
      version: 2,
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
    fs.writeFileSync(CACHE_PATH, JSON.stringify({ version: 2, lastRefreshed: ts, data: [] }), { mode: 0o600 });
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
