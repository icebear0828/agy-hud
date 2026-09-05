import { describe, test } from 'node:test';
import assert from 'node:assert';
import { renderHUD } from '../../runtime/renderer.js';

describe('renderer / quota lines', () => {
  describe('table mode', () => {
    test('renders provider 5h and weekly quota windows in two columns', () => {
      const state = { steps: 5, branch: 'dev' };
      const agyData = {
        context_window: { total_input_tokens: 1000, total_output_tokens: 200, used_percentage: 5 }
      };
      const now = Date.now();
      const quotaData = [
        {
          id: 'gemini-3.7-flash-medium',
          displayName: 'Gemini 3.7 Flash (Medium)',
          modelProvider: 'MODEL_PROVIDER_GOOGLE',
          remainingFraction: 0.87,
          resetTime: new Date(now + 22 * 60 * 1000).toISOString(),
          windows: {
            fiveHour: { remainingFraction: 0.87, resetTime: new Date(now + 22 * 60 * 1000).toISOString(), observedAt: now },
            weekly: { remainingFraction: 0.74, resetTime: new Date(now + (4 * 86400 + 3 * 3600) * 1000).toISOString(), observedAt: now }
          }
        },
        {
          id: 'claude-sonnet-4-6',
          displayName: 'Claude Sonnet 4.6 (Thinking)',
          modelProvider: 'MODEL_PROVIDER_ANTHROPIC',
          remainingFraction: 1.0,
          resetTime: new Date(now + (4 * 3600 + 59 * 60) * 1000).toISOString(),
          windows: {
            fiveHour: { remainingFraction: 1.0, resetTime: new Date(now + (4 * 3600 + 59 * 60) * 1000).toISOString(), observedAt: now },
            weekly: { remainingFraction: 1.0, resetTime: new Date(now + (6 * 86400 + 23 * 3600) * 1000).toISOString(), observedAt: now }
          }
        }
      ];

      const stripAnsi = s => s.replace(/\x1b\[[0-9;]*m/g, '');
      const clean = stripAnsi(renderHUD(state, agyData, { display: { useNerdFonts: false, unicode: true } }, quotaData));

      // Verify grid and rows
      assert.match(clean, /───/);
      assert.match(clean, /Google 5h\s+\[[█░]+\]\s+87%\s+~22m/);
      assert.match(clean, /Google week\s+\[[█░]+\]\s+74%\s+~4d3h/);
      assert.match(clean, /Claude 5h\s+\[[█░]+\]\s+100%\s+~4h59m/);
      assert.match(clean, /Claude week\s+\[[█░]+\]\s+100%\s+~6d23h/);

      const lines = clean.split('\n');
      const g5Line = lines.find(l => l.includes('Google 5h'));
      const gwLine = lines.find(l => l.includes('Google week'));
      assert.ok(g5Line && gwLine, 'both provider rows exist');
      assert.equal(g5Line.indexOf('│'), gwLine.indexOf('│'), 'vertical separator must align perfectly');
    });

    test('reads providerQuota directly instead of stale lower model windows', () => {
      const state = { steps: 5, branch: 'dev' };
      const agyData = {
        context_window: { total_input_tokens: 1000, total_output_tokens: 200, used_percentage: 5 },
      };
      const now = Date.now();
      const quotaData = [{
        id: 'gemini-3-flash-agent',
        displayName: 'Gemini 3 Flash Agent',
        modelProvider: 'MODEL_PROVIDER_GOOGLE',
        remainingFraction: 0.9,
        windows: {
          fiveHour: { remainingFraction: 0.95, resetTime: new Date(now + 4 * 60 * 60 * 1000).toISOString(), observedAt: now - 60_000 },
          weekly: { remainingFraction: 0.9, resetTime: new Date(now + 6 * 24 * 60 * 60 * 1000).toISOString(), observedAt: now - 60_000 },
        },
      }];
      quotaData.providerQuota = {
        google: {
          fiveHour: { remainingFraction: 0.9439, resetTime: new Date(now + (4 * 60 + 10) * 60 * 1000).toISOString() },
          weekly: { remainingFraction: 0.9906, resetTime: new Date(now + (6 * 24 + 23) * 60 * 60 * 1000).toISOString() },
        },
      };

      const clean = renderHUD(state, agyData, { display: { useNerdFonts: false, unicode: true } }, quotaData)
        .replace(/\x1b\[[0-9;]*m/g, '');
      const googleFiveHour = clean.split('\n').find(line => line.includes('Google 5h')) || '';
      const googleWeekly = clean.split('\n').find(line => line.includes('Google week')) || '';

      assert.match(googleFiveHour, /94%\s+~4h10m/);
      assert.match(googleWeekly, /99%\s+~6d23h/);
      assert.doesNotMatch(googleWeekly, /90%/);
    });

    test('models mode renders individual model rows in two columns', () => {
      const state = { steps: 5, branch: 'dev' };
      const agyData = {
        context_window: { total_input_tokens: 1000, total_output_tokens: 200, used_percentage: 5 }
      };
      const quotaData = [
        { displayName: 'Gemini 3.5 Flash (High)', remainingFraction: 0.6, resetTime: new Date(Date.now() + 840000).toISOString() },
        { displayName: 'Claude Sonnet 4.6 (Thinking)', remainingFraction: 0.4, resetTime: new Date(Date.now() + 13620000).toISOString() },
        { displayName: 'GPT-OSS 120B (Medium)', remainingFraction: 1.0 }
      ];

      const output = renderHUD(state, agyData, { display: { quotaStyle: 'models', useNerdFonts: false, unicode: true } }, quotaData);
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

    test('supports custom columnWidth in models mode', () => {
      const state = { steps: 5, branch: 'dev' };
      const agyData = {
        context_window: { total_input_tokens: 1000, total_output_tokens: 200, used_percentage: 5 }
      };
      const quotaData = [
        { displayName: 'Gemini 3.5 Flash (High)', remainingFraction: 0.6 }
      ];
      const config = {
        display: {
          quotaStyle: 'models',
          columnWidth: 45,
          unicode: true
        }
      };
      const output = renderHUD(state, agyData, config, quotaData);
      assert.match(output, /─{91}/);
      assert.match(output, /Gemini 3\.5 Flash\(H\) {5}/);
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

      // Single 'Quota:' label, no window suffix — renderer displays only
      // the top-level binding quota.
      assert.match(output, /Quota: 20%/);
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

    test('appends current model critical window quota to line 2 instead of top-level remainingFraction', () => {
      const state = { steps: 1, branch: 'main' };
      const agyData = {
        context_window: { total_input_tokens: 0, total_output_tokens: 0, used_percentage: 0 },
        model: {
          display_name: 'Gemini 3.8 Flash (Medium)',
          id: 'gemini-3.8-flash-tiered',
        }
      };
      const now = Date.now();
      const quotaData = [
        {
          id: 'gemini-3.8-flash-tiered',
          displayName: 'gemini-3.8-flash-tiered',
          modelProvider: 'MODEL_PROVIDER_GOOGLE',
          remainingFraction: 1.0, // Top-level is 1.0
          resetTime: new Date(now + 4 * 3600 * 1000).toISOString(),
          windows: {
            fiveHour: { remainingFraction: 1.0, resetTime: new Date(now + 4 * 3600 * 1000).toISOString(), observedAt: now },
            weekly: { remainingFraction: 0.82, resetTime: new Date(now + 6 * 86400 * 1000).toISOString(), observedAt: now },
          },
        },
      ];

      const output = renderHUD(state, agyData, { display: { quotaStyle: 'compact', unicode: false } }, quotaData);

      // Must pick the binding weekly window (82%), not top-level 100%
      assert.match(output, /Quota: 82%/);
      assert.doesNotMatch(output, /Quota: 100%/);
    });

    test('renders reset countdown on line 2 even when model quota is 100% if resetTime is present', () => {
      const state = { steps: 1, branch: 'main' };
      const agyData = {
        context_window: { total_input_tokens: 0, total_output_tokens: 0, used_percentage: 0 },
        model: { display_name: 'Claude Sonnet 4.6 (Thinking)' }
      };
      const now = Date.now();
      const quotaData = [
        {
          id: 'claude-sonnet-4-6',
          displayName: 'Claude Sonnet 4.6 (Thinking)',
          modelProvider: 'MODEL_PROVIDER_ANTHROPIC',
          remainingFraction: 1.0,
          resetTime: new Date(now + 4 * 3600 * 1000).toISOString(),
        },
      ];

      const output = renderHUD(state, agyData, { display: { quotaStyle: 'compact', unicode: false } }, quotaData);

      assert.match(output, /Quota: 100%.*~4h/);
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

      assert.match(output, /Google:.*Flash.*Pro/);
      assert.match(output, /Anthropic:.*Sonnet/);
      assert.match(output, /OpenAI:.*GPT/);
    });

    test('deduplicates models by family in compact mini bars', () => {
      const state = { steps: 1, branch: 'main' };
      const agyData = {
        context_window: { total_input_tokens: 0, total_output_tokens: 0, used_percentage: 0 },
        model: { display_name: 'Gemini 3.6 Flash (High)' }
      };
      const quotaData = [
        { id: 'gemini-3.6-flash-high', displayName: 'Gemini 3.6 Flash (High)', modelProvider: 'MODEL_PROVIDER_GOOGLE', remainingFraction: 0.8 },
        { id: 'gemini-3.5-flash-high', displayName: 'Gemini 3.5 Flash (High)', modelProvider: 'MODEL_PROVIDER_GOOGLE', remainingFraction: 0.6 },
        { id: 'gemini-3.6-flash-medium', displayName: 'Gemini 3.6 Flash (Medium)', modelProvider: 'MODEL_PROVIDER_GOOGLE', remainingFraction: 0.9 },
        { id: 'gemini-3.1-pro-high', displayName: 'Gemini 3.1 Pro (High)', modelProvider: 'MODEL_PROVIDER_GOOGLE', remainingFraction: 0.7 },
      ];
      const output = renderHUD(state, agyData, { display: { quotaStyle: 'compact', unicode: true } }, quotaData)
        .replace(/\x1b\[[0-9;]*m/g, '');
      const googleLine = output.split('\n').find(line => line.includes('Google:')) || '';

      assert.equal((googleLine.match(/Flash/g) || []).length, 1);
      assert.equal((googleLine.match(/Pro/g) || []).length, 1);
    });

    test('selects the most constrained quota (lowest remaining fraction) when deduplicating families', () => {
      const state = { steps: 1, branch: 'main' };
      const agyData = {
        context_window: { total_input_tokens: 0, total_output_tokens: 0, used_percentage: 0 },
        model: { display_name: 'Gemini 3.6 Flash (High)' }
      };
      // Test when lowest fraction appears second
      const quotaData1 = [
        { id: 'gemini-3.6-flash-high', displayName: 'Gemini 3.6 Flash (High)', modelProvider: 'MODEL_PROVIDER_GOOGLE', remainingFraction: 0.9 },
        { id: 'gemini-3.5-flash-low', displayName: 'Gemini 3.5 Flash (Low)', modelProvider: 'MODEL_PROVIDER_GOOGLE', remainingFraction: 0.2 },
      ];
      const output1 = renderHUD(state, agyData, { display: { quotaStyle: 'compact', unicode: true } }, quotaData1)
        .replace(/\x1b\[[0-9;]*m/g, '');
      const googleLine1 = output1.split('\n').find(line => line.includes('Google:')) || '';
      // 0.2 -> 20% -> 1 filled (█), 2 empty (░░)
      assert.match(googleLine1, /Flash█░░/);

      // Test when lowest fraction appears first
      const quotaData2 = [
        { id: 'gemini-3.5-flash-low', displayName: 'Gemini 3.5 Flash (Low)', modelProvider: 'MODEL_PROVIDER_GOOGLE', remainingFraction: 0.2 },
        { id: 'gemini-3.6-flash-high', displayName: 'Gemini 3.6 Flash (High)', modelProvider: 'MODEL_PROVIDER_GOOGLE', remainingFraction: 0.9 },
      ];
      const output2 = renderHUD(state, agyData, { display: { quotaStyle: 'compact', unicode: true } }, quotaData2)
        .replace(/\x1b\[[0-9;]*m/g, '');
      const googleLine2 = output2.split('\n').find(line => line.includes('Google:')) || '';
      assert.match(googleLine2, /Flash█░░/);
    });

    test('selects the most constrained quota taking critical window into account in compact mode', () => {
      const state = { steps: 1, branch: 'main' };
      const agyData = {
        context_window: { total_input_tokens: 0, total_output_tokens: 0, used_percentage: 0 },
        model: { display_name: 'Gemini 3.6 Flash (High)' }
      };
      const now = Date.now();
      const quotaData = [
        {
          id: 'gemini-3.6-flash-high',
          displayName: 'Gemini 3.6 Flash (High)',
          modelProvider: 'MODEL_PROVIDER_GOOGLE',
          remainingFraction: 1.0,
          resetTime: new Date(now + 100 * 3600 * 1000).toISOString(),
          windows: {
            fiveHour: { remainingFraction: 0.0, resetTime: new Date(now + 2 * 3600 * 1000).toISOString(), observedAt: now },
            weekly: { remainingFraction: 1.0, resetTime: new Date(now + 100 * 3600 * 1000).toISOString(), observedAt: now },
          },
        },
        {
          id: 'gemini-3.5-flash-low',
          displayName: 'Gemini 3.5 Flash (Low)',
          modelProvider: 'MODEL_PROVIDER_GOOGLE',
          remainingFraction: 0.8,
        },
      ];
      const output = renderHUD(state, agyData, { display: { quotaStyle: 'compact', unicode: true } }, quotaData)
        .replace(/\x1b\[[0-9;]*m/g, '');
      const googleLine = output.split('\n').find(line => line.includes('Google:')) || '';
      // The 0% critical window should make Flash 0% (0 filled, 3 empty ░░░)
      assert.match(googleLine, /Flash░░░/);
    });

    test('filters out image models from compact mini bars', () => {
      const state = { steps: 1, branch: 'main' };
      const agyData = {
        context_window: { total_input_tokens: 0, total_output_tokens: 0, used_percentage: 0 },
        model: { display_name: 'Gemini 3.6 Flash (High)' }
      };
      const quotaData = [
        { id: 'gemini-3.6-flash-high', displayName: 'Gemini 3.6 Flash (High)', modelProvider: 'MODEL_PROVIDER_GOOGLE', remainingFraction: 0.8 },
        { id: 'gemini-3.1-flash-image', displayName: 'Gemini 3.1 Flash Image', modelProvider: 'MODEL_PROVIDER_GOOGLE', remainingFraction: 0.5 },
      ];
      const output = renderHUD(state, agyData, { display: { quotaStyle: 'compact', unicode: true } }, quotaData)
        .replace(/\x1b\[[0-9;]*m/g, '');
      const googleLine = output.split('\n').find(line => line.includes('Google:')) || '';
      assert.match(googleLine, /Flash/);
      assert.doesNotMatch(googleLine, /Image/);
    });

    test('falls back to the same family and tier across model generations', () => {
      const state = { steps: 1, branch: 'main' };
      const agyData = {
        context_window: { total_input_tokens: 0, total_output_tokens: 0, used_percentage: 0 },
        model: { display_name: 'Gemini 3.7 Flash (High)', id: 'gemini-3.7-flash-high' }
      };
      const quotaData = [{
        id: 'gemini-3.5-flash-high',
        displayName: 'Gemini 3.5 Flash (High)',
        modelProvider: 'MODEL_PROVIDER_GOOGLE',
        remainingFraction: 0.74,
        resetTime: new Date(Date.now() + 2 * 3600 * 1000).toISOString(),
      }];
      const output = renderHUD(state, agyData, { display: { quotaStyle: 'compact', unicode: false } }, quotaData);

      assert.match(output, /Quota: 74%/);
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

  describe('image model quota and rate limit display', () => {
    test('renders Image Quota progress bar when quota is normal and showImageQuota is true', () => {
      const state = { steps: 5, branch: 'dev' };
      const agyData = {
        context_window: { total_input_tokens: 1000, total_output_tokens: 200, used_percentage: 5 }
      };
      const quotaData = [
        {
          id: 'gemini-3.1-flash-image',
          displayName: 'Gemini 3.1 Flash Image',
          remainingFraction: 0.9,
          resetTime: new Date(Date.now() + 3 * 3600 * 1000 + 49 * 60 * 1000).toISOString()
        }
      ];

      const output = renderHUD(state, agyData, { display: { unicode: true, useNerdFonts: false, showImageQuota: true } }, quotaData);
      assert.match(output, /Image Quota:/);
      assert.match(output, /90%/);
      assert.match(output, /~3h49m/);
    });

    test('renders Image Quota Exhausted countdown when rate limited', () => {
      const resetTime = new Date(Date.now() + 3 * 3600 * 1000 + 14 * 60 * 1000).toISOString();
      const state = {
        steps: 5,
        branch: 'dev',
        imageExhausted: { exhausted: true, resetTime }
      };
      const agyData = {
        context_window: { total_input_tokens: 1000, total_output_tokens: 200, used_percentage: 5 }
      };
      const quotaData = [
        { id: 'gemini-3.1-flash-image', displayName: 'Gemini 3.1 Flash Image', remainingFraction: 0.0 }
      ];

      const output = renderHUD(state, agyData, { display: { unicode: true, useNerdFonts: false } }, quotaData);
      assert.match(output, /Image Quota Exhausted/);
      assert.match(output, /03h14m/);
    });

    test('image model is NOT rendered as a table row', () => {
      const state = { steps: 5, branch: 'dev' };
      const agyData = {
        context_window: { total_input_tokens: 1000, total_output_tokens: 200, used_percentage: 5 }
      };
      const quotaData = [
        { id: 'gemini-3.5-flash-low', displayName: 'Gemini 3.5 Flash (Low)', remainingFraction: 0.8, resetTime: new Date(Date.now() + 3600000).toISOString() },
        { id: 'gemini-3.1-flash-image', displayName: 'Gemini 3.1 Flash Image', remainingFraction: 0.9 }
      ];

      const output = renderHUD(state, agyData, { display: { unicode: true, useNerdFonts: false, quotaStyle: 'table' } }, quotaData);
      // Image model must NOT appear as a separate table column row
      assert.doesNotMatch(output, /Gemini 3\.1 Flash I/);
    });
  });
});
