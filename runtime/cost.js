'use strict';

// Model pricing per 1,000,000 tokens (USD)
const MODEL_PRICING = [
  {
    pattern: /opus/i,
    input: 15.00,
    output: 75.00,
    cacheRead: 1.50,
  },
  {
    pattern: /sonnet/i,
    input: 3.00,
    output: 15.00,
    cacheRead: 0.30,
  },
  {
    pattern: /haiku/i,
    input: 0.80,
    output: 4.00,
    cacheRead: 0.08,
  },
  {
    pattern: /pro/i,
    input: 1.25,
    output: 5.00,
    cacheRead: 0.3125,
  },
  {
    pattern: /flash/i,
    input: 0.075,
    output: 0.30,
    cacheRead: 0.01875,
  },
  {
    pattern: /gpt-?4/i,
    input: 2.50,
    output: 10.00,
    cacheRead: 1.25,
  },
];

const DEFAULT_PRICING = {
  input: 0.075,
  output: 0.30,
  cacheRead: 0.01875,
};

function isBedrockModelId(id) {
  return typeof id === 'string' && (id.startsWith('anthropic.') || id.startsWith('us.anthropic.') || id.startsWith('eu.anthropic.'));
}

function isVertexModelId(id) {
  return typeof id === 'string' && (id.startsWith('claude-') && id.includes('@'));
}

/**
 * Native session cost reported directly by agy/Claude CLI.
 *
 * @param {Object} agyData
 * @param {Object} [options]
 * @returns {number|null}
 */
function getNativeCostUsd(agyData, options = {}) {
  const cost = agyData?.cost?.total_cost_usd ?? agyData?.cost?.total_usd ?? agyData?.total_usd;
  if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0) {
    return null;
  }
  const modelId = agyData?.model?.id || '';
  const routed = isBedrockModelId(modelId) || isVertexModelId(modelId);
  if (routed && (!options?.allowRoutedCost || cost === 0)) {
    return null;
  }
  return cost;
}

/**
 * Calculates estimated cost from token counts and model pricing.
 *
 * @param {string} modelNameOrId
 * @param {Object} tokens
 * @returns {number|null}
 */
function calculateTokenCost(modelNameOrId, tokens) {
  if (!tokens || typeof tokens !== 'object') return null;

  const modelStr = String(modelNameOrId || '');
  const pricing = MODEL_PRICING.find(p => p.pattern.test(modelStr)) || DEFAULT_PRICING;

  const inTokens = Number(tokens.input_tokens || tokens.total_input_tokens || 0);
  const outTokens = Number(tokens.output_tokens || tokens.total_output_tokens || 0);
  const cacheTokens = Number(tokens.cache_read_input_tokens || tokens.cache_read_tokens || 0);

  const cost = (
    (inTokens / 1_000_000) * pricing.input +
    (outTokens / 1_000_000) * pricing.output +
    (cacheTokens / 1_000_000) * pricing.cacheRead
  );

  return Number.isFinite(cost) && cost >= 0 ? cost : null;
}

/**
 * Returns session cost: native cost when available, or calculates from token usage.
 *
 * @param {Object} agyData
 * @param {Object} [state]
 * @param {Object} [options]
 * @returns {number|null}
 */
function getSessionCostUsd(agyData, state = null, options = {}) {
  const native = getNativeCostUsd(agyData, options);
  if (native !== null) {
    return native;
  }

  const modelName = agyData?.model?.display_name || agyData?.model?.id || '';
  const usage = agyData?.context_window || state?.usage;
  if (!usage) return null;

  return calculateTokenCost(modelName, usage);
}

/**
 * Formats a USD amount according to standard tiered decimal rules.
 *
 * @param {number} amount
 * @returns {string}
 */
function formatUsd(amount) {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return '$0.00';
  if (amount >= 1) return `$${amount.toFixed(2)}`;
  if (amount >= 0.1) return `$${amount.toFixed(3)}`;
  return `$${amount.toFixed(4)}`;
}

module.exports = {
  getNativeCostUsd,
  calculateTokenCost,
  getSessionCostUsd,
  formatUsd,
  isBedrockModelId,
  isVertexModelId,
};
