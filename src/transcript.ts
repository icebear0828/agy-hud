import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { createHash } from 'node:crypto';
import { createDebug } from './debug.ts';
import type { AgentEntry, SessionTokenUsage, StdinData, TodoItem, ToolEntry, TranscriptData } from './types.ts';
import { displayLabel, sanitizeDisplayText } from './utils/sanitize.ts';
import { truncateString } from './utils/truncate.ts';
import { sanitizeTranscriptModel, splitModelAndEffort } from './model-source.ts';
import { effortInfo } from './effort.ts';

const debug = createDebug('transcript');

const TOOLS_KEPT = 20;
const AGENTS_KEPT = 10;
const TOOLS_TRACKED = 256;
const NAME_MAX_LEN = 64;
const ADVISOR_MODEL_MAX_LEN = 64;
const MESSAGE_ID_MAX_LEN = 128;
const MESSAGE_IDS_MAX = 4096;
const MCP_ERRORS_MAX = 64;
const MCP_TOOL = /^mcp__(.+?)__(.+)$/;
const AGY_MCP_TOOL = /^mcp_([^_]+)_(.+)$/;
const EFFORT_COMMAND = /^<local-command-stdout>Set effort level to (\w+)/;

interface Usage {
  input_tokens?: unknown;
  output_tokens?: unknown;
  cache_creation_input_tokens?: unknown;
  cache_read_input_tokens?: unknown;
}

interface Block {
  type?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  is_error?: boolean;
}

interface AgyToolCall {
  name?: string;
  args?: Record<string, unknown>;
}

interface Entry {
  type?: string;
  subtype?: string;
  operation?: string;
  status?: string;
  step_index?: unknown;
  content?: unknown;
  timestamp?: string;
  created_at?: string;
  isSidechain?: boolean;
  advisorModel?: unknown;
  model?: unknown;
  input_tokens?: unknown;
  output_tokens?: unknown;
  cache_read_tokens?: unknown;
  cache_read_input_tokens?: unknown;
  cache_creation_tokens?: unknown;
  cache_creation_input_tokens?: unknown;
  tool_calls?: AgyToolCall[];
  message?: { id?: unknown; model?: unknown; content?: Block[] | string; usage?: Usage };
  toolUseResult?: { resolvedModel?: unknown; isAsync?: unknown; status?: unknown; agentId?: unknown };
  compactMetadata?: { postTokens?: unknown };
  attachment?: { type?: string; prompt?: unknown };
  context_window?: unknown;
}

const emptyTranscript = (): TranscriptData => ({ tools: [], skills: [], mcpServers: [], mcpErrors: [], agents: [], todos: [] });
const ZERO_USAGE: SessionTokenUsage = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
const USAGE_FIELDS = Object.keys(ZERO_USAGE) as (keyof SessionTokenUsage)[];

const count = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;

function addUsage(total: SessionTokenUsage, usage: SessionTokenUsage): void {
  for (const field of USAGE_FIELDS) total[field] += usage[field];
}

const name = (value: unknown): string | undefined => displayLabel(value, NAME_MAX_LEN, '…') || undefined;

function mcpServer(toolName: string): string | undefined {
  const m1 = MCP_TOOL.exec(toolName)?.[1];
  if (m1) return name(m1);
  const m2 = AGY_MCP_TOOL.exec(toolName)?.[1];
  return m2 ? name(m2) : undefined;
}

function unquoteRaw(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  let s = value.trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    try {
      const parsed = JSON.parse(s);
      if (typeof parsed === 'string') s = parsed;
    } catch {
      s = s.slice(1, -1);
    }
  }
  return s || undefined;
}

function unquoteAgyArg(value: unknown): string | undefined {
  const raw = unquoteRaw(value);
  return raw ? (sanitizeDisplayText(raw) || undefined) : undefined;
}

const text = (value: unknown): string | undefined =>
  typeof value === 'string' ? sanitizeDisplayText(value) || undefined : undefined;

function toolTarget(toolName: string, input: Record<string, unknown> | undefined): string | undefined {
  if (!input) return undefined;
  switch (toolName) {
    case 'Read':
    case 'Write':
    case 'Edit':
      return text(input.file_path ?? input.path);
    case 'read_file':
    case 'write_file':
    case 'write_to_file':
    case 'edit_file':
    case 'replace_file_content':
    case 'multi_replace_file_content':
      return unquoteAgyArg(input.Path ?? input.TargetFile ?? input.path ?? input.file_path);
    case 'Glob':
    case 'Grep':
      return text(input.pattern);
    case 'grep_search':
      return unquoteAgyArg(input.Query ?? input.pattern);
    case 'find_by_name':
      return unquoteAgyArg(input.Pattern ?? input.pattern);
    case 'Skill':
      return name(input.skill);
    case 'Bash':
    case 'run_command': {
      const command = (unquoteAgyArg(input.CommandLine) ?? text(input.command))?.replace(/\s+/g, ' ').trim();
      if (!command) return undefined;
      return command.length > 30 ? `${truncateString(command, 30, '').trimEnd()}...` : command;
    }
  }
  return undefined;
}

function taskStatus(status: unknown): TodoItem['status'] | null {
  switch (status) {
    case 'pending':
    case 'not_started':
      return 'pending';
    case 'in_progress':
    case 'running':
      return 'in_progress';
    case 'completed':
    case 'complete':
    case 'done':
      return 'completed';
    default:
      return null;
  }
}

function toTodo(value: unknown): TodoItem[] {
  const todo = value as { content?: unknown; status?: unknown } | null;
  const content = text(todo?.content);
  const status = taskStatus(todo?.status);
  return content && status ? [{ content, status }] : [];
}

const MAX_TODO_FILE_BYTES = 256 * 1024;
const TODO_FILE_PATH_RE = /(?:^|[\\/])(?:todo|task)\.md$/i;
const FENCE_OPEN_RE = /^\s*(`{3,}|~{3,})/;
const SECTION_DIVIDER_RE = /^\s*(?:(?:-\s*){3,}|(?:\*\s*){3,})\s*$/;
const TOP_HEADING_RE = /^\s*#{1,2}\s+(.+)$/;
const SUB_HEADING_RE = /^\s*#{3,6}\s+(.+)$/;
const TODO_LINE_RE = /^\s*[-*]\s+\[([ xX/])\]\s+(.+)$/;

interface MarkdownTodoSection {
  headings: string[];
  todos: TodoItem[];
}

function parseTodoMarkerStatus(marker: string): TodoItem['status'] {
  if (marker === 'x' || marker === 'X') return 'completed';
  if (marker === '/') return 'in_progress';
  return 'pending';
}

function parseMarkdownSections(markdown: string): MarkdownTodoSection[] {
  let current: MarkdownTodoSection = { headings: [], todos: [] };
  const sections: MarkdownTodoSection[] = [current];
  let fenceChar: string | null = null;
  let fenceLen = 0;

  for (const line of markdown.split(/\r?\n/)) {
    const fenceMatch = FENCE_OPEN_RE.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (fenceChar === null) {
        fenceChar = marker[0];
        fenceLen = marker.length;
        continue;
      }
      if (marker[0] === fenceChar && marker.length >= fenceLen && /^\s*(?:`{3,}|~{3,})\s*$/.test(line)) {
        fenceChar = null;
        fenceLen = 0;
      }
      continue;
    }
    if (fenceChar !== null) continue;

    if (SECTION_DIVIDER_RE.test(line)) {
      current = { headings: [], todos: [] };
      sections.push(current);
      continue;
    }

    const topHeading = TOP_HEADING_RE.exec(line);
    if (topHeading) {
      const h = sanitizeDisplayText(topHeading[1]).trim();
      current = { headings: h ? [h] : [], todos: [] };
      sections.push(current);
      continue;
    }

    const subHeading = SUB_HEADING_RE.exec(line);
    if (subHeading) {
      const h = sanitizeDisplayText(subHeading[1]).trim();
      if (h) current.headings.push(h);
      continue;
    }

    const todoMatch = TODO_LINE_RE.exec(line);
    if (todoMatch) {
      const content = sanitizeDisplayText(todoMatch[2]);
      if (content) {
        current.todos.push({ content, status: parseTodoMarkerStatus(todoMatch[1]) });
      }
    }
  }
  return sections;
}

function parseRawTodoLines(fragment: string): TodoItem[] {
  return parseMarkdownSections(fragment).flatMap((sec) => sec.todos);
}

