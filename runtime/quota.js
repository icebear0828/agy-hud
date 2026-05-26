/**
 * quota.js — Real account-level quota fetcher.
 *
 * Calls the same `fetchAvailableModels` endpoint that agy uses for /usage.
 * Token is auto-discovered from known agy app-data locations across platforms.
 * Results are cached to os.tmpdir()/agy-hud-quota-cache.json. The cache key is
 * the stable credential source when available, so access-token rotation does
 * not hide a still-fresh quota cache from the statusline.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync, spawn } = require('child_process');
const { getAntigravityRoots, resolveAntigravityPath, resolveSafeExecutable } = require('./paths.js');

// ─── Cross-platform token discovery ──────────────────────────────────────────
// agy stores its OAuth token in different locations depending on the environment.
// We search in priority order; first readable file wins.
const ANTIGRAVITY_TOKEN_FILENAME = 'antigravity-oauth-token';
const OAUTH_CREDS_FILENAME = 'oauth_creds.json';

function getTokenCandidates(roots = getAntigravityRoots()) {
  const candidates = [];
  for (const root of roots) {
    candidates.push(path.join(root, ANTIGRAVITY_TOKEN_FILENAME));
    if (path.basename(root) === 'antigravity-cli') {
      candidates.push(path.join(path.dirname(root), OAUTH_CREDS_FILENAME));
    }
  }
  return [...new Set(candidates)];
}

const CACHE_PATH = resolveAntigravityPath('agy-hud-quota-cache.json');
const CACHE_VERSION = 2;
const WINDOWS_TOKEN_TEMP_TTL_MS = 5 * 60 * 1000;
const WINDOWS_TOKEN_EXPIRY_SKEW_MS = 60 * 1000;
const WINDOWS_CREDENTIAL_REFRESH_DEBOUNCE_MS = 30 * 1000;
const WINDOWS_CREDENTIAL_TARGETS = [
  'gemini:antigravity',
  'LegacyGeneric:target=gemini:antigravity',
];
let lastWindowsCredentialRefreshAt = 0;

// ─── Runtime User-Agent ───────────────────────────────────────────────────────
// Read version from our own package.json and detect OS/arch at runtime.
let _pkg = null;
function getPackageVersion() {
  if (_pkg) return _pkg;
  try {
    _pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version;
  } catch {
    _pkg = '0.0.0';
  }
  return _pkg;
}

function getPlatformArch() {
  const plat = { darwin: 'darwin', linux: 'linux', win32: 'windows' }[process.platform] || process.platform;
  const arch = { x64: 'amd64', arm64: 'arm64', ia32: '386' }[process.arch] || process.arch;
  return `${plat}/${arch}`;
}

// The same endpoints agy uses (daily first — confirmed authoritative source, prod fallback)
const DEFAULT_ENDPOINTS = [
  'https://daily-cloudcode-pa.googleapis.com',
  'https://cloudcode-pa.googleapis.com',
];

// Fallback model list when agentModelSorts is absent from the API response
const FALLBACK_AGENT_MODEL_IDS = [
  'gemini-3-flash-agent',
  'gemini-3.5-flash-low',
  'gemini-3.5-flash-extra-low',
  'gemini-pro-agent',
  'gemini-3.1-pro-low',
  'claude-sonnet-4-6',
  'claude-opus-4-6-thinking',
  'gpt-oss-120b-medium',
];

function discoverAgentModelIds(apiResponse) {
  const sorts = apiResponse.agentModelSorts;
  if (Array.isArray(sorts) && sorts.length > 0) {
    const ids = sorts[0].groups?.[0]?.modelIds;
    if (Array.isArray(ids) && ids.length > 0) return ids;
  }
  return null;
}

function resolveDeprecatedIds(ids, apiResponse) {
  const deprecated = apiResponse.deprecatedModelIds;
  if (!deprecated || typeof deprecated !== 'object') return ids;
  return ids.map(id => deprecated[id]?.newModelId || id);
}

function normalizeRemainingFraction(value, hasResetTime = false) {
  if (value === undefined || value === null) {
    return hasResetTime ? 0 : 1;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * Normalize the fetchAvailableModels response to the HUD quota shape.
 * @param {Object<string, Object>} models
 * @returns {ModelQuota[]}
 */
