const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const {
  getAntigravityRoots,
  resolveSafeExecutable,
  resolveAntigravityPath,
} = require('./paths.js');
const { FIVE_HOUR_WINDOW_THRESHOLD_MS } = require('./quota/models.js');

function getGeminiHome() {
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  return path.join(home, '.gemini');
}

/**
 * Last-resort email source: the id_token in ~/.gemini/oauth_creds.json. This is
 * the Gemini-CLI credential file, NOT agy's active-account source — agy neither
 * refreshes it nor rewrites it on account switch, so it can name a stale
 * account. It is only used when the authoritative source (the userinfo email
 * cached against the live token) is unavailable (offline / first run).
 * Display-only: the JWT signature is NOT verified.
 * @returns {string|null}
 */
function getOauthCredsEmail() {
  try {
    const credsPath = path.join(getGeminiHome(), 'oauth_creds.json');
    if (!fs.existsSync(credsPath)) return null;

    const raw = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
    if (!raw.id_token) return null;

    const parts = raw.id_token.split('.');
    if (parts.length !== 3) return null;

    // Base64url decode the payload section (index 1). Signature is NOT verified.
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (payload && payload.email) {
      return payload.email;
    }
  } catch {}
  return null;
}

/**
 * Fallback only: agy's account registry (~/.gemini/google_accounts.json `active`).
 * NOTE: agy does NOT rewrite this on account switch (verified — it lagged behind
 * a live switch), so it can be stale. Kept as a best-effort guess ranked below
 * the authoritative cached userinfo email.
 * @returns {string|null}
 */
function getActiveAccountFromRegistry() {
  try {
    const registryPath = path.join(getGeminiHome(), 'google_accounts.json');
    if (!fs.existsSync(registryPath)) return null;
    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    if (registry && typeof registry.active === 'string' && registry.active.includes('@')) {
      return registry.active;
    }
  } catch {}
  return null;
}

/**
 * Resolves the email of agy's active account for display.
 *
 * agy resolves the signed-in account from the live OAuth access token at
 * runtime and never persists it, so no local file reliably names the active
 * account after a switch. The authoritative value is the userinfo email the
 * quota refresh caches against the current token; we read that first and fall
 * back to the account registry / oauth_creds id_token only when it is absent.
 * @param {Object} [options]
 * @returns {string|null}
 */
function getRealHomeDir() {
  try {
    const info = os.userInfo();
    if (info && info.homedir) return info.homedir;
  } catch {}
  return os.homedir();
}

function getActiveAccountEmail(options = {}) {
  try {
    const {
      preloadedToken = undefined,
      cacheSnapshot = undefined,
      skipCredentialSubprocess = false,
      tokenReader = undefined,
    } = options;
    const { readToken } = require('./quota/token.js');
    const { getCachedAccountEmail } = require('./quota/cache.js');
    let tok;
    if (preloadedToken !== undefined) {
      tok = preloadedToken;
    } else {
      const geminiHome = getGeminiHome();
      const isCustomHome = path.resolve(geminiHome) !== path.resolve(path.join(getRealHomeDir(), '.gemini'));
      const roots = isCustomHome
        ? [path.join(geminiHome, 'antigravity-cli')]
        : getAntigravityRoots();
      const reader = tokenReader || readToken;
      tok = reader({
        roots,
        skipKeychain: isCustomHome,
        skipWindowsCredential: skipCredentialSubprocess,
        skipLinuxKeyring: skipCredentialSubprocess,
      });
    }
    if (tok) {
      if (tok.email && tok.sourceFormat !== 'oauth-creds') return tok.email;
      const email = getCachedAccountEmail(tok, cacheSnapshot);
      if (email) return email;
      if (tok.email) return tok.email;
    }
  } catch {}
  return getActiveAccountFromRegistry() || getOauthCredsEmail();
}

/**
 * Falls back to the OS username when no OAuth credentials are available.
 * @returns {string}
 */
