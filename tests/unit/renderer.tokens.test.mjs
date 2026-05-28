import { describe, test } from 'node:test';
import assert from 'node:assert';
import { renderHUD } from '../../runtime/renderer.js';

describe('renderer / tokens & cache breakdown', () => {
  test('renderHUD should correctly display detailed tokens with cache read statistics', () => {
    const state = { steps: 5, branch: 'main' };
    const agyData = {
      context_window: {
        total_input_tokens: 190702,
        total_output_tokens: 358448,
        used_percentage: 18.1,
        context_window_size: 1048576,
        current_usage: {
          input_tokens: 1890,
          output_tokens: 169,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 191019
        }
      }
    };

    const output = renderHUD(state, agyData, { display: { useNerdFonts: false, unicode: true } });
    // Compact format: total ↑in ↓out ⟳cache
    assert.match(output, /Tokens 551\.4k .*?\(.*?in: 1\.9k, out: 358\.4k, cache: 191k.*?\)/);
  });

  test('renderHUD should fall back to transcript token usage for cache breakdown', () => {
    const state = {
      steps: 5,
      branch: 'main',
      usage: {
        current_usage: {
          input_tokens: 6000,
          cache_read_input_tokens: 138200000
        }
      }
    };
    const agyData = {
      context_window: {
        total_input_tokens: 138206000,
        total_output_tokens: 202000,
        used_percentage: 18.1,
        context_window_size: 1048576
      }
    };

    const output = renderHUD(state, agyData, { display: { useNerdFonts: false, unicode: true } });
    assert.match(output, /Tokens 138\.4M .*?\(.*?in: 6k, out: 202k, cache: 138\.2M.*?\)/);
  });

  test('renderHUD hides cache when zero', () => {
    const state = { steps: 0, branch: 'main' };
    const agyData = {
      context_window: { total_input_tokens: 1000, total_output_tokens: 200, used_percentage: 5, context_window_size: 1000000 }
    };
    const output = renderHUD(state, agyData, { display: { useNerdFonts: false, unicode: true } });
    assert.match(output, /Tokens 1\.2k .*?\(.*?in: 1k, out: 200.*?\)/);
    assert.doesNotMatch(output, /⟳/);
  });

  test('renderHUD formatTokens correctly rounds boundary values to M/k without 1000k spikes', () => {
    const output1 = renderHUD(
      { steps: 1, branch: 'main' },
      {
        context_window: { total_input_tokens: 999950, total_output_tokens: 50, used_percentage: 0 }
      },
      { display: { useNerdFonts: false, unicode: true } }
    );
    assert.match(output1, /Tokens 1M /);

    const output2 = renderHUD(
      { steps: 1, branch: 'main' },
      {
        context_window: { total_input_tokens: 999900, total_output_tokens: 0, used_percentage: 0 }
      },
      { display: { useNerdFonts: false, unicode: true } }
    );
    assert.match(output2, /in: 999\.9k/);
  });

  test('renderHUD applies cache smoothing adaption on temporary cache miss', () => {
    const state = {
      steps: 9,
      branch: 'main',
      maxHistoricalCache: 250000
    };
    const agyData = {
      context_window: {
        total_input_tokens: 258000,
        total_output_tokens: 88700,
        used_percentage: 25,
        context_window_size: 1048576,
        current_usage: {
          input_tokens: 258000,
          output_tokens: 88700,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0
        }
      }
    };

    const output = renderHUD(state, agyData, { display: { useNerdFonts: false, unicode: true } });
    assert.match(output, /Tokens 346\.7k .*?\(.*?in: 8k, out: 88\.7k, cache: 250k\*.*?\)/);
  });

  test('renderHUD should correctly display cache for Claude models on cache creation', () => {
    const state = { steps: 1, branch: 'main' };
    const agyData = {
      context_window: {
        total_input_tokens: 92300,
        total_output_tokens: 15900,
        used_percentage: 37,
        context_window_size: 250000,
        current_usage: {
          input_tokens: 99200,
          output_tokens: 15900,
          cache_creation_input_tokens: 92300,
          cache_read_input_tokens: 0
        }
      },
      model: {
        display_name: 'Claude Sonnet 4.6 (Thinking)',
        id: 'claude-sonnet-4-6'
      }
    };

    const output = renderHUD(state, agyData, { display: { useNerdFonts: false, unicode: true } });
    // Total tokens: in (99.2k - 92.3k = 6.9k) + out (15.9k) + cache (92.3k) = 115.1k ~ 115k
    assert.match(output, /Tokens 115\.1k/);
    assert.match(output, /in: 6\.9k/);
    assert.match(output, /out: 15\.9k/);
    assert.match(output, /cache: 92\.3k/);
  });

  test('renderHUD should correctly display cache for Claude models on cache read', () => {
    const state = { steps: 1, branch: 'main' };
    const agyData = {
      context_window: {
        total_input_tokens: 92300,
        total_output_tokens: 15900,
        used_percentage: 37,
        context_window_size: 250000,
        current_usage: {
          input_tokens: 99200,
          output_tokens: 15900,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 92300
        }
      },
      model: {
        display_name: 'Claude Sonnet 4.6 (Thinking)',
        id: 'claude-sonnet-4-6'
      }
    };

    const output = renderHUD(state, agyData, { display: { useNerdFonts: false, unicode: true } });
    assert.match(output, /Tokens 115\.1k/);
    assert.match(output, /in: 6\.9k/);
    assert.match(output, /out: 15\.9k/);
    assert.match(output, /cache: 92\.3k/);
  });
});
