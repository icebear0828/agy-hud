import { describe, test } from 'node:test';
import assert from 'node:assert';
import { renderHUD } from '../../runtime/renderer.js';
import {
  calculateTurnCacheMetrics,
  formatTurnCacheBadge,
} from '../../runtime/renderer/format.js';

const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;

function render(currentUsage, display = {}, options = {}) {
  const state = {
    steps: 1,
    branch: 'main',
    ...(options.state || {}),
  };
  const contextWindow = {
    total_input_tokens: options.totalInput ?? 5000,
    total_output_tokens: options.totalOutput ?? 500000,
    context_window_size: 1000000,
    used_percentage: 1,
    ...(options.contextWindow || {}),
  };
  if (currentUsage !== undefined) contextWindow.current_usage = currentUsage;
  const agyData = {
    context_window: contextWindow,
    model: options.model || {
      id: 'claude-sonnet-4-6',
      display_name: 'Claude Sonnet 4.6 (Thinking)',
    },
  };

  return renderHUD(state, agyData, {
    display,
    language: options.language,
  }).replace(ANSI_RE, '');
}

describe('renderer / per-turn cache hit rate', () => {
  test('table mode renders a standalone badge with absolute read/prompt tokens', () => {
    const output = render({
      input_tokens: 5000,
      output_tokens: 500000,
      cache_creation_input_tokens: 1000,
      cache_read_input_tokens: 3000,
    }, { quotaStyle: 'table', unicode: false });

    assert.match(output, /cache: 4k/);
    assert.match(output, /\| cache 60\.0% \(3k\/5k\) \|/);
    assert.equal(output.trim().split('\n').length, 2);
  });

  test('compact mode omits absolute counts and does not add a line', () => {
    const output = render({
      input_tokens: 5000,
      cache_creation_input_tokens: 1000,
      cache_read_input_tokens: 3000,
    }, { quotaStyle: 'compact', unicode: false });

    assert.match(output, /Tokens 505k \| cache 60\.0% \|/);
    assert.doesNotMatch(output, /in: 1k/);
    assert.match(output, /\| cache 60\.0% \|/);
    assert.doesNotMatch(output, /cache 60\.0% \(/);
    const lines = output.trim().split('\n');
    assert.equal(lines.length, 2);
    assert.ok(lines[1].length <= 80, `compact resource line is ${lines[1].length} columns`);
  });

  test('normalizes cache-inclusive Claude, GPT, DeepSeek, and Gemini input', () => {
    for (const displayName of [
      'Claude Sonnet 4.6 (Thinking)',
      'GPT-OSS 120B (Medium)',
      'DeepSeek V3',
      'Gemini 3.7 Flash (High)',
    ]) {
      const output = render({
        input_tokens: 5000,
        cache_creation_input_tokens: 1000,
        cache_read_input_tokens: 3000,
      }, { quotaStyle: 'table', unicode: false }, {
        model: { id: displayName.toLowerCase(), display_name: displayName },
      });

      assert.match(output, /in: 1k, out: 500k, cache: 4k/);
      assert.match(output, /cache 60\.0% \(3k\/5k\)/);
    }
  });

  test('shows a real zero-percent cold-cache turn', () => {
    const output = render({
      input_tokens: 2000,
      cache_creation_input_tokens: 1000,
      cache_read_input_tokens: 0,
    }, { quotaStyle: 'table', unicode: false });

    assert.match(output, /cache 0\.0% \(0\/2k\)/);
  });

  test('hides unsupported telemetry and marks smoothing as unavailable', () => {
    const withoutTelemetry = render({ input_tokens: 1000 }, { unicode: false });
    assert.doesNotMatch(withoutTelemetry, /\| cache /);

    const missingInput = render({
      cache_creation_input_tokens: 1000,
      cache_read_input_tokens: 3000,
    }, { unicode: false, cacheHitThresholds: null });
    assert.match(missingInput, /\| cache -- \|/);

    const smoothed = render({
      input_tokens: 258000,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    }, { unicode: false }, {
      totalInput: 258000,
      state: { maxHistoricalCache: 250000 },
    });
    assert.match(smoothed, /cache: 250k\*/);
    assert.match(smoothed, /\| cache -- \|/);
  });

  test('can be disabled without hiding the existing cache token count', () => {
    const output = render({
      input_tokens: 1000,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 3000,
    }, { showTurnCacheHitRate: false, unicode: false });

    assert.match(output, /cache: 3k/);
    assert.doesNotMatch(output, /\| cache 75\.0%/);
  });

  test('uses the plain-text English label without Nerd Font glyphs', () => {
    const output = render({
      input_tokens: 10000,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 8520,
    }, { quotaStyle: 'compact', unicode: false }, { language: 'zh' });

    assert.match(output, /\| cache 85\.2% \|/);
  });

  test('uses a complete top-level agy group instead of mixing it with partial current usage', () => {
    const output = render({
      input_tokens: 1000,
      cache_creation_input_tokens: 0,
    }, { unicode: false }, {
      contextWindow: {
        input_tokens: 10000,
        cache_read_input_tokens: 9000,
        cache_creation_input_tokens: 0,
      },
    });

    assert.match(output, /\| cache 90\.0% \(9k\/10k\) \|/);
  });

  test('uses a complete transcript group only after every agy group is incomplete', () => {
    const output = render({
      input_tokens: 1000,
      cache_creation_input_tokens: 0,
    }, { unicode: false }, {
      state: {
        usage: {
          current_usage: {
            input_tokens: 10000,
            cache_read_input_tokens: 9000,
            cache_creation_input_tokens: 0,
          },
        },
      },
    });

    assert.match(output, /\| cache 90\.0% \(9k\/10k\) \|/);
  });

  test('prefers a complete agy group over conflicting transcript telemetry', () => {
    const output = render({
      input_tokens: 10000,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    }, { unicode: false }, {
      state: {
        usage: {
          current_usage: {
            input_tokens: 10000,
            cache_read_input_tokens: 9000,
            cache_creation_input_tokens: 0,
          },
        },
      },
    });

    assert.match(output, /\| cache 0\.0% \(0\/10k\) \|/);
  });

  test('correctly calculates cache hit rate for incremental inputs', () => {
    const output = render({
      input_tokens: 1000,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 3000,
    }, { unicode: false });

    assert.match(output, /\| cache 75\.0% \(3k\/4k\) \|/);
  });

  test('does not alter the existing token bar when the cache badge is enabled', () => {
    const usage = {
      input_tokens: 5000,
      cache_creation_input_tokens: 1000,
      cache_read_input_tokens: 3000,
    };
    const enabled = render(usage, { unicode: false });
    const disabled = render(usage, { showTurnCacheHitRate: false, unicode: false });

    assert.equal(enabled.split('\n')[1].split(' | ')[0], disabled.split('\n')[1].split(' | ')[0]);
  });

  test('correctly calculates cache hit rate for Gemini models', () => {
    const output = render({
      input_tokens: 10000,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 9000,
    }, { unicode: false }, {
      model: { id: 'gemini-3.7-flash-high', display_name: 'Gemini 3.7 Flash (High)' },
    });

    assert.match(output, /\| cache 90\.0% \(9k\/10k\) \|/);
  });

  test('correctly calculates cache hit rate when cache_creation_input_tokens is omitted', () => {
    const output = render({
      input_tokens: 10000,
      cache_read_input_tokens: 9000,
    }, { unicode: false }, {
      model: { id: 'gemini-3.7-flash-high', display_name: 'Gemini 3.7 Flash (High)' },
    });

    assert.match(output, /\| cache 90\.0% \(9k\/10k\) \|/);
  });
});

describe('renderer / cache badge temperature scale', () => {
  const colors = {
    green: '<green>',
    cyan: '<cyan>',
    yellow: '<yellow>',
    gray: '<gray>',
    bold: '<bold>',
    dim: '<dim>',
    reset: '</>',
  };

  function badge(input, read) {
    const metrics = calculateTurnCacheMetrics({
      input_tokens: input,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: read,
    }, 'Claude Sonnet 4.6 (Thinking)');
    return formatTurnCacheBadge(metrics, 'cache', colors, true);
  }

  test('renders 0%, 50%, 85.2%, and 100% with four glanceable styles', () => {
    assert.equal(badge(1000, 0), '<gray><dim>cache 0.0%</>');
    assert.equal(badge(1000, 500), '<yellow>cache 50.0%</>');
    assert.equal(badge(10000, 8520), '<green><bold>cache 85.2%</>');
    assert.equal(badge(1000, 1000), '<green><bold>cache 100.0%</>');
    assert.equal(badge(1000, 250), '<yellow><dim>cache 25.0%</>');
  });

  test('marks invalid cache measurements unavailable', () => {
    for (const usage of [
      { input_tokens: -1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      { input_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: Number.NaN },
      { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    ]) {
      assert.equal(calculateTurnCacheMetrics(usage, 'Claude Sonnet 4.6 (Thinking)').available, false);
    }
  });
});
