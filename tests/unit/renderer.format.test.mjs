import { describe, test } from 'node:test';
import assert from 'node:assert';
import { abbreviateDisplayName, compactModelName } from '../../runtime/renderer.js';

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
});
