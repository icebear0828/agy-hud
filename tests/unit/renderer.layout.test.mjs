import { describe, test } from 'node:test';
import assert from 'node:assert';
import { renderHUD } from '../../runtime/renderer.js';

describe('renderer / line composition', () => {
  test('should contain branch', () => {
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
    assert.match(output, /branch/i);
    assert.match(output, /main/i);
    assert.match(output, /model/i);
    assert.match(output, /Gemini 3\.5 Flash/i);
    assert.match(output, /tier/i);
    assert.match(output, /Google AI Pro/i);
    assert.match(output, /tokens/i);
    assert.match(output, /20k/i);
    assert.match(output, /ctx/i);
    assert.match(output, /15k\/1M/i);
  });

  test('preserves model name suffixes when applying display aliases', () => {
    const output = renderHUD(
      { steps: 1, branch: 'main' },
      {
        context_window: { total_input_tokens: 0, total_output_tokens: 0, used_percentage: 0 },
        model: { display_name: 'Gemini 3.5 Flash (High) Preview' }
      },
      { display: { useNerdFonts: false, unicode: false } }
    );

    assert.match(output, /model/i);
    assert.match(output, /Gemini 3\.5 Flash/i);
    assert.match(output, /Preview/i);

    const outputLow = renderHUD(
      { steps: 1, branch: 'main' },
      {
        context_window: { total_input_tokens: 0, total_output_tokens: 0, used_percentage: 0 },
        model: { display_name: 'Gemini 3.5 Flash (Low)' }
      },
      { display: { useNerdFonts: false, unicode: false } }
    );

    assert.match(outputLow, /model/i);
    assert.match(outputLow, /Gemini 3\.5 Flash/i);
  });

  test('should correctly render update notices', () => {
    const state = { steps: 1, branch: 'main' };
    const agyData = {
      context_window: { total_input_tokens: 0, total_output_tokens: 0, used_percentage: 0 }
    };
    const updateInfo = {
      updateAvailable: true,
      latestVersion: '1.2.3'
    };

    const outputUnicode = renderHUD(state, agyData, { display: { useNerdFonts: false, unicode: true } }, [], 'tier', updateInfo);
    assert.match(outputUnicode, /update/i);
    assert.match(outputUnicode, /v1\.2\.3/i);

    const outputAscii = renderHUD(state, agyData, { display: { useNerdFonts: false, unicode: false } }, [], 'tier', updateInfo);
    assert.match(outputAscii, /update/i);
    assert.match(outputAscii, /v1\.2\.3/i);
  });
});

describe('renderer / metadata line', () => {
  test('renders Memory files, rules, MCPs, and hooks count', () => {
    const state = {
      steps: 1,
      branch: 'main',
      memoryFile: 'MEMORY.md',
      rulesCount: 4,
      mcpCount: 1,
      hooksCount: 5
    };
    const agyData = {
      context_window: { total_input_tokens: 0, total_output_tokens: 0, used_percentage: 0 }
    };
    const output = renderHUD(state, agyData, { display: { useNerdFonts: false, unicode: true } });
    assert.match(output, /memory/i);
    assert.match(output, /MEMORY.md/i);
    assert.match(output, /rules/i);
    assert.match(output, /4/i);
    assert.match(output, /mcps/i);
    assert.match(output, /1/i);
    assert.match(output, /hooks/i);
    assert.match(output, /5/i);
  });

  test('hides zero-count metadata items', () => {
    const state = {
      steps: 1,
      branch: 'main',
      memoryFile: 'GEMINI.md',
      rulesCount: 0,
      mcpCount: 0,
      hooksCount: 2
    };
    const agyData = {
      context_window: { total_input_tokens: 0, total_output_tokens: 0, used_percentage: 0 }
    };
    const output = renderHUD(state, agyData, { display: { useNerdFonts: false, unicode: true } });
    assert.match(output, /memory/i);
    assert.match(output, /GEMINI.md/i);
    assert.match(output, /hooks/i);
    assert.match(output, /2/i);
    assert.doesNotMatch(output, /rules/i);
    assert.doesNotMatch(output, /mcps/i);
  });

  test('omits metadata line when all counts are zero', () => {
    const state = {
      steps: 0,
      branch: 'main',
      rulesCount: 0,
      mcpCount: 0,
      hooksCount: 0
    };
    const agyData = {
      context_window: { total_input_tokens: 0, total_output_tokens: 0, used_percentage: 0 }
    };
    const output = renderHUD(state, agyData, { display: { useNerdFonts: false, unicode: true } });
    const lines = output.trim().split('\n');
    assert.equal(lines.length, 2);
  });

  test('limits breadcrumb metadata by breadcrumbCount', () => {
    const state = {
      steps: 1,
      branch: 'main',
      breadcrumbs: ['README.md', 'runtime/renderer.js', 'tests/unit/renderer.test.mjs'],
    };
    const agyData = {
      context_window: { total_input_tokens: 0, total_output_tokens: 0, used_percentage: 0 }
    };
    const output = renderHUD(state, agyData, { display: { useNerdFonts: false, unicode: true, breadcrumbCount: 2 } });
    assert.match(output, /runtime\/renderer.js/);
    assert.match(output, /tests\/unit\/renderer.test.mjs/);
    assert.doesNotMatch(output, /README.md/);
  });
});
