import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import * as collector from '../collector.mjs';
import { DEFAULT_CONFIG, loadConfigFiles, mergeConfig } from '../src/config.ts';
import { renderPlain } from '../src/render/index.ts';

const THEME_PRESETS = {
  Default: {
    context: 'green',
    usage: 'pink',
    warning: 'yellow',
    usageWarning: 'yellow',
    critical: 'red',
    model: 'cyan',
    project: 'yellow',
    git: 'magenta',
    gitBranch: 'cyan',
    label: 'dim',
    custom: 'cyan',
    barFilled: '█',
    barEmpty: '░',
  },
  Emerald: {
    context: 'green',
    usage: 'green',
    warning: 'yellow',
    usageWarning: 'yellow',
    critical: 'red',
    label: 'gray',
  },
  Ocean: {
    context: 'blue',
    usage: 'cyan',
    warning: 'yellow',
    usageWarning: 'yellow',
    critical: 'red',
    label: 'gray',
  },
  Cyberpunk: {
    context: 'magenta',
    usage: 'brightMagenta',
    warning: 'yellow',
    usageWarning: 'yellow',
    critical: 'red',
    label: 'gray',
  },
  Amber: {
    context: 'yellow',
    usage: 'yellow',
    warning: 'cyan',
    usageWarning: 'cyan',
    critical: 'red',
    label: 'gray',
  },
};

function buildPreviewContext(config, now = Date.now()) {
  const fiveReset = new Date(now + 4 * 60 * 60 * 1000);
  const weekReset = new Date(now + 5 * 24 * 60 * 60 * 1000);
  const fiveIso = fiveReset.toISOString();
  const weekIso = weekReset.toISOString();

  const models = [
    {
      id: 'gemini-3-pro',
      displayName: 'Gemini 3 Pro (High)',
      remainingFraction: 0.92,
      resetTime: fiveIso,
      modelProvider: 'MODEL_PROVIDER_GOOGLE',
      windows: {
        fiveHour: { remainingFraction: 0.92, resetTime: fiveIso, observedAt: now },
        weekly: { remainingFraction: 0.68, resetTime: weekIso, observedAt: now },
      },
    },
    {
      id: 'claude-sonnet-4-6',
      displayName: 'Claude Sonnet 4.6',
      remainingFraction: 0.54,
      resetTime: weekIso,
      modelProvider: 'MODEL_PROVIDER_ANTHROPIC',
      windows: {
        fiveHour: { remainingFraction: 0.72, resetTime: fiveIso, observedAt: now },
        weekly: { remainingFraction: 0.54, resetTime: weekIso, observedAt: now },
      },
    },
  ];

  return {
    stdin: {
      model: { id: 'gemini-3-pro', display_name: 'Gemini 3 Pro (High)' },
      cwd: process.cwd(),
      workspace: { current_dir: process.cwd(), project_dir: process.cwd() },
      plan_tier: 'Pro',
      task_count: 3,
      context_window: {
        context_window_size: 200_000,
        used_percentage: 24,
        current_usage: { input_tokens: 42_000, output_tokens: 4_500, cache_read_input_tokens: 30_000, cache_creation_input_tokens: 2_000 },
      },
      cost: { total_cost_usd: 0.085, total_api_duration_ms: 3200 },
    },
    transcript: {
      steps: 12,
      tools: [
        { id: '1', name: 'Read', target: 'src/main.ts', status: 'completed', startTime: new Date(now - 5000) },
      ],
      skills: [],
      mcpServers: [],
      mcpErrors: [],
      agents: [],
      todos: [{ content: 'Review HUD v0.4 layout', status: 'in_progress' }],
    },
    claudeMdCount: 1,
    memoryLabelName: 'AGENTS.md',
    rulesCount: 2,
    mcpCount: 2,
    hooksCount: 1,
    costTotals: { todayUsd: 0.45, weekUsd: 1.82 },
    outputSpeed: 43.4,
    gitStatus: { branch: 'main', isDirty: true, ahead: 1, behind: 0 },
    usageData: { fiveHour: 8, sevenDay: 32, fiveHourResetAt: fiveReset, sevenDayResetAt: weekReset },
    agyQuota: {
      models,
      providerQuota: {
        google: models[0].windows,
        claude: models[1].windows,
      },
      unavailableReason: null,
      tierName: 'Pro',
      accountEmail: `${os.userInfo().username}@example.com`,
      updateInfo: null,
    },
    memoryUsage: { totalBytes: 16 * 1024 ** 3, usedBytes: 7 * 1024 ** 3, freeBytes: 9 * 1024 ** 3, usedPercent: 44 },
    authInfo: { method: 'Pro', user: os.userInfo().username, email: `${os.userInfo().username}@example.com` },
    config,
    extraLabel: null,
    unicodeSupported: config.display?.unicode !== false,
  };
}

