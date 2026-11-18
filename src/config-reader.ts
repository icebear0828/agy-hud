import * as fs from 'node:fs';
import * as path from 'node:path';
import { createDebug } from './debug.ts';
import type { Paths } from './channel.ts';

const debug = createDebug('config-reader');
const MAX_RULE_ENTRIES = 10_000;
const MAX_RULE_DIRECTORIES = 1_000;

export interface ConfigCounts {
  claudeMdCount: number;
  memoryLabelName?: string;
  rulesCount: number;
  mcpCount: number;
  hooksCount: number;
}

function readJson(filePath: string | null | undefined): Record<string, unknown> | null {
  if (!filePath) return null;
  try {
    const value: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      debug(`Failed to read ${filePath}:`, error);
    }
    return null;
  }
}

const keysOf = (value: unknown): string[] =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value) : [];

const stringsOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

function realPath(inputPath: string): string | null {
  try {
    return fs.realpathSync.native(inputPath);
  } catch {
    return null;
  }
}

function countRules(dir: string | null | undefined, state = { visited: new Set<string>(), entries: 0, directories: 0 }): number {
  if (!dir) return 0;
  const root = realPath(dir);
  if (!root || state.visited.has(root) || state.directories >= MAX_RULE_DIRECTORIES) return 0;
  state.visited.add(root);
  state.directories += 1;

  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch (error) {
    debug(`Failed to read rules from ${dir}:`, error);
    return 0;
  }
  let count = 0;
  for (const entry of entries) {
    if (++state.entries > MAX_RULE_ENTRIES) break;
    const target = realPath(path.join(root, entry));
    if (!target || state.visited.has(target)) continue;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(target);
    } catch (error) {
      debug(`Failed to read rule ${target}:`, error);
      continue;
    }
    if (stat.isDirectory()) {
      count += countRules(target, state);
    } else if (stat.isFile() && entry.endsWith('.md')) {
      state.visited.add(target);
      count += 1;
    }
  }
  return count;
}

export function countConfigs(
  paths: Pick<Paths, 'user' | 'project' | 'claudeJson' | 'projectMemory'>,
  gitHooksCount = 0,
): ConfigCounts {
  const exists = (file: string | null | undefined): boolean => typeof file === 'string' && file.length > 0 && fs.existsSync(file);
  const { user, project } = paths;

  const userSettings = readJson(user.settings);
  const agyUserSettings = readJson(user.agySettings);
  const claudeJson = readJson(paths.claudeJson);
  const userMcp = new Set([
    ...keysOf(userSettings?.mcpServers),
    ...keysOf(agyUserSettings?.mcpServers ?? agyUserSettings?.mcp),
    ...keysOf(claudeJson?.mcpServers),
  ]);
  for (const name of stringsOf(claudeJson?.disabledMcpServers)) userMcp.delete(name);

  let claudeMdCount = [exists(user.claudeMd), exists(user.geminiMd)].filter(Boolean).length;
  let rulesCount = countRules(user.rules) + countRules(user.agyRules);
  let hooksCount = keysOf(userSettings?.hooks).length + keysOf(agyUserSettings?.hooks).length + Math.max(0, gitHooksCount);
  const projectMcp = new Set<string>();
  let memoryLabelName: string | undefined;

  if (project) {
    const projectMemoryChecks: Array<[string | null, string]> = [
      [project.agentsMd, 'AGENTS.md'],
      [project.geminiMd, 'GEMINI.md'],
      [project.claudeMd, 'CLAUDE.md'],
      [project.localMd, 'CLAUDE.local.md'],
      [project.dotClaudeMd, 'CLAUDE.md'],
      [project.dotLocalMd, 'CLAUDE.local.md'],
      [project.memoryMd, 'MEMORY.md'],
    ];
    for (const [file, label] of projectMemoryChecks) {
      if (exists(file)) {
        claudeMdCount += 1;
        if (!memoryLabelName) memoryLabelName = label;
      }
    }
    if (exists(paths.projectMemory)) {
      claudeMdCount += 1;
      if (!memoryLabelName) memoryLabelName = 'MEMORY.md';
    }

    rulesCount +=
      countRules(project.rules) +
      countRules(project.geminiRules) +
      countRules(project.agentsRules) +
      countRules(project.cursorRules) +
      countRules(project.githubRules);

    const projectSettings = readJson(project.settings);
    for (const name of keysOf(projectSettings?.mcpServers)) projectMcp.add(name);
    hooksCount += keysOf(projectSettings?.hooks).length;

    const localSettings = readJson(project.localSettings);
    for (const name of keysOf(localSettings?.mcpServers)) projectMcp.add(name);
    hooksCount += keysOf(localSettings?.hooks).length;

    const disabledMcpJson = new Set(stringsOf(localSettings?.disabledMcpjsonServers));
    for (const name of keysOf(readJson(project.mcpJson)?.mcpServers)) {
      if (!disabledMcpJson.has(name)) projectMcp.add(name);
    }
  } else if (exists(user.geminiMd)) {
    memoryLabelName = 'GEMINI.md';
  }

  return {
    claudeMdCount,
    ...(memoryLabelName ? { memoryLabelName } : {}),
    rulesCount,
    mcpCount: userMcp.size + projectMcp.size,
    hooksCount,
  };
}
