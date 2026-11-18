import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { getAntigravityRoots, resolveAntigravityPath, resolveSafeExecutable } from '../paths.mjs';

export const ANTIGRAVITY_TOKEN_FILENAME = 'antigravity-oauth-token';
export const OAUTH_CREDS_FILENAME = 'oauth_creds.json';
export const WINDOWS_TOKEN_TEMP_TTL_MS = 5 * 60 * 1000;
export const WINDOWS_TOKEN_EXPIRY_SKEW_MS = 60 * 1000;
export const WINDOWS_CREDENTIAL_TARGETS = [
  'gemini:antigravity',
  'LegacyGeneric:target=gemini:antigravity',
];
export const KEYCHAIN_SERVICE = 'gemini';
export const KEYCHAIN_ACCOUNT = 'antigravity';
export const LINUX_KEYRING_SERVICE = KEYCHAIN_SERVICE;
export const LINUX_KEYRING_USERNAME = KEYCHAIN_ACCOUNT;

export function decodeKeyringRaw(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let decoded = trimmed;
  if (trimmed.startsWith('go-keyring-base64:')) {
    try {
      decoded = Buffer.from(trimmed.slice(18), 'base64').toString('utf8');
    } catch {
      return null;
    }
  }
  try {
    return JSON.parse(decoded);
  } catch {
    return decoded;
  }
}

export function extractEmailFromIdToken(idToken) {
  if (!idToken || typeof idToken !== 'string') return undefined;
  const parts = idToken.split('.');
  if (parts.length !== 3) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
    if (payload && typeof payload.email === 'string' && payload.email.includes('@')) {
      return payload.email;
    }
  } catch {}
  return undefined;
}

export function getTokenCandidates(roots = getAntigravityRoots()) {
  const candidates = [];
  for (const root of roots) {
    candidates.push(path.join(root, ANTIGRAVITY_TOKEN_FILENAME));
    if (path.basename(root) === 'antigravity-cli') {
      candidates.push(path.join(path.dirname(root), OAUTH_CREDS_FILENAME));
    }
  }
  return [...new Set(candidates)];
}

export function isUsableAccessToken(token, writtenAt = 0, now = Date.now()) {
  if (!token || !token.accessToken) return false;
  if (token.expiry) {
    const expiresAt = new Date(token.expiry).getTime();
    if (Number.isFinite(expiresAt)) {
      return expiresAt - WINDOWS_TOKEN_EXPIRY_SKEW_MS > now;
    }
  }
  return Boolean(writtenAt && now - writtenAt < WINDOWS_TOKEN_TEMP_TTL_MS);
}

export function selectUsableTokens(tokens, writtenAt = 0, now = Date.now()) {
  return (Array.isArray(tokens) ? tokens : []).filter((token) => isUsableAccessToken(token, writtenAt, now));
}

export function isTokenExpired(token, now = Date.now()) {
  if (!token || !token.expiry) return false;
  const expiresAt = new Date(token.expiry).getTime();
  return Number.isFinite(expiresAt) && expiresAt - WINDOWS_TOKEN_EXPIRY_SKEW_MS <= now;
}

export function tokenResultFromTokens(tokens) {
  if (!tokens || tokens.length === 0) return null;
  return {
    accessToken: tokens[0].accessToken,
    expiry: tokens[0].expiry,
    sourceFormat: tokens[0].sourceFormat,
    email: tokens[0].email,
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
    return { ...token, sourceFormat: token.sourceFormat || 'linux-keyring' };
  }
  return null;
}

function resolveTokenTempPath(roots = getAntigravityRoots()) {
  const candidates = (Array.isArray(roots) ? roots : [])
    .filter(Boolean)
    .map((root) => path.join(root, 'agy-hud-token.json'));
  if (candidates.length > 0) return candidates[0];
  return resolveAntigravityPath('agy-hud-token.json');
}

export function normalizeExpiryDate(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  if (typeof value === 'string') {
    if (/^\d+$/.test(value)) return new Date(Number(value)).toISOString();
    return value;
  }
  return undefined;
}

export function parseTokenPayload(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const rawEmail = (typeof raw.id_token_email === 'string' && raw.id_token_email.includes('@'))
    ? raw.id_token_email
    : ((typeof raw.email === 'string' && raw.email.includes('@'))
      ? raw.email
      : extractEmailFromIdToken(raw.id_token || (raw.token && raw.token.id_token)));

  if (raw.token && typeof raw.token === 'object' && raw.token.access_token) {
    return {
      accessToken: raw.token.access_token,
      expiry: normalizeExpiryDate(raw.token.expiry),
      sourceFormat: 'antigravity-cli',
      ...(rawEmail ? { email: rawEmail } : {}),
    };
  }

  if (raw.access_token) {
    return {
      accessToken: raw.access_token,
      expiry: normalizeExpiryDate(raw.expiry || raw.expiry_date),
      sourceFormat: 'oauth-creds',
      ...(rawEmail ? { email: rawEmail } : {}),
    };
  }

  return null;
}

