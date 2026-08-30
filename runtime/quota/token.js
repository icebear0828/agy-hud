'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  getAntigravityRoots,
  resolveAntigravityPath,
  resolveSafeExecutable,
} = require('../paths.js');

// ─── Cross-platform token discovery ──────────────────────────────────────────
// agy stores its OAuth token in different locations depending on the environment.
// We search in priority order; first readable file wins.
const ANTIGRAVITY_TOKEN_FILENAME = 'antigravity-oauth-token';
const OAUTH_CREDS_FILENAME = 'oauth_creds.json';

const WINDOWS_TOKEN_TEMP_TTL_MS = 5 * 60 * 1000;
const WINDOWS_TOKEN_EXPIRY_SKEW_MS = 60 * 1000;
const WINDOWS_CREDENTIAL_TARGETS = [
  'gemini:antigravity',
  'LegacyGeneric:target=gemini:antigravity',
];

// agy stores its OAuth token in the Linux system keyring (D-Bus Secret
// Service) under this service/username pair, via the python `keyring` library.
// These mirror the arguments agy passes to `keyring.set_password(...)`; update
// here if a future agy version changes the target.
const LINUX_KEYRING_SERVICE = 'gemini';
const LINUX_KEYRING_USERNAME = 'antigravity';

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
  return {
    accessToken: tokens[0].accessToken,
    expiry: tokens[0].expiry,
    sourceFormat: tokens[0].sourceFormat,
    all: tokens,
  };
}

function normalizeKeyringTokenResult(token) {
  if (!token) return null;
  if (typeof token === 'string') {
    return {
      accessToken: token,
      sourceFormat: 'linux-keyring',
      all: [{ accessToken: token, sourceFormat: 'linux-keyring' }],
    };
  }
  if (typeof token === 'object') {
    return {
      ...token,
      sourceFormat: token.sourceFormat || 'linux-keyring',
    };
  }
  return null;
}

function resolveTokenTempPath(roots = getAntigravityRoots()) {
  const candidates = (Array.isArray(roots) ? roots : [])
    .filter(Boolean)
    .map(root => path.join(root, 'agy-hud-token.json'));

  // Always use the first candidate as the canonical path so that read and
  // write operations always target the same file, regardless of whether it
  // already exists.
  if (candidates.length > 0) return candidates[0];
  return resolveAntigravityPath('agy-hud-token.json');
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

function writeWindowsTokenTemp(tokens, roots = getAntigravityRoots()) {
  if (!Array.isArray(tokens) || tokens.length === 0) return;
  try {
    const tmp = resolveTokenTempPath(roots);
    fs.mkdirSync(path.dirname(tmp), { recursive: true });
    // mode 0o600 — the file holds OAuth access tokens, so keep permissions
    // narrow even though this is only a short-lived mirror.
    fs.writeFileSync(tmp, JSON.stringify({ tokens, writtenAt: Date.now() }), { mode: 0o600 });
  } catch { /* best-effort cache */ }
}

function readWindowsTokenTemp(roots = getAntigravityRoots()) {
  try {
    const tmp = resolveTokenTempPath(roots);
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

function readWindowsCredentialTokens(platform = process.platform, roots = getAntigravityRoots()) {
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
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const parsed = JSON.parse(raw.trim() || '{"tokens":[]}');
    const valid = selectUsableTokens(parsed.tokens, Date.now())
      .map(token => ({ ...token, sourceFormat: 'windows-credential' }));
    if (valid.length === 0) return null;
    writeWindowsTokenTemp(valid, roots);
    return { ...tokenResultFromTokens(valid), sourceFormat: 'windows-credential' };
  } catch {
    return null;
  }
}

/**
 * Reads the OAuth token stored in the Linux Keyring (D-Bus Secret Service)
 * by delegating to python3. agy stores its token via the third-party `keyring`
 * pip package, so the python3 resolved from PATH must be able to `import keyring`
 * — typically true when agy was installed via pipx / system pip / an activated
 * venv, but NOT guaranteed for isolated venvs. On failure this returns null and
 * readToken falls back to disk files; see probeLinuxKeyringAvailability() for a
 * diagnostic that distinguishes "no token" from "keyring unreadable".
 *
 * To avoid spawning a python3 subprocess on every statusline refresh, a
 * successful read is written to the same short-lived JSON cache that the
 * Windows Credential Manager path uses.
 *
 * @param {string} [platform]
 * @returns {{ accessToken: string, expiry?: string, sourceFormat?: string, all: Array<{ accessToken: string, expiry?: string }> } | null}
 */
function readLinuxKeyringTokens(platform = process.platform, roots = getAntigravityRoots()) {
  if (platform !== 'linux') return null;

  try {
    const pythonPath = resolveSafeExecutable('python3') || resolveSafeExecutable('python');
    if (!pythonPath) return null;

    const raw = execFileSync(pythonPath, [
      '-c',
      `import keyring; print(keyring.get_password(${JSON.stringify(LINUX_KEYRING_SERVICE)}, ${JSON.stringify(LINUX_KEYRING_USERNAME)}) or '')`,
    ], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });

    const trimmed = raw.trim();
    if (!trimmed) return null;

    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      parsed = trimmed;
    }

    const token = typeof parsed === 'string'
      ? (!/\s/.test(parsed) ? { accessToken: parsed } : null)
      : parseTokenPayload(parsed);
    if (!token) return null;

    // Mirror into the shared temp cache so subsequent statusline renders
    // do not need to re-spawn python3.
    const tokens = [{
      accessToken: token.accessToken,
      expiry: token.expiry,
      sourceFormat: 'linux-keyring',
    }];
    writeWindowsTokenTemp(tokens, roots);

    return { ...token, sourceFormat: 'linux-keyring', all: tokens };
  } catch {
    return null;
  }
}

