import type {
  AgyModelQuota,
  AgyProviderQuotaSummary,
  AgyProviderWindows,
  AgyQuotaProbe,
  AgyQuotaWindow,
  StdinData,
  UsageData,
} from './types.ts';

export function parseAgyStdinQuota(quotaObj: StdinData['quota']): AgyProviderQuotaSummary | null {
  if (!quotaObj || typeof quotaObj !== 'object') return null;
  const result: AgyProviderQuotaSummary = {};

  if (quotaObj['gemini-5h'] || quotaObj['gemini-weekly']) {
    result.google = {};
    const five = quotaObj['gemini-5h'];
    if (five && typeof five.remaining_fraction === 'number') {
      result.google.fiveHour = {
        remainingFraction: Math.min(1, Math.max(0, five.remaining_fraction)),
        resetTime: five.reset_time ?? null,
      };
    }
    const week = quotaObj['gemini-weekly'];
    if (week && typeof week.remaining_fraction === 'number') {
      result.google.weekly = {
        remainingFraction: Math.min(1, Math.max(0, week.remaining_fraction)),
        resetTime: week.reset_time ?? null,
      };
    }
  }

  if (quotaObj['3p-5h'] || quotaObj['3p-weekly']) {
    result.claude = {};
    const five = quotaObj['3p-5h'];
    if (five && typeof five.remaining_fraction === 'number') {
      result.claude.fiveHour = {
        remainingFraction: Math.min(1, Math.max(0, five.remaining_fraction)),
        resetTime: five.reset_time ?? null,
      };
    }
    const week = quotaObj['3p-weekly'];
    if (week && typeof week.remaining_fraction === 'number') {
      result.claude.weekly = {
        remainingFraction: Math.min(1, Math.max(0, week.remaining_fraction)),
        resetTime: week.reset_time ?? null,
      };
    }
  }

  if (quotaObj['argon-5h'] || quotaObj['argon-weekly'] || quotaObj['gemini-argon-wtu-weekly']) {
    result.argon = {};
    const five = quotaObj['argon-5h'];
    if (five && typeof five.remaining_fraction === 'number') {
      result.argon.fiveHour = {
        remainingFraction: Math.min(1, Math.max(0, five.remaining_fraction)),
        resetTime: five.reset_time ?? null,
      };
    }
    const week = quotaObj['argon-weekly'] ?? quotaObj['gemini-argon-wtu-weekly'];
    if (week && typeof week.remaining_fraction === 'number') {
      result.argon.weekly = {
        remainingFraction: Math.min(1, Math.max(0, week.remaining_fraction)),
        resetTime: week.reset_time ?? null,
      };
    }
  }

  return Object.keys(result).length > 0 ? result : null;
}

function isNonExpiredWindow(win: AgyQuotaWindow | undefined, now: number): win is AgyQuotaWindow {
  if (!win) return false;
  if (!win.resetTime) return true;
  const ts = Date.parse(win.resetTime);
  return !Number.isFinite(ts) || ts > now;
}

export function mergeAgyQuotaProbe(probe: AgyQuotaProbe | null | undefined, stdin: StdinData, now = Date.now()): AgyQuotaProbe | null {
  const stdinPq = parseAgyStdinQuota(stdin.quota);
  if (!probe && !stdinPq) return null;
  const base: AgyQuotaProbe = probe
    ? { ...probe, models: [...(probe.models ?? [])] }
    : { models: [], providerQuota: null, unavailableReason: null, tierName: null, accountEmail: null, updateInfo: null };

  if (!stdinPq) return base;

  const prevPq = base.providerQuota ?? {};
  const mergedPq: AgyProviderQuotaSummary = { ...prevPq, ...stdinPq };
  for (const key of ['google', 'claude', 'argon'] as const) {
    if (prevPq[key] || stdinPq[key]) {
      mergedPq[key] = { ...(prevPq[key] ?? {}), ...(stdinPq[key] ?? {}) };
    }
  }
  base.providerQuota = mergedPq;

  base.models = base.models.map((m) => {
    const isArgon = /argon/i.test(m.id) || /argon/i.test(m.displayName ?? '');
    const isGoogle = !isArgon && (m.modelProvider === 'MODEL_PROVIDER_GOOGLE' || /gemini/i.test(m.id) || /gemini/i.test(m.displayName ?? ''));
    const isClaude = m.modelProvider === 'MODEL_PROVIDER_ANTHROPIC' || /claude|gpt/i.test(m.id) || /claude|gpt/i.test(m.displayName ?? '');
    const key = isArgon ? 'argon' : isGoogle ? 'google' : isClaude ? 'claude' : null;
    const summary = key ? mergedPq[key] : undefined;
    if (!summary) return m;
    const windows = { ...(m.windows ?? {}) };
    if (summary.fiveHour) windows.fiveHour = { ...summary.fiveHour, observedAt: now };
    if (summary.weekly) windows.weekly = { ...summary.weekly, observedAt: now };
    return { ...m, windows };
  });

  return base;
}

