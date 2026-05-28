import { describe, test } from 'node:test';
import assert from 'node:assert';
import { renderHUD } from '../../runtime/renderer.js';

describe('renderer / quota lines', () => {
  describe('table mode', () => {
    test('should correctly layout quotas in two aligned columns', () => {
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
      const lines = output.split('\n');
      const gptLine = lines.find(l => l.includes('GPT-OSS'));
      assert.ok(gptLine, 'GPT-OSS line must exist');
      assert.doesNotMatch(gptLine, /│/, 'Odd/last column must not render vertical divider');

      // Verify vertical grid lines
      assert.match(output, /───/);
      // Verify simplified names
      assert.match(output, /Gemini 3\.5 Flash\(H\)/);
      assert.match(output, /Sonnet 4\.6\(Th\)/);
      assert.match(output, /GPT-OSS 120B/);
      // Verify reset times
      assert.match(output, /~14m/);
      assert.match(output, /~3h47m/);
    });

    test('supports custom columnWidth', () => {
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
      assert.match(output, /Gemini 3\.5 Flash\(H\) {5}/);
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

      assert.match(output, /─+/);
      assert.match(output, /Gemini 3\.5 Flash\(H\)/);
      assert.doesNotMatch(output, /Google:/);
    });

    test('renders two rows per model when both quota windows are observed', () => {
      const state = { steps: 0, branch: 'main' };
      const agyData = { context_window: { total_input_tokens: 0, total_output_tokens: 0, used_percentage: 0 } };
      const now = Date.now();
      const quotaData = [{
        id: 'gemini-3-flash-agent',
        displayName: 'Gemini 3.5 Flash (High)',
        modelProvider: 'MODEL_PROVIDER_GOOGLE',
        remainingFraction: 0.2,
        resetTime: new Date(now + 109 * 3600 * 1000).toISOString(),
        windows: {
          fiveHour: { remainingFraction: 0.6, resetTime: new Date(now + 4 * 3600 * 1000).toISOString(), observedAt: now },
          weekly:   { remainingFraction: 0.2, resetTime: new Date(now + 109 * 3600 * 1000).toISOString(), observedAt: now },
        },
      }];
      const stripAnsi = s => s.replace(/\x1b\[[0-9;]*m/g, '');
      const output = stripAnsi(renderHUD(state, agyData, { display: { useNerdFonts: false, unicode: true } }, quotaData));

      assert.match(output, /Gemini 3\.5 Flash\(H\)/);
      assert.match(output, /5h\s+\[[█░]+\]\s+60%\s+~4h/);
      assert.match(output, /Wk\s+\[[█░]+\]\s+20%/);
    });

    test('shows "no data yet" placeholder for a window that has never been observed', () => {
      const state = { steps: 0, branch: 'main' };
      const agyData = { context_window: { total_input_tokens: 0, total_output_tokens: 0, used_percentage: 0 } };
      const now = Date.now();
      const quotaData = [{
        id: 'claude-sonnet-4-6',
        displayName: 'Claude Sonnet 4.6 (Thinking)',
        modelProvider: 'MODEL_PROVIDER_ANTHROPIC',
        remainingFraction: 0.1,
        resetTime: new Date(now + 100 * 3600 * 1000).toISOString(),
        windows: {
          weekly: { remainingFraction: 0.1, resetTime: new Date(now + 100 * 3600 * 1000).toISOString(), observedAt: now },
        },
      }];
      const stripAnsi = s => s.replace(/\x1b\[[0-9;]*m/g, '');
      const output = stripAnsi(renderHUD(state, agyData, { display: { useNerdFonts: false, unicode: true } }, quotaData));

      assert.match(output, /5h\s+─ no data yet/);
      assert.match(output, /Wk\s+\[[█░]+\]\s+10%/);
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
      assert.match(output, /\x1b\[31m\[/);
    });
  });

  describe('compact mode', () => {
    test('appends current model quota to line 2', () => {
      const state = { steps: 5, branch: 'dev' };
      const agyData = {
        context_window: { total_input_tokens: 1000, total_output_tokens: 200, used_percentage: 5 },
        model: { display_name: 'Claude Sonnet 4.6 (Thinking)' }
      };
      const quotaData = [
        { id: 'claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6 (Thinking)', modelProvider: 'MODEL_PROVIDER_ANTHROPIC', remainingFraction: 0.2, resetTime: new Date(Date.now() + 4 * 86400000).toISOString() },
        { id: 'gemini-3-flash-agent', displayName: 'Gemini 3.5 Flash (High)', modelProvider: 'MODEL_PROVIDER_GOOGLE', remainingFraction: 1, resetTime: new Date(Date.now() + 3600000).toISOString() },
      ];
      const config = { display: { quotaStyle: 'compact', unicode: false } };
      const output = renderHUD(state, agyData, config, quotaData);

      // resetTime ~4d ahead → classified as the weekly window, so the label
      // gets the "W" suffix.
      assert.match(output, /Quota\[W\]: 20%/);
      assert.match(output, /Anthropic:/);
      assert.match(output, /Google:/);
      assert.doesNotMatch(output, /─{10}/);
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

      assert.match(output, /Quota: 50%/);
    });

    test('renders provider-grouped mini bars', () => {
      const state = { steps: 1, branch: 'main' };
      const agyData = {
        context_window: { total_input_tokens: 0, total_output_tokens: 0, used_percentage: 0 },
        model: { display_name: 'Gemini 3.5 Flash (High)' }
      };
      const quotaData = [
        { id: 'gemini-3-flash-agent', displayName: 'Gemini 3.5 Flash (High)', modelProvider: 'MODEL_PROVIDER_GOOGLE', remainingFraction: 1, resetTime: null },
        { id: 'gemini-3.1-pro-low', displayName: 'Gemini 3.1 Pro (Low)', modelProvider: 'MODEL_PROVIDER_GOOGLE', remainingFraction: 0.5, resetTime: null },
        { id: 'claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6 (Thinking)', modelProvider: 'MODEL_PROVIDER_ANTHROPIC', remainingFraction: 0.2, resetTime: null },
        { id: 'gpt-oss-120b-medium', displayName: 'GPT-OSS 120B (Medium)', modelProvider: 'MODEL_PROVIDER_OPENAI', remainingFraction: 0.8, resetTime: null },
      ];
      const config = { display: { quotaStyle: 'compact', unicode: true } };
      const output = renderHUD(state, agyData, config, quotaData);

      assert.match(output, /Google:.*Flash\(H\).*Pro\(L\)/);
      assert.match(output, /Anthropic:.*Sonnet/);
      assert.match(output, /OpenAI:.*GPT/);
    });

    test('picks the more critical window per current model', () => {
      const state = { steps: 0, branch: 'main' };
      const now = Date.now();
      const agyData = {
        context_window: { total_input_tokens: 0, total_output_tokens: 0, used_percentage: 0 },
        model: { display_name: 'Gemini 3.5 Flash (High)' },
      };
      const quotaData = [{
        id: 'gemini-3-flash-agent',
        displayName: 'Gemini 3.5 Flash (High)',
        modelProvider: 'MODEL_PROVIDER_GOOGLE',
        remainingFraction: 0.2,
        resetTime: new Date(now + 109 * 3600 * 1000).toISOString(),
        windows: {
          fiveHour: { remainingFraction: 0.95, resetTime: new Date(now + 4 * 3600 * 1000).toISOString(), observedAt: now },
          weekly:   { remainingFraction: 0.2,  resetTime: new Date(now + 109 * 3600 * 1000).toISOString(), observedAt: now },
        },
      }];
      const output = renderHUD(state, agyData, { display: { quotaStyle: 'compact', unicode: false } }, quotaData);

      // Weekly is more critical (20% < 95%), so the label uses [W] and the
      // percent reflects the weekly window, not the 5-hour one.
      assert.match(output, /Quota\[W\]: 20%/);
      assert.doesNotMatch(output, /Quota\[5h\]/);
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

      assert.match(output, /Quota unavailable/);
      assert.match(output, /not logged into Antigravity/);
    });

    test('should explain quota fetch and auth failures', () => {
      const state = { steps: 0, branch: 'main' };
      const agyData = {
        context_window: { total_input_tokens: 1000, total_output_tokens: 200, used_percentage: 5 }
      };
      const expiredToken = [];
      Object.defineProperty(expiredToken, 'unavailableReason', {
        value: 'expired_token',
        enumerable: false
      });
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
        renderHUD(state, agyData, { language: 'en', display: { useNerdFonts: false } }, expiredToken),
        /Antigravity token expired/
      );
      assert.match(
        renderHUD(state, agyData, { language: 'en', display: { useNerdFonts: false } }, authFailed),
        /Antigravity auth failed/
      );
      assert.match(
        renderHUD(state, agyData, { language: 'en', display: { useNerdFonts: false } }, fetchFailed),
        /quota fetch failed/
      );
    });

    test('localizes quota diagnostics when language is zh', () => {
      const state = { steps: 0, branch: 'main' };
      const agyData = {
        context_window: { total_input_tokens: 1000, total_output_tokens: 200, used_percentage: 5 }
      };
      const quotaData = [];
      Object.defineProperty(quotaData, 'unavailableReason', {
        value: 'not_logged_in',
        enumerable: false
      });

      const output = renderHUD(state, agyData, { language: 'zh', display: { useNerdFonts: false } }, quotaData);

      assert.match(output, /额度不可用/);
      assert.match(output, /未登录 Antigravity/);
    });

    test('shows loading state when quotaData is empty array without reason', () => {
      const state = { steps: 0, branch: 'main' };
      const agyData = {
        context_window: { total_input_tokens: 1000, total_output_tokens: 200, used_percentage: 5 }
      };

      const outputUnicode = renderHUD(state, agyData, { language: 'en', display: { unicode: true } }, []);
      assert.match(outputUnicode, /Quota loading…/);
      assert.match(outputUnicode, /─+/);

      const outputAscii = renderHUD(state, agyData, { language: 'en', display: { unicode: false } }, []);
      assert.match(outputAscii, /Quota loading\.\.\./);
    });

    test('does not show loading when quotaData is null or undefined', () => {
      const state = { steps: 0, branch: 'main' };
      const agyData = {
        context_window: { total_input_tokens: 1000, total_output_tokens: 200, used_percentage: 5 }
      };

      const output = renderHUD(state, agyData, { display: { unicode: true } }, null);
      assert.doesNotMatch(output, /Quota loading/);
      assert.doesNotMatch(output, /Quota unavailable/);

      const output2 = renderHUD(state, agyData, { display: { unicode: true } });
      assert.doesNotMatch(output2, /Quota loading/);
    });
  });
});
