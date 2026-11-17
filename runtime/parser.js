const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { resolveSafeExecutable, resolveAntigravityPath } = require('./paths.js');

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
    const geminiHome = getGeminiHome();
    const isCustomHome = geminiHome !== path.join(os.homedir(), '.gemini');
    const tok = readToken({
      roots: [path.join(geminiHome, 'antigravity-cli')],
      skipKeychain: isCustomHome,
    });
    if (tok) {
      if (tok.email && tok.sourceFormat !== 'oauth-creds') return tok.email;
      const email = getCachedAccountEmail(tok);
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

function getSystemMemoryUsage() {
  try {
    let totalBytes = 0;
    let freeBytes = 0;
    if (process.platform === 'linux' && fs.existsSync('/proc/meminfo')) {
      const meminfo = fs.readFileSync('/proc/meminfo', 'utf8');
      const totalMatch = /^MemTotal:\s+(\d+)\s+kB/m.exec(meminfo);
      const availMatch = /^MemAvailable:\s+(\d+)\s+kB/m.exec(meminfo);
      if (totalMatch && availMatch) {
        totalBytes = Number(totalMatch[1]) * 1024;
        freeBytes = Number(availMatch[1]) * 1024;
      }
    }
    if (!totalBytes) {
      totalBytes = os.totalmem();
      freeBytes = os.freemem();
    }
    if (!Number.isFinite(totalBytes) || totalBytes <= 0) return null;
    const clampedFree = Number.isFinite(freeBytes) ? Math.min(Math.max(freeBytes, 0), totalBytes) : 0;
    const usedBytes = totalBytes - clampedFree;
    const usedPercent = Math.round((usedBytes / totalBytes) * 100);
    return { totalBytes, usedBytes, freeBytes: clampedFree, usedPercent };
  } catch {
    return null;
  }
}

async function getSessionState(transcriptPath, customCwd = null) {
  let steps = 0;
  let branch = 'main';
  let gitPath = null;
  let usage;
  let flatUsage;
  let cumulativeOutputTokens = 0;
  let maxHistoricalCache = 0;
  let imageExhausted = null;
  let totalApiDurationMs = 0;
  let lastStepTimeMs = null;
  let transcriptOutputSpeed = null;
  let transcriptModelSelection = null;
  let transcriptModelId = null;
  let transcriptMode = null;

  try {
    const stat = fs.statSync(transcriptPath);
    const transcriptMtimeMs = stat.mtimeMs;
    const fileContent = fs.readFileSync(transcriptPath, 'utf8');
    const parsedEntries = [];
    for (const line of fileContent.split('\n')) {
      if (!line.trim()) continue;
      try {
        parsedEntries.push(JSON.parse(line));
      } catch {
        // Skip invalid JSON lines
      }
    }

    for (let i = 0; i < parsedEntries.length; i++) {
      const entry = parsedEntries[i];
      if (entry.step_index > steps) {
        steps = entry.step_index;
      }
      const entryTimeMs = entry.created_at ? Date.parse(entry.created_at) : null;
      if (entry.type === 'PLANNER_RESPONSE' && lastStepTimeMs !== null && entryTimeMs !== null && entryTimeMs >= lastStepTimeMs) {
        totalApiDurationMs += (entryTimeMs - lastStepTimeMs);
      }
      if (entryTimeMs !== null && Number.isFinite(entryTimeMs)) {
        lastStepTimeMs = entryTimeMs;
      }

      if (entry.type === 'USER_INPUT' && typeof entry.content === 'string') {
        const selMatch = entry.content.match(/changed setting `Model Selection` from [^\n]+? to ([^\n.]+)\./);
        if (selMatch && selMatch[1]) {
          transcriptModelSelection = selMatch[1].trim();
        }
        const modeMatch = entry.content.match(/changed setting `(?:Mode|Agent Mode|Permission Mode)` from [^\n]+? to ([^\n.]+)\./i);
        if (modeMatch && modeMatch[1]) {
          transcriptMode = modeMatch[1].trim();
        }
      }

      if (entry.type === 'PLANNER_RESPONSE') {
        if (typeof entry.model === 'string' && entry.model.trim()) {
          transcriptModelId = entry.model.trim();
        }
        if (typeof entry.output_tokens === 'number' && entry.output_tokens > 0 && entryTimeMs !== null && Number.isFinite(entryTimeMs)) {
          const nextEntry = parsedEntries[i + 1];
          const nextTimeMs = (nextEntry && nextEntry.created_at) ? Date.parse(nextEntry.created_at) : transcriptMtimeMs;
          if (Number.isFinite(nextTimeMs) && nextTimeMs - entryTimeMs >= 500) {
            transcriptOutputSpeed = entry.output_tokens / ((nextTimeMs - entryTimeMs) / 1000);
          }
        }
        if (typeof entry.input_tokens === 'number' || typeof entry.output_tokens === 'number') {
          const inTok = Number(entry.input_tokens) || 0;
          const outTok = Number(entry.output_tokens) || 0;
          const cacheReadTok = Number(entry.cache_read_tokens ?? entry.cache_read_input_tokens) || 0;
          const cacheCreateTok = Number(entry.cache_creation_tokens ?? entry.cache_creation_input_tokens) || 0;
          cumulativeOutputTokens += outTok;
          if (cacheReadTok > maxHistoricalCache) {
            maxHistoricalCache = cacheReadTok;
          }
          const totalIn = inTok + cacheReadTok + cacheCreateTok;
          const ctxSize = 1000000;
          flatUsage = {
            total_input_tokens: totalIn,
            total_output_tokens: cumulativeOutputTokens,
            context_window_size: ctxSize,
            used_percentage: Math.min(100, (totalIn / ctxSize) * 100),
            current_usage: {
              input_tokens: inTok,
              output_tokens: outTok,
              cache_read_input_tokens: cacheReadTok,
              cache_creation_input_tokens: cacheCreateTok,
            },
          };
        }
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
    }
  } catch {
    // File might not exist yet
  }

  const cwd = customCwd || process.cwd();

  try {
    gitPath = resolveSafeExecutable('git');
    if (gitPath) {
      const gitBranch = execFileSync(gitPath, ['rev-parse', '--abbrev-ref', 'HEAD'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        cwd,
      }).trim();
      branch = gitBranch;
    }
  } catch {
    // Not a git repo or git not found
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

  // Count MCP servers and read configured model/mode from settings.json
  let mcpCount = 0;
  let configuredModel = null;
  let configuredMode = null;
  try {
    const settingsPath = resolveAntigravityPath('settings.json');
    if (fs.existsSync(settingsPath)) {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      const mcps = settings.mcpServers || settings.mcp;
      if (mcps && typeof mcps === 'object') {
        mcpCount += Object.keys(mcps).length;
      }
      if (typeof settings.model === 'string' && settings.model.trim()) {
        configuredModel = settings.model.trim();
      }
      const rawMode = settings.agentMode || settings.cycleMode || settings.permissionMode || settings.mode;
      if (typeof rawMode === 'string' && rawMode.trim()) {
        configuredMode = rawMode.trim();
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
  const memoryUsage = getSystemMemoryUsage();
  const state = { steps, branch, memoryFile, rulesCount, mcpCount, hooksCount, currentDir, username, maxHistoricalCache, transcriptPath };
  if (usage) state.usage = usage;
  else if (flatUsage) state.usage = flatUsage;
  if (imageExhausted) state.imageExhausted = imageExhausted;
  if (totalApiDurationMs > 0) state.totalApiDurationMs = totalApiDurationMs;
  if (transcriptOutputSpeed !== null) state.transcriptOutputSpeed = transcriptOutputSpeed;
  if (transcriptModelSelection) state.transcriptModelSelection = transcriptModelSelection;
  if (transcriptModelId) state.transcriptModelId = transcriptModelId;
  if (configuredModel) state.configuredModel = configuredModel;
  if (transcriptMode || configuredMode) state.agentMode = transcriptMode || configuredMode;
  if (memoryUsage) state.memoryUsage = memoryUsage;
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

/**
 * Parses agy stdin `quota` map into internal providerQuota structure.
 * Supports gemini-5h, gemini-weekly, 3p-5h, 3p-weekly.
 * @param {Object} quotaObj
 * @returns {Object|null}
 */
function parseAgyQuota(quotaObj) {
  if (!quotaObj || typeof quotaObj !== 'object') return null;
  const result = {};

  if (quotaObj['gemini-5h'] || quotaObj['gemini-weekly']) {
    result.google = {};
    if (quotaObj['gemini-5h'] && typeof quotaObj['gemini-5h'] === 'object') {
      result.google.fiveHour = {
        remainingFraction: quotaObj['gemini-5h'].remaining_fraction,
        resetTime: quotaObj['gemini-5h'].reset_time,
      };
    }
    if (quotaObj['gemini-weekly'] && typeof quotaObj['gemini-weekly'] === 'object') {
      result.google.weekly = {
        remainingFraction: quotaObj['gemini-weekly'].remaining_fraction,
        resetTime: quotaObj['gemini-weekly'].reset_time,
      };
    }
  }

  if (quotaObj['3p-5h'] || quotaObj['3p-weekly']) {
    result.claude = {};
    if (quotaObj['3p-5h'] && typeof quotaObj['3p-5h'] === 'object') {
      result.claude.fiveHour = {
        remainingFraction: quotaObj['3p-5h'].remaining_fraction,
        resetTime: quotaObj['3p-5h'].reset_time,
      };
    }
    if (quotaObj['3p-weekly'] && typeof quotaObj['3p-weekly'] === 'object') {
      result.claude.weekly = {
        remainingFraction: quotaObj['3p-weekly'].remaining_fraction,
        resetTime: quotaObj['3p-weekly'].reset_time,
      };
    }
  }

  return Object.keys(result).length > 0 ? result : null;
}

module.exports = {
  getSessionState,
  parseAgyInput,
  parseAgyQuota,
};
