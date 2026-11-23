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
    pattern: /argon/i,
    input: 1.25,
    output: 5.00,
    cacheRead: 0.3125,
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
  {
    pattern: /gpt/i,
    input: 0.50,
    output: 2.00,
    cacheRead: 0.125,
  },
];

const DEFAULT_PRICING = {
  input: 0.075,
  output: 0.30,
  cacheRead: 0.01875,
};

function getModelPricing(modelNameOrId) {
  const modelStr = String(modelNameOrId || '');
  return MODEL_PRICING.find(p => p.pattern.test(modelStr)) || DEFAULT_PRICING;
}

function isBedrockModelId(id) {
  return typeof id === 'string' && (id.startsWith('anthropic.') || id.startsWith('us.anthropic.') || id.startsWith('eu.anthropic.'));
}

function isVertexModelId(id) {
  return typeof id === 'string' && (id.startsWith('claude-') && id.includes('@'));
}

function isRoutedModelId(id) {
  return isBedrockModelId(id) || isVertexModelId(id);
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
  const routed = isRoutedModelId(modelId);
  if (routed && (!options?.allowRoutedCost || cost === 0)) {
    return null;
  }
  return cost;
}

function firstFiniteToken(...values) {
  for (const value of values) {
    if (value === undefined || value === null || value === '') continue;
    const num = Number(value);
    if (Number.isFinite(num) && num >= 0) return num;
  }
  return undefined;
}

/**
 * Calculates estimated cost from token counts and model pricing.
 * Aligns cached vs uncached input token billing with renderer.js:
 * when `total_input_tokens` (session cumulative) is present, cached tokens
 * from `current_usage` or top-level fields are subtracted so they are not
 * double-billed at the uncached input rate.
 *
 * @param {string} modelNameOrId
 * @param {Object} tokens
 * @returns {number|null}
 */
function calculateTokenCost(modelNameOrId, tokens) {
  if (!tokens || typeof tokens !== 'object') return null;

  const pricing = getModelPricing(modelNameOrId);
  const cu = tokens.current_usage && typeof tokens.current_usage === 'object'
    ? tokens.current_usage
    : null;

  const cacheRead = firstFiniteToken(
    cu?.cache_read_input_tokens,
    tokens.cache_read_input_tokens,
    tokens.cache_read_tokens
  ) ?? 0;
  const cacheWrite = firstFiniteToken(
    cu?.cache_creation_input_tokens,
    tokens.cache_creation_input_tokens
  ) ?? 0;
  const cacheTotal = cacheRead + cacheWrite;

  let uncachedIn = 0;
  const totalIn = firstFiniteToken(tokens.total_input_tokens);
  if (totalIn !== undefined) {
    uncachedIn = Math.max(0, totalIn - cacheTotal);
  } else {
    uncachedIn = firstFiniteToken(tokens.input_tokens, cu?.input_tokens) ?? 0;
  }

  const outTokens = firstFiniteToken(
    tokens.total_output_tokens,
    tokens.output_tokens,
    cu?.output_tokens
  ) ?? 0;

  const cost = (
    (uncachedIn / 1_000_000) * pricing.input +
    (cacheWrite / 1_000_000) * pricing.input +
    (outTokens / 1_000_000) * pricing.output +
    (cacheRead / 1_000_000) * pricing.cacheRead
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
  const modelId = agyData?.model?.id || '';
  if (isRoutedModelId(modelId) && !options?.allowRoutedCost) {
    return null;
  }

  const native = getNativeCostUsd(agyData, options);
  if (native !== null) {
    return native;
  }

  const modelName = agyData?.model?.display_name || modelId;
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
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) return '$0.00';
  if (amount >= 1) return `$${amount.toFixed(2)}`;
  if (amount >= 0.1) return `$${amount.toFixed(3)}`;
  return `$${amount.toFixed(4)}`;
}

module.exports = {
  MODEL_PRICING,
  DEFAULT_PRICING,
  getModelPricing,
  getNativeCostUsd,
  calculateTokenCost,
  getSessionCostUsd,
  formatUsd,
  isBedrockModelId,
  isVertexModelId,
};
