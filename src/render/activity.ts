import { t } from '../i18n/index.ts';
import type { AgentEntry, TodoItem } from '../types.ts';
import { getFileHref, safeHyperlink } from '../utils/hyperlinks.ts';
import { sanitizeDisplayText } from '../utils/sanitize.ts';
import { truncateString } from '../utils/truncate.ts';
import type { Frame } from './frame.ts';
import { cyan, dim, green, label, magenta, red, yellow } from './colors.ts';

function formatElapsedDuration(ms: number): string {
  const secs = Math.max(0, Math.floor(ms / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return secs % 60 > 0 ? `${mins}m ${secs % 60}s` : `${mins}m`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m`;
}

function symbols(unicode: boolean) {
  return unicode
    ? { running: '◐', done: '✓', error: '✗', bullet: '▸', ellipsis: '…' }
    : { running: '*', done: '+', error: 'x', bullet: '>', ellipsis: '...' };
}

function formatToolTarget(target: string | undefined, maxLen: number, unicode: boolean): string {
  if (!target) return '';
  const clean = sanitizeDisplayText(target);
  if (!clean) return '';
  const shown = maxLen > 0 ? truncateString(clean, Math.max(8, maxLen), unicode ? '…' : '...') : clean;
  const linked = clean.startsWith('/') || /^[A-Za-z]:[\\/]/.test(clean)
    ? safeHyperlink(getFileHref(clean), dim(` ${shown}`))
    : dim(` ${shown}`);
  return linked;
}

export function toolsLine(f: Frame): string | null {
  const display = f.config?.display;
  if (display?.showTools !== true) return null;
  const tools = f.transcript?.tools ?? [];
  if (tools.length === 0) return null;

  const sym = symbols(f.unicode);
  const rawMaxVisible = display?.toolsMaxVisible ?? 4;
  const maxVisible = rawMaxVisible <= 0 ? tools.length : rawMaxVisible;
  const maxLen = display?.toolNameMaxLength ?? 0;
  const truncateName = (text: string): string => (maxLen > 0 ? truncateString(text, maxLen, sym.ellipsis) : text);
  const running = tools.filter((tool) => tool.status === 'running');
  const completed = tools.filter((tool) => tool.status !== 'running');

  const parts: string[] = [];
  for (const tool of running.slice(-maxVisible)) {
    const name = cyan(truncateName(sanitizeDisplayText(tool.name)));
    const target = formatToolTarget(tool.target, maxLen, f.unicode);
    parts.push(`${yellow(sym.running)} ${name}${target}`);
  }

  const remainingSlots = Math.max(0, maxVisible - parts.length);
  if (remainingSlots > 0 && completed.length > 0) {
    const counts = new Map<string, { count: number; hasError: boolean }>();
    for (const tool of completed) {
      const name = sanitizeDisplayText(tool.name);
      const entry = counts.get(name) ?? { count: 0, hasError: false };
      entry.count += 1;
      if (tool.status === 'error') entry.hasError = true;
      counts.set(name, entry);
    }
    const items = [...counts.entries()].slice(-remainingSlots).map(([name, info]) => {
      const icon = info.hasError ? red(sym.error) : green(sym.done);
      const short = truncateName(name);
      return `${icon} ${label(short, f.config?.colors)}${info.count > 1 ? dim(` ×${info.count}`) : ''}`;
    });
    parts.push(...items);
  }

  if (parts.length === 0) return null;
  return parts.join('  ');
}

export function skillsLine(f: Frame): string | null {
  const display = f.config?.display;
  if (display?.showSkills !== true) return null;
  const skills = f.transcript?.skills ?? [];
  if (skills.length === 0) return null;
  const unique = [...new Set(skills.map((s) => sanitizeDisplayText(s)).filter(Boolean))];
  if (unique.length === 0) return null;

  const rawMaxVisible = display?.skillsMaxVisible ?? 4;
  const maxVisible = rawMaxVisible <= 0 ? unique.length : rawMaxVisible;
  const shown = unique.slice(0, maxVisible).map((s) => magenta(`/${s}`));
  if (unique.length > maxVisible) {
    shown.push(dim(`+${unique.length - maxVisible}`));
  }
  return `${label('Skills:', f.config?.colors)} ${shown.join(', ')}`;
}

export function mcpLine(f: Frame): string | null {
  const display = f.config?.display;
  if (display?.showMcp !== true) return null;
  const servers = f.transcript?.mcpServers ?? [];
  const errors = new Set(f.transcript?.mcpErrors ?? []);
  if (servers.length === 0 && errors.size === 0) return null;

  const all = [...new Set([...servers, ...errors])].filter(Boolean);
  const sym = symbols(f.unicode);
  const items = all.slice(0, 6).map((srv) => {
    const clean = sanitizeDisplayText(srv);
    return errors.has(srv) ? `${red(sym.error)} ${red(clean)}` : `${green(sym.done)} ${dim(clean)}`;
  });
  if (all.length > 6) items.push(dim(`+${all.length - 6}`));
  return `${label('MCP:', f.config?.colors)} ${items.join('  ')}`;
}

export function agentsLine(f: Frame): string | null {
  const display = f.config?.display;
  if (display?.showAgents !== true) return null;
  const agents = f.transcript?.agents ?? [];
  const running = agents.filter((a: AgentEntry) => a.status === 'running');
  if (running.length === 0 && agents.length === 0) return null;

  const sym = symbols(f.unicode);
  const list = running.length > 0 ? running.slice(-3) : agents.slice(-2);
  const items = list.map((agent) => {
    const icon = agent.status === 'running' ? yellow(sym.running) : green(sym.done);
    const kind = cyan(sanitizeDisplayText(agent.type || 'agent'));
    const effort = display?.showAgentEffort && agent.effort ? dim(`:${sanitizeDisplayText(agent.effort)}`) : '';
    const desc = agent.description
      ? dim(` (${truncateString(sanitizeDisplayText(agent.description), 24, sym.ellipsis)})`)
      : '';
    const endMs = agent.endTime ? agent.endTime.getTime() : f.now;
    const elapsed = agent.startTime ? dim(` ${formatElapsedDuration(endMs - agent.startTime.getTime())}`) : '';
    return `${icon} ${kind}${effort}${desc}${elapsed}`;
  });
  return items.join('  ');
}

export function todosLine(f: Frame): string | null {
  if (f.config?.display?.showTodos !== true) return null;
  const todos: TodoItem[] = f.transcript?.todos ?? [];
  if (todos.length === 0) return null;

  const sym = symbols(f.unicode);
  const completed = todos.filter((item) => item.status === 'completed').length;
  const inProgress = todos.find((item) => item.status === 'in_progress');
  const nextPending = todos.find((item) => item.status === 'pending');

  if (!inProgress && completed === todos.length) {
    return `${green(sym.done)} ${green(t('status.allTodosComplete'))} ${dim(`(${completed}/${todos.length})`)}`;
  }
  const active = inProgress ?? nextPending;
  const text = active ? truncateString(sanitizeDisplayText(active.content), 42, sym.ellipsis) : '';
  const icon = inProgress ? yellow(sym.bullet) : dim(sym.bullet);
  return `${icon} ${text} ${dim(`(${completed}/${todos.length})`)}`;
}
