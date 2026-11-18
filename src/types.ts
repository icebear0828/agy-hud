import type { HudConfig } from './config.ts';
import type { GitRepoIdentity, GitStatus } from './git.ts';
import type { AuthInfo } from './auth.ts';
import type { CostTotals } from './daily-cost.ts';

export interface AgyStdinQuotaBucket {
  remaining_fraction?: number | null;
  reset_time?: string | null;
}

export interface StdinData {
  session_id?: string;
  conversation_id?: string;
  conversation_title?: string;
  session_name?: string;
  version?: string;
  product?: string;
  email?: string;
  terminal_width?: number;
  transcript_path?: string;
  cwd?: string;
  plan_tier?: string;
  task_count?: number;
  cycle_mode?: string;
  cycleMode?: string;
  agent_mode?: string;
  agentMode?: string;
  permission_mode?: string;
  permissionMode?: string;
  mode?: string;
  thinking_level?: string;
  reasoning_effort?: string;
  workspace?: {
    current_dir?: string;
    project_dir?: string;
    added_dirs?: string[];
    git_worktree?: string;
    repo?: GitRepoIdentity;
  } | null;
  model?: {
    id?: string;
    display_name?: string;
    effort?: string;
    thinking_level?: string;
    reasoning_effort?: string;
  };
  output_style?: { name?: string };
  context_window?: {
    context_window_size?: number;
    total_input_tokens?: number | null;
    total_output_tokens?: number | null;
    current_usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    } | null;
    used_percentage?: number | null;
    remaining_percentage?: number | null;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
  };
  cost?: {
    total_cost_usd?: number | null;
    total_usd?: number | null;
    total_duration_ms?: number | null;
    total_api_duration_ms?: number | null;
    total_lines_added?: number | null;
    total_lines_removed?: number | null;
  } | null;
  total_usd?: number | null;
  total_api_duration_ms?: number | null;
  rate_limits?: {
    five_hour?: RateLimitWindow | null;
    seven_day?: RateLimitWindow | null;
    spend_limit?: RateLimitWindow | null;
  } | null;
  quota?: Record<string, AgyStdinQuotaBucket | undefined> | null;
  prompt_cache?: {
    warm?: boolean;
    caching_observed?: boolean;
    ttl?: string;
    expires_at?: number | null;
    hit_ratio?: number | null;
  } | null;
  effort?: { level?: string } | string | null;
  worktree?: { name?: string; path?: string; branch?: string } | null;
}

interface RateLimitWindow {
  used_percentage?: number | null;
  resets_at?: number | null;
}

export interface AgyQuotaWindow {
  remainingFraction: number;
  resetTime: string | null;
  observedAt?: number;
}

export interface AgyModelQuota {
  id: string;
  displayName?: string;
  modelProvider?: string | null;
  remainingFraction: number;
  resetTime?: string | null;
  window?: 'fiveHour' | 'weekly' | null;
  windows?: {
    fiveHour?: AgyQuotaWindow;
    weekly?: AgyQuotaWindow;
  };
}

export interface AgyProviderWindows {
  fiveHour?: AgyQuotaWindow;
  weekly?: AgyQuotaWindow;
}

export interface AgyProviderQuotaSummary {
  google?: AgyProviderWindows;
  claude?: AgyProviderWindows;
  argon?: AgyProviderWindows;
}

export interface AgyQuotaProbe {
  models: AgyModelQuota[];
  providerQuota: AgyProviderQuotaSummary | null;
  unavailableReason: string | null;
  tierName: string | null;
  accountEmail: string | null;
  updateInfo: { updateAvailable?: boolean; latestVersion?: string } | null;
}

export interface ToolEntry {
  id: string;
  name: string;
  target?: string;
  status: 'running' | 'completed' | 'error';
  startTime: Date;
  endTime?: Date;
}

export interface AgentEntry {
  id: string;
  type: string;
  model?: string;
  description?: string;
  status: 'running' | 'completed';
  startTime: Date;
  endTime?: Date;
  background?: boolean;
  agentId?: string;
  effort?: string;
}

export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export interface UsageData {
  fiveHour: number | null;
  sevenDay: number | null;
  fiveHourResetAt: Date | null;
  sevenDayResetAt: Date | null;
  balanceLabel?: string | null;
  scopedWindows?: ScopedUsageWindow[];
  // Precise remaining fraction when sourced from Antigravity quota (for decimal display modes).
  fiveHourRemainingExact?: number | null;
  sevenDayRemainingExact?: number | null;
}

export interface ScopedUsageWindow {
  label: string;
  percent: number | null;
  resetAt: Date | null;
}

export interface ExternalUsageSnapshot {
  five_hour?: {
    used_percentage?: number | null;
    resets_at?: string | number | null;
  } | null;
  seven_day?: {
    used_percentage?: number | null;
    resets_at?: string | number | null;
  } | null;
  updated_at?: string | number | null;
  balance_label?: string | null;
  model_scoped?: Array<{
    display_name?: string | null;
    utilization?: number | null;
    resets_at?: string | null;
  }> | null;
}

export interface MemoryInfo {
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  usedPercent: number;
}

export function isLimitReached(data: UsageData): boolean {
  return data.fiveHour === 100 || data.sevenDay === 100;
}

export interface SessionTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

export interface TranscriptData {
  tools: ToolEntry[];
  skills: string[];
  mcpServers: string[];
  mcpErrors: string[];
  agents: AgentEntry[];
  todos: TodoItem[];
  sessionStart?: Date;
  lastAssistantResponseAt?: Date;
  sessionTokens?: SessionTokenUsage;
  compactionCount?: number;
  contextTokens?: number;
  advisorModel?: string;
  ultracodeActive?: boolean;
  lastAssistantModel?: string;
  // Antigravity transcript extensions
  steps?: number;
  imageExhausted?: { exhausted: true; resetTime: string };
  totalApiDurationMs?: number;
  transcriptOutputSpeed?: number;
  transcriptModelSelection?: string;
  transcriptMode?: string;
  lastTurnUsage?: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
  };
}

export interface RenderContext {
  stdin: StdinData;
  transcript: TranscriptData;
  claudeMdCount: number;
  memoryLabelName?: string;
  rulesCount: number;
  mcpCount: number;
  hooksCount: number;
  agentsCount?: number;
  costTotals: CostTotals | null;
  outputSpeed: number | null;
  gitStatus: GitStatus | null;
  usageData: UsageData | null;
  agyQuota?: AgyQuotaProbe | null;
  memoryUsage: MemoryInfo | null;
  config: HudConfig;
  extraLabel: string | null;
  authInfo?: AuthInfo | null;
  unicodeSupported?: boolean;
}
