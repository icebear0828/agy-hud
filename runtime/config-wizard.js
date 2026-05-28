'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { loadConfig, saveConfig, getLocalConfigPath, getGlobalConfigPath } = require('./config.js');
const { renderHUD } = require('./renderer.js');

// Mock data to render the live HUD preview
const mockState = {
  branch: 'main',
  steps: 12,
  breadcrumbs: ['index.js', 'auth.js', 'database.js'],
  rulesCount: 4,
  mcpCount: 2,
  hooksCount: 3,
  usage: {
    current_usage: {
      input_tokens: 4800,
      cache_read_input_tokens: 65100
    }
  }
};

const mockAgyData = {
  plan_tier: 'Pro',
  task_count: 5,
  model: {
    display_name: 'Gemini 3.5 Flash (Low)',
    id: 'gemini-3.5-flash-low'
  },
  context_window: {
    total_input_tokens: 69900,
    total_output_tokens: 13900,
    used_percentage: 8,
    context_window_size: 1000000
  }
};

const _wizardNow = Date.now();
const _wizardFiveHourReset = new Date(_wizardNow + 4 * 60 * 60 * 1000).toISOString();
const _wizardWeeklyReset = new Date(_wizardNow + 5 * 24 * 60 * 60 * 1000).toISOString();
const mockQuotaData = [
  {
    id: 'gemini-3.5-flash-low', displayName: 'Gemini 3.5 Flash (Low)',
    remainingFraction: 0.92, resetTime: _wizardFiveHourReset,
    modelProvider: 'MODEL_PROVIDER_GOOGLE',
    windows: {
      fiveHour: { remainingFraction: 0.92, resetTime: _wizardFiveHourReset, observedAt: _wizardNow },
      weekly:   { remainingFraction: 0.55, resetTime: _wizardWeeklyReset, observedAt: _wizardNow },
    },
  },
  {
    id: 'claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6',
    remainingFraction: 0.4, resetTime: _wizardWeeklyReset,
    modelProvider: 'MODEL_PROVIDER_ANTHROPIC',
    windows: {
      fiveHour: { remainingFraction: 0.7, resetTime: _wizardFiveHourReset, observedAt: _wizardNow },
      weekly:   { remainingFraction: 0.4, resetTime: _wizardWeeklyReset, observedAt: _wizardNow },
    },
  },
  {
    id: 'gpt-oss-120b-medium', displayName: 'GPT-OSS 120B',
    remainingFraction: 0.75, resetTime: null,
    modelProvider: 'MODEL_PROVIDER_OPENAI',
    windows: {},
  },
];

const THEME_PRESETS = {
  'Emerald Green': { primary: 'green', secondary: 'gray', warning: 'yellow', critical: 'red' },
  'Ocean Blue': { primary: 'blue', secondary: 'gray', warning: 'yellow', critical: 'red' },
  'Cyberpunk Magenta': { primary: 'magenta', secondary: 'gray', warning: 'yellow', critical: 'red' },
  'Amber Gold': { primary: 'yellow', secondary: 'gray', warning: 'cyan', critical: 'red' }
};

