import { describe, test } from 'node:test';
import assert from 'node:assert';
import { abbreviateDisplayName, compactModelName, formatQuotaPercent } from '../../runtime/renderer.js';

describe('renderer / format helpers', () => {
  describe('abbreviateDisplayName', () => {
    test('handles all known agent model patterns', () => {
      assert.equal(abbreviateDisplayName('Gemini 3.5 Flash (High)'), 'Gemini 3.5 Flash(High)');
      assert.equal(abbreviateDisplayName('Gemini 3.5 Flash (Medium)'), 'Gemini 3.5 Flash(Medium)');
      assert.equal(abbreviateDisplayName('Gemini 3.5 Flash (Low)'), 'Gemini 3.5 Flash(Low)');
      assert.equal(abbreviateDisplayName('Gemini 3.1 Pro (High)'), 'Gemini 3.1 Pro(High)');
      assert.equal(abbreviateDisplayName('Gemini 3.1 Pro (Low)'), 'Gemini 3.1 Pro(Low)');
      assert.equal(abbreviateDisplayName('Gemini 4 Argon (Medium)'), 'Gemini 4 Argon(Medium)');
      assert.equal(abbreviateDisplayName('Gemini 4 Argon (High)'), 'Gemini 4 Argon(High)');
      assert.equal(abbreviateDisplayName('Gemini 4 Argon (Low)'), 'Gemini 4 Argon(Low)');
      assert.equal(abbreviateDisplayName('Gemini 4 Hydrogen (Medium)'), 'Gemini 4 Hydrogen(Medium)');
      assert.equal(abbreviateDisplayName('Claude Sonnet 4.6 (Thinking)'), 'Sonnet 4.6(Thinking)');
      assert.equal(abbreviateDisplayName('Claude Opus 4.6 (Thinking)'), 'Opus 4.6(Thinking)');
      assert.equal(abbreviateDisplayName('GPT-OSS 120B (Medium)'), 'GPT-OSS 120B');
    });

    test('passes through unknown names unchanged', () => {
      assert.equal(abbreviateDisplayName('Some Future Model 9.0'), 'Some Future Model 9.0');
      assert.equal(abbreviateDisplayName(''), '');
    });

    test('handles hypothetical future models', () => {
      assert.equal(abbreviateDisplayName('Gemini 4.0 Flash (High)'), 'Gemini 4.0 Flash(High)');
      assert.equal(abbreviateDisplayName('Claude Haiku 5.0 (Thinking)'), 'Haiku 5.0(Thinking)');
      assert.equal(abbreviateDisplayName('GPT-OSS 200B (Low)'), 'GPT-OSS 200B');
    });
  });

  describe('compactModelName', () => {
    test('produces ultra-short names for provider summary', () => {
      assert.equal(compactModelName('Gemini 3.5 Flash (High)'), 'Flash');
      assert.equal(compactModelName('Gemini 3.5 Flash (Medium)'), 'Flash');
      assert.equal(compactModelName('Gemini 3.1 Pro (Low)'), 'Pro');
      assert.equal(compactModelName('Gemini 4 Argon (Medium)'), 'Argon');
      assert.equal(compactModelName('Claude Sonnet 4.6 (Thinking)'), 'Sonnet');
      assert.equal(compactModelName('Claude Opus 4.6 (Thinking)'), 'Opus');
      assert.equal(compactModelName('GPT-OSS 120B (Medium)'), 'GPT');
      assert.equal(compactModelName('gemini-3.8-flash-tiered'), 'Flash');
      assert.equal(compactModelName('gemini-3.1-pro-low'), 'Pro');
      assert.equal(compactModelName('gemini-4-argon'), 'Argon');
      assert.equal(compactModelName('gemini-4-argon-high'), 'Argon');
      assert.equal(compactModelName('claude-sonnet-4-6'), 'Sonnet');
      assert.equal(compactModelName('claude-opus-4-6-thinking'), 'Opus');
    });

    test('handles null, undefined, empty, and non-string inputs gracefully', () => {
      assert.equal(compactModelName(null), '');
      assert.equal(compactModelName(undefined), '');
      assert.equal(compactModelName(''), '');
      assert.equal(compactModelName(123), '');
    });
  });

  describe('formatQuotaPercent', () => {
    test('formats percentage to two decimal places without rounding sub-1.0 up to 100.00%', () => {
      assert.equal(formatQuotaPercent(1.0), '100.00');
      assert.equal(formatQuotaPercent(0.9953883), '99.54');
      assert.equal(formatQuotaPercent(0.99999), '99.99');
      assert.equal(formatQuotaPercent(0.9668667), '96.69');
      assert.equal(formatQuotaPercent(0.8891867), '88.92');
      assert.equal(formatQuotaPercent(0.5), '50.00');
      assert.equal(formatQuotaPercent(0.0), '0.00');
      assert.equal(formatQuotaPercent(null), '0.00');
    });
  });
});
