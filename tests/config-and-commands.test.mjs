import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_CONFIG,
  checkValue,
  configKeys,
  loadConfigFiles,
  mergeConfig,
} from '../src/config.ts';
import { DESCRIPTIONS, schemaLines } from '../src/schema.ts';
import { runHudCommand } from '../src/commands.ts';

function fakePaths(root) {
  const data = path.join(root, 'data');
  const configDir = path.join(root, 'antigravity-cli');
  const hudDir = path.join(configDir, 'agy-hud');
  fs.mkdirSync(data, { recursive: true });
  fs.mkdirSync(hudDir, { recursive: true });
  return {
    data,
    config: path.join(hudDir, 'config.json'),
    override: path.join(configDir, 'agy-hud.json'),
    legacyConfig: path.join(configDir, 'agy-hud-runtime', 'runtime', 'agy-hud.config.json'),
    heartbeat: path.join(hudDir, 'heartbeat.json'),
    claudeJson: path.join(root, '.claude.json'),
    user: {
      claudeMd: path.join(root, '.claude', 'CLAUDE.md'),
      geminiMd: path.join(root, '.gemini', 'GEMINI.md'),
      rules: path.join(root, '.claude', 'rules'),
      agyRules: path.join(root, '.gemini', 'config', 'rules'),
      settings: path.join(root, '.claude', 'settings.json'),
      agySettings: path.join(configDir, 'settings.json'),
    },
    project: {
      claudeMd: path.join(root, 'proj', 'CLAUDE.md'),
      localMd: path.join(root, 'proj', 'CLAUDE.local.md'),
      agentsMd: path.join(root, 'proj', 'AGENTS.md'),
      geminiMd: path.join(root, 'proj', 'GEMINI.md'),
      memoryMd: path.join(root, 'proj', 'MEMORY.md'),
      mcpJson: path.join(root, 'proj', '.mcp.json'),
      localAgyHudConfig: path.join(root, 'proj', 'agy-hud.config.json'),
      dotClaudeMd: null,
      dotLocalMd: path.join(root, 'proj', '.claude', 'CLAUDE.local.md'),
      rules: null,
      geminiRules: path.join(root, 'proj', '.gemini', 'rules'),
      agentsRules: path.join(root, 'proj', '.agents', 'rules'),
      cursorRules: path.join(root, 'proj', '.cursor', 'rules'),
      githubRules: path.join(root, 'proj', '.github', 'rules'),
      settings: null,
      localSettings: path.join(root, 'proj', '.claude', 'settings.local.json'),
    },
    projectMemory: null,
    transcript: null,
    subagents: null,
  };
}

function fakeFacts(paths, cwd) {
  return {
    runtime: { name: 'node', version: '26.13.0', path: process.execPath, supported: true },
    runtimes: [{ name: 'system', version: 'v26.13.0', path: process.execPath }],
    plugin: { root: cwd, version: '0.4.2' },
    configPath: paths.config,
    undoPath: path.join(path.dirname(paths.config), 'config.undo.json'),
    cwd,
    account: { email: 'secret-user@example.com', tier: 'Google AI Pro' },
    heartbeat: { at: Date.now(), runtime: 'v26.13.0', path: paths.config, outcome: 'ok', columns: 100 },
  };
}

