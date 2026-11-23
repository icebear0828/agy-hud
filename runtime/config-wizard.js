'use strict';

const fs = require('fs');
const readline = require('readline');
const { loadConfig, saveConfig, getLocalConfigPath, getGlobalConfigPath } = require('./config.js');
const { renderHUD } = require('./renderer.js');
const { supportsUnicode } = require('./encoding.js');

const DEFAULT_THEME = { primary: 'green', secondary: 'gray', warning: 'yellow', critical: 'red' };

const THEME_PRESETS = {
  'Emerald Green': { primary: 'green', secondary: 'gray', warning: 'yellow', critical: 'red' },
  'Ocean Blue': { primary: 'blue', secondary: 'gray', warning: 'yellow', critical: 'red' },
  'Cyberpunk Magenta': { primary: 'magenta', secondary: 'gray', warning: 'yellow', critical: 'red' },
  'Amber Gold': { primary: 'yellow', secondary: 'gray', warning: 'cyan', critical: 'red' },
};

const QUOTA_STYLES = ['table', 'models', 'compact'];
const QUOTA_STYLE_LABELS = {
  table: 'Table',
  models: 'Models',
  compact: 'Compact',
};

const LANGUAGE_CYCLE = [undefined, 'en', 'zh'];
const LANGUAGE_LABELS = {
  auto: 'Auto (detect)',
  en: 'English (en)',
  zh: 'Chinese (zh)',
};

// Mock data to render the live HUD preview
const _wizardFiveHourEst = {
  status: 'ready',
  confidence: 'high',
  isPrior: false,
  remainingTokens: 420000,
  totalTokens: 600000,
  remainingFraction: 0.7,
  exhausted: false,
};

const _wizardWeeklyEst = {
  status: 'ready',
  confidence: 'high',
  isPrior: false,
  remainingTokens: 3400000,
  totalTokens: 4000000,
  remainingFraction: 0.85,
  exhausted: false,
};

const mockState = {
  branch: 'main',
  currentDir: 'my-project',
  username: 'dev@example.com',
  steps: 12,
  breadcrumbs: ['index.js', 'auth.js', 'database.js'],
  rulesCount: 4,
  mcpCount: 2,
  hooksCount: 3,
  outputSpeed: 43.4,
  costTotals: {
    todayUsd: 0.45,
    weekUsd: 1.82,
  },
  quotaCapacity: {
    bucket: 'google',
    modelName: 'Gemini 3.5 Flash',
    modelKey: 'flash',
    fiveHour: _wizardFiveHourEst,
    weekly: _wizardWeeklyEst,
    criticalWindow: 'fiveHour',
    critical: _wizardFiveHourEst,
  },
  usage: {
    current_usage: {
      input_tokens: 4800,
      cache_read_input_tokens: 65100,
    },
  },
};

const mockAgyData = {
  plan_tier: 'Pro',
  task_count: 5,
  model: {
    display_name: 'Gemini 3.5 Flash (Low)',
    id: 'gemini-3.5-flash-low',
  },
  cost: {
    total_cost_usd: 0.085,
    total_api_duration_ms: 3200,
  },
  context_window: {
    total_input_tokens: 69900,
    total_output_tokens: 13900,
    used_percentage: 8,
    context_window_size: 1000000,
  },
};

const _wizardNow = Date.now();
const _wizardFiveHourReset = new Date(_wizardNow + 4 * 60 * 60 * 1000).toISOString();
const _wizardWeeklyReset = new Date(_wizardNow + 5 * 24 * 60 * 60 * 1000).toISOString();
const mockQuotaData = [
  {
    id: 'gemini-3.5-flash-low',
    displayName: 'Gemini 3.5 Flash (Low)',
    remainingFraction: 0.92,
    resetTime: _wizardFiveHourReset,
    modelProvider: 'MODEL_PROVIDER_GOOGLE',
    windows: {
      fiveHour: { remainingFraction: 0.92, resetTime: _wizardFiveHourReset, observedAt: _wizardNow },
      weekly:   { remainingFraction: 0.55, resetTime: _wizardWeeklyReset, observedAt: _wizardNow },
    },
  },
  {
    id: 'claude-sonnet-4-6',
    displayName: 'Claude Sonnet 4.6',
    remainingFraction: 0.4,
    resetTime: _wizardWeeklyReset,
    modelProvider: 'MODEL_PROVIDER_ANTHROPIC',
    windows: {
      fiveHour: { remainingFraction: 0.7, resetTime: _wizardFiveHourReset, observedAt: _wizardNow },
      weekly:   { remainingFraction: 0.4, resetTime: _wizardWeeklyReset, observedAt: _wizardNow },
    },
  },
  {
    id: 'gpt-oss-120b-medium',
    displayName: 'GPT-OSS 120B',
    remainingFraction: 0.75,
    resetTime: null,
    modelProvider: 'MODEL_PROVIDER_OPENAI',
    windows: {},
  },
  {
    id: 'gemini-3.1-flash-image',
    displayName: 'Gemini 3.1 Flash Image',
    remainingFraction: 0.9,
    resetTime: _wizardFiveHourReset,
    modelProvider: 'MODEL_PROVIDER_GOOGLE',
    windows: {},
  },
];

