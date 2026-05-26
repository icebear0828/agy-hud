const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { resolveSafeExecutable, resolveAntigravityPath } = require('./paths.js');

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
async function getSessionState(transcriptPath) {
  let steps = 0;
  let branch = 'main';
  let gitPath = null;
  let usage;

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

  const state = { steps, branch, memoryFile, rulesCount, mcpCount, hooksCount };
  if (usage) state.usage = usage;
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
