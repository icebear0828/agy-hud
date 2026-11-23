import type {
  AgyModelQuota,
  AgyProviderQuotaSummary,
  AgyProviderWindows,
  AgyQuotaProbe,
  AgyQuotaWindow,
  AgyStdinQuotaBucket,
  StdinData,
  UsageData,
} from './types.ts';

export type AgyProviderKey = keyof AgyProviderQuotaSummary;

export function isAgyImageModel(id: string | undefined, displayName?: string | null): boolean {
  return Boolean((id && /image/i.test(id)) || (displayName && /image/i.test(displayName)));
}

export function classifyQuotaProvider(
  id: string | undefined,
  displayName?: string | null,
  modelProvider?: string | null,
): AgyProviderKey | null {
  const text = `${id ?? ''} ${displayName ?? ''}`;
  if (/argon/i.test(text)) return 'argon';
  if (modelProvider === 'MODEL_PROVIDER_GOOGLE' || /gemini/i.test(text)) return 'google';
  if (modelProvider === 'MODEL_PROVIDER_ANTHROPIC' || /claude|gpt/i.test(text)) return 'claude';
  return null;
}

function toStdinQuotaWindow(bucket: AgyStdinQuotaBucket | undefined, now = Date.now()): AgyQuotaWindow | undefined {
  if (!bucket || typeof bucket.remaining_fraction !== 'number' || !Number.isFinite(bucket.remaining_fraction)) {
    return undefined;
  }
  let resetTime: string | null = typeof bucket.reset_time === 'string' && bucket.reset_time ? bucket.reset_time : null;
  if (!resetTime && typeof bucket.reset_in_seconds === 'number' && Number.isFinite(bucket.reset_in_seconds)) {
    if (bucket.reset_in_seconds > 0) {
      resetTime = new Date(now + bucket.reset_in_seconds * 1000).toISOString();
    } else {
      return undefined;
    }
  }
  if (resetTime) {
    const ts = Date.parse(resetTime);
    if (Number.isFinite(ts) && ts <= now) {
      return undefined;
    }
  }
  return {
    remainingFraction: Math.min(1, Math.max(0, bucket.remaining_fraction)),
    resetTime,
  };
}

function parseProviderStdinWindows(
  fiveBucket: AgyStdinQuotaBucket | undefined,
  weekBucket: AgyStdinQuotaBucket | undefined,
  now = Date.now(),
): AgyProviderWindows | undefined {
  const fiveHour = toStdinQuotaWindow(fiveBucket, now);
  const weekly = toStdinQuotaWindow(weekBucket, now);
  if (!fiveHour && !weekly) return undefined;
  return {
    ...(fiveHour ? { fiveHour } : {}),
    ...(weekly ? { weekly } : {}),
  };
}

export function parseAgyStdinQuota(quotaObj: StdinData['quota'], now = Date.now()): AgyProviderQuotaSummary | null {
  if (!quotaObj || typeof quotaObj !== 'object') return null;
  const result: AgyProviderQuotaSummary = {};

  const google = parseProviderStdinWindows(quotaObj['gemini-5h'], quotaObj['gemini-weekly'], now);
  if (google) result.google = google;

  const claude = parseProviderStdinWindows(quotaObj['3p-5h'], quotaObj['3p-weekly'], now);
  if (claude) result.claude = claude;

  const argon = parseProviderStdinWindows(
    quotaObj['argon-5h'],
    quotaObj['argon-weekly'] ?? quotaObj['gemini-argon-wtu-weekly'],
    now,
  );
  if (argon) result.argon = argon;

  return Object.keys(result).length > 0 ? result : null;
}

function isNonExpiredWindow(win: AgyQuotaWindow | undefined, now: number): win is AgyQuotaWindow {
  if (!win) return false;
  if (!win.resetTime) return true;
  const ts = Date.parse(win.resetTime);
  return !Number.isFinite(ts) || ts > now;
}

const RESET_TIME_SKEW_MS = 60_000;

function parseResetMs(resetTime: string | null | undefined): number | null {
  if (!resetTime) return null;
  const ts = Date.parse(resetTime);
  return Number.isFinite(ts) ? ts : null;
}

export function pickFresherQuotaWindow(
  current: AgyQuotaWindow | undefined,
  incoming: AgyQuotaWindow | undefined,
  now = Date.now(),
): AgyQuotaWindow | undefined {
  if (!current) return incoming;
  if (!incoming) return current;

  const curTs = parseResetMs(current.resetTime);
  const incTs = parseResetMs(incoming.resetTime);
  if (curTs !== null && curTs <= now && incTs !== null && incTs > now) return incoming;
  if (incTs !== null && incTs <= now && curTs !== null && curTs > now) return current;

  const curLive = isNonExpiredWindow(current, now);
  const incLive = isNonExpiredWindow(incoming, now);
  if (!curLive && incLive) return incoming;
  if (curLive && !incLive) return current;

  if (
    current.remainingFraction >= 1 &&
    incoming.remainingFraction >= 1 &&
    curTs !== null &&
    incTs !== null &&
    curTs > now &&
    incTs > now
  ) {
    return curTs <= incTs ? current : incoming;
  }

  if (curTs !== null && incTs !== null) {
    if (incTs - curTs > RESET_TIME_SKEW_MS) return incoming;
    if (curTs - incTs > RESET_TIME_SKEW_MS) return current;
  } else if (curTs !== null && incTs === null) {
    // Do not let an un-timestamped stale snapshot lock a newly reset full window with a valid future resetTime.
    if (curLive && current.remainingFraction >= 1) return current;
  } else if (incTs !== null && curTs === null) {
    if (incLive && incoming.remainingFraction >= 1) return incoming;
  }

  if (incoming.remainingFraction < current.remainingFraction) return incoming;
  if (current.remainingFraction < incoming.remainingFraction) return current;
  if (incTs !== null && curTs === null) return incoming;
  if (curTs !== null && incTs === null) return current;
  return curTs !== null && incTs !== null && incTs > curTs ? incoming : current;
}