export function extractMarkdownTodos(markdown: string, hint?: string): TodoItem[] {
  if (typeof markdown !== 'string' || !markdown.trim()) return [];
  const nonEmpty = parseMarkdownSections(markdown).filter((sec) => sec.todos.length > 0);
  if (nonEmpty.length === 0) return [];
  if (nonEmpty.length === 1) return [...nonEmpty[0].todos];

  if (typeof hint === 'string' && hint.trim()) {
    const hintSections = parseMarkdownSections(hint);
    const hintTodoSections = hintSections.filter((sec) => sec.todos.length > 0);
    // Only apply hint matching when hint targets a specific snippet/section rather than the entire multi-section document
    if (hintTodoSections.length <= 1) {
      const hintTodoContents = hintSections.flatMap((sec) => sec.todos.map((t) => t.content));
      const hintHeadings = hintSections.flatMap((sec) => sec.headings);
      const todoMatched =
        hintTodoContents.length > 0
          ? nonEmpty.filter((sec) => sec.todos.some((t) => hintTodoContents.includes(t.content)))
          : [];
      const headingMatched =
        hintHeadings.length > 0
          ? nonEmpty.filter((sec) => sec.headings.some((h) => hintHeadings.includes(h)))
          : [];
      let matched: MarkdownTodoSection[] = [];
      if (todoMatched.length > 0 && headingMatched.length > 0) {
        const both = todoMatched.filter((sec) => headingMatched.includes(sec));
        matched = both.length > 0 ? both : todoMatched;
      } else if (todoMatched.length > 0) {
        matched = todoMatched;
      } else if (headingMatched.length > 0) {
        matched = headingMatched;
      } else {
        const cleanHint = sanitizeDisplayText(hint).trim();
        if (cleanHint) {
          matched = nonEmpty.filter(
            (sec) => sec.todos.some((t) => t.content.includes(cleanHint)) || sec.headings.some((h) => h.includes(cleanHint)),
          );
        }
      }
      if (matched.length > 0) {
        return [...matched[matched.length - 1].todos];
      }
    }
  }

  for (let i = nonEmpty.length - 1; i >= 0; i--) {
    if (nonEmpty[i].todos.some((t) => t.status !== 'completed')) {
      return [...nonEmpty[i].todos];
    }
  }
  return [...nonEmpty[nonEmpty.length - 1].todos];
}

function parseDurationToMs(durationStr: string): number {
  let ms = 0;
  const segments = [...durationStr.matchAll(/(\d+(?:\.\d+)?)([dhms])/gi)];
  if (segments.length > 0) {
    for (const [, val, rawUnit] of segments) {
      const n = parseFloat(val);
      const unit = rawUnit.toLowerCase();
      if (unit === 'd') ms += Math.round(n * 86_400_000);
      else if (unit === 'h') ms += Math.round(n * 3_600_000);
      else if (unit === 'm') ms += Math.round(n * 60_000);
      else if (unit === 's') ms += Math.round(n * 1000);
    }
  } else {
    const val = parseFloat(durationStr);
    if (Number.isFinite(val)) ms = Math.round(val * 1000);
  }
  return ms;
}

function deepFind(obj: unknown, key: string, maxDepth = 6): unknown {
  if (!obj || typeof obj !== 'object' || maxDepth === 0) return undefined;
  if (Object.prototype.hasOwnProperty.call(obj, key)) return (obj as Record<string, unknown>)[key];
  for (const v of Object.values(obj as Record<string, unknown>)) {
    const found = deepFind(v, key, maxDepth - 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

const AGENT_ID = /^[\w-]{1,128}$/;
const SUBAGENT_EXIT_VERB = '(?:has\\s+gone\\s+idle|finished|completed|stopped|exited)';
const FILE_OR_CMD_OUTPUT_RE =
  /(?:^|\n)[ \t]*(?:Showing lines \d+|Command output:|Command exited with |Made \d+ replacement|\d+[:|]|[^\n[\]<>]+?\.[A-Za-z0-9]{1,8}:\d+:)/;
const LEADING_FILE_OR_CMD_OUTPUT_RE =
  /^[ \t]*(?:Showing lines \d+|Command output:|Command exited with |Made \d+ replacement|\d+[:|]|[^\n[\]<>]+?\.[A-Za-z0-9]{1,8}:\d+:)/;
const SYSTEM_MESSAGE_BLOCK_RE = /<SYSTEM_MESSAGE>([\s\S]*?)<\/SYSTEM_MESSAGE>/g;
const MESSAGE_SENDER_LINE_RE = /^\[Message\][^\n]*?\bsender=([^\s\]]+)/gm;
const SUBAGENT_LINE_EXIT_RE = new RegExp(`^[ \\t]*Subagent\\s+([\\w-]{8,128})\\s+${SUBAGENT_EXIT_VERB}\\b`, 'gim');
const STRICT_SUBAGENT_LINE_EXIT_RE = new RegExp(`^Subagent\\s+([\\w-]{8,128})\\s+${SUBAGENT_EXIT_VERB}\\b`, 'gim');
const STANDALONE_SUBAGENT_NOTICE_LINE_RE = new RegExp(
  `^(?:\\[Message\\][^\\n]*?\\bsender=([^\\s\\]]+)|[ \\t]*Subagent\\s+([\\w-]{8,128})\\s+${SUBAGENT_EXIT_VERB}\\b\\.?[ \\t]*)$`,
  'i',
);

function isPureConversationJson(content: string): string | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const id = (parsed as { conversationId?: unknown }).conversationId;
      if (typeof id === 'string' && /^[\w-]{8,128}$/.test(id)) return id;
    }
  } catch {}
  return null;
}

function isStructuredGenericNotice(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed || LEADING_FILE_OR_CMD_OUTPUT_RE.test(trimmed)) return false;
  if (/^(?:<SYSTEM_MESSAGE>|\[Message\][^\n]*?\bsender=)/.test(trimmed)) return true;
  const lines = trimmed.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.length > 0 && lines.every((l) => STANDALONE_SUBAGENT_NOTICE_LINE_RE.test(l));
}

const PROMPT_KEY_MAX_LEN = 64;

function normalizeReconcileKey(value: unknown): string {
  return typeof value === 'string' ? sanitizeDisplayText(value).trim().toLowerCase() : '';
}

function toPromptKey(value: unknown): string | undefined {
  const unquoted = unquoteAgyArg(value);
  if (!unquoted) return undefined;
  const key = normalizeReconcileKey(unquoted).slice(0, PROMPT_KEY_MAX_LEN);
  return key || undefined;
}

class Parser {
  private tools = new Map<string, ToolEntry>();
  private agents = new Map<string, AgentEntry>();
  private skills = new Set<string>();
  private mcpServers = new Set<string>();
  private mcpErrors = new Set<string>();
  private todos: TodoItem[] = [];
  private taskIndex = new Map<string, number>();
  private nextTaskId = 1;
  private agentCompletions = new Map<string, Date>();
  private agentIdToToolUseId = new Map<string, string>();
  private reopenedByTool = new Map<string, { agentCallId: string; prevEndTime?: Date }>();
  private usageById = new Map<string, SessionTokenUsage>();
  private settled: SessionTokenUsage = { ...ZERO_USAGE };
  private lastIdlessUsage: string | undefined;
  private lastStepTimeMs: number | null = null;
  private pendingAgyToolIds: string[] = [];
  private agyToolSeq = 0;
  private lastTodoFilePath: string | undefined;
  private lastTodoSource: 'markdown' | 'tool' | undefined;
  private lastTodoHint: string | undefined;
  private data: TranscriptData = { ...emptyTranscript(), compactionCount: 0, steps: 0, totalApiDurationMs: 0 };

  private addAgent(id: string, entry: AgentEntry): void {
    this.agents.set(id, entry);
    if (this.agents.size > AGENTS_KEPT) {
      const evictedIds = new Set<string>();
      for (const [key, agent] of this.agents) {
        if (this.agents.size <= AGENTS_KEPT) break;
        if (agent.status !== 'running') {
          this.agents.delete(key);
          evictedIds.add(key);
        }
      }
      if (evictedIds.size > 0) {
        for (const key of evictedIds) this.agentCompletions.delete(key);
        for (const [agentId, key] of this.agentIdToToolUseId) {
          if (evictedIds.has(key)) this.agentIdToToolUseId.delete(agentId);
        }
        for (const [toolId, rec] of this.reopenedByTool) {
          if (evictedIds.has(rec.agentCallId)) this.reopenedByTool.delete(toolId);
        }
      }
    }
  }

  private findAgentByRef(ref: string): AgentEntry | undefined {
    const callId = this.agentIdToToolUseId.get(ref);
    return callId ? this.agents.get(callId) : [...this.agents.values()].find((a) => a.agentId === ref);
  }

  private markAgentCompleted(ref: string, at: Date | null): void {
    if (!ref) return;
    const agent = this.findAgentByRef(ref);
    if (agent && agent.status === 'running') {
      agent.status = 'completed';
      agent.endTime = at ?? new Date();
    }
  }

  private completeAgentsFromLines(text: string, at: Date | null, allowIndentedSubagent: boolean): void {
    for (const m of text.matchAll(MESSAGE_SENDER_LINE_RE)) {
      this.markAgentCompleted(m[1], at);
    }
    const subagentRe = allowIndentedSubagent ? SUBAGENT_LINE_EXIT_RE : STRICT_SUBAGENT_LINE_EXIT_RE;
    for (const m of text.matchAll(subagentRe)) {
      this.markAgentCompleted(m[1], at);
    }
  }

