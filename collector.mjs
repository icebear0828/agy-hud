// The only code (with runtime/quota) that runs external programs or resolves filesystem paths.
// Logic (src/**/*.ts) runs caged and asks for probes by name; it never chooses a command line
// and never sees OAuth access tokens or secret credential files.
import { exec, execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import nodeModule from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getAntigravityRoots } from './runtime/paths.mjs';
import { detectUnicodeSupport } from './runtime/encoding.mjs';
import { getQuota, resolveActiveAccountSummary } from './runtime/quota.mjs';
import { getLocalPackageVersion, isRemoteVersionNewer } from './runtime/update-checker.mjs';

const SELF = fileURLToPath(import.meta.url);
export const GIT_MAX_OUTPUT_BYTES = 1024 * 1024;
const TREE_KILL_TIMEOUT_MS = 1000;
const WORKER_STARTUP_MS = 1500;

const expandHome = (p, home) => (p === '~' ? home : p.startsWith('~/') || p.startsWith('~\\') ? path.join(home, p.slice(2)) : p);
const homeOf = (env) => (process.platform === 'win32' ? env.USERPROFILE : env.HOME) || os.homedir();

export function agyPaths(env = process.env, home = homeOf(env)) {
  const customAgy = env.AGY_HUD_DATA_DIR?.trim() || env.AGY_CONFIG_DIR?.trim();
  const configDir = customAgy ? path.resolve(expandHome(customAgy, home)) : getAntigravityRoots(env, home)[0];
  const customClaude = env.CLAUDE_CONFIG_DIR?.trim();
  const claudeConfigDir = customClaude ? path.resolve(expandHome(customClaude, home)) : path.join(home, '.claude');
  const hudDir = path.join(configDir, 'agy-hud');
  return {
    home,
    configDir,
    claudeConfigDir,
    hudDir,
    claudeJson: customClaude ? path.join(claudeConfigDir, '.claude.json') : path.join(home, '.claude.json'),
    dataDir: path.join(hudDir, 'data'),
    strippedDir: path.join(hudDir, 'stripped'),
    configPath: path.join(hudDir, 'config.json'),
    overridePath: path.join(configDir, 'agy-hud.json'),
    legacyConfigPath: path.join(configDir, 'agy-hud-runtime', 'runtime', 'agy-hud.config.json'),
    undoPath: path.join(hudDir, 'config.undo.json'),
    heartbeat: path.join(hudDir, 'heartbeat.json'),
    updateStatusPath: path.join(configDir, 'agy-hud-update-status.json'),
  };
}

export const samePath = (a, b) => {
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return path.resolve(a) === path.resolve(b);
  }
};

function findLatestTranscript(configDir) {
  const brainDir = path.join(configDir, 'brain');
  let latest = null;
  let latestMtime = 0;
  try {
    if (!fs.existsSync(brainDir)) return null;
    for (const entry of fs.readdirSync(brainDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(brainDir, entry.name, '.system_generated', 'logs', 'transcript.jsonl');
      try {
        const st = fs.statSync(candidate);
        if (st.mtimeMs > latestMtime) {
          latestMtime = st.mtimeMs;
          latest = candidate;
        }
      } catch {}
    }
  } catch {}
  return latest;
}

function discoverAgyPluginHookFiles(home) {
  const pluginsDir = path.join(home, '.gemini', 'config', 'plugins');
  const files = [];
  try {
    if (!fs.existsSync(pluginsDir)) return files;
    for (const entry of fs.readdirSync(pluginsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      for (const rel of ['hooks.json', path.join('hooks', 'hooks.json')]) {
        const p = path.join(pluginsDir, entry.name, rel);
        try {
          if (fs.statSync(p).isFile()) files.push(p);
        } catch {}
      }
    }
  } catch {}
  return files;
}

const SUBAGENT_ID_PATTERNS = [
  /\\?"conversationId\\?"\s*:\s*\\?"([\w-]{8,128})\\?"/g,
  /(?:Launched subagent|conversationId)\s*[:=]\s*(?:\\?["'])?([\w-]{8,128})/gi,
  /conversation:\/\/([\w-]{8,128})/g,
];

const VALID_SUBAGENT_ID = /^[\w-]{1,128}$/;
const TODO_MUTATION_TOOLS = new Set([
  'write_file',
  'write_to_file',
  'edit_file',
  'replace_file_content',
  'multi_replace_file_content',
]);
const TODO_MD_PATH_RE = /(?:^|[\\/])(?:todo|task)\.md$/i;
const FALLBACK_TODO_TOOL_CALL_RE =
  /\\?"name\\?"\s*:\s*\\?"(write_file|write_to_file|edit_file|replace_file_content|multi_replace_file_content)\\?"[\s\S]*?\\?"(?:Path|TargetFile|path|file_path)\\?"\s*:\s*\\?"((?:\\.|[^"\\])+)\\?"/g;

function unquoteTranscriptArg(value) {
  if (typeof value !== 'string') return null;
  let s = value.trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    try {
      const parsed = JSON.parse(s);
      if (typeof parsed === 'string') s = parsed.trim();
    } catch {
      s = s.slice(1, -1).trim();
    }
  }
  return s || null;
}

