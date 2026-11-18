import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { createHash } from 'node:crypto';
import { createDebug } from './debug.ts';
import type { AgentEntry, SessionTokenUsage, TodoItem, ToolEntry, TranscriptData } from './types.ts';
import { displayLabel, sanitizeDisplayText } from './utils/sanitize.ts';
import { truncateString } from './utils/truncate.ts';
import { sanitizeTranscriptModel } from './model-source.ts';

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
    case 'edit_file':
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

function parseDurationToMs(durationStr: string): number {
  let ms = 0;
  const segments = [...durationStr.matchAll(/(\d+)([hms])/g)];
  if (segments.length > 0) {
    for (const [, val, unit] of segments) {
      const n = parseInt(val, 10);
      if (unit === 'h') ms += n * 3_600_000;
      else if (unit === 'm') ms += n * 60_000;
      else if (unit === 's') ms += n * 1000;
    }
  } else {
    const val = parseInt(durationStr, 10);
    if (Number.isFinite(val)) ms = val * 1000;
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
  private usageById = new Map<string, SessionTokenUsage>();
  private settled: SessionTokenUsage = { ...ZERO_USAGE };
  private lastIdlessUsage: string | undefined;
  private lastStepTimeMs: number | null = null;
  private pendingAgyToolIds: string[] = [];
  private agyToolSeq = 0;
  private data: TranscriptData = { ...emptyTranscript(), compactionCount: 0, steps: 0, totalApiDurationMs: 0 };

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

      const senderMatches = entry.content.matchAll(/\[Message\][^\n]*?sender=([^\s\]]+)/g);
      for (const m of senderMatches) {
        const sender = m[1];
        const callId = this.agentIdToToolUseId.get(sender);
        const agent = callId ? this.agents.get(callId) : [...this.agents.values()].find((a) => a.agentId === sender || (a.status === 'running' && sender.includes(a.agentId ?? '___')));
        if (agent && agent.status === 'running') {
          agent.status = 'completed';
          agent.endTime = at ?? new Date();
        }
      }
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
          const p = unquoteAgyArg(args.Path);
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
        if ((tc.name === 'write_file' || tc.name === 'write_to_file') && typeof args.Path === 'string') {
          const targetPath = unquoteAgyArg(args.Path) ?? '';
          const body = unquoteRaw(args.Content ?? args.CodeContent) ?? '';
          if (/(?:todo|task)\.md$/i.test(targetPath) && body) {
            const parsedTodos: TodoItem[] = [];
            for (const line of body.split(/\r?\n/)) {
              const m = /^\s*[-*]\s+\[([ xX/])\]\s+(.+)$/.exec(line);
              if (!m) continue;
              const status: TodoItem['status'] = m[1] === 'x' || m[1] === 'X' ? 'completed' : m[1] === '/' ? 'in_progress' : 'pending';
              const content = sanitizeDisplayText(m[2]);
              if (content) parsedTodos.push({ content, status });
            }
            if (parsedTodos.length > 0) this.replaceTodos(parsedTodos);
          }
        }
        if (tc.name === 'call_mcp_tool') {
          const srv = name(unquoteAgyArg(args.ServerName));
          if (srv) this.mcpServers.add(srv);
        } else {
          const srv = mcpServer(tc.name);
          if (srv) this.mcpServers.add(srv);
        }

        if (tc.name === 'invoke_subagent') {
          this.agents.set(callId, {
            id: callId,
            type: unquoteAgyArg(args.TypeName) ?? 'subagent',
            model: sanitizeTranscriptModel(unquoteAgyArg(args.Model)),
            description: unquoteAgyArg(args.Role),
            status: 'running',
            startTime: at ?? new Date(),
            background: true,
          });
          cap(this.agents, AGENTS_KEPT);
        } else if (tc.name === 'swarm' && unquoteAgyArg(args.action) === 'add') {
          this.agents.set(callId, {
            id: callId,
            type: unquoteAgyArg(args.name) ?? 'swarm',
            model: sanitizeTranscriptModel(unquoteAgyArg(args.model)),
            description: unquoteAgyArg(args.brief),
            status: 'running',
            startTime: at ?? new Date(),
            background: true,
          });
          cap(this.agents, AGENTS_KEPT);
        } else {
          this.tools.set(callId, {
            id: callId,
            name: tc.name,
            target: toolTarget(tc.name, args),
            status: 'running',
            startTime: at ?? new Date(),
          });
          this.pendingAgyToolIds.push(callId);
          cap(this.tools, TOOLS_TRACKED);
        }
      }
    }
  }

  private agyGenericResponse(entry: Entry, at: Date | null, entryTimeMs: number | null): void {
    const content = typeof entry.content === 'string' ? entry.content : '';
    const isSubagentLaunch = /"conversationId"\s*:|Launched subagent|conversationId:/i.test(content) && !content.includes('finished');
    if (isSubagentLaunch) {
      const idMatch = /conversationId["']?\s*[:=]\s*["']?([\w-]{8,128})/i.exec(content);
      if (idMatch?.[1]) {
        const running = [...this.agents.values()].filter((a) => a.status === 'running' && !a.agentId).at(-1);
        if (running) {
          running.agentId = idMatch[1];
          this.agentIdToToolUseId.set(idMatch[1], running.id);
        }
      }
      return;
    }

    const senderMatch = /\[Message\][^\n]*?sender=([^\s\]]+)/.exec(content);
    if (senderMatch?.[1]) {
      const cid = this.agentIdToToolUseId.get(senderMatch[1]);
      const target = cid ? this.agents.get(cid) : [...this.agents.values()].find((a) => a.agentId === senderMatch[1]);
      if (target && target.status === 'running') {
        target.status = 'completed';
        target.endTime = at ?? new Date();
      }
    }

    const nextId = this.pendingAgyToolIds.shift();
    if (nextId) {
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
    if (content.includes('conversation://') && entryTimeMs !== null) {
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
      entryContent.includes('RESOURCE_EXHAUSTED');
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

    let resetTimeMs = 0;
    if (timestampMs > 0) resetTimeMs = timestampMs;
    else if (delayMs > 0) {
      const timeStr = entry.created_at ?? entry.timestamp;
      const entryTime = timeStr ? new Date(timeStr).getTime() : Date.now();
      resetTimeMs = entryTime + delayMs;
    }

    if (resetTimeMs > Date.now()) {
      const prev = this.data.imageExhausted ? Date.parse(this.data.imageExhausted.resetTime) : 0;
      if (resetTimeMs > prev) {
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
      this.agents.set(block.id as string, {
        id: block.id as string,
        type: (input?.subagent_type as string) ?? 'agent',
        model: sanitizeTranscriptModel(input?.model),
        description: (input?.description as string) ?? undefined,
        status: 'running',
        startTime: at,
        background: input?.run_in_background === true,
      });
      if (cap(this.agents, AGENTS_KEPT)) {
        for (const id of this.agentCompletions.keys()) if (!this.agents.has(id)) this.agentCompletions.delete(id);
        for (const [agentId, id] of this.agentIdToToolUseId) if (!this.agents.has(id)) this.agentIdToToolUseId.delete(agentId);
      }
    } else if (toolName === 'TodoWrite') {
      if (Array.isArray(input?.todos)) this.replaceTodos(input.todos.flatMap(toTodo));
    } else if (toolName === 'TaskCreate') {
      const content = text(input?.subject) ?? text(input?.description);
      this.todos.push({ content: content ?? 'Untitled task', status: taskStatus(input?.status) ?? 'pending' });
      const numbered = String(this.nextTaskId++);
      const explicit = typeof input?.taskId === 'string' || typeof input?.taskId === 'number' ? String(input.taskId) : null;
      for (const id of explicit ? [explicit] : [numbered, block.id]) if (id) this.taskIndex.set(id, this.todos.length - 1);
    } else if (toolName === 'TaskUpdate') {
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
      usageById: [...this.usageById],
      settled: this.settled,
      lastIdlessUsage: this.lastIdlessUsage,
      lastStepTimeMs: this.lastStepTimeMs,
      pendingAgyToolIds: this.pendingAgyToolIds,
      agyToolSeq: this.agyToolSeq,
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
    parser.usageById = new Map(s.usageById);
    parser.settled = s.settled;
    parser.lastIdlessUsage = s.lastIdlessUsage;
    parser.lastStepTimeMs = s.lastStepTimeMs ?? null;
    parser.pendingAgyToolIds = s.pendingAgyToolIds ?? [];
    parser.agyToolSeq = s.agyToolSeq ?? 0;
    parser.data = s.data;
    return parser;
  }

  finish(): TranscriptData {
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

const DATE_KEYS = new Set(['startTime', 'endTime', 'sessionStart', 'lastAssistantResponseAt']);
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

interface Cursor {
  version: string;
  ino: number;
  offset: number;
  state: SavedState;
}

const CURSORS_KEPT = 32;
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

function writeCursor(file: string, cursor: Cursor): void {
  try {
    const dir = path.dirname(file);
    const isNew = !fs.existsSync(file);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cursor), { mode: 0o600 });
    fs.renameSync(tmp, file);
    if (isNew) pruneCursors(dir);
  } catch (err) {
    debug('Transcript cursor write failed:', err instanceof Error ? err.message : err);
  }
}

function pruneCursors(dir: string): void {
  const files = fs.readdirSync(dir).map((fileName) => path.join(dir, fileName));
  if (files.length <= CURSORS_KEPT) return;
  const byAge = files.map((file) => ({ file, mtime: fs.statSync(file).mtimeMs })).sort((a, b) => a.mtime - b.mtime);
  for (const { file } of byAge.slice(0, files.length - CURSORS_KEPT)) fs.rmSync(file, { force: true });
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
  return parser.finish();
}

export async function parseTranscript(transcriptPath: string, dataDir: string): Promise<TranscriptData> {
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
        return await parseFrom(file, Parser.load(cursor.state), cursor.offset, save);
      } catch (err) {
        debug('Saved transcript state unusable, rereading:', err instanceof Error ? err.message : err);
      }
    }
    return await parseFrom(file, new Parser(), 0, save);
  } catch (err) {
    debug('Transcript read failed:', err instanceof Error ? err.message : err);
    return emptyTranscript();
  } finally {
    await file.close();
  }
}

const AGENT_ID = /^[\w-]{1,64}$/;

async function subagentEffort(subagentsDir: string, agentId: string): Promise<string | undefined> {
  if (!AGENT_ID.test(agentId)) return undefined;
  const file = path.join(subagentsDir, `agent-${agentId}.jsonl`);
  try {
    if (!(await fs.promises.stat(file)).isFile()) return undefined;
  } catch {
    return undefined;
  }
  const input = fs.createReadStream(file);
  try {
    for await (const raw of readline.createInterface({ input, crlfDelay: Infinity })) {
      let entry: { type?: unknown; effort?: unknown } | null = null;
      try {
        entry = JSON.parse(raw);
      } catch {
        continue;
      }
      if (entry?.type === 'assistant') return typeof entry.effort === 'string' ? entry.effort : undefined;
    }
  } catch {} finally {
    input.destroy();
  }
  return undefined;
}

export async function addSubagentEfforts(subagentsDir: string, agents: AgentEntry[]): Promise<void> {
  await Promise.all(agents.map(async (agent) => {
    if (agent.agentId) agent.effort = await subagentEffort(subagentsDir, agent.agentId);
  }));
}
