import type { StdinData, UsageData, TranscriptData } from './types.ts';
import type { ModelFormatMode } from './config.ts';
import { sanitizeTranscriptModel } from './model-source.ts';
import { displayLabel } from './utils/sanitize.ts';

export function getTotalTokens(stdin: StdinData): number {
  const usage = stdin.context_window?.current_usage;
  if (usage) {
    return (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
  }
  return stdin.context_window?.total_input_tokens ?? 0;
}

export interface ContextUsage {
  percent: number;
  tokens: number;
  size: number;
}

const toPercent = (value: number): number => Math.min(100, Math.max(0, Math.round(value)));

export function getContextUsage(
  stdin: StdinData,
  autoCompactWindow?: number | null,
  transcriptTokens?: number,
): ContextUsage {
  const live = getTotalTokens(stdin);
  const tokens = live > 0 ? live : transcriptTokens ?? 0;
  const win = stdin.context_window;
  if (typeof autoCompactWindow === 'number' && autoCompactWindow > 0) {
    return { percent: toPercent((tokens / autoCompactWindow) * 100), tokens, size: autoCompactWindow };
  }

  const size = win?.context_window_size ?? 0;
  const native = win?.used_percentage;
  if (typeof native === 'number' && Number.isFinite(native) && native > 0) {
    return { percent: toPercent(native), tokens, size };
  }
  return { percent: size > 0 ? toPercent((tokens / size) * 100) : 0, tokens, size };
}

export function isContextUnreported(stdin: StdinData): boolean {
  const native = stdin.context_window?.used_percentage;
  return !(typeof native === 'number' && native > 0) && getTotalTokens(stdin) === 0;
}

export function humanizeModelId(modelId: string | undefined): string {
  if (!modelId || typeof modelId !== 'string') return '';
  let m = /^gemini-([\d.]+)-(flash|pro|argon|hydrogen)(?:-(.+))?$/i.exec(modelId);
  if (m) {
    const fam = m[2].charAt(0).toUpperCase() + m[2].slice(1).toLowerCase();
    return `Gemini ${m[1]} ${fam}`;
  }
  m = /^claude-(sonnet|opus|haiku)-(\d+)-(\d+)(?:-(.+))?$/i.exec(modelId);
  if (m) {
    const fam = m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase();
    return `Claude ${fam} ${m[2]}.${m[3]}`;
  }
  return modelId;
}

export function getModelName(stdin: StdinData, transcript?: TranscriptData): string {
  return (
    stdin.model?.display_name?.trim() ||
    (stdin.model?.id ? humanizeModelId(stdin.model.id.trim()) : '') ||
    transcript?.transcriptModelSelection?.trim() ||
    'Unknown'
  );
}

function isClaudeModel(model: string): boolean {
  const lower = model.toLowerCase();
  return lower.startsWith('claude-') || lower.startsWith('anthropic.');
}

export function resolveModelName(
  stdin: StdinData,
  transcript: TranscriptData | undefined,
  modelSource: 'auto' | 'stdin' | 'transcript' = 'stdin',
): string {
  const stdinModel = getModelName(stdin, transcript);
  const servedModel = sanitizeTranscriptModel(transcript?.lastAssistantModel);
  if (modelSource === 'stdin' || !servedModel) return stdinModel;
  if (modelSource === 'transcript') return servedModel;
  return isClaudeModel(servedModel) ? stdinModel : servedModel;
}

export function isBedrockModelId(modelId?: string): boolean {
  return modelId?.toLowerCase().includes('anthropic.claude-') ?? false;
}

export function isVertexModelId(modelId?: string): boolean {
  return modelId?.includes('@') ?? false;
}

const ENTERPRISE_MODEL_IDS = new Set(['opusplan', 'sonnetplan', 'haikuplan']);
const MINIMAX_ANTHROPIC_ENDPOINTS = new Set([
  'https://api.minimax.io/anthropic',
  'https://api.minimaxi.com/anthropic',
]);

function isMiniMaxAnthropicEndpoint(env: NodeJS.ProcessEnv): boolean {
  const baseUrl = env.ANTHROPIC_BASE_URL?.trim() || env.ANTHROPIC_API_BASE_URL?.trim();
  if (!baseUrl) return false;
  try {
    const url = new URL(baseUrl);
    return MINIMAX_ANTHROPIC_ENDPOINTS.has(`${url.origin}${url.pathname.replace(/\/+$/, '')}`);
  } catch {
    return false;
  }
}

export function getProviderLabel(stdin: StdinData, env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.CLAUDE_CODE_USE_BEDROCK === '1') return 'Bedrock';
  if (env.CLAUDE_CODE_USE_VERTEX === '1') return 'Vertex';
  if (isMiniMaxAnthropicEndpoint(env)) return 'MiniMax';
  if (ENTERPRISE_MODEL_IDS.has(stdin.model?.id?.toLowerCase() ?? '')) return 'Enterprise';
  return null;
}

function parsePercent(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? toPercent(value) : null;
}

function parseResetAt(value: unknown): Date | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? new Date(value * 1000) : null;
}

export function getUsageFromStdin(stdin: StdinData): UsageData | null {
  const limits = stdin.rate_limits;
  const fiveHour = parsePercent(limits?.five_hour?.used_percentage);
  const sevenDay = parsePercent(limits?.seven_day?.used_percentage);
  if (fiveHour === null && sevenDay === null) return null;
  return {
    fiveHour,
    sevenDay,
    fiveHourResetAt: parseResetAt(limits?.five_hour?.resets_at),
    sevenDayResetAt: parseResetAt(limits?.seven_day?.resets_at),
  };
}

export function stdinText(value: unknown, maxLength = 80): string | undefined {
  return displayLabel(value, maxLength) || undefined;
}

export function stripContextSuffix(name: string): string {
  return name.replace(/\s*\([^)]*\bcontext\b[^)]*\)/i, '').trim();
}

export function formatModelName(name: string, format?: ModelFormatMode, override?: string): string {
  if (override) return override;
  if (!format || format === 'full') return name;
  const compact = stripContextSuffix(name);
  return format === 'short' ? compact.replace(/^Claude\s+/i, '') : compact;
}

export function resolveAgentMode(stdin: StdinData, transcriptMode?: string): string | null {
  const raw =
    stdin.cycle_mode ||
    stdin.cycleMode ||
    stdin.agent_mode ||
    stdin.agentMode ||
    stdin.permission_mode ||
    stdin.permissionMode ||
    stdin.mode ||
    transcriptMode;
  return stdinText(raw, 40) ?? null;
}