function extractTodoFilePaths(content, seed = []) {
  const ordered = [];
  const moveOrAppend = (p) => {
    if (typeof p !== 'string' || !TODO_MD_PATH_RE.test(p)) return;
    const idx = ordered.indexOf(p);
    if (idx !== -1) ordered.splice(idx, 1);
    ordered.push(p);
  };

  for (const p of seed) {
    moveOrAppend(p);
  }

  if (!/(?:todo|task)\.md/i.test(content)) {
    return ordered;
  }

  for (const rawLine of content.split(/\r?\n/)) {
    if (!/(?:todo|task)\.md/i.test(rawLine)) continue;
    let entry = null;
    try {
      entry = JSON.parse(rawLine);
    } catch {}
    if (entry && typeof entry === 'object') {
      if (Array.isArray(entry.tool_calls)) {
        for (const tc of entry.tool_calls) {
          if (!tc || typeof tc.name !== 'string' || !TODO_MUTATION_TOOLS.has(tc.name)) continue;
          const args = tc.args ?? {};
          const p = unquoteTranscriptArg(args.Path ?? args.TargetFile ?? args.path ?? args.file_path);
          if (p && TODO_MD_PATH_RE.test(p)) moveOrAppend(p);
        }
      }
      if (Array.isArray(entry.message?.content)) {
        for (const block of entry.message.content) {
          if (block?.type !== 'tool_use' || typeof block.name !== 'string' || !TODO_MUTATION_TOOLS.has(block.name)) continue;
          const input = block.input ?? {};
          const p = unquoteTranscriptArg(input.Path ?? input.TargetFile ?? input.path ?? input.file_path);
          if (p && TODO_MD_PATH_RE.test(p)) moveOrAppend(p);
        }
      }
    } else {
      for (const m of rawLine.matchAll(FALLBACK_TODO_TOOL_CALL_RE)) {
        let rawVal = m[2];
        try {
          rawVal = JSON.parse(`"${rawVal}"`);
        } catch {}
        const p = unquoteTranscriptArg(rawVal);
        if (p && TODO_MD_PATH_RE.test(p)) moveOrAppend(p);
      }
    }
  }
  return ordered;
}

function extractSubagentIds(content, seed = []) {
  const ordered = [];
  const moveOrAppend = (id) => {
    if (typeof id !== 'string' || !VALID_SUBAGENT_ID.test(id)) return;
    const idx = ordered.indexOf(id);
    if (idx !== -1) ordered.splice(idx, 1);
    ordered.push(id);
  };

  for (const id of seed) {
    moveOrAppend(id);
  }

  if (/conversation(?:id|:\/\/)/i.test(content)) {
    const hits = [];
    for (const re of SUBAGENT_ID_PATTERNS) {
      for (const m of content.matchAll(re)) {
        const id = m[1];
        if (id && VALID_SUBAGENT_ID.test(id) && typeof m.index === 'number') {
          hits.push({ index: m.index, id });
        }
      }
    }
    hits.sort((a, b) => a.index - b.index);
    for (const hit of hits) {
      moveOrAppend(hit.id);
    }
  }
  return ordered;
}

function readTranscriptSlice(filePath, start, end) {
  const len = Math.max(0, end - start);
  if (len === 0) return '';
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.allocUnsafe(len);
    let totalRead = 0;
    while (totalRead < len) {
      const bytesRead = fs.readSync(fd, buf, totalRead, len - totalRead, start + totalRead);
      if (bytesRead <= 0) break;
      totalRead += bytesRead;
    }
    return buf.subarray(0, totalRead).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function readSubagentMapCache(cacheFile) {
  if (!cacheFile) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (
      raw &&
      typeof raw === 'object' &&
      typeof raw.realpath === 'string' &&
      typeof raw.ino === 'number' &&
      typeof raw.size === 'number' &&
      Number.isSafeInteger(raw.size) &&
      raw.size >= 0 &&
      Array.isArray(raw.ids)
    ) {
      return raw;
    }
  } catch {}
  return null;
}