  private completeAgentsBySenders(content: string, at: Date | null, systemMessageEntry = false): void {
    if (systemMessageEntry) {
      const normalized = content.replace(SYSTEM_MESSAGE_BLOCK_RE, (_, body: string) => `\n${body.trimStart()}\n`);
      this.completeAgentsFromLines(normalized, at, true);
      return;
    }
    for (const m of content.matchAll(SYSTEM_MESSAGE_BLOCK_RE)) {
      this.completeAgentsFromLines(m[1].trimStart(), at, true);
    }
    const outsideBlocks = content.replace(SYSTEM_MESSAGE_BLOCK_RE, '\n');
    this.completeAgentsFromLines(outsideBlocks, at, false);
  }

  line(raw: string): void {
    let entry: Entry | null = null;
    try {
      entry = raw.trim() ? (JSON.parse(raw) as Entry) : null;
    } catch {}
    if (!entry || typeof entry !== 'object') {
      this.lastIdlessUsage = undefined;
      return;
    }

    if (typeof entry.step_index === 'number' && entry.step_index > (this.data.steps ?? 0)) {
      this.data.steps = entry.step_index;
    }

    const timeStr = entry.timestamp ?? entry.created_at;
    const time = timeStr ? new Date(timeStr) : null;
    const at = time && !Number.isNaN(time.getTime()) ? time : null;
    if (at && !this.data.sessionStart) this.data.sessionStart = at;

    const entryTimeMs = at ? at.getTime() : null;
    if (entry.type === 'PLANNER_RESPONSE' && this.lastStepTimeMs !== null && entryTimeMs !== null && entryTimeMs >= this.lastStepTimeMs) {
      this.data.totalApiDurationMs = (this.data.totalApiDurationMs ?? 0) + (entryTimeMs - this.lastStepTimeMs);
    }

    // Antigravity native transcript entries
    if (entry.type === 'USER_INPUT' && typeof entry.content === 'string') {
      const selMatch = entry.content.match(/changed setting `Model Selection` from [^\n]+? to ([^\n.]+)\./);
      if (selMatch?.[1]) this.data.transcriptModelSelection = sanitizeDisplayText(selMatch[1].trim());
      const modeMatch = entry.content.match(/changed setting `(?:Mode|Agent Mode|Permission Mode)` from [^\n]+? to ([^\n.]+)\./i);
      if (modeMatch?.[1]) this.data.transcriptMode = sanitizeDisplayText(modeMatch[1].trim());
      this.completeAgentsBySenders(entry.content, at, false);
    } else if (entry.type === 'SYSTEM_MESSAGE' && typeof entry.content === 'string') {
      this.completeAgentsBySenders(entry.content, at, true);
    }

    if (entry.type === 'PLANNER_RESPONSE') {
      this.agyPlannerResponse(entry, at, entryTimeMs);
    } else if (entry.type === 'GENERIC') {
      this.agyGenericResponse(entry, at, entryTimeMs);
    } else if (entry.type === 'assistant') {
      this.assistant(entry, at);
    } else {
      this.lastIdlessUsage = undefined;
    }

    if (entryTimeMs !== null && Number.isFinite(entryTimeMs)) {
      this.lastStepTimeMs = entryTimeMs;
    }

    if (entry.type === 'user' && typeof entry.message?.content === 'string') {
      const effort = EFFORT_COMMAND.exec(entry.message.content);
      if (effort) this.data.ultracodeActive = effort[1].toLowerCase() === 'ultracode';
    }
    if (entry.type === 'attachment') {
      if (entry.attachment?.type === 'ultra_effort_enter') this.data.ultracodeActive = true;
      if (entry.attachment?.type === 'ultra_effort_exit') this.data.ultracodeActive = false;
    }
    if (entry.type === 'system' && entry.subtype === 'compact_boundary' && at) {
      this.data.compactionCount = (this.data.compactionCount ?? 0) + 1;
      const post = entry.compactMetadata?.postTokens;
      this.data.contextTokens = typeof post === 'number' && Number.isFinite(post) && post >= 0 ? Math.trunc(post) : undefined;
    }

    const notice =
      entry.type === 'queue-operation' && entry.operation === 'enqueue' ? entry.content
      : entry.type === 'attachment' && entry.attachment?.type === 'queued_command' ? entry.attachment.prompt
      : undefined;
    if (typeof notice === 'string' && at) {
      const taskId = /<task-id>([^<]+)<\/task-id>/.exec(notice)?.[1];
      const toolUseId =
        /<tool-use-id>([^<]+)<\/tool-use-id>/.exec(notice)?.[1] ??
        (taskId ? this.agentIdToToolUseId.get(taskId) : undefined);
      const prev = toolUseId && this.agentCompletions.get(toolUseId);
      if (toolUseId && taskId && this.agents.has(toolUseId) && !(prev && prev <= at)) this.agentCompletions.set(toolUseId, at);
    }

    if ((entry.type === 'assistant' || entry.type === 'user') && Array.isArray(entry.message?.content)) {
      for (const block of entry.message.content) {
        if (block?.type === 'tool_use' && block.id && block.name) this.toolUse(block, at ?? new Date());
        if (block?.type === 'tool_result' && block.tool_use_id) this.toolResult(block, entry, at ?? new Date());
      }
    }

    this.detectRateLimits(entry, entryTimeMs);
  }

  private agyPlannerResponse(entry: Entry, at: Date | null, entryTimeMs: number | null): void {
    if (at) this.data.lastAssistantResponseAt = at;
    const model = sanitizeTranscriptModel(entry.model);
    if (model) this.data.lastAssistantModel = model;

    if (typeof entry.input_tokens === 'number' || typeof entry.output_tokens === 'number') {
      const usage: SessionTokenUsage = {
        inputTokens: count(entry.input_tokens),
        outputTokens: count(entry.output_tokens),
        cacheCreationTokens: count(entry.cache_creation_tokens ?? entry.cache_creation_input_tokens),
        cacheReadTokens: count(entry.cache_read_tokens ?? entry.cache_read_input_tokens),
      };
      addUsage(this.settled, usage);
      this.data.lastTurnUsage = { ...usage };
      const ctxTokens = usage.inputTokens + usage.cacheCreationTokens + usage.cacheReadTokens;
      if (ctxTokens > 0) this.data.contextTokens = ctxTokens;
      if (usage.outputTokens > 0 && this.lastStepTimeMs !== null && entryTimeMs !== null && entryTimeMs - this.lastStepTimeMs >= 500) {
        this.data.transcriptOutputSpeed = usage.outputTokens / ((entryTimeMs - this.lastStepTimeMs) / 1000);
      }
    }

    if (Array.isArray(entry.tool_calls)) {
      for (const tc of entry.tool_calls) {
        if (!tc?.name) continue;
        const callId = `agy-tc-${++this.agyToolSeq}`;
        const args = tc.args ?? {};
        if (tc.name === 'read_file') {
          const p = unquoteAgyArg(args.Path ?? args.TargetFile ?? args.path ?? args.file_path);
          const pluginSkill = p?.match(/\/plugins\/([^/]+)\/skills\/([^/]+)\/SKILL\.md$/i);
          if (pluginSkill?.[1] && pluginSkill?.[2]) {
            const s = name(`${pluginSkill[1]}:${pluginSkill[2]}`);
            if (s) this.skills.add(s);
          } else {
            const skillMatch = p?.match(/\/skills\/([^/]+)\/SKILL\.md$/i);
            if (skillMatch?.[1]) {
              const s = name(skillMatch[1]);
              if (s) this.skills.add(s);
            }
          }
        }
        this.handleTodoFileTool(tc.name, args, true);
        if (tc.name === 'call_mcp_tool') {
          const srv = name(unquoteAgyArg(args.ServerName));
          if (srv) this.mcpServers.add(srv);
        } else {
          const srv = mcpServer(tc.name);
          if (srv) this.mcpServers.add(srv);
        }

        if (tc.name === 'invoke_subagent') {
          const rawModel = unquoteAgyArg(args.Model);
          const hint = rawModel && rawModel.toLowerCase() !== 'inherit' ? splitModelAndEffort(rawModel) : {};
          const promptKey = toPromptKey(args.Prompt ?? args.prompt);
          this.addAgent(callId, {
            id: callId,
            type: unquoteAgyArg(args.TypeName) ?? 'subagent',
            model: hint.model,
            effort: hint.effort,
            description: unquoteAgyArg(args.Role),
            ...(promptKey ? { promptKey } : {}),
            status: 'running',
            startTime: at ?? new Date(),
            background: true,
          });
        } else if (tc.name === 'swarm' && unquoteAgyArg(args.action) === 'add') {
          const rawModel = unquoteAgyArg(args.model);
          const hint = rawModel && rawModel.toLowerCase() !== 'inherit' ? splitModelAndEffort(rawModel) : {};
          const promptKey = toPromptKey(args.brief ?? args.Brief);
          this.addAgent(callId, {
            id: callId,
            type: unquoteAgyArg(args.name) ?? 'swarm',
            model: hint.model,
            effort: hint.effort,
            description: unquoteAgyArg(args.brief),
            ...(promptKey ? { promptKey } : {}),
            status: 'running',
            startTime: at ?? new Date(),
            background: true,
          });
        } else {
          if (tc.name === 'send_message') {
            const recipient = unquoteAgyArg(args.Recipient ?? args.recipient);
            if (recipient) {
              const targetAgent = this.findAgentByRef(recipient);
              if (targetAgent && targetAgent.status === 'completed') {
                this.reopenedByTool.set(callId, {
                  agentCallId: targetAgent.id,
                  prevEndTime: targetAgent.endTime,
                });
                targetAgent.status = 'running';
                delete targetAgent.endTime;
                this.agentCompletions.delete(targetAgent.id);
              }
            }
          }
          this.tools.set(callId, {
            id: callId,
            name: tc.name,
            target: toolTarget(tc.name, args),
            status: 'running',
            startTime: at ?? new Date(),
          });
          this.pendingAgyToolIds.push(callId);
          if (cap(this.tools, TOOLS_TRACKED)) {
            for (const key of this.reopenedByTool.keys()) if (!this.tools.has(key)) this.reopenedByTool.delete(key);
          }
        }
      }
    }
  }

