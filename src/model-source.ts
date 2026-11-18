import { displayLabel } from './utils/sanitize.ts';

export const TRANSCRIPT_MODEL_MAX_LEN = 80;

export function sanitizeTranscriptModel(value: unknown): string | undefined {
  return displayLabel(value, TRANSCRIPT_MODEL_MAX_LEN) || undefined;
}
