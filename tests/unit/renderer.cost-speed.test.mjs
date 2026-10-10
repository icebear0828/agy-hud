import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderHUD } from '../../runtime/renderer.js';

test('renderHUD includes cost and speed on line 1 when enabled', () => {
  const state = {
    branch: 'main',
    outputSpeed: 65.4,
    costTotals: {
      todayUsd: 1.25,
      weekUsd: 4.5,
    },
  };
  const agyData = {
    model: { display_name: 'Gemini 3.8 Flash (Medium)' },
    cost: { total_cost_usd: 0.15 },
    context_window: {
      total_input_tokens: 1000,
      total_output_tokens: 200,
      used_percentage: 5,
    },
  };

  // 1. With showCost, showDailyCost, showWeeklyCost, showSpeed enabled in en
  const config = {
    display: {
      showCost: true,
      showDailyCost: true,
      showWeeklyCost: true,
      showSpeed: true,
      useNerdFonts: false,
      unicode: true,
    },
    language: 'en',
  };

  const output = renderHUD(state, agyData, config);
  const lines = output.split('\n');
  const line1 = lines[0];

  assert.match(line1, /Cost \$0\.150/);
  assert.match(line1, /Today \$1\.25/);
  assert.match(line1, /Week \$4\.50/);
  assert.match(line1, /out: 65\.4 tok\/s/);

  // 2. In zh language
  const configZh = {
    ...config,
    language: 'zh',
  };
  const outputZh = renderHUD(state, agyData, configZh);
  const line1Zh = outputZh.split('\n')[0];

  assert.match(line1Zh, /费用 \$0\.150/);
  assert.match(line1Zh, /今日 \$1\.25/);
  assert.match(line1Zh, /本周 \$4\.50/);
  assert.match(line1Zh, /输出: 65\.4 tok\/s/);
});

test('renderHUD omits cost and speed when display flags are false', () => {
  const state = {
    branch: 'main',
    outputSpeed: 65.4,
    costTotals: { todayUsd: 1.25, weekUsd: 4.5 },
  };
  const agyData = {
    model: { display_name: 'Gemini 3.8 Flash (Medium)' },
    cost: { total_cost_usd: 0.15 },
    context_window: { total_input_tokens: 1000, total_output_tokens: 200, used_percentage: 5 },
  };
  const config = {
    display: {
      showCost: false,
      showDailyCost: false,
      showWeeklyCost: false,
      showSpeed: false,
    },
  };

  const output = renderHUD(state, agyData, config);
  const line1 = output.split('\n')[0];

  assert.doesNotMatch(line1, /Cost/);
  assert.doesNotMatch(line1, /Today/);
  assert.doesNotMatch(line1, /Week/);
  assert.doesNotMatch(line1, /tok\/s/);
});
