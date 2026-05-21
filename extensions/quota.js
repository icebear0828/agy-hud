/**
 * quota.js — Real account-level quota fetcher.
 *
 * Calls the same `fetchAvailableModels` endpoint that agy uses for /usage.
 * Token is auto-discovered from known agy app-data locations across platforms.
 * Results are cached to os.tmpdir()/agy-hud-quota-cache.json keyed by the
 * earliest resetTime, so we never hit the network more than once per window.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync, spawn } = require('child_process');
const { getAntigravityRoots, resolveAntigravityPath } = require('./paths.js');

// ─── Cross-platform token discovery ──────────────────────────────────────────
// agy stores its OAuth token in different locations depending on the environment.
// We search in priority order; first readable file wins.
// Includes both antigravity-cli (standard) and jetski-standalone (older installs)
// token filenames, each under all known app-data roots.
const TOKEN_CANDIDATES = [
  ...getAntigravityRoots().map(root => path.join(root, 'antigravity-oauth-token')),
  path.join(os.homedir(), '.gemini', 'jetski-standalone-oauth-token'),
];

const CACHE_PATH = path.join(os.tmpdir(), 'agy-hud-quota-cache.json');
const CACHE_VERSION = 2;
const WINDOWS_TOKEN_TEMP_TTL_MS = 5 * 60 * 1000;
const WINDOWS_TOKEN_EXPIRY_SKEW_MS = 60 * 1000;
const WINDOWS_CREDENTIAL_TARGETS = [
  'gemini:antigravity',
  'LegacyGeneric:target=gemini:antigravity',
];

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

// Models to show in the HUD — filtered from the full list, de-duped by quota bucket
const DEFAULT_INTERESTING_MODEL_IDS = [
  'gemini-3-flash-agent',    // Gemini 3.5 Flash (High)
  'gemini-3.5-flash-low',    // Gemini 3.5 Flash (Medium)
  'gemini-3.1-pro-high',     // Gemini 3.1 Pro (High)
  'gemini-3.1-pro-low',      // Gemini 3.1 Pro (Low)
  'claude-sonnet-4-6',       // Claude Sonnet 4.6
  'claude-opus-4-6-thinking',// Claude Opus 4.6
  'gpt-oss-120b-medium',     // GPT-OSS 120B
];

function normalizeRemainingFraction(value) {
  if (value === undefined || value === null) return 1;
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
function normalizeQuotaModels(models, interestingModelIds = DEFAULT_INTERESTING_MODEL_IDS) {
  const results = [];
  for (const id of interestingModelIds) {
    const m = models[id];
    if (!m || !m.quotaInfo) continue;
    const qi = m.quotaInfo;
    results.push({
      id,
      displayName: m.displayName || id,
      remainingFraction: normalizeRemainingFraction(qi.remainingFraction),
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

function tokenResultFromTokens(tokens) {
  if (!tokens || tokens.length === 0) return null;
  return { accessToken: tokens[0].accessToken, all: tokens };
}

function writeWindowsTokenTemp(tokens) {
  if (!Array.isArray(tokens) || tokens.length === 0) return;
  try {
    const tmp = resolveAntigravityPath('agy-hud-token.json');
    fs.mkdirSync(path.dirname(tmp), { recursive: true });
    // mode 0o600 — the file holds an OAuth access token, must match the
    // permissions used by the bootstrap hook in hooks/inline-bootstrap.js.
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

function readWindowsCredentialTokens() {
  if (process.platform !== 'win32') return null;

  try {
    const raw = execFileSync('powershell', [
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
 * @returns {{ accessToken: string } | null}
 */
