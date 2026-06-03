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
    // Layer 1: branch, model, plan (no AGY-HUD brand, no labels)
    assert.match(output, /⎇ main/);
    assert.match(output, /Gemini 3\.5 Flash\(H\)/);
    assert.match(output, /Google AI Pro/);
    // Layer 2: compact tokens, context bar with %
    assert.match(output, /Tokens 20k .*?\(.*?in: 15k, out: 5k.*?\)/);
    assert.match(output, /13%/);
    assert.match(output, /│/); // Unicode divider
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

    assert.match(output, /Gemini 3\.5 Flash\(H\) Preview/);

    const outputLow = renderHUD(
      { steps: 1, branch: 'main' },
      {
        context_window: { total_input_tokens: 0, total_output_tokens: 0, used_percentage: 0 },
        model: { display_name: 'Gemini 3.5 Flash (Low)' }
      },
      { display: { useNerdFonts: false, unicode: false } }
    );

    assert.match(outputLow, /Gemini 3\.5 Flash\(L\)/);
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
    assert.match(outputUnicode, /⟳ v1\.2\.3/);

    const outputAscii = renderHUD(state, agyData, { display: { useNerdFonts: false, unicode: false } }, [], 'tier', updateInfo);
    assert.match(outputAscii, /\[UP\] v1\.2\.3/);
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
    assert.match(output, /1 MEMORY.md/);
    assert.match(output, /4 rules/);
    assert.match(output, /1 MCPs/);
    assert.match(output, /5 hooks/);
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
    assert.match(output, /1 GEMINI.md/);
    assert.match(output, /2 hooks/);
    assert.doesNotMatch(output, /0 rules/);
    assert.doesNotMatch(output, /0 MCPs/);
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
    // 4 lines now due to top/bottom borders wrapping 2 data lines (identity + resources)
    assert.equal(lines.length, 4);
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

    const output = renderHUD(state, agyData, {
      display: {
        breadcrumbCount: 2,
        unicode: false
      }
    });

    assert.doesNotMatch(output, /README\.md/);
    assert.match(output, /runtime\/renderer\.js/);
    assert.match(output, /tests\/unit\/renderer\.test\.mjs/);
  });
});