function normalizeThemeObject(theme) {
  if (!theme || typeof theme !== 'object' || Array.isArray(theme)) {
    return { ...DEFAULT_THEME };
  }
  return {
    primary: theme.primary || DEFAULT_THEME.primary,
    secondary: theme.secondary || DEFAULT_THEME.secondary,
    warning: theme.warning || DEFAULT_THEME.warning,
    critical: theme.critical || DEFAULT_THEME.critical,
  };
}

function detectThemeName(themeObj) {
  for (const [name, colors] of Object.entries(THEME_PRESETS)) {
    if (
      themeObj.primary === colors.primary &&
      themeObj.secondary === colors.secondary &&
      themeObj.warning === colors.warning &&
      themeObj.critical === colors.critical
    ) {
      return name;
    }
  }
  return 'Custom';
}

function getIconSetMode(display) {
  if (display.useNerdFonts === true) return 'nerd';
  if (display.unicode === true) return 'unicode';
  if (display.unicode === false) return 'ascii';
  return 'auto';
}

function getIconSetLabel(display) {
  const mode = getIconSetMode(display);
  if (mode === 'nerd') return 'Nerd Fonts';
  if (mode === 'unicode') return 'Unicode Emoji';
  if (mode === 'ascii') return 'Plain ASCII';
  return 'Auto (detect)';
}

function cycleIconSet(display) {
  const mode = getIconSetMode(display);
  if (mode === 'auto') {
    display.useNerdFonts = true;
    display.unicode = true;
  } else if (mode === 'nerd') {
    display.useNerdFonts = false;
    display.unicode = true;
  } else if (mode === 'unicode') {
    display.useNerdFonts = false;
    display.unicode = false;
  } else {
    // Plain ASCII -> Auto (detect)
    display.useNerdFonts = false;
    delete display.unicode;
  }
}

/**
 * Create a mutable, pure wizard state object from an existing config.
 *
 * @param {Object} currentConfig
 * @param {Object} [options]
 * @param {boolean} [options.localExists]
 */
function createWizardState(currentConfig = {}, options = {}) {
  const config = JSON.parse(JSON.stringify(currentConfig || {}));
  config.display = (config.display && typeof config.display === 'object' && !Array.isArray(config.display))
    ? config.display
    : {};
  config.theme = normalizeThemeObject(config.theme);

  const originalTheme = { ...config.theme };
  const themeName = detectThemeName(config.theme);
  const localExists = options.localExists !== undefined
    ? Boolean(options.localExists)
    : fs.existsSync(getLocalConfigPath());

  return {
    config,
    originalTheme,
    themeName,
    targetIsGlobal: !localExists,
    selectedIdx: 0,
  };
}

/**
 * Build interactive menu items bound to a wizardState.
 *
 * @param {Object} wizardState
 * @param {Object} [callbacks]
 * @param {Function} [callbacks.onSave]
 * @param {Function} [callbacks.onCancel]
 * @returns {Array}
 */