  private agyGenericResponse(entry: Entry, at: Date | null, entryTimeMs: number | null): void {
    const content = typeof entry.content === 'string' ? entry.content : '';
    if (isStructuredGenericNotice(content)) {
      this.completeAgentsBySenders(content, at, true);
      return;
    }

    const fileOrCmd = FILE_OR_CMD_OUTPUT_RE.test(content);
    const unlinkedRunning = [...this.agents.values()].find((a) => a.status === 'running' && !a.agentId);
    const pureLaunchId = !fileOrCmd ? isPureConversationJson(content) : null;
    const isSubagentLaunch =
      Boolean(unlinkedRunning) &&
      !fileOrCmd &&
      (pureLaunchId !== null ||
        /(?:^|\n)[ \t]*(?:Created the following subagent:|Launched subagent\s+conversationId\b)/i.test(content)) &&
      !content.includes('finished');
    if (isSubagentLaunch) {
      const launchedId =
        pureLaunchId ?? /"?conversationId"?\s*[:=]\s*["']?([\w-]{8,128})/i.exec(content)?.[1];
      if (launchedId && unlinkedRunning) {
        unlinkedRunning.agentId = launchedId;
        this.agentIdToToolUseId.set(launchedId, unlinkedRunning.id);
      }
      return;
    }

    const nextId = this.pendingAgyToolIds.shift();
    if (nextId) {
      const reopened = this.reopenedByTool.get(nextId);
      if (reopened) {
        this.reopenedByTool.delete(nextId);
        if (entry.status === 'ERROR') {
          const targetAgent = this.agents.get(reopened.agentCallId);
          if (targetAgent && targetAgent.status === 'running') {
            targetAgent.status = 'completed';
            targetAgent.endTime = reopened.prevEndTime ?? at ?? new Date();
          }
        }
      }
      const tool = this.tools.get(nextId);
      if (tool) {
        const isErr = entry.status === 'ERROR';
        tool.status = isErr ? 'error' : 'completed';
        tool.endTime = at ?? new Date();
        const srv = mcpServer(tool.name);
        if (srv && isErr) {
          this.mcpErrors.add(srv);
          cap(this.mcpErrors, MCP_ERRORS_MAX);
        } else if (srv) {
          this.mcpErrors.delete(srv);
        }
      }
    }
    if (!fileOrCmd && !nextId && content.includes('conversation://') && entryTimeMs !== null) {
      for (const agent of this.agents.values()) {
        if (agent.status === 'running' && !agent.agentId) {
          agent.status = 'completed';
          agent.endTime = at ?? new Date();
          break;
        }
      }
    }
  }

  private detectRateLimits(entry: Entry, _entryTimeMs: number | null): void {
    const entryContent = typeof entry.content === 'string' ? entry.content : '';
    const isRateLimit =
      deepFind(entry, 'RESOURCE_EXHAUSTED') !== undefined ||
      deepFind(entry, 'quotaResetDelay') !== undefined ||
      deepFind(entry, 'quotaResetTimeStamp') !== undefined ||
      entryContent.includes('HTTP 429') ||
      entryContent.includes('RESOURCE_EXHAUSTED') ||
      entryContent.includes('quotaResetTimeStamp') ||
      entryContent.includes('quotaResetDelay');
    if (!isRateLimit) return;

    let delayMs = 0;
    let timestampMs = 0;
    const delayVal = deepFind(entry, 'quotaResetDelay') ?? deepFind(entry, 'retryDelay');
    if (typeof delayVal === 'string' && delayVal) delayMs = parseDurationToMs(delayVal);
    const tsVal = deepFind(entry, 'quotaResetTimeStamp');
    if (typeof tsVal === 'string' && tsVal) {
      const parsedTs = Date.parse(tsVal);
      if (Number.isFinite(parsedTs)) timestampMs = parsedTs;
    }

    if (entryContent) {
      if (!timestampMs) {
        const tsMatch = /\\?"quotaResetTimeStamp\\?"\s*:\s*\\?"([^"\\]+)\\?"/.exec(entryContent);
        if (tsMatch?.[1]) {
          const parsedTs = Date.parse(tsMatch[1]);
          if (Number.isFinite(parsedTs)) timestampMs = parsedTs;
        }
      }
      if (!delayMs) {
        const delayMatch =
          /\\?"(?:quotaResetDelay|retryDelay)\\?"\s*:\s*\\?"([^"\\]+)\\?"/.exec(entryContent) ??
          /(?:\bResets in|\btry again in)\s+((?:\d+(?:\.\d+)?[dhms]\s*)+)/i.exec(entryContent);
        if (delayMatch?.[1]) {
          delayMs = parseDurationToMs(delayMatch[1]);
        }
      }
    }

    const timeStr = entry.created_at ?? entry.timestamp;
    const parsedEntryTime = timeStr ? Date.parse(timeStr) : Number.NaN;
    const baseTime = Number.isFinite(parsedEntryTime) ? parsedEntryTime : Date.now();

    let resetTimeMs = 0;
    if (timestampMs > 0) resetTimeMs = timestampMs;
    else if (delayMs > 0) {
      resetTimeMs = baseTime + delayMs;
    }

    if (resetTimeMs > 0 && resetTimeMs > (Number.isFinite(parsedEntryTime) ? parsedEntryTime : Date.now())) {
      const prev = this.data.imageExhausted ? Date.parse(this.data.imageExhausted.resetTime) : 0;
      if (!Number.isFinite(prev) || resetTimeMs > prev) {
        this.data.imageExhausted = { exhausted: true, resetTime: new Date(resetTimeMs).toISOString() };
      }
    }
  }

  private assistant(entry: Entry, at: Date | null): void {
    if (at) this.data.lastAssistantResponseAt = at;
    if (typeof entry.advisorModel === 'string' && entry.advisorModel) {
      this.data.advisorModel = truncateString(entry.advisorModel, ADVISOR_MODEL_MAX_LEN, '');
    }
    const model = sanitizeTranscriptModel(entry.message?.model);
    if (model && model !== '<synthetic>') this.data.lastAssistantModel = model;

    const raw = entry.message?.usage;
    if (!raw) {
      this.lastIdlessUsage = undefined;
      return;
    }
    const usage: SessionTokenUsage = {
      inputTokens: count(raw.input_tokens),
      outputTokens: count(raw.output_tokens),
      cacheCreationTokens: count(raw.cache_creation_input_tokens),
      cacheReadTokens: count(raw.cache_read_input_tokens),
    };
    const contextTokens = usage.inputTokens + usage.cacheCreationTokens + usage.cacheReadTokens;
    if (entry.isSidechain !== true && contextTokens > 0) {
      this.data.contextTokens = contextTokens;
    }

    const id = entry.message?.id;
    if (typeof id === 'string' && id && id.length <= MESSAGE_ID_MAX_LEN) {
      this.lastIdlessUsage = undefined;
      const previous = this.usageById.get(id);
      this.usageById.set(id, previous ? maxUsage(previous, usage) : usage);
      if (this.usageById.size > MESSAGE_IDS_MAX) {
        const [oldestId, oldest] = this.usageById.entries().next().value as [string, SessionTokenUsage];
        this.usageById.delete(oldestId);
        addUsage(this.settled, oldest);
      }
      return;
    }
    const fingerprint = JSON.stringify(usage);
    if (fingerprint !== this.lastIdlessUsage) addUsage(this.settled, usage);
    this.lastIdlessUsage = fingerprint;
  }

  private toolUse(block: Block, at: Date): void {
    const toolName = block.name as string;
    const input = block.input;
    const skill = toolName === 'Skill' ? name(input?.skill) : undefined;
    if (skill) this.skills.add(skill);
    const server = mcpServer(toolName);
    if (server) this.mcpServers.add(server);

    if (toolName === 'Task' || toolName === 'Agent') {
      this.addAgent(block.id as string, {
        id: block.id as string,
        type: (input?.subagent_type as string) ?? 'agent',
        model: sanitizeTranscriptModel(input?.model),
        description: (input?.description as string) ?? undefined,
        status: 'running',
        startTime: at,
        background: input?.run_in_background === true,
      });
    } else if (toolName === 'TodoWrite') {
      this.lastTodoSource = 'tool';
      if (Array.isArray(input?.todos)) this.replaceTodos(input.todos.flatMap(toTodo));
    } else if (toolName === 'TaskCreate') {
      this.lastTodoSource = 'tool';
      const content = text(input?.subject) ?? text(input?.description);
      this.todos.push({ content: content ?? 'Untitled task', status: taskStatus(input?.status) ?? 'pending' });
      const numbered = String(this.nextTaskId++);
      const explicit = typeof input?.taskId === 'string' || typeof input?.taskId === 'number' ? String(input.taskId) : null;
      for (const id of explicit ? [explicit] : [numbered, block.id]) if (id) this.taskIndex.set(id, this.todos.length - 1);
    } else if (toolName === 'TaskUpdate') {
      this.lastTodoSource = 'tool';
      const index = this.findTask(input?.taskId);
      if (index === null) return;
      const todo = this.todos[index];
      if (input?.status === 'deleted') {
        this.todos.splice(index, 1);
        this.moveTasks((i) => (i === index ? -1 : i > index ? i - 1 : i));
        return;
      }
      const status = taskStatus(input?.status);
      if (status) todo.status = status;
      const content = text(input?.subject) ?? text(input?.description);
      if (content) todo.content = content;
    } else {
      this.handleTodoFileTool(toolName, input, false);
      this.tools.set(block.id as string, {
        id: block.id as string,
        name: toolName,
        target: toolTarget(toolName, input),
        status: 'running',
        startTime: at,
      });
      cap(this.tools, TOOLS_TRACKED);
    }
  }

  private handleTodoFileTool(toolName: string, args: Record<string, unknown> | undefined, isAgyQuoted: boolean): void {
    if (!args) return;
    const isTodoWriteTool = toolName === 'write_file' || toolName === 'write_to_file';
    const isTodoEditTool =
      toolName === 'edit_file' || toolName === 'replace_file_content' || toolName === 'multi_replace_file_content';
    if (!isTodoWriteTool && !isTodoEditTool) return;

    const readArg = (v: unknown): string => (isAgyQuoted ? unquoteRaw(v) : typeof v === 'string' ? v : unquoteRaw(v)) ?? '';
    const targetPath =
      (isAgyQuoted
        ? unquoteAgyArg(args.Path ?? args.TargetFile ?? args.path ?? args.file_path)
        : text(args.Path ?? args.TargetFile ?? args.path ?? args.file_path)) ?? '';
    if (!TODO_FILE_PATH_RE.test(targetPath)) return;

    this.lastTodoFilePath = targetPath;
    this.lastTodoSource = 'markdown';
    if (isTodoWriteTool) {
      const body = readArg(args.Content ?? args.CodeContent ?? args.content);
      const isAppend = args.Append === true || readArg(args.Append) === 'true';
      if (body) this.lastTodoHint = body;
      if (!isAppend) {
        const parsedTodos = body ? extractMarkdownTodos(body) : [];
        if (parsedTodos.length > 0) this.replaceTodos(parsedTodos);
      } else if (body) {
        this.applyTodoPatchesInMemory([{ target: '', replacement: body }]);
      }
    } else if (toolName === 'multi_replace_file_content') {
      let rawChunks: unknown = args.ReplacementChunks ?? args.chunks;
      if (typeof rawChunks === 'string') {
        const unquoted = readArg(rawChunks);
        if (unquoted) {
          try {
            rawChunks = JSON.parse(unquoted);
          } catch {}
        }
      }
      const patches: Array<{ target: string; replacement: string }> = [];
      if (Array.isArray(rawChunks)) {
        for (const chunk of rawChunks) {
          if (!chunk || typeof chunk !== 'object') continue;
          const c = chunk as Record<string, unknown>;
          const target = readArg(c.TargetContent ?? c.Target ?? c.target ?? c.old_string);
          const replacement = readArg(c.ReplacementContent ?? c.Replacement ?? c.replacement ?? c.new_string);
          if (target || replacement) patches.push({ target, replacement });
        }
      }
      const hintText = patches.map((p) => p.replacement || p.target).filter(Boolean).join('\n');
      if (hintText) this.lastTodoHint = hintText;
      if (patches.length > 0) this.applyTodoPatchesInMemory(patches);
    } else {
      const target = readArg(args.Target ?? args.TargetContent ?? args.target ?? args.old_string);
      const replacement = readArg(args.Replacement ?? args.ReplacementContent ?? args.replacement ?? args.new_string);
      const hintText = replacement || target;
      if (hintText) this.lastTodoHint = hintText;
      if (target || replacement) this.applyTodoPatchesInMemory([{ target, replacement }]);
    }
  }

  private toolResult(block: Block, entry: Entry, at: Date): void {
    const id = block.tool_use_id as string;
    const tool = this.tools.get(id);
    if (tool) {
      tool.status = block.is_error ? 'error' : 'completed';
      tool.endTime = at;
      const server = mcpServer(tool.name);
      if (server && block.is_error) {
        this.mcpErrors.add(server);
        cap(this.mcpErrors, MCP_ERRORS_MAX);
      } else if (server) {
        this.mcpErrors.delete(server);
      }
    }

    const agent = this.agents.get(id);
    if (agent) {
      const agentId = entry.toolUseResult?.agentId;
      if (typeof agentId === 'string' && agentId) {
        this.agentIdToToolUseId.set(agentId, id);
        agent.agentId = agentId;
      }
      agent.model = sanitizeTranscriptModel(entry.toolUseResult?.resolvedModel) ?? agent.model;
      if (entry.toolUseResult?.isAsync === true || entry.toolUseResult?.status === 'async_launched') {
        agent.background = true;
      }
      if (!agent.background) agent.endTime = at;
    }
  }

  private applyTodoPatchesInMemory(patches: Array<{ target: string; replacement: string }>): void {
    const next = this.todos.map((t) => ({ ...t }));
    for (const { target, replacement } of patches) {
      const targetTodos = target ? parseRawTodoLines(target) : [];
      const repSections = replacement ? parseMarkdownSections(replacement).filter((sec) => sec.todos.length > 0) : [];
      const hasSectionBreakInRep =
        replacement &&
        (repSections.length > 1 ||
          /^\s*(?:(?:-\s*){3,}|(?:\*\s*){3,})\s*$/m.test(replacement) ||
          /^\s*#{1,2}\s+/m.test(replacement));

      if (targetTodos.length === 0 && hasSectionBreakInRep) {
        const extracted = extractMarkdownTodos(replacement);
        if (extracted.length > 0) {
          const hasIncomplete = extracted.some((t) => t.status !== 'completed');
          const allCurrentDone = next.length === 0 || next.every((t) => t.status === 'completed');
          if (hasIncomplete || allCurrentDone) {
            next.splice(0, next.length, ...extracted);
            continue;
          }
        }
      }

      const repTodos = replacement ? parseRawTodoLines(replacement) : [];
      if (targetTodos.length === 0 && repTodos.length === 0) continue;

      if (targetTodos.length > 0 && targetTodos.length === repTodos.length) {
        for (let i = 0; i < targetTodos.length; i++) {
          const tItem = targetTodos[i];
          const rItem = repTodos[i];
          let idx = next.findIndex((item) => item.content === tItem.content && item.status === tItem.status);
          if (idx === -1) idx = next.findIndex((item) => item.content === tItem.content);
          if (idx !== -1) {
            next[idx] = { content: rItem.content, status: rItem.status };
          } else {
            const rIdx = next.findIndex((item) => item.content === rItem.content);
            if (rIdx !== -1) next[rIdx] = { content: rItem.content, status: rItem.status };
            else next.push({ content: rItem.content, status: rItem.status });
          }
        }
        continue;
      }

      if (targetTodos.length > 0) {
        const startIdx = next.findIndex((item) => item.content === targetTodos[0].content);
        if (
          startIdx !== -1 &&
          startIdx + targetTodos.length <= next.length &&
          targetTodos.every((tItem, offset) => next[startIdx + offset].content === tItem.content)
        ) {
          next.splice(startIdx, targetTodos.length, ...repTodos);
          continue;
        }
      }

      const repContentSet = new Set(repTodos.map((t) => t.content));
      for (const tItem of targetTodos) {
        if (!repContentSet.has(tItem.content)) {
          const idx = next.findIndex((item) => item.content === tItem.content);
          if (idx !== -1) next.splice(idx, 1);
        }
      }
      for (const rItem of repTodos) {
        const idx = next.findIndex((item) => item.content === rItem.content);
        if (idx !== -1) {
          next[idx] = { content: rItem.content, status: rItem.status };
        } else {
          next.push({ content: rItem.content, status: rItem.status });
        }
      }
    }
    this.replaceTodos(next);
  }

  private refreshTodosFromDisk(todoFiles?: string[]): void {
    if (this.lastTodoSource !== 'markdown' || !this.lastTodoFilePath) return;
    const rawTarget = this.lastTodoFilePath;
    const home = (process.platform === 'win32' ? process.env.USERPROFILE : process.env.HOME) || os.homedir();
    const expandedTarget =
      rawTarget === '~'
        ? home
        : rawTarget.startsWith('~/') || rawTarget.startsWith('~\\')
          ? path.join(home, rawTarget.slice(2))
          : rawTarget;
    const normTarget = expandedTarget.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
    const lowerNormTarget = normTarget.toLowerCase();
    const baseTarget = path.posix.basename(lowerNormTarget);

    const candidates: string[] = [];
    const addCandidate = (p: string | undefined): void => {
      if (typeof p === 'string' && p && !candidates.includes(p)) {
        candidates.push(p);
      }
    };

    if (Array.isArray(todoFiles) && todoFiles.length > 0) {
      for (let i = todoFiles.length - 1; i >= 0; i--) {
        const f = todoFiles[i];
        if (f === rawTarget || f === expandedTarget) addCandidate(f);
      }
      for (let i = todoFiles.length - 1; i >= 0; i--) {
        const f = todoFiles[i];
        const normF = typeof f === 'string' ? f.replace(/\\/g, '/').toLowerCase() : '';
        if (normF && (normF === lowerNormTarget || normF.endsWith(`/${lowerNormTarget}`))) {
          addCandidate(f);
        }
      }
      for (let i = todoFiles.length - 1; i >= 0; i--) {
        const f = todoFiles[i];
        if (typeof f === 'string' && path.basename(f).toLowerCase() === baseTarget) {
          addCandidate(f);
        }
      }
      addCandidate(todoFiles[todoFiles.length - 1]);
    }
    addCandidate(expandedTarget);
    addCandidate(rawTarget);

    for (const candidatePath of candidates) {
      try {
        const st = fs.statSync(candidatePath);
        if (!st.isFile() || st.size > MAX_TODO_FILE_BYTES) continue;
        const diskContent = fs.readFileSync(candidatePath, 'utf8');
        const diskTodos = extractMarkdownTodos(diskContent, this.lastTodoHint);
        if (diskTodos.length > 0) {
          this.replaceTodos(diskTodos);
        }
        return;
      } catch {
        // EACCES / ERR_ACCESS_DENIED / ENOENT: try next candidate or retain in-memory todos
      }
    }
  }

  private replaceTodos(next: TodoItem[]): void {
    const oldByContent = new Map<string, number[]>();
    this.todos.forEach((todo, index) => oldByContent.set(todo.content, [...(oldByContent.get(todo.content) ?? []), index]));
    const moved = new Map<number, number>();
    next.forEach((todo, index) => {
      const old = oldByContent.get(todo.content)?.shift();
      if (old !== undefined) moved.set(old, index);
    });
    this.todos = [...next];
    this.moveTasks((index) => moved.get(index) ?? -1);
  }

  private moveTasks(to: (index: number) => number): void {
    for (const [id, index] of this.taskIndex) if (index >= 0) this.taskIndex.set(id, to(index));
  }

  private findTask(taskId: unknown): number | null {
    if (typeof taskId !== 'string' && typeof taskId !== 'number') return null;
    const key = String(taskId);
    const mapped = this.taskIndex.get(key);
    if (mapped !== undefined) return mapped >= 0 ? mapped : null;
    const position = /^\d+$/.test(key) ? Number(key) - 1 : -1;
    return position >= 0 && position < this.todos.length ? position : null;
  }

  save() {
    return {
      tools: [...this.tools],
      agents: [...this.agents],
      skills: [...this.skills],
      mcpServers: [...this.mcpServers],
      mcpErrors: [...this.mcpErrors],
      todos: this.todos,
      taskIndex: [...this.taskIndex],
      nextTaskId: this.nextTaskId,
      agentCompletions: [...this.agentCompletions],
      agentIdToToolUseId: [...this.agentIdToToolUseId],
      reopenedByTool: [...this.reopenedByTool],
      usageById: [...this.usageById],
      settled: this.settled,
      lastIdlessUsage: this.lastIdlessUsage,
      lastStepTimeMs: this.lastStepTimeMs,
      pendingAgyToolIds: this.pendingAgyToolIds,
      agyToolSeq: this.agyToolSeq,
      lastTodoFilePath: this.lastTodoFilePath,
      lastTodoSource: this.lastTodoSource,
      lastTodoHint: this.lastTodoHint,
      data: this.data,
    };
  }

  static load(s: SavedState): Parser {
    const parser = new Parser();
    parser.tools = new Map(s.tools);
    parser.agents = new Map(s.agents);
    parser.skills = new Set(s.skills);
    parser.mcpServers = new Set(s.mcpServers);
    parser.mcpErrors = new Set(s.mcpErrors);
    parser.todos = s.todos;
    parser.taskIndex = new Map(s.taskIndex);
    parser.nextTaskId = s.nextTaskId;
    parser.agentCompletions = new Map(s.agentCompletions.map(([id, at]) => [id, new Date(at)]));
    parser.agentIdToToolUseId = new Map(s.agentIdToToolUseId);
    parser.reopenedByTool = new Map(
      (s.reopenedByTool ?? []).map(([toolId, rec]) => [
        toolId,
        {
          agentCallId: rec.agentCallId,
          ...(rec.prevEndTime !== undefined
            ? { prevEndTime: rec.prevEndTime instanceof Date ? rec.prevEndTime : new Date(rec.prevEndTime) }
            : {}),
        },
      ]),
    );
    parser.usageById = new Map(s.usageById);
    parser.settled = s.settled;
    parser.lastIdlessUsage = s.lastIdlessUsage;
    parser.lastStepTimeMs = s.lastStepTimeMs ?? null;
    parser.pendingAgyToolIds = s.pendingAgyToolIds ?? [];
    parser.agyToolSeq = s.agyToolSeq ?? 0;
    parser.lastTodoFilePath = s.lastTodoFilePath;
    parser.lastTodoSource = s.lastTodoSource;
    parser.lastTodoHint = s.lastTodoHint;
    parser.data = s.data;
    return parser;
  }

  finish(todoFiles?: string[]): TranscriptData {
    this.refreshTodosFromDisk(todoFiles);
    for (const [id, endTime] of this.agentCompletions) {
      const agent = this.agents.get(id);
      if (agent?.background) agent.endTime = endTime;
    }
    for (const agent of this.agents.values()) {
      if (agent.endTime) agent.status = 'completed';
    }
    const sessionTokens = { ...this.settled };
    for (const usage of this.usageById.values()) addUsage(sessionTokens, usage);
    return {
      ...this.data,
      tools: [...this.tools.values()].slice(-TOOLS_KEPT),
      agents: [...this.agents.values()],
      skills: [...this.skills],
      mcpServers: [...this.mcpServers],
      mcpErrors: [...this.mcpErrors],
      todos: this.todos,
      sessionTokens,
    };
  }
}

