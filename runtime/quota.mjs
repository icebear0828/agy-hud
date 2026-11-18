import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getAntigravityRoots } from './paths.mjs';
import * as tokenMod from './quota/token.mjs';
import * as cacheMod from './quota/cache.mjs';
import * as cloudMod from './quota/cloud.mjs';
import * as modelsMod from './quota/models.mjs';

const __filename = fileURLToPath(import.meta.url);
const WINDOWS_CREDENTIAL_REFRESH_DEBOUNCE_MS = 30 * 1000;
let lastWindowsCredentialRefreshAt = 0;

function triggerBackgroundRefresh() {
  try {
    const subprocess = spawn(process.execPath, [__filename, '--refresh'], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, NODE_USE_ENV_PROXY: '1' },
    });
    subprocess.unref();
  } catch {}
}

function triggerWindowsCredentialRefresh(backgroundRefresh, now, debounceMs) {
  if (now - lastWindowsCredentialRefreshAt < debounceMs) return;
  lastWindowsCredentialRefreshAt = now;
  backgroundRefresh();
}

export async function getQuota(options = {}) {
  const {
    fast = false,
    platform = process.platform,
    tokenReader = tokenMod.readToken,
    backgroundRefresh = triggerBackgroundRefresh,
    credentialReader = tokenMod.readWindowsCredentialTokens,
    roots = getAntigravityRoots(),
    windowsCredentialRefreshDebounceMs = WINDOWS_CREDENTIAL_REFRESH_DEBOUNCE_MS,
    cachePath = cacheMod.getCachePath(),
  } = options;

  const shouldRefreshWindowsCredential = fast && platform === 'win32';
  const refreshWindowsCredential = () => {
    if (!shouldRefreshWindowsCredential) return;
    triggerWindowsCredentialRefresh(backgroundRefresh, Date.now(), windowsCredentialRefreshDebounceMs);
  };

  const tok = tokenReader({
    platform,
    roots,
    credentialReader,
    skipWindowsCredential: fast && platform === 'win32',
  });

  if (!tok) {
    if (tokenMod.anyTokenFileExists(roots)) {
      const fallback = cacheMod.readCacheFallback(cachePath);
      if (fallback && cacheMod.isCachePayloadFresh(fallback)) return fallback.data;
    }
    refreshWindowsCredential();
    return modelsMod.createUnavailableQuotaResult('not_logged_in');
  }

  const payload = cacheMod.readCachePayload(tok, cachePath)
    || (tok.all && tok.all.slice(1).reduce((acc, t) => acc || cacheMod.readCachePayload(t, cachePath), null));
  const isFresh = payload && cacheMod.isCachePayloadFresh(payload);
  const tokenExpired = tokenMod.isTokenExpired(tok);
  const needsRefresh = !tokenExpired && (!isFresh || cacheMod.didAccessTokenRotate(payload, tok));

  if (needsRefresh) {
    const lastRefreshed = payload ? (payload.lastRefreshed || 0) : cacheMod.readCacheLastRefreshed(cachePath);
    if (cacheMod.didAccessTokenRotate(payload, tok) || Date.now() - lastRefreshed > 30 * 1000) {
      backgroundRefresh();
    }
  }

  if (payload) return payload.data;
  if (tokenExpired) {
    refreshWindowsCredential();
    return modelsMod.createUnavailableQuotaResult('expired_token');
  }

  const fallback = cacheMod.readCacheFallback(cachePath);
  if (fallback) return fallback.data;
  return [];
}

/**
 * Redacted active account summary for caged logic (never contains access tokens).
 */
export function resolveActiveAccountSummary(env = process.env, home) {
  try {
    const roots = getAntigravityRoots(env, home);
    const cachePath = cacheMod.getCachePath(env);
    const tok = tokenMod.readToken({ roots, skipKeychain: true, skipWindowsCredential: true });
    let email = null;
    if (tok) {
      if (tok.email && tok.sourceFormat !== 'oauth-creds') email = tok.email;
      else email = cacheMod.getCachedAccountEmail(tok, cachePath) || tok.email || null;
    }
    if (!email) {
      const geminiHome = path.join(path.dirname(roots[0]), '.gemini');
      try {
        const reg = JSON.parse(fsReadFile(path.join(geminiHome, 'google_accounts.json')));
        if (typeof reg?.active === 'string' && reg.active.includes('@')) email = reg.active;
      } catch {}
    }
    return { email, tier: cacheMod.getCachedTier(cachePath) };
  } catch {
    return { email: null, tier: null };
  }
}

import fs from 'node:fs';
function fsReadFile(p) {
  return fs.readFileSync(p, 'utf8');
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename && process.argv.includes('--refresh')) {
  try {
    const tok = tokenMod.readToken();
    if (tok) {
      const [fresh, tier, accountEmail] = await Promise.all([
        cloudMod.fetchQuotaFromCloud(tok.accessToken),
        cloudMod.fetchTierFromCloud(tok.accessToken),
        cloudMod.fetchAccountEmail(tok.accessToken),
      ]);
      if (fresh && fresh.unavailableReason === 'auth_failed') {
        tokenMod.clearTokenTemp();
      } else if (fresh.length > 0 || accountEmail) {
        cacheMod.writeCache(fresh, tok, tier, accountEmail, fresh.providerQuota);
      }
    }
  } catch {}
  process.exit(0);
}

export * from './quota/models.mjs';
export * from './quota/token.mjs';
export * from './quota/cache.mjs';
export * from './quota/cloud.mjs';