function normalizeQuotaModels(models, interestingModelIds = FALLBACK_AGENT_MODEL_IDS) {
  const results = [];
  for (const id of interestingModelIds) {
    const m = models[id];
    if (!m || !m.quotaInfo) continue;
    const qi = m.quotaInfo;
    results.push({
      id,
      displayName: m.displayName || id,
      modelProvider: m.modelProvider || null,
      remainingFraction: normalizeRemainingFraction(qi.remainingFraction, !!qi.resetTime),
      resetTime: qi.resetTime || null,
    });
  }
  return results;
}

function createUnavailableQuotaResult(reason) {
  const result = [];
  Object.defineProperty(result, 'unavailableReason', {
    value: reason,
    enumerable: false,
  });
  return result;
}

function isUsableAccessToken(token, writtenAt = 0, now = Date.now()) {
  if (!token || !token.accessToken) return false;

  if (token.expiry) {
    const expiresAt = new Date(token.expiry).getTime();
    if (Number.isFinite(expiresAt)) {
      return expiresAt - WINDOWS_TOKEN_EXPIRY_SKEW_MS > now;
    }
  }

  return Boolean(writtenAt && now - writtenAt < WINDOWS_TOKEN_TEMP_TTL_MS);
}

function selectUsableTokens(tokens, writtenAt = 0, now = Date.now()) {
  return (Array.isArray(tokens) ? tokens : [])
    .filter(token => isUsableAccessToken(token, writtenAt, now));
}

function isTokenExpired(token, now = Date.now()) {
  if (!token || !token.expiry) return false;
  const expiresAt = new Date(token.expiry).getTime();
  return Number.isFinite(expiresAt) && expiresAt - WINDOWS_TOKEN_EXPIRY_SKEW_MS <= now;
}

function tokenResultFromTokens(tokens) {
  if (!tokens || tokens.length === 0) return null;
  return { accessToken: tokens[0].accessToken, all: tokens };
}

function normalizeExpiryDate(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  if (typeof value === 'string') {
    if (/^\d+$/.test(value)) {
      return new Date(Number(value)).toISOString();
    }
    return value;
  }
  return undefined;
}

function parseTokenPayload(raw) {
  if (!raw || typeof raw !== 'object') return null;

  if (raw.token && typeof raw.token === 'object' && raw.token.access_token) {
    return {
      accessToken: raw.token.access_token,
      expiry: normalizeExpiryDate(raw.token.expiry),
      sourceFormat: 'antigravity-cli',
    };
  }

  if (raw.access_token) {
    return {
      accessToken: raw.access_token,
      expiry: normalizeExpiryDate(raw.expiry || raw.expiry_date),
      sourceFormat: 'oauth-creds',
    };
  }

  return null;
}

function writeWindowsTokenTemp(tokens) {
  if (!Array.isArray(tokens) || tokens.length === 0) return;
  try {
    const tmp = resolveAntigravityPath('agy-hud-token.json');
    fs.mkdirSync(path.dirname(tmp), { recursive: true });
    // mode 0o600 — the file holds OAuth access tokens, so keep permissions
    // narrow even though this is only a short-lived mirror.
    fs.writeFileSync(tmp, JSON.stringify({ tokens, writtenAt: Date.now() }), { mode: 0o600 });
  } catch { /* best-effort cache */ }
}

function readWindowsTokenTemp() {
  try {
    const tmp = resolveAntigravityPath('agy-hud-token.json');
    const raw = JSON.parse(fs.readFileSync(tmp, 'utf8'));
    return tokenResultFromTokens(selectUsableTokens(raw.tokens, raw.writtenAt));
  } catch {
    return null;
  }
}