const DATE_KEYS = new Set(['startTime', 'endTime', 'prevEndTime', 'sessionStart', 'lastAssistantResponseAt']);
type SavedState = ReturnType<Parser['save']>;
const reviveDates = (key: string, value: unknown): unknown =>
  DATE_KEYS.has(key) && typeof value === 'string' ? new Date(value) : value;

function cap<K>(collection: Map<K, unknown> | Set<K>, max: number): boolean {
  const over = collection.size > max;
  for (const key of collection.keys()) {
    if (collection.size <= max) break;
    collection.delete(key);
  }
  return over;
}

function maxUsage(a: SessionTokenUsage, b: SessionTokenUsage): SessionTokenUsage {
  return {
    inputTokens: Math.max(a.inputTokens, b.inputTokens),
    outputTokens: Math.max(a.outputTokens, b.outputTokens),
    cacheCreationTokens: Math.max(a.cacheCreationTokens, b.cacheCreationTokens),
    cacheReadTokens: Math.max(a.cacheReadTokens, b.cacheReadTokens),
  };
}

export interface Cursor {
  version: string;
  ino: number;
  offset: number;
  state: SavedState;
}

const CURSORS_KEPT = 32;
const STALE_TMP_AGE_MS = 60 * 1000;
const CHUNK_BYTES = 1 << 20;
const CHECKPOINT_BYTES = 32 << 20;
const NEWLINE = 0x0a;

