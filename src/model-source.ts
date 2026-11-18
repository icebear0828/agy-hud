import { effortInfo } from './effort.ts';
import { displayLabel } from './utils/sanitize.ts';

export const TRANSCRIPT_MODEL_MAX_LEN = 80;
const MODEL_EFFORT_SUFFIX = /^(.+?)-(?:tiered-)?(minimal|low|medium|high|xhigh|max|thinking)$/i;

export function sanitizeTranscriptModel(value: unknown): string | undefined {
  return displayLabel(value, TRANSCRIPT_MODEL_MAX_LEN) || undefined;
}

export function splitModelAndEffort(value: unknown): { model?: string; effort?: string } {
  const raw = sanitizeTranscriptModel(value);
  if (!raw) return {};
  const match = MODEL_EFFORT_SUFFIX.exec(raw);
  if (!match) return { model: raw };
  const info = effortInfo(match[2]);
  if (!info) return { model: raw };
  return {
    model: match[1],
    effort: info.level,
  };
}