function writeSubagentMapCache(dataDir, cacheFile, entry) {
  if (!dataDir || !cacheFile) return;
  const tmp = `${cacheFile}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(tmp, JSON.stringify(entry), { mode: 0o600 });
    fs.renameSync(tmp, cacheFile);
  } catch {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {}
  }
}

function scanTranscriptIncremental(transcriptPath, dataDir) {
  const empty = { ids: [], todoFiles: [] };
  if (!transcriptPath) return empty;
  try {
    const realTranscript = fs.realpathSync(transcriptPath);
    const st = fs.statSync(realTranscript);
    if (!st.isFile()) return empty;

    const cacheFile = dataDir ? path.join(dataDir, 'agy-subagent-map.json') : null;
    const cached = readSubagentMapCache(cacheFile);
    if (st.size === 0) {
      if (cacheFile && cached && cached.realpath === realTranscript) {
        try { fs.rmSync(cacheFile, { force: true }); } catch {}
      }
      return empty;
    }

    const maxBytes = 16 * 1024 * 1024;
    const sameFile = Boolean(cached && cached.realpath === realTranscript && cached.ino === st.ino);

    let ids;
    let todoFiles;
    if (sameFile && cached.size === st.size) {
      ids = cached.ids.filter((id) => typeof id === 'string' && VALID_SUBAGENT_ID.test(id));
      todoFiles = Array.isArray(cached.todoFiles)
        ? cached.todoFiles.filter((p) => typeof p === 'string' && TODO_MD_PATH_RE.test(p))
        : [];
    } else if (sameFile && st.size > cached.size) {
      const overlapStart = Math.max(0, cached.size - 512);
      const start = Math.max(overlapStart, st.size - maxBytes);
      const seedIds = start === overlapStart ? cached.ids : [];
      const seedTodos = start === overlapStart && Array.isArray(cached.todoFiles) ? cached.todoFiles : [];
      const content = readTranscriptSlice(realTranscript, start, st.size);
      ids = extractSubagentIds(content, seedIds);
      todoFiles = extractTodoFilePaths(content, seedTodos);
      writeSubagentMapCache(dataDir, cacheFile, {
        realpath: realTranscript,
        ino: st.ino,
        size: st.size,
        ids: ids.slice(-128),
        todoFiles: todoFiles.slice(-32),
      });
    } else {
      const start = Math.max(0, st.size - maxBytes);
      const content = readTranscriptSlice(realTranscript, start, st.size);
      ids = extractSubagentIds(content);
      todoFiles = extractTodoFilePaths(content);
      writeSubagentMapCache(dataDir, cacheFile, {
        realpath: realTranscript,
        ino: st.ino,
        size: st.size,
        ids: ids.slice(-128),
        todoFiles: todoFiles.slice(-32),
      });
    }
    return { ids, todoFiles };
  } catch {
    return empty;
  }
}

function resolveSubagentTranscriptsFromIds(configDir, ids) {
  const result = {};
  if (!configDir || !Array.isArray(ids) || ids.length === 0) return result;
  try {
    const brainRoot = fs.realpathSync(path.join(configDir, 'brain'));
    const validEntries = [];
    for (const id of ids) {
      const candidate = path.join(configDir, 'brain', id, '.system_generated', 'logs', 'transcript.jsonl');
      try {
        const real = fs.realpathSync(candidate);
        if (real.startsWith(`${brainRoot}${path.sep}`) && fs.statSync(real).isFile()) {
          validEntries.push([id, real]);
        }
      } catch {}
    }
    for (const [id, real] of validEntries.slice(-64)) {
      result[id] = real;
    }
  } catch {}
  return result;
}

export function discoverAgySubagentTranscripts(configDir, transcriptPath, dataDir) {
  const { ids } = scanTranscriptIncremental(transcriptPath, dataDir);
  return resolveSubagentTranscriptsFromIds(configDir, ids);
}

function isInsideRoot(filePath, rootDir) {
  if (!filePath || !rootDir) return false;
  const rel = path.relative(rootDir, filePath);
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function resolveSafeTodoFiles({ rawTodoPaths, cwd, projectDir, convBrainDirs, home }) {
  if (!Array.isArray(rawTodoPaths) || rawTodoPaths.length === 0) return [];
  const safeRoots = new Set();
  const addRoot = (dir) => {
    if (typeof dir !== 'string' || !dir) return;
    safeRoots.add(path.resolve(dir));
    try {
      safeRoots.add(fs.realpathSync(dir));
    } catch {}
  };
  addRoot(cwd);
  addRoot(projectDir);
  for (const dir of convBrainDirs) addRoot(dir);
  if (home) addRoot(path.join(home, 'ai-tasks'));

  const roots = [...safeRoots];
  const granted = [];
  for (const rawPath of rawTodoPaths) {
    if (typeof rawPath !== 'string' || !rawPath) continue;
    const expanded = home ? expandHome(rawPath, home) : rawPath;
    const candidate = path.isAbsolute(expanded) ? expanded : cwd ? path.resolve(cwd, expanded) : null;
    if (!candidate) continue;
    try {
      const real = fs.realpathSync(candidate);
      if (!TODO_MD_PATH_RE.test(real)) continue;
      if (!fs.statSync(real).isFile()) continue;
      if (!roots.some((rootDir) => isInsideRoot(real, rootDir))) continue;
      if (!granted.includes(real)) granted.push(real);
    } catch {}
  }
  return granted;
}

export function logicPaths(paths, input) {
  const absolute = (p) => (typeof p === 'string' && path.isAbsolute(p) ? p : null);
  const cwd = absolute(input?.workspace?.current_dir) ?? absolute(input?.cwd);
  let transcript = absolute(input?.transcript_path);
  if ((!transcript || !fs.existsSync(transcript)) && typeof input?.conversation_id === 'string' && /^[\w-]{1,128}$/.test(input.conversation_id)) {
    const candidate = path.join(paths.configDir, 'brain', input.conversation_id, '.system_generated', 'logs', 'transcript.jsonl');
    if (fs.existsSync(candidate) || !transcript) transcript = candidate;
  }
  if (!transcript && input === null) {
    transcript = findLatestTranscript(paths.configDir);
  }

  const user = {
    claudeMd: path.join(paths.claudeConfigDir, 'CLAUDE.md'),
    geminiMd: path.join(paths.home, '.gemini', 'GEMINI.md'),
    rules: path.join(paths.claudeConfigDir, 'rules'),
    agyRules: path.join(paths.home, '.gemini', 'config', 'rules'),
    agents: path.join(paths.claudeConfigDir, 'agents'),
    agyConfigAgents: path.join(paths.home, '.gemini', 'config', 'agents'),
    agyAgents: path.join(paths.home, '.gemini', 'agents'),
    agyCliAgents: path.join(paths.configDir, 'agents'),
    settings: path.join(paths.claudeConfigDir, 'settings.json'),
    agySettings: path.join(paths.configDir, 'settings.json'),
    mcpConfig: path.join(paths.home, '.gemini', 'config', 'mcp_config.json'),
    agyMcpConfig: path.join(paths.configDir, 'mcp_config.json'),
    agyHookFiles: discoverAgyPluginHookFiles(paths.home),
  };

  let project = null;
  if (cwd) {
    const claudeDir = path.join(cwd, '.claude');
    const ownClaude = !samePath(claudeDir, paths.claudeConfigDir);
    project = {
      claudeMd: path.join(cwd, 'CLAUDE.md'),
      localMd: path.join(cwd, 'CLAUDE.local.md'),
      agentsMd: path.join(cwd, 'AGENTS.md'),
      geminiMd: path.join(cwd, 'GEMINI.md'),
      memoryMd: path.join(cwd, 'MEMORY.md'),
      mcpJson: path.join(cwd, '.mcp.json'),
      localAgyHudConfig: path.join(cwd, 'agy-hud.config.json'),
      dotClaudeMd: ownClaude ? path.join(claudeDir, 'CLAUDE.md') : null,
      dotLocalMd: path.join(claudeDir, 'CLAUDE.local.md'),
      rules: ownClaude ? path.join(claudeDir, 'rules') : null,
      geminiRules: path.join(cwd, '.gemini', 'rules'),
      agentsRules: path.join(cwd, '.agents', 'rules'),
      cursorRules: path.join(cwd, '.cursor', 'rules'),
      githubRules: path.join(cwd, '.github', 'rules'),
      agents: ownClaude ? path.join(claudeDir, 'agents') : null,
      geminiAgents: path.join(cwd, '.gemini', 'agents'),
      agentsAgents: path.join(cwd, '.agents', 'agents'),
      settings: ownClaude ? path.join(claudeDir, 'settings.json') : null,
      localSettings: path.join(claudeDir, 'settings.local.json'),
    };
  }

  const normalizedCwd = cwd ? cwd.replace(/\\/g, '/') : '';
  const projectKey = normalizedCwd ? normalizedCwd.replace(/:/g, '').replace(/\//g, '-') : '';
  const projectMemory = projectKey ? path.join(paths.claudeConfigDir, 'projects', projectKey, 'memory', 'MEMORY.md') : null;
  const projectDir = absolute(input?.workspace?.project_dir);
  const convBrainDirs = [];
  if (typeof input?.conversation_id === 'string' && /^[\w-]{1,128}$/.test(input.conversation_id)) {
    convBrainDirs.push(path.join(paths.configDir, 'brain', input.conversation_id));
  }
  if (transcript) {
    const candidateConvDir = path.resolve(transcript, '..', '..', '..');
    if (samePath(path.dirname(candidateConvDir), path.join(paths.configDir, 'brain'))) {
      convBrainDirs.push(candidateConvDir);
    }
  }
  const scanned = scanTranscriptIncremental(transcript, paths.dataDir);
  const agySubagentTranscripts = resolveSubagentTranscriptsFromIds(paths.configDir, scanned.ids);
  const todoFiles = resolveSafeTodoFiles({
    rawTodoPaths: scanned.todoFiles,
    cwd,
    projectDir,
    convBrainDirs,
    home: paths.home,
  });

  return {
    data: paths.dataDir,
    config: paths.configPath,
    override: paths.overridePath,
    legacyConfig: paths.legacyConfigPath,
    heartbeat: paths.heartbeat,
    claudeJson: paths.claudeJson,
    user,
    project,
    projectMemory,
    transcript,
    subagents: transcript ? path.join(path.dirname(transcript), path.basename(transcript, '.jsonl'), 'subagents') : null,
    agySubagentTranscripts,
    todoFiles,
  };
}

export function readGrants(root, named) {
  const flat = (value) => (value && typeof value === 'object' ? Object.values(value).flatMap(flat) : typeof value === 'string' ? [value] : []);
  const grants = [root, ...flat(named)];
  const dirGrants = [
    named.user?.rules,
    named.user?.agyRules,
    named.user?.agents,
    named.user?.agyConfigAgents,
    named.user?.agyAgents,
    named.user?.agyCliAgents,
    named.project?.rules,
    named.project?.geminiRules,
    named.project?.agentsRules,
    named.project?.cursorRules,
    named.project?.githubRules,
    named.project?.agents,
    named.project?.geminiAgents,
    named.project?.agentsAgents,
  ].filter(Boolean);
  for (const dir of dirGrants) {
    try { grants.push(fs.realpathSync(dir)); } catch {}
  }
  return [...new Set(grants)];
}

const MOVED_INTO_DATA = ['daily-cost.json', 'speed-cache', 'transcript-cursors'];

export function prepareDataDir({ configDir, hudDir, dataDir }) {
  if (fs.lstatSync(dataDir, { throwIfNoEntry: false })?.isSymbolicLink()) fs.rmSync(dataDir);
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  for (const name of MOVED_INTO_DATA) {
    for (const base of [hudDir, configDir]) {
      const from = path.join(base, name);
      const to = path.join(dataDir, name);
      if (fs.existsSync(from) && !fs.existsSync(to)) {
        try { fs.renameSync(from, to); } catch {}
      }
    }
  }
  const sweep = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) fs.rmSync(full, { force: true });
      else if (entry.isDirectory()) sweep(full);
    }
  };
  sweep(dataDir);
  return fs.realpathSync(dataDir);
}

export const strippedName = (source) => `${crypto.hash('sha256', `${process.version}\0${source}`)}.js`;

function strip(source) {
  const emitWarning = process.emitWarning;
  process.emitWarning = () => {};
  try {
    return nodeModule.stripTypeScriptTypes(source);
  } finally {
    process.emitWarning = emitWarning;
  }
}

export function stripLogic(dir, root) {
  try {
    if (fs.lstatSync(dir, { throwIfNoEntry: false })?.isSymbolicLink()) fs.rmSync(dir);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const rootUrl = pathToFileURL(path.join(root, path.sep)).href;
    const files = {};
    for (const file of fs.readdirSync(path.join(root, 'src'), { recursive: true })) {
      if (!file.endsWith('.ts')) continue;
      const sourcePath = path.join(root, 'src', file);
      const source = fs.readFileSync(sourcePath, 'utf8');
      const name = strippedName(source);
      files[pathToFileURL(sourcePath).href.slice(rootUrl.length)] = name;
      const target = path.join(dir, name);
      if (fs.existsSync(target)) continue;
      const tmp = `${target}.${process.pid}.tmp`;
      try {
        fs.writeFileSync(tmp, strip(source), { mode: 0o600 });
        fs.renameSync(tmp, target);
      } catch (err) {
        try {
          fs.rmSync(tmp, { force: true });
        } catch {}
        throw err;
      }
    }
    const current = new Set(Object.values(files));
    const now = Date.now();
    const staleTmpAgeMs = 60 * 1000;
    for (const name of fs.readdirSync(dir)) {
      if (current.has(name)) continue;
      const full = path.join(dir, name);
      if (name.endsWith('.tmp')) {
        try {
          const st = fs.statSync(full);
          if (now - st.mtimeMs <= staleTmpAgeMs) continue;
        } catch {
          continue;
        }
      }
      try {
        fs.rmSync(full, { force: true });
      } catch {}
    }
    return { dir, files };
  } catch {
    return null;
  }
}

function readJsonObject(file, maxBytes = 64 * 1024) {
  try {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      if (!fs.fstatSync(fd).isFile() || fs.fstatSync(fd).size > maxBytes) return null;
      const value = JSON.parse(fs.readFileSync(fd, 'utf8'));
      return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

export function userSettings(paths) {
  const files = [readJsonObject(paths.overridePath), readJsonObject(paths.configPath), readJsonObject(paths.legacyConfigPath)];
  return (section, key) => files.find((f) => f?.[section] && typeof f[section] === 'object' && key in f[section])?.[section][key];
}

export function usagePaths(paths, env = process.env, setting = userSettings(paths)) {
  return resolveUsagePaths({ read: setting('display', 'externalUsagePath'), write: setting('display', 'externalUsageWritePath') }, paths.home, env);
}

export function probesToStart(setting) {
  const early = [];
  if (setting('gitStatus', 'enabled') !== false && setting('jjStatus', 'enabled') !== true) early.push('git.status');
  if (setting('display', 'showUsage') !== false) early.push('agy.quota');
  return early;
}

export function resolveUsagePaths({ read, write }, home = os.homedir(), env = process.env) {
  const resolve = (value) => {
    const expanded = typeof value === 'string'
      ? expandHome(value.trim(), home).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, name) => env[name] ?? m)
      : '';
    return path.isAbsolute(expanded) ? path.normalize(expanded) : null;
  };
  const target = resolve(write);
  return { read: resolve(read), write: target && path.extname(target).toLowerCase() === '.json' ? target : null };
}

function readText(file, maxBytes = 1024 * 1024) {
  try {
    const stat = fs.statSync(file);
    return stat.isFile() && stat.size <= maxBytes ? { text: fs.readFileSync(file, 'utf8'), mtimeMs: stat.mtimeMs } : null;
  } catch {
    return null;
  }
}

export function writeUsageSnapshot(target, snapshot, now = Date.now()) {
  if (!target || !snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return false;
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${now}.tmp`);
  try {
    if (!fs.statSync(path.dirname(target)).isDirectory()) return false;
    fs.writeFileSync(tmp, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, target);
    fs.chmodSync(target, 0o600);
    return true;
  } catch {
    fs.rmSync(tmp, { force: true });
    return false;
  }
}