let hudVersion: string | undefined;
function getHudVersion(): string {
  if (hudVersion === undefined) {
    try {
      hudVersion = String(JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
    } catch {
      hudVersion = '';
    }
  }
  return hudVersion;
}

function cursorPath(dataDir: string, transcriptPath: string): string {
  const key = createHash('sha256').update(path.resolve(transcriptPath)).digest('hex');
  return path.join(dataDir, 'transcript-cursors', `${key}.json`);
}

function readCursor(file: string): Cursor | null {
  let cursor: Partial<Cursor> | null;
  try {
    cursor = JSON.parse(fs.readFileSync(file, 'utf8'), reviveDates);
  } catch {
    return null;
  }
  if (typeof cursor !== 'object' || cursor === null) return null;
  if (cursor.version !== getHudVersion() || typeof cursor.ino !== 'number') return null;
  if (typeof cursor.offset !== 'number' || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0) return null;
  return cursor as Cursor;
}

function sweepCursorEntries(dir: string, entries: string[], now: number): string[] {
  const jsonFiles: string[] = [];
  for (const fileName of entries) {
    const full = path.join(dir, fileName);
    if (fileName.endsWith('.tmp')) {
      try {
        const st = fs.statSync(full);
        if (now - st.mtimeMs > STALE_TMP_AGE_MS) {
          fs.rmSync(full, { force: true });
        }
      } catch {}
      continue;
    }
    if (fileName.endsWith('.json')) {
      jsonFiles.push(full);
    }
  }
  return jsonFiles;
}

export function writeCursor(file: string, cursor: Cursor): void {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    const dir = path.dirname(file);
    const isNew = !fs.existsSync(file);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(tmp, JSON.stringify(cursor), { mode: 0o600 });
    fs.renameSync(tmp, file);
    if (isNew) {
      pruneCursors(dir);
    } else {
      try {
        sweepCursorEntries(dir, fs.readdirSync(dir), Date.now());
      } catch {}
    }
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {}
    debug('Transcript cursor write failed:', err instanceof Error ? err.message : err);
  }
}