function buildMenuItems(wizardState, callbacks = {}) {
  const { config } = wizardState;
  const onSave = callbacks.onSave || (() => 'save');
  const onCancel = callbacks.onCancel || (() => 'cancel');

  return [
    {
      key: 'scope',
      label: 'Configuration Scope',
      getValue: () => (wizardState.targetIsGlobal ? 'Global (All Projects)' : 'Local (Current Project Workspace)'),
      toggle: () => {
        wizardState.targetIsGlobal = !wizardState.targetIsGlobal;
      },
    },
    {
      key: 'language',
      label: 'Language',
      getValue: () => {
        if (config.language === 'en') return LANGUAGE_LABELS.en;
        if (config.language === 'zh') return LANGUAGE_LABELS.zh;
        return LANGUAGE_LABELS.auto;
      },
      toggle: () => {
        const curLang = (config.language === 'en' || config.language === 'zh') ? config.language : undefined;
        const idx = LANGUAGE_CYCLE.indexOf(curLang);
        const next = LANGUAGE_CYCLE[(idx + 1) % LANGUAGE_CYCLE.length];
        if (next === undefined) {
          delete config.language;
        } else {
          config.language = next;
        }
      },
    },
    {
      key: 'theme',
      label: 'Theme Preset',
      getValue: () => wizardState.themeName,
      toggle: () => {
        const keys = Object.keys(THEME_PRESETS).concat(['Custom']);
        const idx = keys.indexOf(wizardState.themeName);
        wizardState.themeName = keys[(idx + 1) % keys.length];
        if (wizardState.themeName === 'Custom') {
          config.theme = { ...wizardState.originalTheme };
        } else {
          config.theme = { ...THEME_PRESETS[wizardState.themeName] };
        }
      },
    },
    {
      key: 'quotaStyle',
      label: 'Quota Display Mode',
      getValue: () => {
        const style = QUOTA_STYLES.includes(config.display.quotaStyle) ? config.display.quotaStyle : 'table';
        return QUOTA_STYLE_LABELS[style];
      },
      toggle: () => {
        const cur = QUOTA_STYLES.includes(config.display.quotaStyle) ? config.display.quotaStyle : 'table';
        const idx = QUOTA_STYLES.indexOf(cur);
        config.display.quotaStyle = QUOTA_STYLES[(idx + 1) % QUOTA_STYLES.length];
      },
    },
    {
      key: 'iconSet',
      label: 'Icon & Font Set',
      getValue: () => getIconSetLabel(config.display),
      toggle: () => {
        cycleIconSet(config.display);
      },
    },
    {
      key: 'showQuotaCapacity',
      label: 'Show Quota Capacity',
      getValue: () => (config.display.showQuotaCapacity !== false ? 'Enabled' : 'Disabled'),
      toggle: () => {
        config.display.showQuotaCapacity = config.display.showQuotaCapacity !== false ? false : true;
      },
    },
    {
      key: 'showGit',
      label: 'Show Git Branch',
      getValue: () => (config.display.showGitBranch !== false ? 'Enabled' : 'Disabled'),
      toggle: () => {
        config.display.showGitBranch = config.display.showGitBranch !== false ? false : true;
      },
    },
    {
      key: 'showCurrentDir',
      label: 'Show Current Directory',
      getValue: () => (config.display.showCurrentDir !== false ? 'Enabled' : 'Disabled'),
      toggle: () => {
        config.display.showCurrentDir = config.display.showCurrentDir !== false ? false : true;
      },
    },
    {
      key: 'showUsername',
      label: 'Show Username',
      getValue: () => (config.display.showUsername === true ? 'Enabled' : 'Disabled'),
      toggle: () => {
        config.display.showUsername = config.display.showUsername === true ? false : true;
      },
    },
    {
      key: 'showTokens',
      label: 'Show Token Bar',
      getValue: () => (config.display.showTokenBar !== false ? 'Enabled' : 'Disabled'),
      toggle: () => {
        config.display.showTokenBar = config.display.showTokenBar !== false ? false : true;
      },
    },
    {
      key: 'showTurnCacheHitRate',
      label: 'Show Turn Cache Hit Rate',
      getValue: () => (config.display.showTurnCacheHitRate === true ? 'Enabled' : 'Disabled'),
      toggle: () => {
        config.display.showTurnCacheHitRate = config.display.showTurnCacheHitRate === true ? false : true;
      },
    },
    {
      key: 'showImageQuota',
      label: 'Show Image Quota',
      getValue: () => (config.display.showImageQuota === true ? 'Enabled' : 'Disabled'),
      toggle: () => {
        config.display.showImageQuota = config.display.showImageQuota === true ? false : true;
      },
    },
    {
      key: 'showBreadcrumbs',
      label: 'Show Breadcrumbs',
      getValue: () => (config.display.showBreadcrumbs !== false ? 'Enabled' : 'Disabled'),
      toggle: () => {
        config.display.showBreadcrumbs = config.display.showBreadcrumbs !== false ? false : true;
      },
    },
    {
      key: 'breadcrumbCount',
      label: 'Breadcrumb Limit',
      getValue: () => (config.display.breadcrumbCount !== undefined ? config.display.breadcrumbCount : 3),
      toggle: () => {
        const val = config.display.breadcrumbCount !== undefined ? config.display.breadcrumbCount : 3;
        config.display.breadcrumbCount = (val % 5) + 1;
      },
    },
    {
      key: 'showSpeed',
      label: 'Show Output Speed',
      getValue: () => (config.display.showSpeed === true ? 'Enabled' : 'Disabled'),
      toggle: () => {
        config.display.showSpeed = config.display.showSpeed === true ? false : true;
      },
    },
    {
      key: 'showCost',
      label: 'Show Session Cost',
      getValue: () => (config.display.showCost === true ? 'Enabled' : 'Disabled'),
      toggle: () => {
        config.display.showCost = config.display.showCost === true ? false : true;
      },
    },
    {
      key: 'showDailyCost',
      label: 'Show Daily Cost',
      getValue: () => (config.display.showDailyCost === true ? 'Enabled' : 'Disabled'),
      toggle: () => {
        config.display.showDailyCost = config.display.showDailyCost === true ? false : true;
      },
    },
    {
      key: 'showWeeklyCost',
      label: 'Show Weekly Cost',
      getValue: () => (config.display.showWeeklyCost === true ? 'Enabled' : 'Disabled'),
      toggle: () => {
        config.display.showWeeklyCost = config.display.showWeeklyCost === true ? false : true;
      },
    },
    {
      key: 'save',
      label: 'Save & Exit',
      getValue: () => '',
      toggle: onSave,
    },
    {
      key: 'cancel',
      label: 'Cancel & Exit',
      getValue: () => '',
      toggle: onCancel,
    },
  ];
}