export function isExtraCmdAllowed(env = process.env) {
  return ['1', 'true', 'yes', 'on'].includes(
    (env.AGY_HUD_ALLOW_EXTRA_CMD ?? env.CLAUDE_HUD_ALLOW_EXTRA_CMD)?.trim().toLowerCase() ?? ''
  );
}

export function parseExtraCmdArg(argv = process.argv, env = process.env) {
  const index = argv.findIndex((arg) => arg === '--extra-cmd' || arg.startsWith('--extra-cmd='));
  if (index === -1 || !isExtraCmdAllowed(env)) return null;
  const arg = argv[index];
  return (arg === '--extra-cmd' ? argv[index + 1] : arg.slice('--extra-cmd='.length)) || null;
}

export function runExtraCmd(cmd, timeout = 3000) {
  return new Promise((resolve) => {
    exec(cmd, { timeout, maxBuffer: 10 * 1024, windowsHide: true }, (error, stdout) => {
      resolve(error ? null : String(stdout).trim() || null);
    });
  });
}

// ---- git

export class GitTimeoutError extends Error {}

export function createGitEnvironment(base = process.env) {
  return { ...base, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never', GIT_NO_LAZY_FETCH: '1' };
}

export function runGit(cwd, args, timeout, platform = process.platform) {
  if (platform === 'win32') {
    const gitExecutable = resolveWindowsExecutable('git');
    if (!gitExecutable) return Promise.reject(new Error('Unable to resolve an absolute git.exe from PATH'));
    return runGitInWorker(gitExecutable, cwd, args, timeout);
  }
  return new Promise((resolve, reject) => {
    execFile('git', [...args], {
      cwd, timeout, maxBuffer: GIT_MAX_OUTPUT_BYTES, encoding: 'utf8', windowsHide: true, shell: false, env: createGitEnvironment(),
    }, (error, stdout) => {
      if (!error) resolve(stdout);
      else reject(error.killed ? new GitTimeoutError(`git ${args.join(' ')} timed out`) : error);
    });
  });
}

export function runGitInWorker(gitExecutable, cwd, args, timeout) {
  return new Promise((resolve, reject) => {
    const worker = spawn(process.execPath, [SELF, '--git-worker', gitExecutable, cwd, ...args], {
      env: createGitEnvironment(), windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'ignore', 'ipc'],
    });
    const chunks = [];
    let bytes = 0;
    let settled = false;
    const settle = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!error) return resolve(Buffer.concat(chunks).toString('utf8'));
      if (worker.connected) worker.disconnect();
      worker.stdout?.destroy();
      worker.unref();
      reject(error);
    };
    const timer = setTimeout(() => settle(new GitTimeoutError(`git ${args.join(' ')} timed out`)), timeout + WORKER_STARTUP_MS);
    worker.stdout?.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > GIT_MAX_OUTPUT_BYTES) settle(new Error(`git output exceeded ${GIT_MAX_OUTPUT_BYTES} bytes`));
      else chunks.push(chunk);
    });
    worker.once('error', (error) => settle(error));
    worker.once('close', (code) => settle(code === 0 ? null : new Error(`git exited with code ${code}`)));
  });
}

