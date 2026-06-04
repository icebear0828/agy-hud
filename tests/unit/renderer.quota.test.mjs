import { describe, test } from 'node:test';
import assert from 'node:assert';
import { renderHUD } from '../../runtime/renderer.js';

describe('renderer / quota lines', () => {
  describe('table mode', () => {
    test('should correctly layout quotas in three aligned columns', () => {
      const state = { steps: 5, branch: 'dev' };
      const agyData = {
        context_window: { total_input_tokens: 1000, total_output_tokens: 200, used_percentage: 5 }
      };
      const quotaData = [
        { id: 'gemini-3.5-flash-high', displayName: 'Gemini 3.5 Flash (High)', modelProvider: 'MODEL_PROVIDER_GOOGLE', remainingFraction: 0.6, resetTime: new Date(Date.now() + 840000).toISOString() },
        { id: 'claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6 (Thinking)', modelProvider: 'MODEL_PROVIDER_ANTHROPIC', remainingFraction: 0.4, resetTime: new Date(Date.now() + 13620000).toISOString() },
        { id: 'gemini-3.1-flash-image', displayName: 'Gemini 3.1 Flash Image', modelProvider: 'MODEL_PROVIDER_GOOGLE', remainingFraction: 1.0 }
      ];

      const output = renderHUD(state, agyData, { display: { useNerdFonts: false, unicode: true } }, quotaData);
      
      // Verify column partitions exist in new output style
      assert.match(output, /│/);
      
      // Verify simplified names
      assert.match(output, /Gemini 3\.5 Flash/);
      assert.match(output, /Sonnet/);
      assert.match(output, /Flash/);
      
      // Verify progress bars or remaining fractions
      assert.match(output, /60%/);
      assert.match(output, /40%/);
      assert.match(output, /100%/);
    });

    test('is unchanged with quotaStyle unset', () => {
      const state = { steps: 1, branch: 'main' };
      const agyData = {
        context_window: { total_input_tokens: 0, total_output_tokens: 0, used_percentage: 0 }
      };
      const quotaData = [
        { id: 'gemini-3-flash-agent', displayName: 'Gemini 3.5 Flash (High)', remainingFraction: 1, resetTime: null },
      ];
      const config = { display: { unicode: true } };
      const output = renderHUD(state, agyData, config, quotaData);

      assert.match(output, /Gemini 3\.5 Flash/);
      assert.match(output, /-------------------------------------------------------------------------------------------------/);
    });

    test('uses warning/critical colors for both percent text and progress bar', () => {
      const state = { steps: 0, branch: 'main' };
      const agyData = {
        context_window: { total_input_tokens: 0, total_output_tokens: 0, used_percentage: 0 }
      };
      const quotaData = [{
        id: 'gemini-3.5-flash-low',
        displayName: 'Gemini 3.5 Flash (Low)',
        remainingFraction: 0.08, // 8%, which is <= 10% critical threshold
        resetTime: null
      }];
      const output = renderHUD(state, agyData, { display: { unicode: true, useNerdFonts: false } }, quotaData);
      assert.match(output, /\x1b\[31m/);
    });
  });

  describe('compact mode', () => {
    test('appends current model quota to line 2', () => {
      const state = { steps: 5, branch: 'dev' };
      const agyData = {
        context_window: { total_input_tokens: 1000, total_output_tokens: 200, used_percentage: 5 },
        model: { display_name: 'Claude Sonnet 4.6 (Thinking)', id: 'claude-sonnet-4-6' }
      };
      const quotaData = [
        { id: 'claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6 (Thinking)', modelProvider: 'MODEL_PROVIDER_ANTHROPIC', remainingFraction: 0.2, resetTime: new Date(Date.now() + 4 * 86400000).toISOString() },
        { id: 'gemini-3-flash-agent', displayName: 'Gemini 3.5 Flash (High)', modelProvider: 'MODEL_PROVIDER_GOOGLE', remainingFraction: 1, resetTime: new Date(Date.now() + 3600000).toISOString() },
      ];
      const config = { display: { quotaStyle: 'compact', unicode: false } };
      const output = renderHUD(state, agyData, config, quotaData);

      assert.match(output, /quota/i);
      assert.match(output, /20%/);
    });

    test('matches current model despite display suffix drift', () => {
      const state = { steps: 5, branch: 'dev' };
      const agyData = {
        context_window: { total_input_tokens: 1000, total_output_tokens: 200, used_percentage: 5 },
        model: {
          id: 'gemini-3-flash-agent',
          display_name: 'Gemini 3.5 Flash (High) Preview'
        }
      };
      const quotaData = [
        { id: 'gemini-3-flash-agent', displayName: 'Gemini 3.5 Flash (High)', modelProvider: 'MODEL_PROVIDER_GOOGLE', remainingFraction: 0.5, resetTime: null },
      ];

      const output = renderHUD(state, agyData, { display: { quotaStyle: 'compact', unicode: false } }, quotaData);

      assert.match(output, /quota/i);
      assert.match(output, /50%/);
    });
  });

  describe('diagnostics & loading states', () => {
    test('should explain when quota is unavailable because auth is missing', () => {
      const state = { steps: 0, branch: 'main' };
      const agyData = {
        context_window: { total_input_tokens: 1000, total_output_tokens: 200, used_percentage: 5 }
      };
      const quotaData = [];
      Object.defineProperty(quotaData, 'unavailableReason', {
        value: 'not_logged_in',
        enumerable: false
      });

      const output = renderHUD(state, agyData, { language: 'en', display: { useNerdFonts: false } }, quotaData);

      assert.match(output, /quota/i);
      assert.match(output, /not logged into Antigravity/i);
    });

    test('shows loading state when quotaData is empty array without reason', () => {
      const state = { steps: 0, branch: 'main' };
      const agyData = {
        context_window: { total_input_tokens: 1000, total_output_tokens: 200, used_percentage: 5 }
      };

      const outputUnicode = renderHUD(state, agyData, { language: 'en', display: { unicode: true } }, []);
      assert.match(outputUnicode, /quota/i);
      assert.match(outputUnicode, /loading/i);
    });
  });
});
