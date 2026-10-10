import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getNativeCostUsd,
  calculateTokenCost,
  getSessionCostUsd,
  formatUsd,
} from '../../runtime/cost.js';

test('getNativeCostUsd extracts native cost from agyData', () => {
  assert.equal(getNativeCostUsd({ cost: { total_cost_usd: 1.5 } }), 1.5);
  assert.equal(getNativeCostUsd({ cost: { total_usd: 2.25 } }), 2.25);
  assert.equal(getNativeCostUsd({ total_usd: 0.75 }), 0.75);
  assert.equal(getNativeCostUsd({ cost: { total_cost_usd: -1 } }), null);
  assert.equal(getNativeCostUsd({ cost: null }), null);
  assert.equal(getNativeCostUsd({}), null);
});

test('getNativeCostUsd respects routed models unless allowRoutedCost is set', () => {
  const stdin = {
    model: { id: 'us.anthropic.claude-sonnet-4-20250514-v1:0' },
    cost: { total_cost_usd: 2.0 },
  };
  assert.equal(getNativeCostUsd(stdin), null);
  assert.equal(getNativeCostUsd(stdin, { allowRoutedCost: true }), 2.0);
});

test('calculateTokenCost calculates estimated cost from tokens and model rates', () => {
  // Gemini 3.8 Flash: input $0.075/1M, output $0.30/1M, cache read $0.01875/1M
  const flashTokens = {
    input_tokens: 1_000_000,
    output_tokens: 1_000_000,
    cache_read_input_tokens: 1_000_000,
  };
  const flashCost = calculateTokenCost('Gemini 3.8 Flash (Medium)', flashTokens);
  assert.equal(flashCost?.toFixed(5), (0.075 + 0.30 + 0.01875).toFixed(5));

  // Claude 3.5 Sonnet: input $3/1M, output $15/1M, cache read $0.30/1M
  const sonnetTokens = {
    input_tokens: 100_000,
    output_tokens: 10_000,
    cache_read_input_tokens: 50_000,
  };
  const sonnetCost = calculateTokenCost('Claude Sonnet 3.5', sonnetTokens);
  // (100k/1M * 3) + (10k/1M * 15) + (50k/1M * 0.3) = 0.30 + 0.15 + 0.015 = 0.465
  assert.equal(sonnetCost?.toFixed(4), (0.465).toFixed(4));
});

test('getSessionCostUsd prefers native cost, falls back to calculated token cost', () => {
  // When native cost is present:
  const withNative = {
    cost: { total_cost_usd: 0.42 },
    model: { id: 'gemini-3.8-flash' },
    context_window: { total_input_tokens: 1000, total_output_tokens: 500 },
  };
  assert.equal(getSessionCostUsd(withNative), 0.42);

  // When native cost is absent, computes from context_window tokens:
  const withoutNative = {
    model: { id: 'gemini-3.8-flash' },
    context_window: {
      total_input_tokens: 100_000,
      total_output_tokens: 10_000,
    },
  };
  const computed = getSessionCostUsd(withoutNative);
  // Flash: (100k/1M * 0.075) + (10k/1M * 0.30) = 0.0075 + 0.003 = 0.0105
  assert.equal(computed?.toFixed(4), (0.0105).toFixed(4));
});

test('formatUsd formats currencies across thresholds', () => {
  assert.equal(formatUsd(1.2345), '$1.23');
  assert.equal(formatUsd(0.4567), '$0.457');
  assert.equal(formatUsd(0.01234), '$0.0123');
  assert.equal(formatUsd(0), '$0.00');
});
