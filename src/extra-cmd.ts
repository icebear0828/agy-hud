import { sanitizeDisplayText } from './utils/sanitize.ts';
import { truncateString } from './utils/truncate.ts';

const MAX_LABEL_LENGTH = 50;

export function extraCmdLabel(output: unknown): string | null {
  if (typeof output !== 'string' || !output) return null;
  let label: unknown;
  try {
    const data: unknown = JSON.parse(output);
    label = data !== null && typeof data === 'object' ? (data as { label?: unknown }).label : undefined;
  } catch {
    label = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1);
  }
  if (typeof label !== 'string') return null;
  const clean = sanitizeDisplayText(label);
  if (!clean) return null;
  return truncateString(clean, MAX_LABEL_LENGTH, '…');
}