function buildWindowsCredentialScript() {
  const targets = WINDOWS_CREDENTIAL_TARGETS
    .map(target => `'${target.replace(/'/g, "''")}'`)
    .join(',');

  return [
    '$ErrorActionPreference = "SilentlyContinue"',
    'Add-Type -Language CSharp -TypeDefinition @"',
    'using System; using System.Runtime.InteropServices; using System.Text;',
    'public class WC {',
    '  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)]',
    '  public struct CRED { public uint Flags,Type; public string Target,Comment;',
    '    public long LastWritten; public uint BlobSize; public IntPtr Blob;',
    '    public uint Persist,AttrCount; public IntPtr Attrs; public string Alias,User; }',
    '  [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)]',
    '  public static extern bool CredRead(string target,uint type,int reservedFlag,out IntPtr credentialPtr);',
    '  [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr p);',
    '}',
    '"@',
    `$targets=@(${targets})`,
    '$tokens=@()',
    'foreach($target in $targets){',
    '  $p=[IntPtr]::Zero',
    '  if([WC]::CredRead($target,1,0,[ref]$p)){',
    '    try {',
    '      $c=[Runtime.InteropServices.Marshal]::PtrToStructure($p,[type][WC+CRED])',
    '      if($c.BlobSize -gt 0){',
    '        $bytes=New-Object byte[] $c.BlobSize',
    '        [Runtime.InteropServices.Marshal]::Copy($c.Blob,$bytes,0,$c.BlobSize)',
    '        foreach($enc in @([Text.Encoding]::UTF8,[Text.Encoding]::Unicode)){',
    '          try {',
    '            $o=$enc.GetString($bytes)|ConvertFrom-Json',
    '            $tok=$o.token',
    '            if($tok -and $tok.access_token){',
    '              $tokens += [pscustomobject]@{ accessToken=$tok.access_token; expiry=$tok.expiry }',
    '              break',
    '            } elseif($o.access_token){',
    '              $tokens += [pscustomobject]@{ accessToken=$o.access_token; expiry=$o.expiry }',
    '              break',
    '            }',
    '          } catch {}',
    '        }',
    '      }',
    '    } finally { [WC]::CredFree($p) }',
    '  }',
    '}',
    '$dedup=@{}',
    'foreach($t in $tokens){ if($t.accessToken -and -not $dedup.ContainsKey($t.accessToken)){ $dedup[$t.accessToken]=$t } }',
    'if($dedup.Count -gt 0){ [pscustomobject]@{ tokens=@($dedup.Values) } | ConvertTo-Json -Compress -Depth 4 }',
    'else { Write-Output "{`"tokens`":[]}" }',
  ].join('\n');
}

function readWindowsCredentialTokens(platform = process.platform) {
  if (platform !== 'win32') return null;

  try {
    const powershellPath = resolveSafeExecutable('powershell');
    if (!powershellPath) return null;
    const raw = execFileSync(powershellPath, [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      buildWindowsCredentialScript(),
    ], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
    });
    const parsed = JSON.parse(raw.trim() || '{"tokens":[]}');
    const valid = selectUsableTokens(parsed.tokens, Date.now());
    if (valid.length === 0) return null;
    writeWindowsTokenTemp(valid);
    return tokenResultFromTokens(valid);
  } catch {
    return null;
  }
}

/**
 * @returns {{ accessToken: string, expiry?: string, sourceFormat?: string, sourcePath?: string, all?: Array<{ accessToken: string, expiry?: string }> } | null}
 */
function readToken(options = {}) {
  const {
    platform = process.platform,
    roots = getAntigravityRoots(),
    skipWindowsCredential = false,
    credentialReader = readWindowsCredentialTokens,
  } = options;

  // Windows: agy stores its OAuth token in Credential Manager. Keep a short
  // JSON mirror so normal statusline renders do not spawn PowerShell every time.
  if (platform === 'win32') {
    const tempToken = readWindowsTokenTemp();
    if (tempToken) return tempToken;

    if (!skipWindowsCredential) {
      const credentialToken = credentialReader(platform);
      if (credentialToken) return credentialToken;
    }
  }

  for (const candidate of getTokenCandidates(roots)) {
    try {
      const raw = JSON.parse(fs.readFileSync(candidate, 'utf8'));
      const token = parseTokenPayload(raw);
      if (token) return { ...token, sourcePath: candidate };
    } catch { /* try next */ }
  }
  return null;
}

/**
 * Build headers matching what agy sends.
 * @param {string} accessToken
 */
