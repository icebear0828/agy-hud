import { describe, test } from 'node:test';
import assert from 'node:assert';
import { abbreviateDisplayName, compactModelName } from '../../runtime/renderer.js';
import { visualWidth, padToVisualWidth } from '../../runtime/renderer/format.js';

describe('renderer / format helpers', () => {
  describe('abbreviateDisplayName', () => {
    test('handles all known agent model patterns', () => {
      assert.equal(abbreviateDisplayName('Gemini 3.5 Flash (High)'), 'Gemini 3.5 Flash(H)');
      assert.equal(abbreviateDisplayName('Gemini 3.5 Flash (Medium)'), 'Gemini 3.5 Flash(M)');
      assert.equal(abbreviateDisplayName('Gemini 3.5 Flash (Low)'), 'Gemini 3.5 Flash(L)');
      assert.equal(abbreviateDisplayName('Gemini 3.1 Pro (High)'), 'Gemini 3.1 Pro(H)');
      assert.equal(abbreviateDisplayName('Gemini 3.1 Pro (Low)'), 'Gemini 3.1 Pro(L)');
      assert.equal(abbreviateDisplayName('Claude Sonnet 4.6 (Thinking)'), 'Sonnet 4.6(Th)');
      assert.equal(abbreviateDisplayName('Claude Opus 4.6 (Thinking)'), 'Opus 4.6(Th)');
      assert.equal(abbreviateDisplayName('GPT-OSS 120B (Medium)'), 'GPT-OSS 120B');
    });

    test('passes through unknown names unchanged', () => {
      assert.equal(abbreviateDisplayName('Some Future Model 9.0'), 'Some Future Model 9.0');
      assert.equal(abbreviateDisplayName(''), '');
    });

    test('handles hypothetical future models', () => {
      assert.equal(abbreviateDisplayName('Gemini 4.0 Flash (High)'), 'Gemini 4.0 Flash(H)');
      assert.equal(abbreviateDisplayName('Claude Haiku 5.0 (Thinking)'), 'Haiku 5.0(Th)');
      assert.equal(abbreviateDisplayName('GPT-OSS 200B (Low)'), 'GPT-OSS 200B');
    });
  });

  describe('compactModelName', () => {
    test('produces ultra-short names for provider summary', () => {
      assert.equal(compactModelName('Gemini 3.5 Flash (High)'), 'Flash(H)');
      assert.equal(compactModelName('Gemini 3.5 Flash (Medium)'), 'Flash(M)');
      assert.equal(compactModelName('Gemini 3.1 Pro (Low)'), 'Pro(L)');
      assert.equal(compactModelName('Claude Sonnet 4.6 (Thinking)'), 'Sonnet');
      assert.equal(compactModelName('Claude Opus 4.6 (Thinking)'), 'Opus');
      assert.equal(compactModelName('GPT-OSS 120B (Medium)'), 'GPT');
    });
  });

  describe('visualWidth', () => {
    test('counts ASCII as 1 column per char', () => {
      assert.equal(visualWidth('hello'), 5);
      assert.equal(visualWidth(''), 0);
      assert.equal(visualWidth('5h remaining & reset'), 20);
    });

    test('counts CJK as 2 columns per char', () => {
      assert.equal(visualWidth('模型'), 4);
      assert.equal(visualWidth('5h 剩余配额与可用时间'), 3 + 9 * 2); // "5h " + 9 CJK
      assert.equal(visualWidth('周趋势'), 6);
    });

    test('strips ANSI escapes before counting', () => {
      assert.equal(visualWidth('\x1b[31mhello\x1b[0m'), 5);
      assert.equal(visualWidth('\x1b[90m─\x1b[0m'), 1);
    });

    test('ignores C0 controls and DEL', () => {
      assert.equal(visualWidth('a\x00b\x7fc'), 3);
    });
  });

  describe('padToVisualWidth', () => {
    test('right-pads with spaces to reach visual target width', () => {
      assert.equal(padToVisualWidth('hi', 5), 'hi   ');
      assert.equal(padToVisualWidth('模型', 6), '模型  '); // 4 visual + 2 spaces
      assert.equal(padToVisualWidth('exact', 5), 'exact');
    });

    test('returns string unchanged when already at or past target', () => {
      assert.equal(padToVisualWidth('overflow', 3), 'overflow');
    });

    test('pads correctly even when input contains ANSI escapes', () => {
      const colored = '\x1b[31mhi\x1b[0m';
      const padded = padToVisualWidth(colored, 5);
      assert.equal(visualWidth(padded), 5);
      assert.ok(padded.endsWith('   '), 'padding spaces are appended after the reset');
    });
  });
});