describe('renderer / theme & icons', () => {
  test('falls back to ASCII when config.display.unicode is false', () => {
    const state = { steps: 1, branch: 'main' };
    const agyData = {
      context_window: { total_input_tokens: 1000, total_output_tokens: 200, used_percentage: 5, context_window_size: 1000000 },
      plan_tier: 'Free',
      task_count: 0,
      model: { display_name: 'GPT-OSS 120B (Medium)' }
    };

    const output = renderHUD(state, agyData, { display: { useNerdFonts: false, unicode: false } });

    // Box-drawing characters should NOT appear
    assert.doesNotMatch(output, /│/);
    assert.doesNotMatch(output, /█/);
    assert.doesNotMatch(output, /░/);
    // Ascii substitutes should appear
    assert.match(output, /\|/);
    assert.match(output, /#/);
    // Plain-text icons
    assert.match(output, /\[B\]/);
    assert.match(output, /Tokens/);
    // ASCII labels
    assert.match(output, /in: 1k/);
    assert.match(output, /out: 200/);
  });

  test('renders Nerd Font icons when enabled', () => {
    const state = { steps: 0, branch: 'main' };
    const agyData = {
      context_window: { total_input_tokens: 0, total_output_tokens: 0, used_percentage: 0 }
    };
    const output = renderHUD(state, agyData, { display: { useNerdFonts: true } });
    assert.doesNotMatch(output, /AGY-HUD/);
    assert.match(output, /main/);
    assert.match(output, /0%/);
    assert.doesNotMatch(output, /\[B\]/);
    assert.doesNotMatch(output, /\[Tk\]/);
    assert.doesNotMatch(output, /⎇/);
    assert.doesNotMatch(output, /⚿/);
  });

  test('supports theme custom colors', () => {
    const state = { steps: 5, branch: 'dev' };
    const agyData = {
      context_window: { total_input_tokens: 1000, total_output_tokens: 200, used_percentage: 95 }
    };
    const config = {
      display: {
        unicode: true
      },
      theme: {
        critical: 'blue'
      }
    };
    const output = renderHUD(state, agyData, config);
    assert.match(output, /\x1b\[34m\[█+/);
  });

  test('supports custom warning and critical thresholds', () => {
    const state = { steps: 5, branch: 'dev' };
    const agyData = {
      context_window: { total_input_tokens: 1000, total_output_tokens: 200, used_percentage: 30 }
    };
    const config = {
      display: {
        unicode: true
      },
      thresholds: {
        warning: 0.2,
        critical: 0.4
      }
    };
    const output = renderHUD(state, agyData, config);
    assert.match(output, /\x1b\[33m\[█+/);
  });
});

describe('renderer / display visibility toggles', () => {
  test('respects display visibility toggles', () => {
    const state = {
      steps: 5,
      branch: 'main',
      memoryFile: 'GEMINI.md',
      rulesCount: 2,
      hooksCount: 1
    };
    const agyData = {
      context_window: { total_input_tokens: 1000, total_output_tokens: 200, used_percentage: 5 },
      model: { display_name: 'Gemini 3.5 Flash (High)' }
    };

    const output = renderHUD(state, agyData, {
      display: {
        showGitBranch: false,
        showTokenBar: false,
        showBreadcrumbs: false,
        unicode: false
      }
    });

    assert.doesNotMatch(output, /\[B\] main/);
    assert.doesNotMatch(output, /\[Tk\]/);
    assert.doesNotMatch(output, /GEMINI\.md/);
    assert.match(output, /Gemini 3\.5 Flash\(H\)/);
    assert.match(output, /\[C\] 1k\/0/);
    assert.match(output, /2 rules/);
    assert.match(output, /1 hooks/);
  });
});

describe('renderer / current directory', () => {
  test('renders current directory', () => {
    const state = {
      steps: 1,
      branch: 'main',
      currentDir: 'my-project-dir',
    };
    const agyData = {
      context_window: { total_input_tokens: 0, total_output_tokens: 0, used_percentage: 0 }
    };

    // Test with showCurrentDir = true
    const output1 = renderHUD(state, agyData, {
      display: {
        showCurrentDir: true,
        showGitBranch: true,
        unicode: false
      }
    });
    assert.match(output1, /my-project-dir/);
    assert.match(output1, /my-project-dir.*\[B\] main.*[|│]/);

    // Test with showCurrentDir = false
    const output2 = renderHUD(state, agyData, {
      display: {
        showCurrentDir: false,
        showGitBranch: true,
        unicode: false
      }
    });
    assert.doesNotMatch(output2, /my-project-dir/);
  });

  test('sanitizes current directory before terminal output', () => {
    const state = {
      steps: 1,
      branch: 'main',
      currentDir: 'repo\x1b]52;c;SGVsbG8=\x07\x1b[5mblink',
    };
    const agyData = {
      context_window: { total_input_tokens: 0, total_output_tokens: 0, used_percentage: 0 }
    };

    const output = renderHUD(state, agyData, {
      display: {
        showCurrentDir: true,
        unicode: false
      }
    });

    assert.match(output, /repo/);
    assert.doesNotMatch(output, /\x1b\]52/);
    assert.doesNotMatch(output, /\x07/);
    assert.doesNotMatch(output, /\x1b\[5m/);
  });
});

describe('renderer / username', () => {
  test('displays username when showUsername is true', () => {
    const state = {
      steps: 1,
      branch: 'main',
      username: 'shetterelland@gmail.com',
    };
    const agyData = {
      context_window: { total_input_tokens: 0, total_output_tokens: 0, used_percentage: 0 }
    };

    // Test with showUsername = true
    const output1 = renderHUD(state, agyData, {
      display: {
        showUsername: true,
        unicode: false
      }
    });
    assert.match(output1, /shetterelland@gmail\.com/);

    // Test with showUsername = false (default behavior)
    const output2 = renderHUD(state, agyData, {
      display: {
        showUsername: false,
        unicode: false
      }
    });
    assert.doesNotMatch(output2, /shetterelland@gmail\.com/);
  });

  test('respects custom config username over state username', () => {
    const state = {
      steps: 1,
      branch: 'main',
      username: 'shetterelland@gmail.com',
    };
    const agyData = {
      context_window: { total_input_tokens: 0, total_output_tokens: 0, used_percentage: 0 }
    };

    const output = renderHUD(state, agyData, {
      display: {
        showUsername: true,
        username: 'custom-user',
        unicode: false
      }
    });
    assert.match(output, /custom-user/);
    assert.doesNotMatch(output, /shetterelland@gmail\.com/);
  });

  test('sanitizes username before terminal output', () => {
    const state = {
      steps: 1,
      branch: 'main',
      username: 'user\x1b]52;c;SGVsbG8=\x07\x1b[5mblink',
    };
    const agyData = {
      context_window: { total_input_tokens: 0, total_output_tokens: 0, used_percentage: 0 }
    };

    const output = renderHUD(state, agyData, {
      display: {
        showUsername: true,
        unicode: false
      }
    });

    assert.match(output, /user/);
    assert.doesNotMatch(output, /\x1b\]52/);
    assert.doesNotMatch(output, /\x07/);
    assert.doesNotMatch(output, /\x1b\[5m/);
  });

  test('sanitizes username with terminated OSC sequence correctly without losing subsequent text', () => {
    const state = {
      steps: 1,
      branch: 'main',
      username: 'user\x1b]52;c;SGVsbG8=\x1b\\safe-suffix',
    };
    const agyData = {
      context_window: { total_input_tokens: 0, total_output_tokens: 0, used_percentage: 0 }
    };

    const output = renderHUD(state, agyData, {
      display: {
        showUsername: true,
        unicode: false
      }
    });

    assert.match(output, /user/);
    assert.match(output, /safe-suffix/);
    assert.doesNotMatch(output, /\x1b\]52/);
    assert.doesNotMatch(output, /\x1b\\/);
  });
});