function matchProviderForModel(modelId: string, modelName: string): keyof AgyProviderQuotaSummary {
  const text = `${modelId} ${modelName}`.toLowerCase();
  if (text.includes('argon')) return 'argon';
  if (text.includes('claude') || text.includes('sonnet') || text.includes('opus') || text.includes('haiku') || text.includes('gpt')) return 'claude';
  return 'google';
}

function findMatchingModelQuota(models: AgyModelQuota[], modelId: string, modelName: string): AgyModelQuota | undefined {
  const norm = (s: string) => s.toLowerCase().replace(/\([^)]*\)/g, '').trim();
  const target = norm(modelName);
  return (
    models.find((m) => modelId && m.id === modelId) ??
    models.find((m) => modelName && m.displayName === modelName) ??
    models.find((m) => target && m.displayName && norm(m.displayName) === target)
  );
}

function toResetDate(resetTime: string | null | undefined): Date | null {
  if (!resetTime) return null;
  const ts = Date.parse(resetTime);
  return Number.isFinite(ts) ? new Date(ts) : null;
}

function toUsedPercent(remainingFraction: number): number {
  const clamped = Math.min(1, Math.max(0, remainingFraction));
  return Math.round((1 - clamped) * 100);
}

/**
 * Converts Antigravity quota probe into claude-hud's UsageData for default minimal rendering.
 */
export function agyQuotaToUsageData(
  probe: AgyQuotaProbe | null | undefined,
  stdin: StdinData,
  now = Date.now(),
): UsageData | null {
  if (!probe) return null;
  const modelId = stdin.model?.id ?? '';
  const modelName = stdin.model?.display_name ?? '';
  const providerKey = matchProviderForModel(modelId, modelName);

  const pq: AgyProviderWindows | undefined =
    probe.providerQuota?.[providerKey] ??
    probe.providerQuota?.google ??
    probe.providerQuota?.claude ??
    probe.providerQuota?.argon;

  const matchedModel = findMatchingModelQuota(probe.models ?? [], modelId, modelName);

  const fiveWin = isNonExpiredWindow(pq?.fiveHour, now)
    ? pq.fiveHour
    : isNonExpiredWindow(matchedModel?.windows?.fiveHour, now)
      ? matchedModel.windows.fiveHour
      : undefined;

  const weekWin = isNonExpiredWindow(pq?.weekly, now)
    ? pq.weekly
    : isNonExpiredWindow(matchedModel?.windows?.weekly, now)
      ? matchedModel.windows.weekly
      : undefined;

  if (!fiveWin && !weekWin) {
    if (matchedModel) {
      return {
        fiveHour: toUsedPercent(matchedModel.remainingFraction),
        sevenDay: null,
        fiveHourResetAt: toResetDate(matchedModel.resetTime),
        sevenDayResetAt: null,
        fiveHourRemainingExact: matchedModel.remainingFraction * 100,
        sevenDayRemainingExact: null,
      };
    }
    return null;
  }

  return {
    fiveHour: fiveWin ? toUsedPercent(fiveWin.remainingFraction) : null,
    sevenDay: weekWin ? toUsedPercent(weekWin.remainingFraction) : null,
    fiveHourResetAt: fiveWin ? toResetDate(fiveWin.resetTime) : null,
    sevenDayResetAt: weekWin ? toResetDate(weekWin.resetTime) : null,
    fiveHourRemainingExact: fiveWin ? fiveWin.remainingFraction * 100 : null,
    sevenDayRemainingExact: weekWin ? weekWin.remainingFraction * 100 : null,
  };
}