/**
 * Pure key reducer for the configuration wizard.
 * Returns an action tag: 'noop' | 'render' | 'toggle' | 'cancel' | 'abort'.
 *
 * @param {Object} wizardState
 * @param {Array} menuItems
 * @param {string|undefined} str
 * @param {Object|undefined} key
 * @returns {'noop'|'render'|'toggle'|'cancel'|'abort'}
 */
function applyWizardKey(wizardState, menuItems, str, key) {
  if (!key) return 'noop';

  if (key.ctrl && key.name === 'c') {
    return 'abort';
  }

  if (key.name === 'escape' || key.name === 'q' || str === 'q' || str === 'Q') {
    return 'cancel';
  }

  if (key.name === 'up') {
    wizardState.selectedIdx = (wizardState.selectedIdx - 1 + menuItems.length) % menuItems.length;
    return 'render';
  }

  if (key.name === 'down') {
    wizardState.selectedIdx = (wizardState.selectedIdx + 1) % menuItems.length;
    return 'render';
  }

  if (key.name === 'space' || key.name === 'return' || key.name === 'enter') {
    return 'toggle';
  }

  if (typeof str === 'string' && /^[1-9]$/.test(str)) {
    const targetIdx = parseInt(str, 10) - 1;
    if (targetIdx < menuItems.length) {
      wizardState.selectedIdx = targetIdx;
      return 'render';
    }
  }

  return 'noop';
}

function resolveWizardUnicode(config) {
  if (process.env.AGY_HUD_FORCE_ASCII === '1') return false;
  if (process.env.AGY_HUD_FORCE_UNICODE === '1') return true;
  if (typeof config?.display?.unicode === 'boolean') return config.display.unicode;
  return supportsUnicode();
}

/**
 * Build the complete wizard screen string (menu + live HUD preview).
 *
 * @param {Object} wizardState
 * @param {Array} menuItems
 * @param {Object} [options]
 * @returns {string}
 */