function pickModelTopLevelWindow(
  windows: { fiveHour?: AgyQuotaWindow; weekly?: AgyQuotaWindow },
  now: number,
): AgyQuotaWindow | null {
  const five = isNonExpiredWindow(windows.fiveHour, now) ? windows.fiveHour : null;
  const week = isNonExpiredWindow(windows.weekly, now) ? windows.weekly : null;
  if (five && week) return five.remainingFraction <= week.remainingFraction ? five : week;
  return five ?? week;
}

export function mergeAgyQuotaProbe(probe: AgyQuotaProbe | null | undefined, stdin: StdinData, now = Date.now()): AgyQuotaProbe | null {
  const stdinPq = parseAgyStdinQuota(stdin.quota, now);
  if (!probe && !stdinPq) return null;
  const base: AgyQuotaProbe = probe
    ? { ...probe, models: [...(probe.models ?? [])] }
    : { models: [], providerQuota: null, unavailableReason: null, tierName: null, accountEmail: null, updateInfo: null };

  if (!stdinPq) return base;

  const prevPq = base.providerQuota ?? {};
  const mergedPq: AgyProviderQuotaSummary = { ...prevPq };
  for (const key of ['google', 'claude', 'argon'] as const) {
    const prevWin = prevPq[key];
    const incWin = stdinPq[key];
    if (!prevWin && !incWin) continue;
    const fiveHour = pickFresherQuotaWindow(prevWin?.fiveHour, incWin?.fiveHour, now);
    const weekly = pickFresherQuotaWindow(prevWin?.weekly, incWin?.weekly, now);
    const nextWin: AgyProviderWindows = {};
    if (fiveHour) nextWin.fiveHour = fiveHour;
    if (weekly) nextWin.weekly = weekly;
    mergedPq[key] = nextWin;
  }
  base.providerQuota = mergedPq;

  base.models = base.models.map((m) => {
    if (!m || isAgyImageModel(m.id, m.displayName)) return m;
    const key = classifyQuotaProvider(m.id, m.displayName, m.modelProvider);
    const stdinSummary = key ? stdinPq[key] : undefined;
    if (!stdinSummary) return m;

    const windows = { ...(m.windows ?? {}) };
    let changed = false;

    if (stdinSummary.fiveHour) {
      const pickedFive = pickFresherQuotaWindow(windows.fiveHour, stdinSummary.fiveHour, now);
      if (pickedFive === stdinSummary.fiveHour) {
        windows.fiveHour = { ...stdinSummary.fiveHour, observedAt: now };
        changed = true;
      }
    }
    if (stdinSummary.weekly) {
      const pickedWeek = pickFresherQuotaWindow(windows.weekly, stdinSummary.weekly, now);
      if (pickedWeek === stdinSummary.weekly) {
        windows.weekly = { ...stdinSummary.weekly, observedAt: now };
        changed = true;
      }
    }

    if (!changed) return m;
    const critical = pickModelTopLevelWindow(windows, now);
    return {
      ...m,
      windows,
      ...(critical ? { remainingFraction: critical.remainingFraction, resetTime: critical.resetTime } : {}),
    };
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

  const effectiveProviderKey: keyof AgyProviderQuotaSummary = probe.providerQuota?.[providerKey]
    ? providerKey
    : probe.providerQuota?.google
      ? 'google'
      : probe.providerQuota?.claude
        ? 'claude'
        : probe.providerQuota?.argon
          ? 'argon'
          : providerKey;
  const pq: AgyProviderWindows | undefined = probe.providerQuota?.[effectiveProviderKey];

  const matchedModel = findMatchingModelQuota(probe.models ?? [], modelId, modelName);
  const sevenDayLabel = effectiveProviderKey === 'argon' || (providerKey === 'argon' && matchedModel)
    ? 'Argon 7d'
    : undefined;

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
      const topTs = parseResetMs(matchedModel.resetTime);
      const topExpired = topTs !== null && topTs <= now;
      const hadModelWindows = Boolean(matchedModel.windows?.fiveHour || matchedModel.windows?.weekly);
      if (topExpired || hadModelWindows) {
        return {
          fiveHour: 0,
          sevenDay: null,
          fiveHourResetAt: null,
          sevenDayResetAt: null,
          ...(sevenDayLabel ? { sevenDayLabel } : {}),
          fiveHourRemainingExact: 100,
          sevenDayRemainingExact: null,
        };
      }
      return {
        fiveHour: toUsedPercent(matchedModel.remainingFraction),
        sevenDay: null,
        fiveHourResetAt: toResetDate(matchedModel.resetTime),
        sevenDayResetAt: null,
        ...(sevenDayLabel ? { sevenDayLabel } : {}),
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
    ...(sevenDayLabel ? { sevenDayLabel } : {}),
    fiveHourRemainingExact: fiveWin ? fiveWin.remainingFraction * 100 : null,
    sevenDayRemainingExact: weekWin ? weekWin.remainingFraction * 100 : null,
  };
}
