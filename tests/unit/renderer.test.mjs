import { test } from 'node:test';
import assert from 'node:assert';
import { renderHUD, abbreviateDisplayName, compactModelName } from '../../runtime/renderer.js';

test('renderHUD should contain branch', () => {
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

test('renderHUD should correctly render Memory files, rules, MCPs, and hooks count', () => {
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

test('renderHUD hides zero-count metadata items', () => {
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

test('renderHUD omits metadata line when all counts are zero', () => {
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
  // Only 2 lines (identity + resources), no metadata line
  assert.equal(lines.length, 2);
});

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
  // Compact format: total ↑in ↓out ⟳cache
  assert.match(output, /Tokens 551\.4k .*?\(.*?in: 1\.9k, out: 358\.4k, cache: 191k.*?\)/);
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
  assert.match(output, /Tokens 138\.4M .*?\(.*?in: 6k, out: 202k, cache: 138\.2M.*?\)/);
});

test('renderHUD hides cache when zero', () => {
  const state = { steps: 0, branch: 'main' };
  const agyData = {
    context_window: { total_input_tokens: 1000, total_output_tokens: 200, used_percentage: 5, context_window_size: 1000000 }
  };
  const output = renderHUD(state, agyData, { display: { useNerdFonts: false, unicode: true } });
  assert.match(output, /Tokens 1\.2k .*?\(.*?in: 1k, out: 200.*?\)/);
  assert.doesNotMatch(output, /⟳/);
});

test('renderHUD formatTokens correctly rounds boundary values to M/k without 1000k spikes', () => {
  const output1 = renderHUD(
    { steps: 1, branch: 'main' },
    {
      context_window: { total_input_tokens: 999950, total_output_tokens: 50, used_percentage: 0 }
    },
    { display: { useNerdFonts: false, unicode: true } }
  );
  assert.match(output1, /Tokens 1M /);

  const output2 = renderHUD(
    { steps: 1, branch: 'main' },
    {
      context_window: { total_input_tokens: 999900, total_output_tokens: 0, used_percentage: 0 }
    },
    { display: { useNerdFonts: false, unicode: true } }
  );
  assert.match(output2, /in: 999\.9k/);
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
  assert.match(output, /Tokens 346\.7k .*?\(.*?in: 8k, out: 88\.7k, cache: 250k\*.*?\)/);
});


test('renderHUD preserves model name suffixes when applying display aliases', () => {
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

test('renderHUD should correctly layout quotas in two aligned columns', () => {
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

test('renderHUD should explain when quota is unavailable because auth is missing', () => {
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

test('renderHUD should explain quota fetch and auth failures', () => {
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

test('renderHUD localizes quota diagnostics when language is zh', () => {
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

test('renderHUD falls back to ASCII when config.display.unicode is false', () => {
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

test('renderHUD should render Nerd Font icons when enabled', () => {
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


test('renderHUD supports theme custom colors', () => {
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

test('renderHUD supports custom warning and critical thresholds', () => {
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

test('renderHUD supports custom columnWidth', () => {
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

test('renderHUD respects display visibility toggles', () => {
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

test('renderHUD should correctly render current directory', () => {
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
  assert.match(output1, /my-project-dir.*[|│].*\[B\] main/);

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

test('renderHUD sanitizes current directory before terminal output', () => {
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

test('renderHUD displays username when showUsername is true', () => {
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

test('renderHUD respects custom config username over state username', () => {
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

test('renderHUD sanitizes username before terminal output', () => {
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

test('renderHUD sanitizes username with terminated OSC sequence correctly without losing subsequent text', () => {
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


test('renderHUD limits breadcrumb metadata by breadcrumbCount', () => {
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

test('abbreviateDisplayName handles all known agent model patterns', () => {
  assert.equal(abbreviateDisplayName('Gemini 3.5 Flash (High)'), 'Gemini 3.5 Flash(H)');
  assert.equal(abbreviateDisplayName('Gemini 3.5 Flash (Medium)'), 'Gemini 3.5 Flash(M)');
  assert.equal(abbreviateDisplayName('Gemini 3.5 Flash (Low)'), 'Gemini 3.5 Flash(L)');
  assert.equal(abbreviateDisplayName('Gemini 3.1 Pro (High)'), 'Gemini 3.1 Pro(H)');
  assert.equal(abbreviateDisplayName('Gemini 3.1 Pro (Low)'), 'Gemini 3.1 Pro(L)');
  assert.equal(abbreviateDisplayName('Claude Sonnet 4.6 (Thinking)'), 'Sonnet 4.6(Th)');
  assert.equal(abbreviateDisplayName('Claude Opus 4.6 (Thinking)'), 'Opus 4.6(Th)');
  assert.equal(abbreviateDisplayName('GPT-OSS 120B (Medium)'), 'GPT-OSS 120B');
});

test('abbreviateDisplayName passes through unknown names unchanged', () => {
  assert.equal(abbreviateDisplayName('Some Future Model 9.0'), 'Some Future Model 9.0');
  assert.equal(abbreviateDisplayName(''), '');
});

test('abbreviateDisplayName handles hypothetical future models', () => {
  assert.equal(abbreviateDisplayName('Gemini 4.0 Flash (High)'), 'Gemini 4.0 Flash(H)');
  assert.equal(abbreviateDisplayName('Claude Haiku 5.0 (Thinking)'), 'Haiku 5.0(Th)');
  assert.equal(abbreviateDisplayName('GPT-OSS 200B (Low)'), 'GPT-OSS 200B');
});

test('compactModelName produces ultra-short names for provider summary', () => {
  assert.equal(compactModelName('Gemini 3.5 Flash (High)'), 'Flash(H)');
  assert.equal(compactModelName('Gemini 3.5 Flash (Medium)'), 'Flash(M)');
  assert.equal(compactModelName('Gemini 3.1 Pro (Low)'), 'Pro(L)');
  assert.equal(compactModelName('Claude Sonnet 4.6 (Thinking)'), 'Sonnet');
  assert.equal(compactModelName('Claude Opus 4.6 (Thinking)'), 'Opus');
  assert.equal(compactModelName('GPT-OSS 120B (Medium)'), 'GPT');
});

test('renderHUD compact mode appends current model quota to line 2', () => {
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

  assert.match(output, /Quota: 20%/);
  assert.match(output, /Anthropic:/);
  assert.match(output, /Google:/);
  assert.doesNotMatch(output, /─{10}/);
});

test('renderHUD compact mode matches current model despite display suffix drift', () => {
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

test('renderHUD compact mode renders provider-grouped mini bars', () => {
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

test('renderHUD table mode is unchanged with quotaStyle unset', () => {
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

test('renderHUD shows loading state when quotaData is empty array without reason', () => {
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

test('renderHUD does not show loading when quotaData is null or undefined', () => {
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

test('renderHUD uses warning/critical colors for both percent text and progress bar in table mode', () => {
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
  
  // Assert red color code \x1b[31m prefix on progress bar
  assert.match(output, /\x1b\[31m\[/);
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
  // Total tokens: in (99.2k - 92.3k = 6.9k) + out (15.9k) + cache (92.3k) = 115.1k ~ 115k
  assert.match(output, /Tokens 115\.1k/);
  assert.match(output, /in: 6\.9k/);
  assert.match(output, /out: 15\.9k/);
  assert.match(output, /cache: 92\.3k/);
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
  // Total tokens: in (99.2k - 92.3k = 6.9k) + out (15.9k) + cache (92.3k) = 115.1k ~ 115k
  assert.match(output, /Tokens 115\.1k/);
  assert.match(output, /in: 6\.9k/);
  assert.match(output, /out: 15\.9k/);
  assert.match(output, /cache: 92\.3k/);
});

test('renderHUD should correctly render update notices', () => {
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

