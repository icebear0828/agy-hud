import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type { StdinData, TranscriptData } from './types.ts';

const MIN_API_DELTA_MS = 500;

interface SpeedState {
  apiDurationMs: number;
  usageKey: string;
  speed: number | null;
}

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

function speedFile(dataDir: string, transcriptPath: string): string {
  const key = createHash('sha256').update(path.resolve(transcriptPath)).digest('hex');
  return path.join(dataDir, 'speed-cache', `${key}.json`);
}

function readState(file: string): SpeedState | null {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!raw || typeof raw !== 'object') return null;
    const obj = raw as Record<string, unknown>;
    const speed = obj.speed ?? null;
    return isCount(obj.apiDurationMs) && typeof obj.usageKey === 'string' && (speed === null || isCount(speed))
      ? { apiDurationMs: obj.apiDurationMs, usageKey: obj.usageKey, speed }
      : null;
  } catch {
    return null;
  }
}

function writeState(file: string, state: SpeedState): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {}
}

export function getOutputSpeed(stdin: StdinData, dataDir: string, transcript?: TranscriptData): number | null {
  const transcriptPath = (stdin.transcript_path || stdin.session_id || stdin.conversation_id)?.trim();
  const cu = stdin.context_window?.current_usage;
  const tu = transcript?.lastTurnUsage;
  const inTok = cu ? cu.input_tokens : tu?.inputTokens;
  const outTok = cu ? cu.output_tokens : tu?.outputTokens;
  const ccTok = cu ? cu.cache_creation_input_tokens : tu?.cacheCreationTokens;
  const crTok = cu ? cu.cache_read_input_tokens : tu?.cacheReadTokens;
  const output = (cu || tu) ? outTok : stdin.context_window?.total_output_tokens;
  const apiDurationMs = stdin.cost?.total_api_duration_ms ?? stdin.total_api_duration_ms ?? transcript?.totalApiDurationMs;

  if (!transcriptPath || (!cu && !tu) || !isCount(output) || !isCount(apiDurationMs)) {
    return transcript?.transcriptOutputSpeed ?? null;
  }

  const file = speedFile(dataDir, transcriptPath);
  const usageKey = [inTok ?? 0, output, ccTok ?? 0, crTok ?? 0].join(':');

  const previous = readState(file);
  if (!previous || apiDurationMs < previous.apiDurationMs) {
    writeState(file, { apiDurationMs, usageKey, speed: null });
    return transcript?.transcriptOutputSpeed ?? null;
  }

  if (apiDurationMs === previous.apiDurationMs) {
    return previous.speed ?? transcript?.transcriptOutputSpeed ?? null;
  }

  const deltaMs = apiDurationMs - previous.apiDurationMs;
  const isNewResponse = usageKey !== previous.usageKey && output > 0;
  const speed = isNewResponse && deltaMs >= MIN_API_DELTA_MS
    ? output / (deltaMs / 1000)
    : previous.speed;

  writeState(file, { apiDurationMs, usageKey, speed });
  return speed ?? transcript?.transcriptOutputSpeed ?? null;
}