async function startWizard() {
  const currentConfig = await loadConfig();

  // Clone current config safely
  const config = JSON.parse(JSON.stringify(currentConfig));

  // Pre-fill display if not exist
  config.display = config.display || {};
  config.theme = config.theme || { primary: 'green', secondary: 'gray', warning: 'yellow', critical: 'red' };

  // Detect active theme preset
  let initialThemeName = 'Custom';
  for (const [name, colors] of Object.entries(THEME_PRESETS)) {
    if (config.theme.primary === colors.primary &&
        config.theme.secondary === colors.secondary &&
        config.theme.warning === colors.warning &&
        config.theme.critical === colors.critical) {
      initialThemeName = name;
      break;
    }
  }

  // Save original theme so cycling back to Custom restores it
  const originalTheme = { ...config.theme };

  // State of the interactive menu
  const localExists = fs.existsSync(getLocalConfigPath());
  let targetIsGlobal = !localExists;
  let themeName = initialThemeName;

  // Menu items definition
  const menuItems = [
    {
      key: 'scope',
      label: 'Configuration Scope',
      getValue: () => targetIsGlobal ? 'Global (All Projects)' : 'Local (Current Project Workspace)',
      toggle: () => { targetIsGlobal = !targetIsGlobal; }
    },
    {
      key: 'theme',
      label: 'Theme Preset',
      getValue: () => themeName,
      toggle: () => {
        const keys = Object.keys(THEME_PRESETS).concat(['Custom']);
        const idx = keys.indexOf(themeName);
        themeName = keys[(idx + 1) % keys.length];
        if (themeName === 'Custom') {
          config.theme = { ...originalTheme };
        } else {
          config.theme = { ...THEME_PRESETS[themeName] };
        }
      }
    },
    {
      key: 'quotaStyle',
      label: 'Quota Display Mode',
      getValue: () => (config.display.quotaStyle || 'table') === 'compact' ? 'Compact' : 'Table',
      toggle: () => {
        config.display.quotaStyle = (config.display.quotaStyle || 'table') === 'compact' ? 'table' : 'compact';
      }
    },
    {
      key: 'iconSet',
      label: 'Icon & Font Set',
      getValue: () => {
        if (config.display.useNerdFonts) return 'Nerd Fonts';
        if (config.display.unicode !== false) return 'Unicode Emoji';
        return 'Plain ASCII';
      },
      toggle: () => {
        if (config.display.useNerdFonts) {
          // Nerd Fonts -> Unicode Emoji
          config.display.useNerdFonts = false;
          config.display.unicode = true;
        } else if (config.display.unicode !== false) {
          // Unicode Emoji -> Plain ASCII
          config.display.useNerdFonts = false;
          config.display.unicode = false;
        } else {
          // Plain ASCII -> Nerd Fonts
          config.display.useNerdFonts = true;
          config.display.unicode = true;
        }
      }
    },
    {
      key: 'showGit',
      label: 'Show Git Branch',
      getValue: () => (config.display.showGitBranch !== false ? 'Enabled' : 'Disabled'),
      toggle: () => {
        config.display.showGitBranch = config.display.showGitBranch !== false ? false : true;
      }
    },
    // Note: showCurrentDir defaults ON (absent key = enabled), so we check `!== false`.
    //       showUsername defaults OFF (absent key = disabled), so we check `=== true`.
    //       The toggle patterns intentionally differ to match each field's default.
    {
      key: 'showCurrentDir',
      label: 'Show Current Directory',
      getValue: () => (config.display.showCurrentDir !== false ? 'Enabled' : 'Disabled'),
      toggle: () => {
        config.display.showCurrentDir = config.display.showCurrentDir !== false ? false : true;
      }
    },
    {
      key: 'showUsername',
      label: 'Show Username',
      getValue: () => (config.display.showUsername === true ? 'Enabled' : 'Disabled'),
      toggle: () => {
        config.display.showUsername = config.display.showUsername === true ? false : true;
      }
    },
    {
      key: 'showTokens',
      label: 'Show Token Bar',
      getValue: () => (config.display.showTokenBar !== false ? 'Enabled' : 'Disabled'),
      toggle: () => {
        config.display.showTokenBar = config.display.showTokenBar !== false ? false : true;
      }
    },
    {
      key: 'showBreadcrumbs',
      label: 'Show Breadcrumbs',
      getValue: () => (config.display.showBreadcrumbs !== false ? 'Enabled' : 'Disabled'),
      toggle: () => {
        config.display.showBreadcrumbs = config.display.showBreadcrumbs !== false ? false : true;
      }
    },
    {
      key: 'breadcrumbCount',
      label: 'Breadcrumb Limit',
      getValue: () => (config.display.breadcrumbCount !== undefined ? config.display.breadcrumbCount : 3),
      toggle: () => {
        const val = config.display.breadcrumbCount !== undefined ? config.display.breadcrumbCount : 3;
        config.display.breadcrumbCount = (val % 5) + 1; // rotates 1, 2, 3, 4, 5
      }
    },
    {
      key: 'save',
      label: 'Save & Exit',
      getValue: () => '',
      toggle: async () => {
        await saveConfig(config, targetIsGlobal);
        cleanup();
        console.log(`\n\x1b[32m✔ Configuration saved successfully to ${targetIsGlobal ? getGlobalConfigPath() : getLocalConfigPath()}\x1b[0m\n`);
        process.exit(0);
      }
    },
    {
      key: 'cancel',
      label: 'Cancel & Exit',
      getValue: () => '',
      toggle: () => {
        cleanup();
        console.log('\n\x1b[90mConfiguration canceled.\x1b[0m\n');
        process.exit(0);
      }
    }
  ];

  let selectedIdx = 0;

  // Setup raw mode for keypress capture
  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }

  function cleanup() {
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    process.stdin.pause();
  }

  function renderMenu() {
    // Clear screen and reset cursor to home (0,0)
    readline.cursorTo(process.stdout, 0, 0);
    readline.clearScreenDown(process.stdout);

    console.log('\x1b[1m\x1b[35m=== agy-hud Configuration Wizard ===\x1b[0m\n');
    console.log('Use \x1b[1m↑/↓\x1b[0m or \x1b[1m数字键\x1b[0m to navigate, \x1b[1mSpace/Enter\x1b[0m to change settings.\n');

    for (let i = 0; i < menuItems.length; i++) {
      const item = menuItems[i];
      const isSelected = i === selectedIdx;
      const marker = isSelected ? '\x1b[32m▸ \x1b[0m' : '  ';
      const labelStr = isSelected ? `\x1b[1m${item.label}\x1b[0m` : item.label;
      const valStr = item.getValue() ? `: \x1b[36m${item.getValue()}\x1b[0m` : '';

      let actionMarker = '';
      if (item.key === 'save') {
        actionMarker = isSelected ? '\x1b[32m[ Save ]\x1b[0m' : '[ Save ]';
        console.log(`${marker}${actionMarker}`);
      } else if (item.key === 'cancel') {
        actionMarker = isSelected ? '\x1b[31m[ Cancel ]\x1b[0m' : '[ Cancel ]';
        console.log(`${marker}${actionMarker}`);
      } else {
        console.log(`${marker}${labelStr}${valStr}`);
      }
    }

    console.log('\n\x1b[90m─────────────────────────────────────────────────────────────────────────────────\x1b[0m');
    console.log('\x1b[1mHUD PREVIEW:\x1b[0m');

    // Live render HUD preview
    try {
      const hudPreview = renderHUD(mockState, mockAgyData, config, mockQuotaData, 'Pro');
      console.log(hudPreview);
    } catch (err) {
      console.log(`\x1b[31mFailed to render preview: ${err.message}\x1b[0m`);
    }
    console.log('\x1b[90m─────────────────────────────────────────────────────────────────────────────────\x1b[0m');
  }

  // Initial render
  renderMenu();

  process.stdin.on('keypress', async (str, key) => {
    if (key.ctrl && key.name === 'c') {
      cleanup();
      process.exit(1);
    }

    if (key.name === 'up') {
      selectedIdx = (selectedIdx - 1 + menuItems.length) % menuItems.length;
      renderMenu();
    } else if (key.name === 'down') {
      selectedIdx = (selectedIdx + 1) % menuItems.length;
      renderMenu();
    } else if (key.name === 'space' || key.name === 'return' || key.name === 'enter') {
      try {
        await menuItems[selectedIdx].toggle();
      } catch (err) {
        cleanup();
        console.error(`\n\x1b[31mError: ${err.message}\x1b[0m\n`);
        process.exit(1);
      }
      renderMenu();
    } else if (/[0-9]/.test(str)) {
      const num = parseInt(str, 10);
      const targetIdx = num === 0 ? 9 : num - 1;
      if (targetIdx < menuItems.length) {
        selectedIdx = targetIdx;
        renderMenu();
      }
    }
  });
}

module.exports = { startWizard };