/**
 * Probes whether the Linux keyring read path is wired up, WITHOUT reading the
 * token itself. Returns null on non-linux platforms. On linux, reports whether
 * a python interpreter is resolvable on PATH and can `import keyring` (the
 * third-party pip package agy uses to store its OAuth token). Used by
 * diagnose-auth so users can tell "not logged in" apart from "system python3
 * is missing the keyring package".
 *
 * @param {string} [platform]
 * @returns {{ available: boolean, reason?: string, python?: string, status?: number, stderr?: string } | null}
 */
function probeLinuxKeyringAvailability(platform = process.platform) {
  if (platform !== 'linux') return null;

  const pythonPath = resolveSafeExecutable('python3') || resolveSafeExecutable('python');
  if (!pythonPath) return { available: false, reason: 'python-not-found' };

  try {
    execFileSync(pythonPath, ['-c', 'import keyring'], {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { available: true, python: pythonPath };
  } catch (error) {
    return {
      available: false,
      reason: 'keyring-not-importable',
      python: pythonPath,
      status: typeof error.status === 'number' ? error.status : undefined,
      stderr: error.stderr ? String(error.stderr).trim().slice(0, 200) : undefined,
    };
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
    keyringReader = readLinuxKeyringTokens,
  } = options;

  // Windows: agy stores its OAuth token in Credential Manager. Keep a short
  // JSON mirror so normal statusline renders do not spawn PowerShell every time.
  if (platform === 'win32') {
    const tempToken = readWindowsTokenTemp(roots);
    if (tempToken) return { ...tempToken, sourceFormat: tempToken.sourceFormat || 'windows-credential' };

    if (!skipWindowsCredential) {
      const credentialToken = credentialReader(platform, roots);
      if (credentialToken) return credentialToken;
    }
  }

  // Linux: agy stores its OAuth token in the system keyring (D-Bus Secret
  // Service). Check the short-lived JSON cache first; fall back to python3.
  if (platform === 'linux') {
    const tempToken = readWindowsTokenTemp(roots);
    if (tempToken) return { ...tempToken, sourceFormat: tempToken.sourceFormat || 'linux-keyring' };

    const keyringToken = normalizeKeyringTokenResult(keyringReader(platform, roots));
    if (keyringToken) return keyringToken;
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

function anyTokenFileExists(roots = getAntigravityRoots()) {
  for (const candidate of getTokenCandidates(roots)) {
    try {
      if (fs.existsSync(candidate)) return true;
    } catch { /* ignore */ }
  }
  return false;
}

function clearTokenTemp(roots = getAntigravityRoots()) {
  try {
    const tmp = resolveTokenTempPath(roots);
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  } catch { /* best effort */ }
}

module.exports = {
  ANTIGRAVITY_TOKEN_FILENAME,
  OAUTH_CREDS_FILENAME,
  WINDOWS_TOKEN_TEMP_TTL_MS,
  WINDOWS_TOKEN_EXPIRY_SKEW_MS,
  WINDOWS_CREDENTIAL_TARGETS,
  LINUX_KEYRING_SERVICE,
  LINUX_KEYRING_USERNAME,
  getTokenCandidates,
  isUsableAccessToken,
  selectUsableTokens,
  isTokenExpired,
  tokenResultFromTokens,
  normalizeExpiryDate,
  parseTokenPayload,
  writeWindowsTokenTemp,
  readWindowsTokenTemp,
  clearTokenTemp,
  buildWindowsCredentialScript,
  readWindowsCredentialTokens,
  readLinuxKeyringTokens,
  probeLinuxKeyringAvailability,
  readToken,
  anyTokenFileExists,
};