function saveConfigTarget(config, targetPath) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true, mode: 0o700 });
  const tmp = `${targetPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, targetPath);
}

export async function startWizard() {
  const paths = collector.agyPaths(process.env);
  const logicNamed = collector.logicPaths(paths, { cwd: process.cwd() });
  const loaded = loadConfigFiles(logicNamed);
  const base = JSON.parse(JSON.stringify(loaded.base && Object.keys(loaded.base).length > 0 ? loaded.base : DEFAULT_CONFIG));
  base.display = base.display || {};
  base.gitStatus = base.gitStatus || {};
  base.colors = base.colors || {};

  const localConfigPath = path.join(process.cwd(), 'agy-hud.config.json');
  let targetIsGlobal = !fs.existsSync(localConfigPath);

  const themeKeys = Object.keys(THEME_PRESETS);
  let themeIdx = 0;

  const ensureDisplay = (k) => (k in base.display ? base.display[k] : DEFAULT_CONFIG.display[k]);
  const ensureGit = (k) => (k in base.gitStatus ? base.gitStatus[k] : DEFAULT_CONFIG.gitStatus[k]);

  const menuItems = [
    {
      key: 'scope',
      label: 'Configuration Scope',
      getValue: () => (targetIsGlobal ? `Global (${paths.configPath})` : `Local (${localConfigPath})`),
      toggle: () => { targetIsGlobal = !targetIsGlobal; },
    },
    {
      key: 'lineLayout',
      label: 'Line Layout',
      getValue: () => base.lineLayout || DEFAULT_CONFIG.lineLayout,
      toggle: () => {
        base.lineLayout = (base.lineLayout || DEFAULT_CONFIG.lineLayout) === 'compact' ? 'expanded' : 'compact';
      },
    },
    {
      key: 'language',
      label: 'Language',
      getValue: () => base.language || DEFAULT_CONFIG.language,
      toggle: () => {
        const langs = ['auto', 'en', 'zh-Hans', 'zh-Hant'];
        const cur = base.language || DEFAULT_CONFIG.language;
        base.language = langs[(langs.indexOf(cur) + 1) % langs.length];
      },
    },
    {
      key: 'quotaStyle',
      label: 'Quota Style',
      getValue: () => ensureDisplay('quotaStyle'),
      toggle: () => {
        const modes = ['minimal', 'table', 'models', 'compact'];
        const cur = ensureDisplay('quotaStyle');
        base.display.quotaStyle = modes[(modes.indexOf(cur) + 1) % modes.length];
      },
    },
    {
      key: 'theme',
      label: 'Color Preset',
      getValue: () => themeKeys[themeIdx],
      toggle: () => {
        themeIdx = (themeIdx + 1) % themeKeys.length;
        base.colors = { ...base.colors, ...THEME_PRESETS[themeKeys[themeIdx]] };
      },
    },
    {
      key: 'iconSet',
      label: 'Icon & Font Set',
      getValue: () => {
        if (ensureDisplay('useNerdFonts')) return 'Nerd Fonts';
        if (ensureDisplay('unicode') !== false) return 'Unicode';
        return 'Plain ASCII';
      },
      toggle: () => {
        if (ensureDisplay('useNerdFonts')) {
          base.display.useNerdFonts = false;
          base.display.unicode = true;
        } else if (ensureDisplay('unicode') !== false) {
          base.display.useNerdFonts = false;
          base.display.unicode = false;
        } else {
          base.display.useNerdFonts = true;
          base.display.unicode = true;
        }
      },
    },
    {
      key: 'gitBranch',
      label: 'Show Git Status',
      getValue: () => (ensureGit('enabled') ? 'Enabled' : 'Disabled'),
      toggle: () => { base.gitStatus.enabled = !ensureGit('enabled'); },
    },
    {
      key: 'showUsage',
      label: 'Show Usage / Quota',
      getValue: () => (ensureDisplay('showUsage') ? 'Enabled' : 'Disabled'),
      toggle: () => { base.display.showUsage = !ensureDisplay('showUsage'); },
    },
    {
      key: 'showTools',
      label: 'Show Tools Activity',
      getValue: () => (ensureDisplay('showTools') ? 'Enabled' : 'Disabled'),
      toggle: () => { base.display.showTools = !ensureDisplay('showTools'); },
    },
    {
      key: 'showMemoryUsage',
      label: 'Show RAM Usage',
      getValue: () => (ensureDisplay('showMemoryUsage') ? 'Enabled' : 'Disabled'),
      toggle: () => { base.display.showMemoryUsage = !ensureDisplay('showMemoryUsage'); },
    },
    {
      key: 'showSpeed',
      label: 'Show Output Speed',
      getValue: () => (ensureDisplay('showSpeed') ? 'Enabled' : 'Disabled'),
      toggle: () => { base.display.showSpeed = !ensureDisplay('showSpeed'); },
    },
    {
      key: 'showCost',
      label: 'Show Session Cost',
      getValue: () => (ensureDisplay('showCost') ? 'Enabled' : 'Disabled'),
      toggle: () => { base.display.showCost = !ensureDisplay('showCost'); },
    },
    {
      key: 'showDailyCost',
      label: 'Show Daily Cost',
      getValue: () => (ensureDisplay('showDailyCost') ? 'Enabled' : 'Disabled'),
      toggle: () => { base.display.showDailyCost = !ensureDisplay('showDailyCost'); },
    },
    {
      key: 'showAuthUser',
      label: 'Show Username',
      getValue: () => (ensureDisplay('showAuthUser') ? 'Enabled' : 'Disabled'),
      toggle: () => { base.display.showAuthUser = !ensureDisplay('showAuthUser'); },
    },
    {
      key: 'save',
      label: 'Save & Exit',
      getValue: () => '',
      toggle: () => {
        const dest = targetIsGlobal ? paths.configPath : localConfigPath;
        saveConfigTarget(base, dest);
        cleanup();
        console.log(`\n\x1b[32m✔ Saved configuration to ${dest}\x1b[0m\n`);
        process.exit(0);
      },
    },
    {
      key: 'cancel',
      label: 'Cancel & Exit',
      getValue: () => '',
      toggle: () => {
        cleanup();
        console.log('\n\x1b[90mConfiguration canceled.\x1b[0m\n');
        process.exit(0);
      },
    },
  ];

  let selectedIdx = 0;
  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);

  function cleanup() {
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
  }

  function renderMenu() {
    readline.cursorTo(process.stdout, 0, 0);
    readline.clearScreenDown(process.stdout);

    console.log('\x1b[1m\x1b[35m=== agy-hud v0.4 Configuration Wizard ===\x1b[0m\n');
    console.log('Use \x1b[1m↑/↓\x1b[0m to navigate, \x1b[1mSpace/Enter\x1b[0m to toggle/confirm.\n');

    for (let i = 0; i < menuItems.length; i++) {
      const item = menuItems[i];
      const isSelected = i === selectedIdx;
      const marker = isSelected ? '\x1b[32m▸ \x1b[0m' : '  ';
      if (item.key === 'save') {
        console.log(`${marker}${isSelected ? '\x1b[32m[ Save ]\x1b[0m' : '[ Save ]'}`);
      } else if (item.key === 'cancel') {
        console.log(`${marker}${isSelected ? '\x1b[31m[ Cancel ]\x1b[0m' : '[ Cancel ]'}`);
      } else {
        const labelStr = isSelected ? `\x1b[1m${item.label}\x1b[0m` : item.label;
        console.log(`${marker}${labelStr}: \x1b[36m${item.getValue()}\x1b[0m`);
      }
    }

    console.log('\n\x1b[90m─────────────────────────────────────────────────────────────────────────────────\x1b[0m');
    console.log('\x1b[1mHUD PREVIEW:\x1b[0m');
    try {
      const merged = mergeConfig(base);
      console.log(renderPlain(buildPreviewContext(merged), process.stdout.columns ?? 100));
    } catch (err) {
      console.log(`\x1b[31mPreview error: ${err instanceof Error ? err.message : String(err)}\x1b[0m`);
    }
    console.log('\x1b[90m─────────────────────────────────────────────────────────────────────────────────\x1b[0m');
  }

  renderMenu();

  process.stdin.on('keypress', (str, key) => {
    if (key?.ctrl && key?.name === 'c') {
      cleanup();
      process.exit(1);
    }
    if (key?.name === 'up') {
      selectedIdx = (selectedIdx - 1 + menuItems.length) % menuItems.length;
      renderMenu();
    } else if (key?.name === 'down') {
      selectedIdx = (selectedIdx + 1) % menuItems.length;
      renderMenu();
    } else if (key?.name === 'space' || key?.name === 'return' || key?.name === 'enter') {
      try {
        menuItems[selectedIdx].toggle();
      } catch (err) {
        cleanup();
        console.error(`\n\x1b[31mError: ${err instanceof Error ? err.message : String(err)}\x1b[0m\n`);
        process.exit(1);
      }
      renderMenu();
    } else if (str && /[1-9]/.test(str)) {
      const idx = parseInt(str, 10) - 1;
      if (idx < menuItems.length) {
        selectedIdx = idx;
        renderMenu();
      }
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await startWizard();
}