function readToken() {
  // Windows: agy stores its OAuth token in Credential Manager. Keep a short
  // JSON mirror so normal statusline renders do not spawn PowerShell every time.
  if (process.platform === 'win32') {
    const tempToken = readWindowsTokenTemp();
    if (tempToken) return tempToken;

    const credentialToken = readWindowsCredentialTokens();
    if (credentialToken) return credentialToken;
  }

  for (const candidate of TOKEN_CANDIDATES) {
    try {
      const raw = JSON.parse(fs.readFileSync(candidate, 'utf8'));
      // antigravity-cli format: { token: { access_token } }
      if (raw.token && raw.token.access_token) return { accessToken: raw.token.access_token };
      // jetski-standalone format: { access_token } (flat)
      if (raw.access_token) return { accessToken: raw.access_token };
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
async function fetchQuotaFromCloud(accessToken) {
  let sawAuthFailure = false;
  const { loadConfig } = require('./config.js');
  const config = await loadConfig().catch(() => ({}));

  const endpoints = process.env.AGY_HUD_ENDPOINTS
    ? process.env.AGY_HUD_ENDPOINTS.split(',').map(s => s.trim()).filter(Boolean)
    : (config.endpoints || DEFAULT_ENDPOINTS);

  const interestingModelIds = process.env.AGY_HUD_INTERESTING_MODELS
    ? process.env.AGY_HUD_INTERESTING_MODELS.split(',').map(s => s.trim()).filter(Boolean)
    : (config.interestingModels || DEFAULT_INTERESTING_MODEL_IDS);

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

/**
 * Read cached quota if still valid.
 * @param {string} accessToken
 * @returns {ModelQuota[] | null}
 */
function readCache(accessToken) {
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    if (!isCachePayloadFresh(raw)) return null;
    const currentHash = crypto.createHash('sha256').update(accessToken).digest('hex');
    if (raw.tokenHash !== currentHash) return null;
    return raw.data;
  } catch {
    return null;
  }
}

/**
 * Write quota cache. Expires at the earliest resetTime among all buckets.
 * @param {ModelQuota[]} data
 * @param {string} accessToken
 */
function writeCache(data, accessToken) {
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
  const tokenHash = crypto.createHash('sha256').update(accessToken).digest('hex');
  const payload = {
    version: CACHE_VERSION,
    expiresAt,
    lastRefreshed: Date.now(),
    tokenHash,
    data
  };
  try {
    fs.writeFileSync(CACHE_PATH, JSON.stringify(payload));
  } catch { /* ignore write errors */ }
}

/**
 * Read the entire raw cache payload (even if expired).
 * @param {string} accessToken
 * @returns {Object | null}
 */
function readCachePayload(accessToken) {
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    const currentHash = crypto.createHash('sha256').update(accessToken).digest('hex');
    if (raw.tokenHash !== currentHash) return null;
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

/**
 * Get quota data using a non-blocking Stale-While-Revalidate pattern.
 * @returns {Promise<ModelQuota[]>}
 */
async function getQuota() {
  const tok = readToken();
  if (!tok) return createUnavailableQuotaResult('not_logged_in');

  // For multi-account (Windows Credential Manager), use the primary token for
  // cache keying but fall back to alternates if the primary has no cache.
  const payload = readCachePayload(tok.accessToken) ||
    (tok.all && tok.all.slice(1).reduce((acc, t) => acc || readCachePayload(t.accessToken), null));
  const isFresh = payload && isCachePayloadFresh(payload);

  if (!isFresh) {
    const lastRefreshed = payload ? payload.lastRefreshed || 0 : 0;
    // Debounce background refreshes — only spawn one if not refreshed in the last 30s
    if (Date.now() - lastRefreshed > 30 * 1000) {
      triggerBackgroundRefresh();
    }
  }

  if (payload) {
    return payload.data;
  }

  // If no cache exists at all, return empty but trigger background load
  return [];
}

// ─── CLI Execution for background refreshes ──────────────────────────────────
if (process.argv.includes('--refresh')) {
  (async () => {
    try {
      const tok = readToken();
      if (tok) {
        const fresh = await fetchQuotaFromCloud(tok.accessToken);
        if (fresh.length > 0) {
          writeCache(fresh, tok.accessToken);
        }
      }
    } catch {}
    process.exit(0);
  })();
}

module.exports = {
  getQuota,
  fetchQuotaFromCloud,
  normalizeQuotaModels,
  isCachePayloadFresh,
  createUnavailableQuotaResult,
  selectUsableTokens,
  readToken,
  readWindowsCredentialTokens,
  readCache,
  writeCache,
};
