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
    assert.match(output, /551\.4k/i);
    assert.match(output, /1\.9k/i);
    assert.match(output, /358\.4k/i);
    assert.match(output, /191k/i);
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
    assert.match(output, /138\.4M/i);
    assert.match(output, /6k/i);
    assert.match(output, /202k/i);
    assert.match(output, /138\.2M/i);
  });

  test('renderHUD hides cache when zero', () => {
    const state = { steps: 0, branch: 'main' };
    const agyData = {
      context_window: { total_input_tokens: 1000, total_output_tokens: 200, used_percentage: 5, context_window_size: 1000000 }
    };
    const output = renderHUD(state, agyData, { display: { useNerdFonts: false, unicode: true } });
    assert.match(output, /1\.2k/i);
    assert.match(output, /1k/i);
    assert.match(output, /200/i);
    assert.doesNotMatch(output, /cache/i);
  });

  test('renderHUD formatTokens correctly rounds boundary values to M/k without 1000k spikes', () => {
    const output1 = renderHUD(
      { steps: 1, branch: 'main' },
      {
        context_window: { total_input_tokens: 999950, total_output_tokens: 50, used_percentage: 0 }
      },
      { display: { useNerdFonts: false, unicode: true } }
    );
    assert.match(output1, /1M/i);

    const output2 = renderHUD(
      { steps: 1, branch: 'main' },
      {
        context_window: { total_input_tokens: 999900, total_output_tokens: 0, used_percentage: 0 }
      },
      { display: { useNerdFonts: false, unicode: true } }
    );
    assert.match(output2, /999\.9k/i);
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
    assert.match(output, /346\.7k/i);
    assert.match(output, /8k/i);
    assert.match(output, /88\.7k/i);
    assert.match(output, /250k\*/i);
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
    assert.match(output, /115\.1k/i);
    assert.match(output, /6\.9k/i);
    assert.match(output, /15\.9k/i);
    assert.match(output, /92\.3k/i);
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
    assert.match(output, /115\.1k/i);
    assert.match(output, /6\.9k/i);
    assert.match(output, /15\.9k/i);
    assert.match(output, /92\.3k/i);
  });
});
