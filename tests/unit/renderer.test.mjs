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

  const output = renderHUD(state, agyData, { display: { useNerdFonts: false, unicode: true } });
  assert.doesNotMatch(output, /^\n/);
  assert.match(output, /^\x1b\[1m\x1b\[36mAGY-HUD/);
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

  const output = renderHUD(state, agyData, { display: { useNerdFonts: false, unicode: true } }, quotaData);
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

test('renderHUD falls back to ASCII when config.display.unicode is false', () => {
  const state = { steps: 1, branch: 'main' };
  const agyData = {
    context_window: { total_input_tokens: 1000, total_output_tokens: 200, used_percentage: 5, context_window_size: 1000000 },
    plan_tier: 'Free',
    task_count: 0,
    model: { display_name: 'GPT-OSS 120B (Medium)' }
  };

  const output = renderHUD(state, agyData, { display: { useNerdFonts: false, unicode: false } });

  // Box-drawing characters should NOT appear
  assert.doesNotMatch(output, /│/);
  assert.doesNotMatch(output, /█/);
  assert.doesNotMatch(output, /░/);
  // Ascii substitutes should appear
  assert.match(output, /\|/);
  assert.match(output, /#/);
  // Plain-text icons replace emoji/glyphs
  assert.match(output, /\[B\]/);
  assert.match(output, /\[P\]/);
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

test('renderHUD supports theme custom colors', () => {
  const state = { steps: 5, branch: 'dev' };
  const agyData = {
    context_window: { total_input_tokens: 1000, total_output_tokens: 200, used_percentage: 95 }
  };
  const config = {
    display: {
      unicode: true
    },
    theme: {
      critical: 'blue'
    }
  };
  const output = renderHUD(state, agyData, config);
  assert.match(output, /\x1b\[34m\[█+/);
});

test('renderHUD supports custom warning and critical thresholds', () => {
  const state = { steps: 5, branch: 'dev' };
  const agyData = {
    context_window: { total_input_tokens: 1000, total_output_tokens: 200, used_percentage: 30 }
  };
  const config = {
    display: {
      unicode: true
    },
    thresholds: {
      warning: 0.2,
      critical: 0.4
    }
  };
  const output = renderHUD(state, agyData, config);
  assert.match(output, /\x1b\[33m\[█+/);
});

test('renderHUD supports custom columnWidth', () => {
  const state = { steps: 5, branch: 'dev' };
  const agyData = {
    context_window: { total_input_tokens: 1000, total_output_tokens: 200, used_percentage: 5 }
  };
  const quotaData = [
    { displayName: 'Gemini 3.5 Flash (High)', remainingFraction: 0.6 }
  ];
  const config = {
    display: {
      columnWidth: 45,
      unicode: true
    }
  };
  const output = renderHUD(state, agyData, config, quotaData);
  assert.match(output, /─{91}/);
  assert.match(output, /Gem 3\.5 Flash\(H\) {8}/);
});