export async function terminateWindowsProcessTree(child, spawnImpl = spawn, environment = process.env) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;
  const taskkillPath = resolveTaskkillPath(environment);
  if (!pid || !Number.isSafeInteger(pid) || pid <= 0 || !taskkillPath) {
    child.kill();
    return;
  }
  await new Promise((resolve) => {
    let settled = false;
    let timer;
    const finish = (fallback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (fallback && child.exitCode === null && child.signalCode === null) child.kill();
      resolve();
    };
    let killer;
    try {
      killer = spawnImpl(taskkillPath, ['/PID', String(pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' });
    } catch {
      child.kill();
      return resolve();
    }
    timer = setTimeout(() => { killer.kill(); finish(true); }, TREE_KILL_TIMEOUT_MS);
    killer.once('error', () => finish(true));
    killer.once('exit', (code) => finish(code !== 0));
  });
}

export function resolveTaskkillPath(environment = process.env) {
  const systemRoot = environment.SystemRoot ?? environment.SYSTEMROOT;
  if (!systemRoot || systemRoot.includes('\0')) return null;
  if (!/^[A-Za-z]:[\\/]/.test(systemRoot) || !path.win32.isAbsolute(systemRoot)) return null;
  return path.win32.join(path.win32.normalize(systemRoot), 'System32', 'taskkill.exe');
}

export function resolveWindowsExecutable(name, environment = process.env, resolveCandidate = (candidate) => {
  try {
    const resolved = fs.realpathSync(candidate);
    return fs.statSync(resolved).isFile() ? resolved : null;
  } catch {
    return null;
  }
}) {
  const pathValue = Object.entries(environment).find(([key]) => key.toLowerCase() === 'path')?.[1];
  if (!pathValue) return null;
  for (const rawEntry of pathValue.split(path.win32.delimiter)) {
    const entry = rawEntry.trim().replace(/^"(.*)"$/, '$1');
    if (!entry || entry.includes('\0') || !path.win32.isAbsolute(entry)) continue;
    const resolved = resolveCandidate(path.win32.join(entry, `${name}.exe`));
    if (resolved && path.win32.isAbsolute(resolved)) return resolved;
  }
  return null;
}

async function untrustedConfigOverrides(cwd) {
  const overrides = ['-c', 'core.quotePath=false', '--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'protocol.allow=never'];
  let listed;
  try {
    listed = await runGit(cwd, ['config', '--show-scope', '-z', '--get-regexp', '^filter\\.'], 1000);
  } catch {
    return overrides;
  }
  const drivers = new Set();
  const fields = listed.split('\0');
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const [scope, entry] = [fields[i], fields[i + 1]];
    if (scope === 'global' || scope === 'system') continue;
    const key = entry.split('\n', 1)[0];
    const name = key.slice('filter.'.length, key.lastIndexOf('.'));
    if (!/^[\w.-]+$/.test(name)) throw new Error('a repo filter driver git could not be told to skip');
    drivers.add(name);
  }
  for (const name of drivers) {
    overrides.push('-c', `filter.${name}.clean=`, '-c', `filter.${name}.process=`, '-c', `filter.${name}.required=false`);
  }
  return overrides;
}

export function parseGitHubRemoteUrl(remoteUrl) {
  if (typeof remoteUrl !== 'string') return null;
  const trimmed = remoteUrl.trim();
  const match = /^(?:https?:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i.exec(trimmed);
  return match ? { host: 'github.com', owner: match[1], name: match[2] } : null;
}

// ---- jj

export function isJjRepo(cwd) {
  const marker = (p) => {
    try { return fs.lstatSync(p).isDirectory() ? 'directory' : 'other'; } catch { return null; }
  };
  let dir = realDirectory(cwd);
  for (let depth = 0; dir && depth < 64; depth++) {
    if (marker(path.join(dir, '.jj')) === 'directory') return true;
    if (marker(path.join(dir, '.git')) !== null) return false;
    const parent = path.dirname(dir);
    dir = parent === dir ? null : parent;
  }
  return false;
}

function realDirectory(cwd) {
  try {
    const resolved = fs.realpathSync(cwd);
    return fs.lstatSync(resolved).isDirectory() ? resolved : null;
  } catch {
    return null;
  }
}

export const JJ_ARGS = ['--ignore-working-copy', '--at-operation=@', '--no-pager', 'log', '-r', '@', '--no-graph', '--color', 'never', '-T',
  'change_id.shortest(8) ++ "\\x1f" ++ self.local_bookmarks().map(|bookmark| bookmark.name()).join("\\x1e") ++ "\\x1f" ++ '
  + 'if(self.empty(), "0", "1") ++ "\\x1f" ++ if(self.conflict(), "1", "0")'];

const run = (file, args, options) => new Promise((resolve) => {
  execFile(file, args, { encoding: 'utf8', windowsHide: true, shell: false, ...options }, (error, stdout) => resolve(error ? null : stdout));
});

// ---- subcommands & facts

export const isNodeSupported = (version) => {
  const [major, minor] = String(version).replace(/^v/, '').split('.').map(Number);
  return major > 22 || (major === 22 && minor >= 18);
};

function findRuntimes(env = process.env, home = os.homedir(), platform = process.platform) {
  const exe = platform === 'win32' ? 'node.exe' : path.join('bin', 'node');
  const managers = [
    ['nvm', path.join(env.NVM_DIR || path.join(home, '.nvm'), 'versions', 'node'), ''],
    ['nvm-windows', env.NVM_HOME || path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'nvm'), 'win'],
    ['fnm', path.join(env.FNM_DIR || path.join(home, platform === 'darwin' ? 'Library/Application Support' : '.local/share', 'fnm'), 'node-versions'), 'installation'],
    ['mise', path.join(env.MISE_DATA_DIR || path.join(home, '.local', 'share', 'mise'), 'installs', 'node'), ''],
    ['asdf', path.join(env.ASDF_DATA_DIR || path.join(home, '.asdf'), 'installs', 'nodejs'), ''],
    ['volta', path.join(env.VOLTA_HOME || path.join(home, '.volta'), 'tools', 'image', 'node'), ''],
  ];
  const found = [];
  for (const [manager, dir, inner] of managers) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch {}
    for (const name of names) {
      if (!/^v?\d+\.\d+\.\d+$/.test(name)) continue;
      const file = inner === 'win' ? path.join(dir, name, 'node.exe') : path.join(dir, name, inner, exe);
      if (fs.existsSync(file)) found.push({ manager, version: name.replace(/^v/, ''), path: file, supported: isNodeSupported(name) });
    }
  }
  const system = platform === 'win32'
    ? [path.join(env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node.exe')]
    : ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node'];
  for (const file of system) if (fs.existsSync(file)) found.push({ manager: 'system', version: '', path: file, supported: null });
  return found;
}

export function writeHeartbeat(paths, { outcome, stdin = null, now = Date.now(), env = process.env }) {
  const columns = Number.parseInt(env.COLUMNS ?? '', 10);
  const record = {
    at: now,
    runtime: process.versions.bun ? `bun ${process.versions.bun}` : process.version,
    path: process.execPath,
    outcome,
    columns: columns > 0 ? columns : null,
    stdin,
  };
  try {
    fs.mkdirSync(paths.hudDir, { recursive: true });
    const tmp = `${paths.heartbeat}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
    fs.renameSync(tmp, paths.heartbeat);
  } catch {}
}

export function commandFacts({ root, paths, env = process.env, cwd = process.cwd() }) {
  const pkg = readJsonObject(path.join(root, 'package.json'));
  const account = resolveActiveAccountSummary(env, paths.home);
  return {
    runtime: {
      name: process.versions.bun ? 'bun' : 'node',
      version: process.versions.bun ?? process.versions.node,
      path: process.execPath,
      supported: !process.versions.bun && isNodeSupported(process.versions.node),
    },
    runtimes: findRuntimes(env, paths.home),
    plugin: { root, version: typeof pkg?.version === 'string' ? pkg.version : null },
    configPath: paths.configPath,
    undoPath: paths.undoPath,
    cwd,
    account,
    heartbeat: readJsonObject(paths.heartbeat, 512 * 1024),
  };
}

const CAPABILITY_KEYS = ['externalUsagePath', 'externalUsageWritePath'];

export function writeConfig(paths, config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('not a config object');
  const onDisk = readJsonObject(paths.configPath)?.display ?? {};
  const { display: returned, ...next } = config;
  const display = { ...(returned && typeof returned === 'object' ? returned : {}) };
  for (const key of CAPABILITY_KEYS) {
    delete display[key];
    if (Object.hasOwn(onDisk, key)) display[key] = onDisk[key];
  }
  if (Object.keys(display).length > 0) next.display = display;
  fs.mkdirSync(paths.hudDir, { recursive: true });
  fs.writeFileSync(paths.undoPath, fs.existsSync(paths.configPath) ? fs.readFileSync(paths.configPath) : '{}\n', { mode: 0o600 });
  replaceFile(paths.configPath, `${JSON.stringify(next, null, 2)}\n`);
}

export function undoConfig(paths) {
  const previous = fs.readFileSync(paths.undoPath, 'utf8');
  const current = fs.existsSync(paths.configPath) ? fs.readFileSync(paths.configPath, 'utf8') : '{}\n';
  replaceFile(paths.configPath, previous);
  fs.writeFileSync(paths.undoPath, current, { mode: 0o600 });
}

function replaceFile(file, text) {
  const target = fs.existsSync(file) ? fs.realpathSync(file) : file;
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, target);
}

// ---- Probes

export function createProbes({ cwd, argv = process.argv, env = process.env, paths, usage = { read: null, write: null }, early = [] }) {
  const extraCmd = parseExtraCmdArg(argv, env);
  const extra = extraCmd ? runExtraCmd(extraCmd) : Promise.resolve(null);
  let overrides;
  const git = async (args, timeout, safe = true) => {
    if (typeof cwd !== 'string' || !cwd) return null;
    try {
      const prefix = safe ? await (overrides ??= untrustedConfigOverrides(cwd)) : [];
      return { stdout: await runGit(cwd, [...prefix, ...args], timeout) };
    } catch (error) {
      return { error: error instanceof GitTimeoutError ? 'timeout' : 'failed' };
    }
  };

  const countGitHooks = async () => {
    if (typeof cwd !== 'string' || !cwd) return 0;
    let hooksDir = path.join(cwd, '.git', 'hooks');
    try {
      const res = await git(['rev-parse', '--git-path', 'hooks'], 500, false);
      if (res?.stdout?.trim()) {
        const raw = res.stdout.trim();
        hooksDir = path.isAbsolute(raw) ? raw : path.resolve(cwd, raw);
      }
    } catch {}
    try {
      if (!fs.existsSync(hooksDir)) return 0;
      return fs.readdirSync(hooksDir).filter((f) => {
        if (f.endsWith('.sample') || f.endsWith('.disabled')) return false;
        try { return fs.statSync(path.join(hooksDir, f)).isFile(); } catch { return false; }
      }).length;
    } catch {
      return 0;
    }
  };

  const resolveGitRepoRemote = async () => {
    if (typeof cwd !== 'string' || !cwd) return null;
    try {
      const res = await git(['config', '--get', 'remote.origin.url'], 500, false);
      return res?.stdout ? parseGitHubRemoteUrl(res.stdout) : null;
    } catch {
      return null;
    }
  };

  const readAgyQuotaProbe = async () => {
    const roots = paths?.configDir ? [paths.configDir] : getAntigravityRoots(env, paths?.home);
    const cachePath = paths?.configDir ? path.join(paths.configDir, 'agy-hud-quota-cache.json') : undefined;
    const quotaData = await getQuota({ fast: true, roots, cachePath }).catch(() => []);
    const account = resolveActiveAccountSummary(env, paths?.home);
    let updateInfo = null;
    try {
      const updateFile = paths?.updateStatusPath;
      if (updateFile && fs.existsSync(updateFile)) {
        const raw = JSON.parse(fs.readFileSync(updateFile, 'utf8'));
        const localVersion = getLocalPackageVersion();
        if (raw?.updateAvailable && localVersion) {
          updateInfo = {
            updateAvailable: isRemoteVersionNewer(raw.latestVersion, localVersion),
            latestVersion: raw.latestVersion,
          };
        }
      }
    } catch {}
    return {
      models: Array.isArray(quotaData) ? [...quotaData] : [],
      providerQuota: quotaData?.providerQuota ?? null,
      unavailableReason: quotaData?.unavailableReason ?? null,
      tierName: account.tier ?? null,
      accountEmail: account.email ?? null,
      updateInfo,
    };
  };

  const probes = {
    'git.status': () => git(['status', '--porcelain=v2', '--branch', '-z', '--ignore-submodules=dirty'], 1000),
    'git.numstat': () => git(['diff-index', '-M', '--numstat', '-z', '--ignore-submodules=dirty', 'HEAD'], 2000),
    'git.branch': () => git(['rev-parse', '--abbrev-ref', 'HEAD'], 1000, false),
    'git.describe': () => git(['describe', '--tags', '--exact-match', 'HEAD'], 1000, false),
    'git.hooks': () => countGitHooks(),
    'git.repo': () => resolveGitRepoRemote(),
    jj: async () => {
      const dir = typeof cwd === 'string' && isJjRepo(cwd) ? realDirectory(cwd) : null;
      const jj = process.platform === 'win32' ? resolveWindowsExecutable('jj') : 'jj';
      return dir && jj ? run(jj, JJ_ARGS, { cwd: dir, timeout: 2000, maxBuffer: 16 * 1024 }) : null;
    },
    memory: async () => {
      if (process.platform === 'linux') return { meminfo: readText('/proc/meminfo')?.text ?? null };
      if (process.platform === 'darwin') return { vmStat: await run('/usr/bin/vm_stat', [], { timeout: 1000 }) };
      return {};
    },
    extra: () => extra,
    'usage.read': () => (usage.read ? readText(usage.read)?.text ?? null : null),
    'usage.target': () => {
      if (!usage.write) return null;
      try {
        if (!fs.statSync(path.dirname(usage.write)).isDirectory()) return null;
      } catch {
        return null;
      }
      return readText(usage.write) ?? { text: null, mtimeMs: null };
    },
    'agy.quota': () => readAgyQuotaProbe(),
    'agy.unicode': () => detectUnicodeSupport({ env }),
  };

  const started = new Map();
  const once = (name) => {
    if (!started.has(name)) started.set(name, probes[name]());
    return started.get(name);
  };
  const ask = async (names) => {
    const answers = {};
    await Promise.all([...new Set(Array.isArray(names) ? names : [])]
      .filter((name) => typeof name === 'string' && Object.hasOwn(probes, name))
      .map(async (name) => { answers[name] = await once(name); }));
    return answers;
  };
  ask.start = () => early.forEach(once);
  return ask;
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF && process.argv[2] === '--git-worker') {
  const [gitExecutable, cwd, ...args] = process.argv.slice(3);
  const gitName = path.basename(gitExecutable ?? '').toLowerCase();
  if (!gitExecutable || gitExecutable.includes('\0') || !path.isAbsolute(gitExecutable)
    || (gitName !== 'git' && gitName !== 'git.exe') || !cwd) {
    process.exit(2);
  }
  const git = spawn(gitExecutable, args, { cwd, env: createGitEnvironment(), windowsHide: true, shell: false, stdio: ['ignore', 'inherit', 'ignore'] });
  git.once('error', () => process.exit(1));
  git.once('exit', (code) => process.exit(code ?? 1));
  process.once('disconnect', () => {
    void terminateWindowsProcessTree(git).finally(() => process.exit(1));
  });
}