function buildHeaders(accessToken) {
  return {
    'Authorization': `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'User-Agent': `antigravity/${getPackageVersion()} ${getPlatformArch()}`,
    'X-Goog-Api-Client': `gl-node/${process.versions.node}`,
    'Client-Metadata': JSON.stringify({
      ideType: 'IDE_UNSPECIFIED',
      platform: 'PLATFORM_UNSPECIFIED',
      pluginType: 'GEMINI',
    }),
  };
}

/**
 * Get the caller's Google Cloud project id from loadCodeAssist.
 * Returns null if the endpoint is unreachable or the response doesn't carry
 * a project — callers should treat that as "quota unavailable" rather than
 * substituting an arbitrary project id (which leaks identity).
 *
 * @param {string} accessToken
 * @param {string} endpoint
 * @returns {Promise<string|null>}
 */
/**
 * @typedef {Object} ModelQuota
 * @property {string} id
 * @property {string} displayName
 * @property {number} remainingFraction  0–1
 * @property {string|null} resetTime     ISO-8601 or null
 */

/**
 * Fetch quota data from the cloud API.
 * loadCodeAssist no longer returns cloudaicompanionProject; fetchAvailableModels
 * accepts an empty body and returns quota directly.
 * @param {string} accessToken
 * @returns {Promise<ModelQuota[]>}
 */
/**
 * Extract a human-readable tier name from a loadCodeAssist response.
 * Priority: paidTier.name > first non-free allowedTier name > null
 * @param {Object} data
 * @returns {string|null}
 */
function extractTierName(data) {
  if (data.paidTier && data.paidTier.name) return data.paidTier.name;
  const nonFree = (data.allowedTiers || []).find(t => t.id !== 'free-tier');
  if (nonFree && nonFree.name) return nonFree.name;
  if (data.allowedTiers && data.allowedTiers.length > 0) return data.allowedTiers[0].name;
  return null;
}

/**
 * Fetch the user's subscription tier from loadCodeAssist.
 * Returns a display string like "Google AI Pro" or null if unavailable.
 * @param {string} accessToken
 * @returns {Promise<string|null>}
 */
async function fetchTierFromCloud(accessToken) {
  const { loadConfig } = require('./config.js');
  const config = await loadConfig().catch(() => ({}));
  const endpoints = process.env.AGY_HUD_ENDPOINTS
    ? process.env.AGY_HUD_ENDPOINTS.split(',').map(s => s.trim()).filter(Boolean)
    : (config.endpoints || DEFAULT_ENDPOINTS);

  for (const endpoint of endpoints) {
    try {
      const r = await fetch(`${endpoint}/v1internal:loadCodeAssist`, {
        method: 'POST',
        headers: buildHeaders(accessToken),
        body: JSON.stringify({
          cloudaicompanionProject: '',
          metadata: {
            ideType: 'IDE_UNSPECIFIED',
            platform: 'PLATFORM_UNSPECIFIED',
            pluginType: 'GEMINI',
          },
        }),
      });
      if (!r.ok) continue;
      const data = await r.json();
      return extractTierName(data);
    } catch { /* try next endpoint */ }
  }
  return null;
}

async function fetchQuotaFromCloud(accessToken) {
  let sawAuthFailure = false;
  const { loadConfig } = require('./config.js');
  const config = await loadConfig().catch(() => ({}));

  const endpoints = process.env.AGY_HUD_ENDPOINTS
    ? process.env.AGY_HUD_ENDPOINTS.split(',').map(s => s.trim()).filter(Boolean)
    : (config.endpoints || DEFAULT_ENDPOINTS);

  const envModelIds = process.env.AGY_HUD_INTERESTING_MODELS
    ? process.env.AGY_HUD_INTERESTING_MODELS.split(',').map(s => s.trim()).filter(Boolean)
    : null;

  for (const endpoint of endpoints) {
    try {
      const r = await fetch(`${endpoint}/v1internal:fetchAvailableModels`, {
        method: 'POST',
        headers: buildHeaders(accessToken),
        body: JSON.stringify({}),
      });
      if (!r.ok) {
        if (r.status === 401 || r.status === 403) sawAuthFailure = true;
        continue;
      }
      const data = await r.json();
      const models = data.models || {};
      const interestingModelIds = envModelIds
        || config.interestingModels
        || resolveDeprecatedIds(
            discoverAgentModelIds(data) || FALLBACK_AGENT_MODEL_IDS,
            data
          );
      return normalizeQuotaModels(models, interestingModelIds);
    } catch { /* try next endpoint */ }
  }
  return createUnavailableQuotaResult(sawAuthFailure ? 'auth_failed' : 'quota_fetch_failed');
}

function isCachePayloadFresh(raw) {
  return raw &&
    raw.version === CACHE_VERSION &&
    raw.expiresAt &&
    Date.now() < raw.expiresAt &&
    Array.isArray(raw.data);
}

function hashCacheKey(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function normalizeTokenCacheInput(tokenOrAccessToken) {
  if (typeof tokenOrAccessToken === 'string') {
    return { accessToken: tokenOrAccessToken };
  }
  if (!tokenOrAccessToken || typeof tokenOrAccessToken !== 'object') {
    return null;
  }
  return tokenOrAccessToken;
}

function getTokenCacheIdentity(tokenOrAccessToken) {
  const token = normalizeTokenCacheInput(tokenOrAccessToken);
  if (!token) return null;

  if (token.sourcePath) {
    return `sourcePath:${path.resolve(token.sourcePath)}`;
  }

  if (token.sourceFormat) {
    return `sourceFormat:${token.sourceFormat}`;
  }

  if (token.accessToken) {
    return `accessToken:${token.accessToken}`;
  }

  return null;
}

function getTokenHash(tokenOrAccessToken) {
  const token = normalizeTokenCacheInput(tokenOrAccessToken);
  if (!token || !token.accessToken) return null;
  return hashCacheKey(token.accessToken);
}

function getTokenCacheKeyHash(tokenOrAccessToken) {
  const identity = getTokenCacheIdentity(tokenOrAccessToken);
  return identity ? hashCacheKey(identity) : null;
}

function doesCachePayloadMatchToken(raw, tokenOrAccessToken) {
  if (!raw || !Array.isArray(raw.data)) return false;

  const cacheKeyHash = getTokenCacheKeyHash(tokenOrAccessToken);
  if (raw.cacheKeyHash && cacheKeyHash && raw.cacheKeyHash === cacheKeyHash) {
    return true;
  }

  const tokenHash = getTokenHash(tokenOrAccessToken);
  return Boolean(raw.tokenHash && tokenHash && raw.tokenHash === tokenHash);
}

function didAccessTokenRotate(raw, tokenOrAccessToken) {
  const tokenHash = getTokenHash(tokenOrAccessToken);
  return Boolean(raw && raw.tokenHash && tokenHash && raw.tokenHash !== tokenHash);
}

/**
 * Read cached quota if still valid.
 * @param {string|Object} tokenOrAccessToken
 * @returns {ModelQuota[] | null}
 */
function readCache(tokenOrAccessToken) {
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    if (!isCachePayloadFresh(raw)) return null;
    if (!doesCachePayloadMatchToken(raw, tokenOrAccessToken)) return null;
    return raw.data;
  } catch {
    return null;
  }
}

/**
 * Write quota cache. Expires at the earliest resetTime among all buckets.
 * Uses atomic write (tmp + rename) to prevent concurrent readers from seeing
 * truncated/empty content — the main fix for statusline quota flicker.
 * @param {ModelQuota[]} data
 * @param {string|Object} tokenOrAccessToken
 */
function writeCache(data, tokenOrAccessToken, tier = null) {
  // Find earliest resetTime
  let earliest = Infinity;
  for (const m of data) {
    if (m.resetTime) {
      const t = new Date(m.resetTime).getTime();
      if (t < earliest) earliest = t;
    }
  }
  // If no resetTime found, cache for 5 minutes
  const expiresAt = isFinite(earliest) ? earliest : Date.now() + 5 * 60 * 1000;
  const cacheKeyHash = getTokenCacheKeyHash(tokenOrAccessToken);
  const tokenHash = getTokenHash(tokenOrAccessToken);
  const payload = {
    version: CACHE_VERSION,
    expiresAt,
    lastRefreshed: Date.now(),
    cacheKeyHash,
    tokenHash,
    tier: tier || null,
    data,
  };
  try {
    const tmpPath = `${CACHE_PATH}.tmp.${process.pid}`;
    fs.writeFileSync(tmpPath, JSON.stringify(payload), { mode: 0o600 });
    fs.renameSync(tmpPath, CACHE_PATH);
  } catch {
    try { fs.unlinkSync(`${CACHE_PATH}.tmp.${process.pid}`); } catch {}
  }
}

/**
 * Read the cached tier name without requiring a token match.
 * Tier is account-level, not token-level, so we skip token matching.
 * @returns {string|null}
 */
function getCachedTier() {
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    return raw.tier || null;
  } catch {
    return null;
  }
}

/**
 * Read the entire raw cache payload (even if expired).
 * @param {string|Object} tokenOrAccessToken
 * @returns {Object | null}
 */
function readCachePayload(tokenOrAccessToken) {
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    if (!doesCachePayloadMatchToken(raw, tokenOrAccessToken)) return null;
    return raw;
  } catch {
    return null;
  }
}

/**
 * Read lastRefreshed from cache file without requiring token match.
 * Used to debounce background refreshes even when the caller's token
 * doesn't match the cache (e.g. token rotation, new account).
 */
function readCacheLastRefreshed() {
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    return raw.lastRefreshed || 0;
  } catch {
    return 0;
  }
}

/**
 * Check whether any token candidate file exists on disk (regardless of
 * whether it parses). Distinguishes "file being rewritten" (transient)
 * from "user genuinely logged out" (no file at all).
 */
function anyTokenFileExists(roots = getAntigravityRoots()) {
  for (const candidate of getTokenCandidates(roots)) {
    try {
      if (fs.existsSync(candidate)) return true;
    } catch { /* ignore */ }
  }
  return false;
}

/**
 * Read entire cache payload without requiring token match.
 * Fallback for transient token-read failures — if the user was recently
 * authenticated (fresh cache exists), return stale data rather than
 * flashing "not logged in".
 */
function readCacheFallback() {
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    if (!raw || !Array.isArray(raw.data) || raw.version !== CACHE_VERSION) return null;
    return raw;
  } catch {
    return null;
  }
}

/**
 * Spawn a detached background process to refresh the quota cache.
 */
function triggerBackgroundRefresh() {
  try {
    const subprocess = spawn(process.execPath, [
      path.join(__dirname, 'quota.js'),
      '--refresh'
    ], {
      detached: true,
      stdio: 'ignore'
    });
    subprocess.unref();
  } catch { /* ignore spawning issues */ }
}

function triggerWindowsCredentialRefresh(backgroundRefresh, now, debounceMs) {
  if (now - lastWindowsCredentialRefreshAt < debounceMs) return;
  lastWindowsCredentialRefreshAt = now;
  backgroundRefresh();
}

/**
 * Get quota data using a non-blocking Stale-While-Revalidate pattern.
 * @returns {Promise<ModelQuota[]>}
 */
async function getQuota(options = {}) {
  const {
    fast = false,
    platform = process.platform,
    tokenReader = readToken,
    backgroundRefresh = triggerBackgroundRefresh,
    credentialReader = readWindowsCredentialTokens,
    roots = getAntigravityRoots(),
    windowsCredentialRefreshDebounceMs = WINDOWS_CREDENTIAL_REFRESH_DEBOUNCE_MS,
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
    // Token file exists but failed to parse → transient (OAuth mid-refresh).
    // Return fresh cache rather than flashing "not logged in".
    // Token file absent → genuine logout, skip fallback.
    if (anyTokenFileExists(roots)) {
      const fallback = readCacheFallback();
      if (fallback && isCachePayloadFresh(fallback)) {
        return fallback.data;
      }
    }
    refreshWindowsCredential();
    return createUnavailableQuotaResult('not_logged_in');
  }

  // For multi-account (Windows Credential Manager), use the primary token for
  // cache keying but fall back to alternates if the primary has no cache.
  const payload = readCachePayload(tok) ||
    (tok.all && tok.all.slice(1).reduce((acc, t) => acc || readCachePayload(t), null));
  const isFresh = payload && isCachePayloadFresh(payload);
  const tokenExpired = isTokenExpired(tok);
  const needsRefresh = !tokenExpired && (!isFresh || didAccessTokenRotate(payload, tok));

  if (needsRefresh) {
    // Read lastRefreshed from cache even when payload doesn't match our token,
    // to prevent a storm of concurrent background refresh processes.
    const lastRefreshed = payload
      ? payload.lastRefreshed || 0
      : readCacheLastRefreshed();
    // Debounce stale/no-cache refreshes, but refresh immediately when a fresh
    // cache belongs to the same source and only the access token has rotated.
    if (didAccessTokenRotate(payload, tok) || Date.now() - lastRefreshed > 30 * 1000) {
      backgroundRefresh();
    }
  }

  if (payload) {
    return payload.data;
  }

  if (tokenExpired) {
    refreshWindowsCredential();
    return createUnavailableQuotaResult('expired_token');
  }

  // If no cache exists at all, return empty. Non-fast callers trigger the
  // refresh above; statusline fast path stays bounded and never waits on it.
  return [];
}

// ─── CLI Execution for background refreshes ──────────────────────────────────
if (process.argv.includes('--refresh')) {
  (async () => {
    try {
      const tok = readToken();
      if (tok) {
        const [fresh, tier] = await Promise.all([
          fetchQuotaFromCloud(tok.accessToken),
          fetchTierFromCloud(tok.accessToken),
        ]);
        if (fresh.length > 0) {
          writeCache(fresh, tok, tier);
        }
      }
    } catch {}
    process.exit(0);
  })();
}

module.exports = {
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
  getTokenCandidates,
  parseTokenPayload,
  readToken,
  readWindowsCredentialTokens,
  readCache,
  writeCache,
  readCachePayload,
  readCacheLastRefreshed,
  readCacheFallback,
  anyTokenFileExists,
  CACHE_PATH,
};