export function pruneCursors(dir: string, now = Date.now()): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  const jsonFiles = sweepCursorEntries(dir, entries, now);
  if (jsonFiles.length <= CURSORS_KEPT) return;
  const byAge = jsonFiles
    .flatMap((file) => {
      try {
        return [{ file, mtime: fs.statSync(file).mtimeMs }];
      } catch {
        return [];
      }
    })
    .sort((a, b) => a.mtime - b.mtime);
  for (const { file } of byAge.slice(0, Math.max(0, byAge.length - CURSORS_KEPT))) {
    try {
      fs.rmSync(file, { force: true });
    } catch {}
  }
}

async function resumes(file: fs.promises.FileHandle, stat: fs.Stats, cursor: Cursor): Promise<boolean> {
  if (cursor.ino !== stat.ino || cursor.offset > stat.size) return false;
  if (cursor.offset === 0) return true;
  const { bytesRead, buffer } = await file.read(Buffer.alloc(1), 0, 1, cursor.offset - 1);
  return bytesRead === 1 && buffer[0] === NEWLINE;
}

async function readLines(
  file: fs.promises.FileHandle,
  start: number,
  onLine: (line: string, end: number) => void,
): Promise<{ end: number; rest: string }> {
  const buffer = Buffer.alloc(CHUNK_BYTES);
  let pending: Buffer[] = [];
  let end = start;
  let position = start;
  while (true) {
    let bytesRead: number;
    try {
      ({ bytesRead } = await file.read(buffer, 0, CHUNK_BYTES, position));
    } catch (err) {
      debug('Transcript read failed:', err instanceof Error ? err.message : err);
      break;
    }
    if (bytesRead === 0) break;
    const chunk = buffer.subarray(0, bytesRead);
    let from = 0;
    let newline: number;
    while ((newline = chunk.indexOf(NEWLINE, from)) !== -1) {
      const piece = chunk.subarray(from, newline);
      end = position + newline + 1;
      onLine((pending.length > 0 ? Buffer.concat([...pending, piece]) : piece).toString('utf8'), end);
      pending = [];
      from = newline + 1;
    }
    if (from < bytesRead) pending.push(Buffer.from(chunk.subarray(from)));
    position += bytesRead;
  }
  return { end, rest: Buffer.concat(pending).toString('utf8') };
}

async function parseFrom(
  file: fs.promises.FileHandle,
  parser: Parser,
  offset: number,
  save: (parser: Parser, offset: number) => void,
  todoFiles?: string[],
): Promise<TranscriptData> {
  let saved = offset;
  const { end, rest } = await readLines(file, offset, (line, lineEnd) => {
    parser.line(line);
    if (lineEnd - saved >= CHECKPOINT_BYTES) {
      save(parser, lineEnd);
      saved = lineEnd;
    }
  });
  if (end > saved) save(parser, end);
  if (rest) parser.line(rest);
  return parser.finish(todoFiles);
}

export async function parseTranscript(
  transcriptPath: string,
  dataDir: string,
  todoFiles?: string[],
): Promise<TranscriptData> {
  let file: fs.promises.FileHandle;
  try {
    if (!transcriptPath || !(await fs.promises.stat(transcriptPath)).isFile()) return emptyTranscript();
    file = await fs.promises.open(transcriptPath, 'r');
  } catch {
    return emptyTranscript();
  }
  try {
    const stat = await file.stat();
    const cursorFile = cursorPath(dataDir, transcriptPath);
    const save = (parser: Parser, offset: number): void =>
      writeCursor(cursorFile, { version: getHudVersion(), ino: stat.ino, offset, state: parser.save() });
    const cursor = readCursor(cursorFile);
    if (cursor && (await resumes(file, stat, cursor))) {
      try {
        return await parseFrom(file, Parser.load(cursor.state), cursor.offset, save, todoFiles);
      } catch (err) {
        debug('Saved transcript state unusable, rereading:', err instanceof Error ? err.message : err);
      }
    }
    return await parseFrom(file, new Parser(), 0, save, todoFiles);
  } catch (err) {
    debug('Transcript read failed:', err instanceof Error ? err.message : err);
    return emptyTranscript();
  } finally {
    await file.close();
  }
}

const SUBAGENT_DETAIL_MODEL_LINE_LIMIT = 200;
const SUBAGENT_DETAIL_HARD_LINE_LIMIT = 500;
const SUBAGENT_PLANNER_FOLLOWUPS = 2;

const RUNNING_STDIN_STATUSES = new Set(['running', 'working', 'pending', 'queued']);
const TERMINAL_STDIN_STATUSES = new Set([
  'completed',
  'done',
  'error',
  'failed',
  'cancelled',
  'canceled',
  'stopped',
  'idle',
]);

interface StdinGroupStats {
  stillRunning: number;
  terminalCount: number;
  hasUnknown: boolean;
}

interface MatchedBucket {
  stats: StdinGroupStats;
  completedCount: number;
  runningItems: Array<{ agent: AgentEntry; index: number }>;
}

function completeOldestRunning(items: Array<{ agent: AgentEntry; index: number }>, count: number, ts: number): void {
  if (count <= 0 || items.length === 0) return;
  items.sort((a, b) => {
    const ta = a.agent.startTime instanceof Date ? a.agent.startTime.getTime() : 0;
    const tb = b.agent.startTime instanceof Date ? b.agent.startTime.getTime() : 0;
    const validA = Number.isFinite(ta) ? ta : 0;
    const validB = Number.isFinite(tb) ? tb : 0;
    return validA - validB || a.index - b.index;
  });
  const limit = Math.min(count, items.length);
  for (let i = 0; i < limit; i++) {
    const agent = items[i].agent;
    agent.status = 'completed';
    agent.endTime ??= new Date(ts);
  }
}

