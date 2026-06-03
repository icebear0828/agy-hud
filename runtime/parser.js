const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { resolveSafeExecutable, resolveAntigravityPath } = require('./paths.js');

function getGeminiHome() {
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  return path.join(home, '.gemini');
}

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
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
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
 * @returns {string|null}
 */
function getActiveAccountEmail() {
  try {
    const { readToken } = require('./quota/token.js');
    const { getCachedAccountEmail } = require('./quota/cache.js');
    const tok = readToken();
    if (tok) {
      const email = getCachedAccountEmail(tok);
      if (email) return email;
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

async function getSessionState(transcriptPath) {
  let steps = 0;
  let branch = 'main';
  let gitPath = null;
  let usage;
  let maxHistoricalCache = 0;
  let imageExhausted = null;

  try {
    const fileContent = fs.readFileSync(transcriptPath, 'utf8');
    for (const line of fileContent.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.step_index > steps) {
          steps = entry.step_index;
        }
        const contextWindow = findContextWindow(entry);
        if (contextWindow) {
          usage = contextWindow;
          const cacheReadVal = contextWindow.cache_read_input_tokens || 
                               (contextWindow.current_usage && contextWindow.current_usage.cache_read_input_tokens) || 0;
          if (cacheReadVal > maxHistoricalCache) {
            maxHistoricalCache = cacheReadVal;
          }
        }

        // Parse image model 429 rate limits.
        // Use deepFind on the already-parsed object instead of stringify+regex
        // to avoid false positives (e.g. step_index or token counts containing "429").
        const entryContent = typeof entry.content === 'string' ? entry.content : '';
        const isRateLimit = (
          deepFind(entry, 'RESOURCE_EXHAUSTED') !== undefined ||
          deepFind(entry, 'quotaResetDelay') !== undefined ||
          deepFind(entry, 'quotaResetTimeStamp') !== undefined ||
          entryContent.includes('HTTP 429') ||
          entryContent.includes('RESOURCE_EXHAUSTED')
        );
        if (isRateLimit) {
          let delayMs = 0;
          let timestampMs = 0;

          const delayVal = deepFind(entry, 'quotaResetDelay') ?? deepFind(entry, 'retryDelay');
          if (typeof delayVal === 'string' && delayVal) {
            delayMs = parseDurationToMs(delayVal);
          }

          const tsVal = deepFind(entry, 'quotaResetTimeStamp');
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
      } catch {
        // Skip invalid JSON lines
      }
    }
  } catch {
    // File might not exist yet
  }

  try {
    gitPath = resolveSafeExecutable('git');
    if (gitPath) {
      const gitBranch = execFileSync(gitPath, ['rev-parse', '--abbrev-ref', 'HEAD'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        cwd: process.cwd(),
      }).trim();
      branch = gitBranch;
    }
  } catch {
    // Not a git repo or git not found
  }

  const cwd = process.cwd();
  const normalizedCwd = cwd.replace(/\\/g, '/');
  const projectKey = normalizedCwd.replace(/:/g, '').replace(/\//g, '-');
  const projectMemoryDir = path.join(os.homedir(), '.claude', 'projects', projectKey, 'memory');

  // Detect memory files (GEMINI.md first — this is an agy plugin)
  let memoryFile;
  if (fs.existsSync(path.join(cwd, 'GEMINI.md'))) {
    memoryFile = 'GEMINI.md';
  } else if (fs.existsSync(path.join(cwd, 'CLAUDE.md'))) {
    memoryFile = 'CLAUDE.md';
  } else if (fs.existsSync(path.join(cwd, 'MEMORY.md'))) {
    memoryFile = 'MEMORY.md';
  } else {
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
  let hooksDir = path.join(cwd, '.git', 'hooks');
  if (gitPath) {
    try {
      const gitHooksPath = execFileSync(gitPath, ['rev-parse', '--git-path', 'hooks'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        cwd,
      }).trim();
      hooksDir = path.isAbsolute(gitHooksPath)
        ? gitHooksPath
        : path.resolve(cwd, gitHooksPath);
    } catch {}
  }
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

  const username = getActiveAccountEmail() || getFallbackUsername();
  const currentDir = path.basename(cwd);
  const state = { steps, branch, memoryFile, rulesCount, mcpCount, hooksCount, currentDir, username, maxHistoricalCache };
  if (usage) state.usage = usage;
  if (imageExhausted) state.imageExhausted = imageExhausted;
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

module.exports = {
  getSessionState,
  parseAgyInput
};
