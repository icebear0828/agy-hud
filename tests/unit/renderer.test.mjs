import { test } from 'node:test';
import assert from 'node:assert';
import { renderHUD } from '../../extensions/renderer.js';

test('renderHUD should contain branch and steps', () => {
  const state = {
    steps: 42,
    branch: 'main'
  };
  const agyData = {
    context_window: {
      total_input_tokens: 15000,
      total_output_tokens: 5000,
      used_percentage: 12.5,
      context_window_size: 1000000
    },
    plan_tier: 'Google AI Pro',
    task_count: 3,
    model: {
      display_name: 'Gemini 3.5 Flash (High)'
    }
  };

  const output = renderHUD(state, agyData, { display: { useNerdFonts: false } });
  assert.match(output, /main/);
  assert.match(output, /42/);
  assert.match(output, /15\.0k\/5\.0k/);
  assert.match(output, /Google AI Pro/);
  assert.match(output, /│/); // Unicode divider
  assert.match(output, /Gem 3.5 Flash\(H\)/); // Simplified model name
});

test('renderHUD should correctly layout quotas in two aligned columns', () => {
  const state = { steps: 5, branch: 'dev' };
  const agyData = {
    context_window: { total_input_tokens: 1000, total_output_tokens: 200, used_percentage: 5 }
  };
  const quotaData = [
    { displayName: 'Gemini 3.5 Flash (High)', remainingFraction: 0.6, resetTime: new Date(Date.now() + 840000).toISOString() },
    { displayName: 'Claude Sonnet 4.6 (Thinking)', remainingFraction: 0.4, resetTime: new Date(Date.now() + 13620000).toISOString() },
    { displayName: 'GPT-OSS 120B (Medium)', remainingFraction: 1.0 }
  ];

  const output = renderHUD(state, agyData, { display: { useNerdFonts: false } }, quotaData);
  // Verify vertical grid lines
  assert.match(output, /───/);
  // Verify simplified names
  assert.match(output, /Gem 3.5 Flash\(H\)/);
  assert.match(output, /Claude 4.6\(Th\)/);
  assert.match(output, /GPT-OSS 120B/);
  // Verify reset times
  assert.match(output, /~14m/);
  assert.match(output, /~3h47m/);
});

test('renderHUD should explain when quota is unavailable because auth is missing', () => {
  const state = { steps: 0, branch: 'main' };
  const agyData = {
    context_window: { total_input_tokens: 1000, total_output_tokens: 200, used_percentage: 5 }
  };
  const quotaData = [];
  Object.defineProperty(quotaData, 'unavailableReason', {
    value: 'not_logged_in',
    enumerable: false
  });

  const output = renderHUD(state, agyData, { display: { useNerdFonts: false } }, quotaData);

  assert.match(output, /Quota unavailable/);
  assert.match(output, /not logged into Antigravity/);
});

test('renderHUD should explain quota fetch and auth failures', () => {
  const state = { steps: 0, branch: 'main' };
  const agyData = {
    context_window: { total_input_tokens: 1000, total_output_tokens: 200, used_percentage: 5 }
  };
  const authFailed = [];
  Object.defineProperty(authFailed, 'unavailableReason', {
    value: 'auth_failed',
    enumerable: false
  });
  const fetchFailed = [];
  Object.defineProperty(fetchFailed, 'unavailableReason', {
    value: 'quota_fetch_failed',
    enumerable: false
  });

  assert.match(
    renderHUD(state, agyData, { display: { useNerdFonts: false } }, authFailed),
    /Antigravity auth failed/
  );
  assert.match(
    renderHUD(state, agyData, { display: { useNerdFonts: false } }, fetchFailed),
    /quota fetch failed/
  );
});

test('renderHUD should explain quota fetch timeouts without hiding the HUD', () => {
  const state = { steps: 0, branch: 'main' };
  const agyData = {
    context_window: { total_input_tokens: 1000, total_output_tokens: 200, used_percentage: 5 }
  };
  const timedOut = [];
  Object.defineProperty(timedOut, 'unavailableReason', {
    value: 'quota_fetch_timeout',
    enumerable: false
  });

  const output = renderHUD(state, agyData, { display: { useNerdFonts: false } }, timedOut);

  assert.match(output, /AGY-HUD/);
  assert.match(output, /quota fetch timed out/);
});

test('renderHUD should render Nerd Font icons when enabled', () => {
  const state = { steps: 0, branch: 'main' };
  const agyData = {
    context_window: { total_input_tokens: 0, total_output_tokens: 0, used_percentage: 0 }
  };
  
  const output = renderHUD(state, agyData, { display: { useNerdFonts: true } });
  assert.match(output, //); // branchIcon
  assert.match(output, /󰌢/); // planIcon
  assert.match(output, //); // stepIcon
  assert.match(output, //); // taskIcon
  assert.match(output, /󰚩/); // tokenIcon
  assert.match(output, /󱔐/); // ctxIcon
  assert.match(output, /󰚗/); // modelIcon
});