export function writeWindowsTokenTemp(tokens, roots = getAntigravityRoots()) {
  if (!Array.isArray(tokens) || tokens.length === 0) return;
  try {
    const tmp = resolveTokenTempPath(roots);
    fs.mkdirSync(path.dirname(tmp), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ tokens, writtenAt: Date.now() }), { mode: 0o600 });
  } catch {}
}

export function readWindowsTokenTemp(roots = getAntigravityRoots()) {
  try {
    const tmp = resolveTokenTempPath(roots);
    const raw = JSON.parse(fs.readFileSync(tmp, 'utf8'));
    return tokenResultFromTokens(selectUsableTokens(raw.tokens, raw.writtenAt));
  } catch {
    return null;
  }
}

export function buildWindowsCredentialScript() {
  const targets = WINDOWS_CREDENTIAL_TARGETS.map((target) => `'${target.replace(/'/g, "''")}'`).join(',');
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

export function readWindowsCredentialTokens(platform = process.platform, roots = getAntigravityRoots()) {
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
      .map((token) => ({ ...token, sourceFormat: 'windows-credential' }));
    if (valid.length === 0) return null;
    writeWindowsTokenTemp(valid, roots);
    return { ...tokenResultFromTokens(valid), sourceFormat: 'windows-credential' };
  } catch {
    return null;
  }
}

export function readLinuxKeyringTokens(platform = process.platform, roots = getAntigravityRoots()) {
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
    const parsed = decodeKeyringRaw(trimmed);
    if (!parsed) return null;
    const token = typeof parsed === 'string'
      ? (!/\s/.test(parsed) ? { accessToken: parsed } : null)
      : parseTokenPayload(parsed);
    if (!token) return null;
    const tokens = [{
      accessToken: token.accessToken,
      expiry: token.expiry,
      sourceFormat: 'linux-keyring',
      ...(token.email ? { email: token.email } : {}),
    }];
    writeWindowsTokenTemp(tokens, roots);
    return { ...token, sourceFormat: 'linux-keyring', all: tokens };
  } catch {
    return null;
  }
}

export function readMacosKeychainTokens(platform = process.platform) {
  if (platform !== 'darwin') return null;
  try {
    const securityPath = resolveSafeExecutable('security') || '/usr/bin/security';
    if (!fs.existsSync(securityPath)) return null;
    const raw = execFileSync(securityPath, [
      'find-generic-password',
      '-s',
      KEYCHAIN_SERVICE,
      '-a',
      KEYCHAIN_ACCOUNT,
      '-w',
    ], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const parsed = decodeKeyringRaw(raw);
    if (!parsed) return null;
    const token = typeof parsed === 'string'
      ? (!/\s/.test(parsed) ? { accessToken: parsed } : null)
      : parseTokenPayload(parsed);
    if (!token) return null;
    const tokens = [{
      accessToken: token.accessToken,
      expiry: token.expiry,
      sourceFormat: 'macos-keychain',
      ...(token.email ? { email: token.email } : {}),
    }];
    return { ...token, sourceFormat: 'macos-keychain', all: tokens };
  } catch {
    return null;
  }
}

export function probeMacosKeychainAvailability(platform = process.platform) {
  if (platform !== 'darwin') return null;
  const securityPath = resolveSafeExecutable('security') || '/usr/bin/security';
  return { available: fs.existsSync(securityPath), security: securityPath };
}

export function probeLinuxKeyringAvailability(platform = process.platform) {
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

export function readToken(options = {}) {
  const {
    platform = process.platform,
    roots = getAntigravityRoots(),
    skipWindowsCredential = false,
    skipKeychain = false,
    credentialReader = readWindowsCredentialTokens,
    keyringReader = readLinuxKeyringTokens,
    keychainReader = readMacosKeychainTokens,
  } = options;

  if (platform === 'darwin' && !skipKeychain) {
    const keychainToken = keychainReader(platform, roots);
    if (keychainToken) return keychainToken;
  }

  if (platform === 'win32') {
    const tempToken = readWindowsTokenTemp(roots);
    if (tempToken) return { ...tempToken, sourceFormat: tempToken.sourceFormat || 'windows-credential' };
    if (!skipWindowsCredential) {
      const credentialToken = credentialReader(platform, roots);
      if (credentialToken) return credentialToken;
    }
  }

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
    } catch {}
  }
  return null;
}

export function anyTokenFileExists(roots = getAntigravityRoots()) {
  for (const candidate of getTokenCandidates(roots)) {
    try {
      if (fs.existsSync(candidate)) return true;
    } catch {}
  }
  return false;
}

export function clearTokenTemp(roots = getAntigravityRoots()) {
  try {
    const tmp = resolveTokenTempPath(roots);
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  } catch {}
}