function renderWizardScreen(wizardState, menuItems, options = {}) {
  const unicode = options.unicode !== undefined ? Boolean(options.unicode) : resolveWizardUnicode(wizardState.config);
  const hbar = unicode ? '─' : '-';
  const pointer = unicode ? '▸ ' : '> ';
  const arrows = unicode ? '↑/↓' : 'Up/Down';
  const rule = hbar.repeat(78);

  const lines = [];
  lines.push('\x1b[1m\x1b[35m=== agy-hud Configuration Wizard ===\x1b[0m');
  lines.push('');
  lines.push(`Use \x1b[1m${arrows}\x1b[0m or \x1b[1m1-9\x1b[0m to navigate, \x1b[1mSpace/Enter\x1b[0m to change, \x1b[1mq/Esc\x1b[0m to cancel.`);
  lines.push('');

  for (let i = 0; i < menuItems.length; i++) {
    const item = menuItems[i];
    const isSelected = i === wizardState.selectedIdx;
    const marker = isSelected ? `\x1b[32m${pointer}\x1b[0m` : '  ';
    const numPrefix = i < 9 ? `\x1b[90m${i + 1}.\x1b[0m ` : '   ';

    if (item.key === 'save') {
      const actionMarker = isSelected ? '\x1b[32m[ Save ]\x1b[0m' : '[ Save ]';
      lines.push(`${marker}${actionMarker}`);
    } else if (item.key === 'cancel') {
      const actionMarker = isSelected ? '\x1b[31m[ Cancel ]\x1b[0m' : '[ Cancel ]';
      lines.push(`${marker}${actionMarker}`);
    } else {
      const labelStr = isSelected ? `\x1b[1m${item.label}\x1b[0m` : item.label;
      const val = item.getValue();
      const valStr = val !== '' && val !== undefined ? `: \x1b[36m${val}\x1b[0m` : '';
      lines.push(`${marker}${numPrefix}${labelStr}${valStr}`);
    }
  }

  lines.push('');
  lines.push(`\x1b[90m${rule}\x1b[0m`);
  lines.push('\x1b[1mHUD PREVIEW:\x1b[0m');

  try {
    const hudPreview = renderHUD(mockState, mockAgyData, wizardState.config, mockQuotaData, 'Pro');
    lines.push(hudPreview);
  } catch (err) {
    lines.push(`\x1b[31mFailed to render preview: ${err.message}\x1b[0m`);
  }
  lines.push(`\x1b[90m${rule}\x1b[0m`);

  return lines.join('\n');
}

async function startWizard() {
  if (!process.stdin.isTTY) {
    console.error('Interactive configuration wizard requires a TTY terminal.');
    process.exitCode = 1;
    return;
  }

  const currentConfig = await loadConfig();
  const wizardState = createWizardState(currentConfig);

  function cleanup() {
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    process.stdin.pause();
  }

  const handleSave = async () => {
    await saveConfig(wizardState.config, wizardState.targetIsGlobal);
    cleanup();
    const okMark = resolveWizardUnicode(wizardState.config) ? '✔' : '[OK]';
    const targetPath = wizardState.targetIsGlobal ? getGlobalConfigPath() : getLocalConfigPath();
    console.log(`\n\x1b[32m${okMark} Configuration saved successfully to ${targetPath}\x1b[0m\n`);
    process.exit(0);
  };

  const handleCancel = () => {
    cleanup();
    console.log('\n\x1b[90mConfiguration canceled.\x1b[0m\n');
    process.exit(0);
  };

  const menuItems = buildMenuItems(wizardState, {
    onSave: handleSave,
    onCancel: handleCancel,
  });

  // Setup raw mode for keypress capture
  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }

  function renderMenu() {
    readline.cursorTo(process.stdout, 0, 0);
    readline.clearScreenDown(process.stdout);
    console.log(renderWizardScreen(wizardState, menuItems));
  }

  renderMenu();

  process.stdin.on('keypress', async (str, key) => {
    const action = applyWizardKey(wizardState, menuItems, str, key);
    if (action === 'noop') return;
    if (action === 'abort') {
      cleanup();
      process.exit(1);
    }
    if (action === 'cancel') {
      handleCancel();
      return;
    }
    if (action === 'render') {
      renderMenu();
      return;
    }
    if (action === 'toggle') {
      try {
        await menuItems[wizardState.selectedIdx].toggle();
      } catch (err) {
        cleanup();
        console.error(`\n\x1b[31mError: ${err.message}\x1b[0m\n`);
        process.exit(1);
      }
      renderMenu();
    }
  });
}

module.exports = {
  startWizard,
  createWizardState,
  buildMenuItems,
  applyWizardKey,
  renderWizardScreen,
  THEME_PRESETS,
  mockState,
  mockAgyData,
  mockQuotaData,
};
