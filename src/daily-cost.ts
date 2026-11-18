import * as fs from 'node:fs';
import * as path from 'node:path';
import type { WeeklyCostPeriod } from './config.ts';
import { getSessionCostUsd } from './cost.ts';
import { createDebug } from './debug.ts';
import type { StdinData, TranscriptData } from './types.ts';

const debug = createDebug('daily-cost');

export const DAILY_COST_WRITE_THROTTLE_MS = 30_000;
const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const SEVEN_DAY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

interface SessionEntry {
  baseline: number;
  weekBaseline: number;
  total: number;
  ts: number;
}

interface Ledger {
  date: string;
  sessions: Record<string, SessionEntry>;
  week: { start: number; carry: number };
}

export type CostTotals = {
  todayUsd: number;
  weekUsd: number | null;
};

export type DailyCostDeps = {
  dataDir: () => string;
  now: () => number;
};

export function getDailyCostLedgerPath(dataDir: string): string {
  return path.join(dataDir, 'daily-cost.json');
}

function localDateKey(now: number): string {
  const date = new Date(now);
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
}

const WEEKDAYS: readonly WeeklyCostPeriod[] = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function calendarWeekStart(now: number, day: number): number {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - ((date.getDay() - day + 7) % 7));
  return date.getTime();
}

const isAmount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

function readLedger(ledgerPath: string): Ledger | null {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    if (!isObject(raw) || typeof raw.date !== 'string' || !/^\d{8}$/.test(raw.date) || !isObject(raw.sessions)) {
      return null;
    }
    const sessions: Record<string, SessionEntry> = {};
    for (const [id, entry] of Object.entries(raw.sessions)) {
      if (!isObject(entry) || !isAmount(entry.baseline) || !isAmount(entry.total) || !isAmount(entry.ts) || entry.ts === 0) continue;
      const weekBaseline = isAmount(entry.weekBaseline) ? entry.weekBaseline : entry.baseline;
      sessions[id] = { baseline: entry.baseline, weekBaseline, total: entry.total, ts: entry.ts };
    }
    const week = isObject(raw.week) ? raw.week : {};
    return {
      date: raw.date,
      sessions,
      week: {
        start: isAmount(week.start) ? week.start : 0,
        carry: isAmount(week.carry) ? week.carry : 0,
      },
    };
  } catch {
    return null;
  }
}

function isThrottled(ledgerPath: string, now: number): boolean {
  try {
    return now - fs.statSync(ledgerPath).mtimeMs <= DAILY_COST_WRITE_THROTTLE_MS;
  } catch {
    return false;
  }
}

function writeLedger(ledgerPath: string, ledger: Ledger, now: number): void {
  const tmpPath = `${ledgerPath}.${process.pid}.${now}.tmp`;
  try {
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(tmpPath, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmpPath, ledgerPath);
    try {
      fs.utimesSync(ledgerPath, new Date(now), new Date(now));
    } catch {}
  } catch (error) {
    debug('Failed to write daily cost ledger:', error);
    try { fs.rmSync(tmpPath, { force: true }); } catch {}
  }
}

export function getCostTotals(
  stdin: StdinData,
  options: { allowRoutedCost?: boolean; sevenDayResetAt?: Date | null; weeklyCostPeriod?: WeeklyCostPeriod; transcript?: TranscriptData } | undefined,
  deps: DailyCostDeps,
): CostTotals | null {
  const ledgerPath = getDailyCostLedgerPath(deps.dataDir());
  return updateLedger(ledgerPath, stdin, options, deps);
}

function updateLedger(
  ledgerPath: string,
  stdin: StdinData,
  options: { allowRoutedCost?: boolean; sevenDayResetAt?: Date | null; weeklyCostPeriod?: WeeklyCostPeriod; transcript?: TranscriptData } | undefined,
  deps: DailyCostDeps,
): CostTotals | null {
  const now = deps.now();
  const today = localDateKey(now);
  const stored = readLedger(ledgerPath);
  const ledger: Ledger = stored ?? { date: today, sessions: {}, week: { start: now, carry: 0 } };
  let changed = stored === null;

  for (const [id, session] of Object.entries(ledger.sessions)) {
    if (now - session.ts > SESSION_MAX_AGE_MS) {
      ledger.week.carry += Math.max(0, session.total - session.weekBaseline);
      delete ledger.sessions[id];
      changed = true;
    }
  }

  if (ledger.date !== today) {
    ledger.date = today;
    for (const session of Object.values(ledger.sessions)) {
      session.baseline = session.total;
    }
    changed = true;
  }

  const day = WEEKDAYS.indexOf(options?.weeklyCostPeriod ?? 'quota');
  const resetAt = options?.sevenDayResetAt?.getTime();
  const quotaStart = resetAt !== undefined && Number.isFinite(resetAt) ? resetAt - SEVEN_DAY_WINDOW_MS : null;
  const windowStart = day >= 0 ? calendarWeekStart(now, day) : quotaStart;
  if (windowStart !== null && ledger.week.start < windowStart) {
    for (const session of Object.values(ledger.sessions)) session.weekBaseline = session.total;
    ledger.week = { start: now, carry: 0 };
    changed = true;
  }

  const rawSessionId = stdin.session_id || stdin.conversation_id || stdin.transcript_path;
  const sessionId = typeof rawSessionId === 'string' ? rawSessionId.trim() : '';
  const cost = getSessionCostUsd(stdin, options?.transcript, options);

  if (sessionId && cost !== null) {
    const session = ledger.sessions[sessionId];
    if (!session) {
      ledger.sessions[sessionId] = { baseline: cost, weekBaseline: cost, total: cost, ts: now };
      changed = true;
    } else if (cost !== session.total) {
      if (cost < session.total) {
        const lost = session.total - session.baseline;
        const lostWeek = session.total - session.weekBaseline;
        session.baseline = cost - Math.max(0, lost);
        session.weekBaseline = cost - Math.max(0, lostWeek);
      }
      session.total = cost;
      session.ts = now;
      changed = true;
    } else {
      session.ts = now;
    }
  }

  const sessionCount = Object.keys(ledger.sessions).length;
  if (sessionCount === 0 && ledger.week.carry === 0) {
    return null;
  }

  if (changed || !isThrottled(ledgerPath, now)) {
    writeLedger(ledgerPath, ledger, now);
  }

  let todayUsd = 0;
  let activeWeekUsd = 0;
  for (const session of Object.values(ledger.sessions)) {
    todayUsd += Math.max(0, session.total - session.baseline);
    activeWeekUsd += Math.max(0, session.total - session.weekBaseline);
  }

  const weekAvailable = day >= 0 || quotaStart !== null;
  return {
    todayUsd,
    weekUsd: weekAvailable ? ledger.week.carry + activeWeekUsd : null,
  };
}