function getFallbackUsername() {
  try {
    const userInfo = os.userInfo();
    return userInfo.username || '';
  } catch {
    return '';
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isContextWindow(value) {
  return isObject(value) && (
    Object.hasOwn(value, 'total_input_tokens') ||
    Object.hasOwn(value, 'total_output_tokens') ||
    Object.hasOwn(value, 'context_window_size') ||
    Object.hasOwn(value, 'used_percentage') ||
    isObject(value.current_usage)
  );
}

function findContextWindow(value, depth = 0) {
  if (!isObject(value) || depth > 4) return null;
  if (isContextWindow(value.context_window)) return value.context_window;
  if (isContextWindow(value)) return value;

  for (const child of Object.values(value)) {
    const found = findContextWindow(child, depth + 1);
    if (found) return found;
  }
  return null;
}

/**
 * Parses the transcript log to count steps and get branch info.
 * Also scans local config / workspace metadata (memory files, rules count, MCPs, hooks).
 * @param {string} transcriptPath
 * @returns {Promise<SessionState>}
 */
function parseDurationToMs(durationStr) {
  let ms = 0;
  const segments = [...durationStr.matchAll(/(\d+)([hms])/g)];
  if (segments.length > 0) {
    for (const [, val, unit] of segments) {
      const n = parseInt(val, 10);
      if (unit === 'h') ms += n * 60 * 60 * 1000;
      else if (unit === 'm') ms += n * 60 * 1000;
      else if (unit === 's') ms += n * 1000;
    }
  } else {
    const val = parseInt(durationStr, 10);
    if (Number.isFinite(val)) {
      ms = val * 1000;
    }
  }
  return ms;
}

/**
 * Recursively searches an object tree for a key, up to maxDepth levels deep.
 * Safer than JSON.stringify + regex for extracting nested API error fields.
 * @param {unknown} obj
 * @param {string} key
 * @param {number} [maxDepth=6]
 * @returns {unknown}
 */
function deepFind(obj, key, maxDepth = 6) {
  if (!obj || typeof obj !== 'object' || maxDepth === 0) return undefined;
  if (Object.prototype.hasOwnProperty.call(obj, key)) return obj[key];
  for (const v of Object.values(obj)) {
    const found = deepFind(v, key, maxDepth - 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

function lineMayContainContextWindow(line) {
  return (
    line.includes('context_window') ||
    line.includes('total_input_tokens') ||
    line.includes('total_output_tokens') ||
    line.includes('context_window_size') ||
    line.includes('used_percentage') ||
    line.includes('current_usage')
  );
}

function lineMayContainRateLimit(line) {
  return (
    line.includes('quotaResetDelay') ||
    line.includes('quotaResetTimeStamp') ||
    line.includes('RESOURCE_EXHAUSTED') ||
    line.includes('HTTP 429')
  );
}

async function getSessionState(transcriptPath, customCwd = null, options = {}) {
  let steps = 0;
  let branch = 'main';
  let gitPath = null;
  let usage;
  let maxHistoricalCache = 0;
  let imageExhausted = null;
  let totalApiDurationMs = 0;
  let lastStepTimeMs = null;
  let sessionStartedAt = null;

  if (typeof transcriptPath === 'string' && transcriptPath) {
    try {
      const fileContent = fs.readFileSync(transcriptPath, 'utf8');
      for (const line of fileContent.split('\n')) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          if (entry.step_index > steps) {
            steps = entry.step_index;
          }
          const entryTimeMs = entry.created_at ? Date.parse(entry.created_at) : null;
          if (entryTimeMs !== null && Number.isFinite(entryTimeMs)) {
            if (sessionStartedAt === null || entryTimeMs < sessionStartedAt) {
              sessionStartedAt = entryTimeMs;
            }
            if (entry.type === 'PLANNER_RESPONSE' && lastStepTimeMs !== null && entryTimeMs >= lastStepTimeMs) {
              totalApiDurationMs += (entryTimeMs - lastStepTimeMs);
            }
            lastStepTimeMs = entryTimeMs;
          }
          if (lineMayContainContextWindow(line)) {
            const contextWindow = findContextWindow(entry);
            if (contextWindow) {
              usage = contextWindow;
              const cacheReadVal = contextWindow.cache_read_input_tokens ||
                                   (contextWindow.current_usage && contextWindow.current_usage.cache_read_input_tokens) || 0;
              if (cacheReadVal > maxHistoricalCache) {
                maxHistoricalCache = cacheReadVal;
              }
            }
          }

          // Parse image model 429 rate limits.
          // Pre-filter raw line before structured inspection so normal transcript
          // lines pay zero tree-walk cost and numeric fields like step_index=429
          // never false-positive.
          if (lineMayContainRateLimit(line)) {
            const entryContent = typeof entry.content === 'string' ? entry.content : '';
            const delayVal = deepFind(entry, 'quotaResetDelay') ?? deepFind(entry, 'retryDelay');
            const tsVal = deepFind(entry, 'quotaResetTimeStamp');
            const statusVal = deepFind(entry, 'status');
            const isRateLimit = (
              delayVal !== undefined ||
              tsVal !== undefined ||
              statusVal === 'RESOURCE_EXHAUSTED' ||
              entryContent.includes('HTTP 429') ||
              entryContent.includes('RESOURCE_EXHAUSTED')
            );
            if (isRateLimit) {
              let delayMs = 0;
              let timestampMs = 0;

              if (typeof delayVal === 'string' && delayVal) {
                delayMs = parseDurationToMs(delayVal);
              }

              if (typeof tsVal === 'string' && tsVal) {
                const parsedTs = Date.parse(tsVal);
                if (Number.isFinite(parsedTs)) {
                  timestampMs = parsedTs;
                }
              }

              let resetTimeMs = 0;
              if (timestampMs > 0) {
                resetTimeMs = timestampMs;
              } else if (delayMs > 0) {
                const entryTime = entry.created_at ? new Date(entry.created_at).getTime() : Date.now();
                resetTimeMs = entryTime + delayMs;
              }

              if (resetTimeMs > Date.now()) {
                if (!imageExhausted || resetTimeMs > new Date(imageExhausted.resetTime).getTime()) {
                  imageExhausted = {
                    exhausted: true,
                    resetTime: new Date(resetTimeMs).toISOString()
                  };
                }
              }
            }
          }
        } catch {
          // Skip invalid JSON lines
        }
      }
    } catch {
      // File might not exist yet
    }
  }

  const cwd = customCwd || process.cwd();

  // Single combined git rev-parse for both hooks path and branch name (with timeout).
  let hooksDir = path.join(cwd, '.git', 'hooks');
  try {
    gitPath = resolveSafeExecutable('git');
    if (gitPath) {
      const gitOutput = execFileSync(gitPath, ['rev-parse', '--git-path', 'hooks', '--abbrev-ref', 'HEAD'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        cwd,
        timeout: 1000,
      });
      const gitLines = gitOutput.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      if (gitLines[0]) {
        hooksDir = path.isAbsolute(gitLines[0])
          ? gitLines[0]
          : path.resolve(cwd, gitLines[0]);
      }
      if (gitLines[1]) {
        branch = gitLines[1];
      }
    }
  } catch (err) {
    // On an unborn HEAD (fresh `git init` with no commits), git exits 128 on
    // HEAD after already printing `--git-path hooks` on line 1 of stdout.
    const partial = typeof err?.stdout === 'string' ? err.stdout : '';
    const firstLine = partial.split(/\r?\n/).map(s => s.trim()).find(Boolean);
    if (firstLine && firstLine !== 'HEAD') {
      hooksDir = path.isAbsolute(firstLine)
        ? firstLine
        : path.resolve(cwd, firstLine);
    }
  }

  const normalizedCwd = cwd.replace(/\\/g, '/');
  const projectKey = normalizedCwd.replace(/:/g, '').replace(/\//g, '-');
  const projectMemoryDir = path.join(os.homedir(), '.claude', 'projects', projectKey, 'memory');

  // Detect memory files (AGENTS.md first).
  const memoryCandidates = [
    'AGENTS.md', 'agents.md',
    'GEMINI.md', 'gemini.md',
    'CLAUDE.md', 'claude.md',
    'MEMORY.md', 'memory.md',
  ];
  let memoryFile;
  try {
    const workspaceEntries = new Set(fs.readdirSync(cwd));
    for (const candidate of memoryCandidates) {
      if (workspaceEntries.has(candidate)) {
        memoryFile = candidate;
        break;
      }
    }
  } catch {}
  if (memoryFile === undefined) {
    for (const candidate of memoryCandidates) {
      if (fs.existsSync(path.join(cwd, candidate))) {
        memoryFile = candidate;
        break;
      }
    }
  }
  if (memoryFile === undefined) {
    const projectMemoryPath = path.join(projectMemoryDir, 'MEMORY.md');
    if (fs.existsSync(projectMemoryPath)) {
      memoryFile = 'MEMORY.md';
    }
  }

  // Count rules
  let rulesCount = 0;
  const ruleDirs = [
    path.join(cwd, '.claude', 'rules'),
    path.join(cwd, '.cursor', 'rules'),
    path.join(cwd, '.github', 'rules'),
    path.join(cwd, '.gemini', 'rules')
  ];
  for (const dir of ruleDirs) {
    if (fs.existsSync(dir)) {
      try {
        const files = fs.readdirSync(dir);
        rulesCount += files.filter(f => f.endsWith('.md')).length;
      } catch {}
    }
  }

  // Count git hooks
  let hooksCount = 0;
  if (fs.existsSync(hooksDir)) {
    try {
      const files = fs.readdirSync(hooksDir);
      const activeHooks = files.filter(f => {
        return !f.endsWith('.sample') &&
               !f.endsWith('.disabled') &&
               fs.statSync(path.join(hooksDir, f)).isFile();
      });
      hooksCount = activeHooks.length;
    } catch {}
  }

  // Count MCP servers
  let mcpCount = 0;
  try {
    const settingsPath = resolveAntigravityPath('settings.json');
    if (fs.existsSync(settingsPath)) {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      const mcps = settings.mcpServers || settings.mcp;
      if (mcps && typeof mcps === 'object') {
        mcpCount += Object.keys(mcps).length;
      }
    }
  } catch {}
  try {
    const claudeConfigPath = process.platform === 'win32'
      ? path.join(os.homedir(), 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json')
      : path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
    if (fs.existsSync(claudeConfigPath)) {
      const config = JSON.parse(fs.readFileSync(claudeConfigPath, 'utf8'));
      const mcps = config.mcpServers || config.mcp;
      if (mcps && typeof mcps === 'object') {
        mcpCount += Object.keys(mcps).length;
      }
    }
  } catch {}

  const username = options?.skipUsername
    ? ''
    : (getActiveAccountEmail(options) || getFallbackUsername());
  const currentDir = path.basename(cwd);
  const state = {
    steps,
    branch,
    memoryFile,
    rulesCount,
    mcpCount,
    hooksCount,
    currentDir,
    username,
    maxHistoricalCache,
    transcriptPath,
    sessionStartedAt,
  };
  if (usage) state.usage = usage;
  if (imageExhausted) state.imageExhausted = imageExhausted;
  if (totalApiDurationMs > 0) state.totalApiDurationMs = totalApiDurationMs;
  return state;
}

/**
 * Parses the stdin JSON data provided by agy.
 * @param {string} jsonStr
 * @returns {Object|null}
 */
function parseAgyInput(jsonStr) {
  try {
    return JSON.parse(jsonStr);
  } catch {
    return null;
  }
}

function parseQuotaBucketEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const resetTime = typeof entry.reset_time === 'string' ? entry.reset_time : null;
  const hasValidResetTime = Boolean(resetTime && Number.isFinite(Date.parse(resetTime)));
  const rawFraction = entry.remaining_fraction;
  const hasNumericFraction = typeof rawFraction === 'number' && Number.isFinite(rawFraction);

  // Reject empty or malformed entries so they never overwrite valid cached
  // quota with 0%. Proto3 may omit a default 0 remaining_fraction, which is
  // only accepted when a valid parseable reset_time is present.
  if (!hasNumericFraction && !hasValidResetTime) return null;
  if (resetTime !== null && !hasValidResetTime) return null;

  let remainingFraction = hasNumericFraction ? rawFraction : 0;
  if (remainingFraction < 0) remainingFraction = 0;
  if (remainingFraction > 1) remainingFraction = 1;

  return {
    remainingFraction,
    resetTime: hasValidResetTime ? resetTime : undefined,
  };
}

function classifyStdinBucketKey(key, entry) {
  const lower = String(key || '').toLowerCase();
  let provider = null;
  if (lower.includes('argon')) provider = 'argon';
  else if (lower.startsWith('gemini-')) provider = 'google';
  else if (lower.startsWith('3p-')) provider = 'claude';
  if (!provider) return null;

  let winType = null;
  if (lower.includes('weekly')) winType = 'weekly';
  else if (lower.includes('5h') || lower.includes('fivehour')) winType = 'fiveHour';
  else if (typeof entry?.reset_in_seconds === 'number' && Number.isFinite(entry.reset_in_seconds) && entry.reset_in_seconds > 0) {
    winType = entry.reset_in_seconds * 1000 < FIVE_HOUR_WINDOW_THRESHOLD_MS ? 'fiveHour' : 'weekly';
  } else {
    // Bare bucket key (e.g. 'gemini-4-argon') defaults to weekly unless reset_in_seconds says 5h.
    winType = 'weekly';
  }
  return { provider, winType };
}

/**
 * Parses agy stdin `quota` map into internal providerQuota structure.
 * Supports gemini-5h, gemini-weekly, 3p-5h, 3p-weekly, argon-5h, argon-weekly,
 * and gemini-4-argon* bucket keys. Validates/clamps remaining_fraction ([0, 1])
 * and reset_time.
 * @param {Object} quotaObj
 * @returns {Object|null}
 */
function parseAgyQuota(quotaObj) {
  if (!quotaObj || typeof quotaObj !== 'object') return null;
  const result = {};

  for (const [key, entry] of Object.entries(quotaObj)) {
    const classified = classifyStdinBucketKey(key, entry);
    if (!classified) continue;
    const parsed = parseQuotaBucketEntry(entry);
    if (!parsed) continue;

    const { provider, winType } = classified;
    if (!result[provider]) result[provider] = {};
    const existing = result[provider][winType];
    if (!existing || parsed.remainingFraction < existing.remainingFraction) {
      result[provider][winType] = parsed;
    }
  }

  return Object.keys(result).length > 0 ? result : null;
}

module.exports = {
  getSessionState,
  getActiveAccountEmail,
  parseAgyInput,
  parseAgyQuota,
};
