import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createWizardState,
  buildMenuItems,
  applyWizardKey,
  renderWizardScreen,
  THEME_PRESETS,
  mockState,
} from '../../runtime/config-wizard.js';

const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;

describe('config-wizard / state & menu reducer', () => {
  test('handles string theme === "default" without spreading string into object keys', () => {
    const ws = createWizardState({ enabled: true, theme: 'default' }, { localExists: false });
    assert.equal(typeof ws.config.theme, 'object');
    assert.equal(ws.config.theme[0], undefined);
    assert.equal(ws.config.theme.primary, 'green');
    assert.equal(ws.themeName, 'Emerald Green');
    assert.equal(ws.targetIsGlobal, true);
  });

  test('preserves and restores Custom theme when cycling presets', () => {
    const customTheme = { primary: 'cyan', secondary: 'gray', warning: 'magenta', critical: 'red' };
    const ws = createWizardState({ theme: customTheme }, { localExists: true });
    assert.equal(ws.themeName, 'Custom');
    assert.equal(ws.targetIsGlobal, false);

    const items = buildMenuItems(ws);
    const themeItem = items.find(i => i.key === 'theme');
    assert.ok(themeItem);

    const presetCount = Object.keys(THEME_PRESETS).length;
    themeItem.toggle(); // Custom -> first preset
    assert.notEqual(ws.themeName, 'Custom');

    for (let i = 0; i < presetCount; i++) {
      themeItem.toggle();
    }
    assert.equal(ws.themeName, 'Custom');
    assert.deepEqual(ws.config.theme, customTheme);
  });

  test('quotaStyle supports table, models, and compact without overwriting models as Table', () => {
    const ws = createWizardState({ display: { quotaStyle: 'models' } }, { localExists: false });
    const items = buildMenuItems(ws);
    const quotaItem = items.find(i => i.key === 'quotaStyle');

    assert.equal(quotaItem.getValue(), 'Models');
    quotaItem.toggle();
    assert.equal(ws.config.display.quotaStyle, 'compact');
    assert.equal(quotaItem.getValue(), 'Compact');
    quotaItem.toggle();
    assert.equal(ws.config.display.quotaStyle, 'table');
    assert.equal(quotaItem.getValue(), 'Table');
    quotaItem.toggle();
    assert.equal(ws.config.display.quotaStyle, 'models');
    assert.equal(quotaItem.getValue(), 'Models');
  });

  test('iconSet supports Auto (detect) and deletes display.unicode when returning to Auto', () => {
    const ws = createWizardState({ display: {} }, { localExists: false });
    const items = buildMenuItems(ws);
    const iconItem = items.find(i => i.key === 'iconSet');

    assert.equal(iconItem.getValue(), 'Auto (detect)');
    assert.equal(ws.config.display.unicode, undefined);

    iconItem.toggle(); // Auto -> Nerd Fonts
    assert.equal(iconItem.getValue(), 'Nerd Fonts');
    assert.equal(ws.config.display.useNerdFonts, true);
    assert.equal(ws.config.display.unicode, true);

    iconItem.toggle(); // Nerd -> Unicode Emoji
    assert.equal(iconItem.getValue(), 'Unicode Emoji');
    assert.equal(ws.config.display.useNerdFonts, false);
    assert.equal(ws.config.display.unicode, true);

    iconItem.toggle(); // Unicode -> Plain ASCII
    assert.equal(iconItem.getValue(), 'Plain ASCII');
    assert.equal(ws.config.display.unicode, false);

    iconItem.toggle(); // ASCII -> Auto (detect)
    assert.equal(iconItem.getValue(), 'Auto (detect)');
    assert.equal(ws.config.display.unicode, undefined);
    assert.equal(ws.config.display.useNerdFonts, false);
  });

  test('supports language, showQuotaCapacity, showTurnCacheHitRate, and showImageQuota toggles', () => {
    const ws = createWizardState({ display: {} }, { localExists: false });
    const items = buildMenuItems(ws);

    const langItem = items.find(i => i.key === 'language');
    assert.equal(langItem.getValue(), 'Auto (detect)');
    langItem.toggle();
    assert.equal(ws.config.language, 'en');
    langItem.toggle();
    assert.equal(ws.config.language, 'zh');
    langItem.toggle();
    assert.equal(ws.config.language, undefined);

    const capItem = items.find(i => i.key === 'showQuotaCapacity');
    assert.equal(capItem.getValue(), 'Enabled');
    capItem.toggle();
    assert.equal(ws.config.display.showQuotaCapacity, false);
    assert.equal(capItem.getValue(), 'Disabled');
    capItem.toggle();
    assert.equal(ws.config.display.showQuotaCapacity, true);

    const cacheItem = items.find(i => i.key === 'showTurnCacheHitRate');
    assert.equal(cacheItem.getValue(), 'Disabled');
    cacheItem.toggle();
    assert.equal(ws.config.display.showTurnCacheHitRate, true);

    const imgItem = items.find(i => i.key === 'showImageQuota');
    assert.equal(imgItem.getValue(), 'Disabled');
    imgItem.toggle();
    assert.equal(ws.config.display.showImageQuota, true);
  });

  test('applyWizardKey guards missing key, navigates up/down/1-9, toggles, cancels on q/Esc, aborts on Ctrl+C', () => {
    const ws = createWizardState({}, { localExists: false });
    const items = buildMenuItems(ws);

    assert.equal(applyWizardKey(ws, items, '', undefined), 'noop');
    assert.equal(applyWizardKey(ws, items, '', null), 'noop');

    assert.equal(applyWizardKey(ws, items, '', { name: 'down' }), 'render');
    assert.equal(ws.selectedIdx, 1);

    assert.equal(applyWizardKey(ws, items, '', { name: 'up' }), 'render');
    assert.equal(ws.selectedIdx, 0);

    assert.equal(applyWizardKey(ws, items, '', { name: 'up' }), 'render');
    assert.equal(ws.selectedIdx, items.length - 1);

    assert.equal(applyWizardKey(ws, items, '5', { name: '5' }), 'render');
    assert.equal(ws.selectedIdx, 4);

    assert.equal(applyWizardKey(ws, items, ' ', { name: 'space' }), 'toggle');
    assert.equal(applyWizardKey(ws, items, '\r', { name: 'return' }), 'toggle');
    assert.equal(applyWizardKey(ws, items, 'q', { name: 'q' }), 'cancel');
    assert.equal(applyWizardKey(ws, items, '\x1b', { name: 'escape' }), 'cancel');
    assert.equal(applyWizardKey(ws, items, '\x03', { name: 'c', ctrl: true }), 'abort');
  });

  test('renderWizardScreen renders live preview with currentDir, username, quotaCapacity, English prompt, and ASCII chrome', () => {
    assert.ok(mockState.currentDir);
    assert.ok(mockState.username);
    assert.ok(mockState.quotaCapacity);

    const ws = createWizardState({
      language: 'en',
      display: {
        unicode: false,
        showCurrentDir: true,
        showUsername: true,
        showQuotaCapacity: true,
        showImageQuota: true,
      },
    }, { localExists: false });
    const items = buildMenuItems(ws);

    const screenAscii = renderWizardScreen(ws, items).replace(ANSI_RE, '');
    assert.doesNotMatch(screenAscii, /数字键/);
    assert.match(screenAscii, /Use Up\/Down or 1-9 to navigate/);
    assert.match(screenAscii, /1\. Configuration Scope/);
    assert.match(screenAscii, /my-project/);
    assert.match(screenAscii, /dev@example\.com/);
    assert.match(screenAscii, /~ Est \(Gemini 3\.5 Flash\): 5h ~420k\/600k tok \| week ~3\.4M\/4M tok/);
    assert.match(screenAscii, /Image Quota:/);
    assert.doesNotMatch(screenAscii, /[─▸↑↓]/);

    // Toggling showQuotaCapacity off removes the capacity line from live preview
    ws.config.display.showQuotaCapacity = false;
    const screenNoCap = renderWizardScreen(ws, items).replace(ANSI_RE, '');
    assert.doesNotMatch(screenNoCap, /~ Est \(/);
  });
});