export function reconcileAgentsWithStdin(
  agents: AgentEntry[],
  stdinSubagents: StdinData['subagents'],
  now = Date.now(),
): void {
  if (!Array.isArray(agents) || agents.length === 0 || !Array.isArray(stdinSubagents) || stdinSubagents.length === 0) {
    return;
  }

  const exactGroups = new Map<string, StdinGroupStats>();
  const byNameStats = new Map<string, StdinGroupStats>();
  const stdinRolesByName = new Map<string, Set<string>>();

  const recordStat = (map: Map<string, StdinGroupStats>, key: string, status: string) => {
    let stat = map.get(key);
    if (!stat) {
      stat = { stillRunning: 0, terminalCount: 0, hasUnknown: false };
      map.set(key, stat);
    }
    if (RUNNING_STDIN_STATUSES.has(status)) stat.stillRunning += 1;
    else if (TERMINAL_STDIN_STATUSES.has(status)) stat.terminalCount += 1;
    else stat.hasUnknown = true;
  };

  for (const item of stdinSubagents) {
    if (!item || typeof item !== 'object') continue;
    const nameKey = normalizeReconcileKey(item.name);
    if (!nameKey) continue;
    const roleKey = normalizeReconcileKey(item.role);
    const status = normalizeReconcileKey(item.status);
    recordStat(exactGroups, `${nameKey}\0${roleKey}`, status);
    recordStat(byNameStats, nameKey, status);
    let roles = stdinRolesByName.get(nameKey);
    if (!roles) {
      roles = new Set();
      stdinRolesByName.set(nameKey, roles);
    }
    roles.add(roleKey);
  }

  const txRolesByName = new Map<string, Set<string>>();
  const parsedAgents: Array<{
    agent: AgentEntry;
    index: number;
    nameKey: string;
    roleKey: string;
    promptKey: string;
    promptTrimmed: string;
    promptTruncated: boolean;
  }> = [];
  for (let i = 0; i < agents.length; i++) {
    const agent = agents[i];
    if (!agent) continue;
    const nameKey = normalizeReconcileKey(agent.type);
    if (!nameKey) continue;
    const roleKey = normalizeReconcileKey(agent.description);
    const rawPromptKey = typeof agent.promptKey === 'string' ? sanitizeDisplayText(agent.promptKey).toLowerCase().trimStart() : '';
    const promptKey = rawPromptKey.slice(0, PROMPT_KEY_MAX_LEN);
    const promptTrimmed = promptKey.trim();
    const promptTruncated = rawPromptKey.length >= PROMPT_KEY_MAX_LEN && promptTrimmed.length > 0;
    parsedAgents.push({ agent, index: i, nameKey, roleKey, promptKey, promptTrimmed, promptTruncated });
    let roles = txRolesByName.get(nameKey);
    if (!roles) {
      roles = new Set();
      txRolesByName.set(nameKey, roles);
    }
    roles.add(roleKey);
  }

  if (!parsedAgents.some((entry) => entry.agent.status === 'running')) return;

  const matchedBuckets = new Map<string, MatchedBucket>();
  const matchedStdinGroupKeys = new Set<string>();
  const unmatchedRunningByName = new Map<string, Array<{ agent: AgentEntry; index: number }>>();
  const unmatchedCompletedByName = new Map<string, number>();
  const pushToBucket = (bucketKey: string, stats: StdinGroupStats, agent: AgentEntry, index: number) => {
    let bucket = matchedBuckets.get(bucketKey);
    if (!bucket) {
      bucket = { stats, completedCount: 0, runningItems: [] };
      matchedBuckets.set(bucketKey, bucket);
    }
    if (agent.status === 'running') {
      bucket.runningItems.push({ agent, index });
    } else {
      bucket.completedCount += 1;
    }
  };

  for (const entry of parsedAgents) {
    // 1. Exact (nameKey, description) match
    const exactKey = `${entry.nameKey}\0${entry.roleKey}`;
    const exactStats = exactGroups.get(exactKey);
    if (exactStats) {
      matchedStdinGroupKeys.add(exactKey);
      pushToBucket(`exact:${exactKey}`, exactStats, entry.agent, entry.index);
      continue;
    }

    // 2. PromptKey match when stdin.subagents[].role carries prompt text (prefix match only when truncated at 64 chars)
    const stdinRoles = stdinRolesByName.get(entry.nameKey);
    if (entry.promptTrimmed && stdinRoles) {
      let matchedRole: string | undefined;
      if (stdinRoles.has(entry.promptTrimmed)) {
        matchedRole = entry.promptTrimmed;
      } else if (entry.promptTruncated) {
        const promptMatches: string[] = [];
        for (const candidateRole of stdinRoles) {
          if (candidateRole.startsWith(entry.promptKey)) {
            promptMatches.push(candidateRole);
          }
        }
        if (promptMatches.length === 1) {
          matchedRole = promptMatches[0];
        }
      }
      if (matchedRole !== undefined) {
        const matchedGroupKey = `${entry.nameKey}\0${matchedRole}`;
        const promptStats = exactGroups.get(matchedGroupKey);
        if (promptStats) {
          matchedStdinGroupKeys.add(matchedGroupKey);
          pushToBucket(`exact:${matchedGroupKey}`, promptStats, entry.agent, entry.index);
          continue;
        }
      }
    }

    // 3. Unambiguous single-side missing role fallback
    const txRoles = txRolesByName.get(entry.nameKey);
    if (stdinRoles && txRoles && stdinRoles.size === 1 && txRoles.size === 1) {
      const onlyStdinRole = [...stdinRoles][0];
      const onlyTxRole = [...txRoles][0];
      const singleSideMissingRole = (onlyStdinRole === '' && onlyTxRole !== '') || (onlyStdinRole !== '' && onlyTxRole === '');
      const nameStats = singleSideMissingRole ? byNameStats.get(entry.nameKey) : undefined;
      if (nameStats) {
        for (const r of stdinRoles) matchedStdinGroupKeys.add(`${entry.nameKey}\0${r}`);
        pushToBucket(`name:${entry.nameKey}`, nameStats, entry.agent, entry.index);
        continue;
      }
    }

    if (entry.agent.status === 'running') {
      let pending = unmatchedRunningByName.get(entry.nameKey);
      if (!pending) {
        pending = [];
        unmatchedRunningByName.set(entry.nameKey, pending);
      }
      pending.push({ agent: entry.agent, index: entry.index });
    } else {
      unmatchedCompletedByName.set(entry.nameKey, (unmatchedCompletedByName.get(entry.nameKey) ?? 0) + 1);
    }
  }

  const ts = Number.isFinite(now) ? now : Date.now();
  for (const { stats, completedCount, runningItems } of matchedBuckets.values()) {
    if (stats.hasUnknown || stats.terminalCount <= completedCount || runningItems.length <= stats.stillRunning) {
      continue;
    }
    completeOldestRunning(
      runningItems,
      Math.min(runningItems.length - stats.stillRunning, stats.terminalCount - completedCount),
      ts,
    );
  }

  // 4. Safe all-terminal fallback: sum only unmatched stdin groups (never borrow terminal budget from matched groups)
  if (unmatchedRunningByName.size > 0) {
    for (const [nameKey, runningItems] of unmatchedRunningByName) {
      const nameStats = byNameStats.get(nameKey);
      if (!nameStats || nameStats.hasUnknown || nameStats.stillRunning !== 0) {
        continue;
      }
      let unmatchedStdinTerminalCount = 0;
      const stdinRoles = stdinRolesByName.get(nameKey);
      if (stdinRoles) {
        for (const r of stdinRoles) {
          const groupKey = `${nameKey}\0${r}`;
          if (matchedStdinGroupKeys.has(groupKey)) continue;
          const groupStats = exactGroups.get(groupKey);
          if (groupStats) unmatchedStdinTerminalCount += groupStats.terminalCount;
        }
      }
      const unmatchedCompletedCount = unmatchedCompletedByName.get(nameKey) ?? 0;
      if (unmatchedStdinTerminalCount <= 0 || unmatchedStdinTerminalCount - unmatchedCompletedCount < runningItems.length) {
        continue;
      }
      completeOldestRunning(runningItems, runningItems.length, ts);
    }
  }
}

interface SubagentDetails {
  model?: string;
  effort?: string;
}

async function readSubagentDetails(file: string): Promise<SubagentDetails> {
  try {
    if (!(await fs.promises.stat(file)).isFile()) return {};
  } catch {
    return {};
  }
  const input = fs.createReadStream(file);
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  const details: SubagentDetails = {};
  let linesRead = 0;
  let plannerFollowups = 0;
  let sawModelInPlanner = false;
  try {
    for await (const raw of rl) {
      linesRead += 1;
      let entry: { type?: unknown; effort?: unknown; thinking_level?: unknown; model?: unknown; message?: { model?: unknown } } | null = null;
      try {
        entry = JSON.parse(raw);
      } catch {}
      if (entry) {
        if (entry.type === 'assistant') {
          const split = splitModelAndEffort(entry.message?.model);
          if (split.model) details.model = split.model;
          const explicit = typeof entry.effort === 'string' ? effortInfo(entry.effort)?.level : undefined;
          if (explicit ?? split.effort) details.effort = explicit ?? split.effort;
          return details;
        }
        if (entry.type === 'PLANNER_RESPONSE') {
          const hadModelBefore = sawModelInPlanner;
          const split = splitModelAndEffort(entry.model);
          if (split.model) details.model = split.model;
          const explicitRaw = entry.effort ?? entry.thinking_level;
          const explicit = typeof explicitRaw === 'string' ? effortInfo(explicitRaw)?.level : undefined;
          if (explicit ?? split.effort) details.effort = explicit ?? split.effort;
          if (details.model && details.effort) return details;
          if (details.model) {
            if (hadModelBefore) {
              plannerFollowups += 1;
              if (plannerFollowups >= SUBAGENT_PLANNER_FOLLOWUPS) return details;
            } else {
              sawModelInPlanner = true;
            }
          }
        }
      }
      if ((details.model && linesRead >= SUBAGENT_DETAIL_MODEL_LINE_LIMIT) || linesRead >= SUBAGENT_DETAIL_HARD_LINE_LIMIT) {
        break;
      }
    }
  } catch {} finally {
    rl.close();
    input.destroy();
  }
  return details;
}

export async function addSubagentEfforts(
  subagentsDir: string,
  agents: AgentEntry[],
  agySubagentTranscripts?: Record<string, string>,
): Promise<void> {
  await Promise.all(agents.map(async (agent) => {
    if (!agent.agentId || !AGENT_ID.test(agent.agentId)) return;
    const mappedFile = agySubagentTranscripts?.[agent.agentId];
    const targetFile = mappedFile || (subagentsDir ? path.join(subagentsDir, `agent-${agent.agentId}.jsonl`) : '');
    if (!targetFile) return;
    const details = await readSubagentDetails(targetFile);
    if (details.model) agent.model = details.model;
    if (details.effort) agent.effort = details.effort;
  }));
}
