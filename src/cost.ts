import { isBedrockModelId, isVertexModelId } from './stdin.ts';
import type { StdinData, TranscriptData } from './types.ts';

const MODEL_PRICING = [
  { pattern: /opus/i, input: 15.0, output: 75.0, cacheRead: 1.5 },
  { pattern: /sonnet/i, input: 3.0, output: 15.0, cacheRead: 0.3 },
  { pattern: /haiku/i, input: 0.8, output: 4.0, cacheRead: 0.08 },
  { pattern: /hydrogen|argon|pro/i, input: 1.25, output: 5.0, cacheRead: 0.3125 },
  { pattern: /flash/i, input: 0.075, output: 0.3, cacheRead: 0.01875 },
  { pattern: /gpt-?4/i, input: 2.5, output: 10.0, cacheRead: 1.25 },
];

const DEFAULT_PRICING = { input: 0.075, output: 0.3, cacheRead: 0.01875 };

export function getNativeCostUsd(stdin: StdinData, options?: { allowRoutedCost?: boolean }): number | null {
  const cost = stdin.cost?.total_cost_usd ?? stdin.cost?.total_usd ?? stdin.total_usd;
  if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0) return null;
  const modelId = stdin.model?.id;
  const routed = isBedrockModelId(modelId) || isVertexModelId(modelId);
  if (routed && (!options?.allowRoutedCost || cost === 0)) return null;
  return cost;
}

export function calculateTokenCost(
  modelNameOrId: string,
  tokens: {
    input_tokens?: number | null;
    total_input_tokens?: number | null;
    output_tokens?: number | null;
    total_output_tokens?: number | null;
    cache_read_input_tokens?: number | null;
    cache_read_tokens?: number | null;
  },
): number | null {
  if (!tokens || typeof tokens !== 'object') return null;
  const pricing = MODEL_PRICING.find((p) => p.pattern.test(modelNameOrId)) ?? DEFAULT_PRICING;
  const inTokens = Number(tokens.input_tokens ?? tokens.total_input_tokens ?? 0);
  const outTokens = Number(tokens.output_tokens ?? tokens.total_output_tokens ?? 0);
  const cacheTokens = Number(tokens.cache_read_input_tokens ?? tokens.cache_read_tokens ?? 0);
  const cost =
    (inTokens / 1_000_000) * pricing.input +
    (outTokens / 1_000_000) * pricing.output +
    (cacheTokens / 1_000_000) * pricing.cacheRead;
  return Number.isFinite(cost) && cost >= 0 ? cost : null;
}

export function getSessionCostUsd(
  stdin: StdinData,
  transcript?: TranscriptData,
  options?: { allowRoutedCost?: boolean },
): number | null {
  const native = getNativeCostUsd(stdin, options);
  if (native !== null) return native;

  const modelName = stdin.model?.display_name || stdin.model?.id || transcript?.lastAssistantModel || '';
  const tx = transcript?.sessionTokens;
  if (tx) {
    const txTotal = tx.inputTokens + tx.outputTokens + tx.cacheReadTokens;
    const cwTotal = (stdin.context_window?.total_input_tokens ?? 0) + (stdin.context_window?.total_output_tokens ?? 0);
    if (!stdin.context_window || txTotal >= cwTotal) {
      return calculateTokenCost(modelName, {
        input_tokens: tx.inputTokens,
        output_tokens: tx.outputTokens,
        cache_read_input_tokens: tx.cacheReadTokens,
      });
    }
  }
  if (stdin.context_window) {
    return calculateTokenCost(modelName, stdin.context_window);
  }
  return null;
}

export function formatUsd(amount: number): string {
  if (!Number.isFinite(amount) || amount <= 0) return '$0.00';
  if (amount >= 1) return `$${amount.toFixed(2)}`;
  if (amount >= 0.1) return `$${amount.toFixed(3)}`;
  return `$${amount.toFixed(4)}`;
}