describe('config / merge, validation, and legacy v0.3 migration', () => {
  test('defaults to rich claude-hud aligned configuration with auto locale and minimal quota bar', () => {
    const cfg = mergeConfig({});
    assert.equal(cfg.language, 'auto');
    assert.equal(cfg.lineLayout, 'expanded');
    assert.equal(cfg.display.quotaStyle, 'minimal');
    assert.equal(cfg.display.showTools, true);
    assert.equal(cfg.display.showAgents, true);
    assert.equal(cfg.display.showSessionTokens, true);
    assert.deepEqual(cfg.display.mergeGroups, [['context', 'usage']]);
    assert.equal(cfg.display.weeklyCostPeriod, 'quota');
  });

  test('migrates legacy v0.3.x config keys cleanly (theme, thresholds, showGitBranch, showUsername, etc.)', () => {
    const cfg = mergeConfig({
      theme: { primary: 'cyan', secondary: 'gray', warning: 'yellow', critical: 'red' },
      thresholds: { warning: 0.7, critical: 90 },
      display: {
        showGitBranch: false,
        showCurrentDir: false,
        showUsername: true,
        username: 'alice',
        showTokenBar: true,
        showTurnCacheHitRate: true,
        cacheHitThresholds: { excellent: 85, partial: 45 },
      },
    });

    assert.equal(cfg.colors.context, 'cyan');
    assert.equal(cfg.colors.label, 'gray');
    assert.equal(cfg.display.contextWarningThreshold, 70);
    assert.equal(cfg.display.contextCriticalThreshold, 90);
    assert.equal(cfg.gitStatus.enabled, false);
    assert.equal(cfg.display.showProject, false);
    assert.equal(cfg.display.showAuthUser, true);
    assert.equal(cfg.display.authUserOverride, 'alice');
    assert.equal(cfg.display.showSessionTokens, true);
    assert.equal(cfg.display.showCacheHitRate, true);
    assert.equal(cfg.display.cacheHitExcellentThreshold, 85);
    assert.equal(cfg.display.cacheHitPartialThreshold, 45);
  });

  test('handles priority order: config.json -> legacyConfig fallback -> agy-hud.json override -> project agy-hud.config.json', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-prio-'));
    try {
      const paths = fakePaths(tmp);
      fs.mkdirSync(path.dirname(paths.legacyConfig), { recursive: true });
      fs.mkdirSync(path.dirname(paths.project.localAgyHudConfig), { recursive: true });
      fs.writeFileSync(paths.legacyConfig, JSON.stringify({ language: 'zh-Hans', display: { quotaStyle: 'table' } }));
      fs.writeFileSync(paths.project.localAgyHudConfig, JSON.stringify({ display: { showCost: true } }));

      const loadedLegacy = loadConfigFiles(paths);
      assert.equal(loadedLegacy.config.language, 'zh-Hans');
      assert.equal(loadedLegacy.config.display.quotaStyle, 'table');
      assert.equal(loadedLegacy.config.display.showCost, true);

      fs.writeFileSync(paths.config, JSON.stringify({ language: 'en' }));
      const loadedPrimary = loadConfigFiles(paths);
      assert.equal(loadedPrimary.config.language, 'en');
      assert.equal(loadedPrimary.config.display.quotaStyle, 'minimal');
      assert.equal(loadedPrimary.config.display.showCost, true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('checkValue validates enums, numbers, arrays, hex colors, and rejects invalid values', () => {
    assert.equal(checkValue('display.weeklyCostPeriod', 'monday'), null);
    assert.equal(checkValue('display.quotaStyle', 'models'), null);
    assert.equal(checkValue('colors.model', '#ff8800'), null);
    assert.equal(checkValue('colors.model', 42), null);
    assert.ok(checkValue('display.weeklyCostPeriod', 'funday') !== null);
    assert.ok(checkValue('display.columnWidth', 999) !== null);
    assert.ok(checkValue('nonexistent.key', true) !== null);
  });

  test('every configKey has schema description and schemaLines searches cleanly', () => {
    const all = configKeys();
    assert.ok(all.length > 100);
    for (const k of all) assert.ok(DESCRIPTIONS[k.key], `Missing description for ${k.key}`);
    const weekly = schemaLines(['weeklyCostPeriod']);
    assert.ok(weekly.some((l) => l.includes('display.weeklyCostPeriod')));
  });
});

describe('commands / schema, set, preview, doctor, report', () => {
  test('set updates valid keys, blocks capability-only externalUsagePath, and supports --reset', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-set-'));
    try {
      const paths = fakePaths(tmp);
      const ask = async () => ({});
      const res = await runHudCommand({ name: 'set', args: ['lineLayout=compact', 'display.quotaStyle=table'], facts: fakeFacts(paths, tmp) }, paths, ask, Date.now());
      assert.equal(res.failed, undefined);
      assert.equal(res.config.lineLayout, 'compact');
      assert.equal(res.config.display.quotaStyle, 'table');

      const blocked = await runHudCommand({ name: 'set', args: ['display.externalUsagePath=/etc/passwd'], facts: fakeFacts(paths, tmp) }, paths, ask, Date.now());
      assert.equal(blocked.failed, true);
      assert.match(blocked.lines[0], /edited directly/);

      const reset = await runHudCommand({ name: 'set', args: ['--reset'], facts: fakeFacts(paths, tmp) }, paths, ask, Date.now());
      assert.deepEqual(reset.config, {});

      const minimal = await runHudCommand({ name: 'preset', args: ['minimal'], facts: fakeFacts(paths, tmp) }, paths, ask, Date.now());
      assert.equal(minimal.failed, undefined);
      assert.equal(minimal.config.display.showTools, false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('preview, doctor, and report scrub sensitive paths and emails', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-diag-'));
    try {
      const paths = fakePaths(tmp);
      fs.writeFileSync(paths.config, JSON.stringify({ display: { authUserOverride: 'secret-name', showUsage: true } }));
      const ask = async () => ({
        'agy.quota': { models: [{ id: 'g', remainingFraction: 0.8 }], providerQuota: null, unavailableReason: null, tierName: 'Google AI Pro', accountEmail: 'secret-user@example.com', updateInfo: null },
        'agy.unicode': true,
      });

      const preview = await runHudCommand({ name: 'preview', args: ['display.quotaStyle=models'], facts: fakeFacts(paths, tmp) }, paths, ask, Date.now());
      assert.ok(preview.lines.some((l) => l.includes('Gemini 3 Pro')));

      const doctor = await runHudCommand({ name: 'doctor', args: [], facts: fakeFacts(paths, tmp) }, paths, ask, Date.now());
      const docObj = JSON.parse(doctor.lines[0]);
      assert.equal(docObj.account.signedIn, true);
      assert.equal(docObj.quota.modelsCount, 1);

      const report = await runHudCommand({ name: 'report', args: [], facts: fakeFacts(paths, tmp) }, paths, ask, Date.now());
      const serialized = report.lines[0];
      assert.doesNotMatch(serialized, /secret-user@example\.com|secret-name/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
