import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { getAntigravityRoots, resolveAntigravityPath, resolveSafeExecutable } from '../runtime/paths.mjs';
import { detectUnicodeSupport } from '../runtime/encoding.mjs';
import { isRemoteVersionNewer } from '../runtime/update-checker.mjs';
import { buildShShimContents, createStatusLineCommand, writeCmdShim } from '../install.mjs';
import { clearStatusLine, removeExtraFiles, removeWindowsShShims } from '../runtime/uninstall.mjs';
import { buildAuthDiagnostic } from '../scripts/diagnose-auth.js';
import { detectHudRender, renderTerminalScreen, stripAnsi } from '../scripts/verify-display.js';
import { cleanStalePluginFiles, installRuntime, RUNTIME_FILES } from '../scripts/bootstrap.js';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));

function withEnv(overrides, fn) {
  const snapshot = {};
  for (const key of Object.keys(overrides)) {
    snapshot[key] = process.env[key];
    if (overrides[key] === undefined) delete process.env[key];
    else process.env[key] = overrides[key];
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(snapshot)) {
      if (snapshot[key] === undefined) delete process.env[key];
      else process.env[key] = snapshot[key];
    }
  }
}

describe('runtime / paths', () => {
  test('getAntigravityRoots starts with home/.gemini/antigravity-cli and includes env fallbacks', () => {
    withEnv({ AGY_HUD_DATA_DIR: undefined, XDG_DATA_HOME: undefined, APPDATA: undefined, LOCALAPPDATA: undefined }, () => {
      const roots = getAntigravityRoots();
      assert.equal(roots.length, 1);
      assert.equal(roots[0], path.join(os.homedir(), '.gemini', 'antigravity-cli'));
    });

    withEnv({ AGY_HUD_DATA_DIR: undefined, XDG_DATA_HOME: '/xdg/home', APPDATA: 'C:\\AppData\\Roaming', LOCALAPPDATA: 'C:\\AppData\\Local' }, () => {
      const roots = getAntigravityRoots();
      assert.ok(roots.includes(path.join('/xdg/home', 'antigravity-cli')));
      assert.ok(roots.includes(path.join('C:\\AppData\\Roaming', 'antigravity-cli')));
      assert.ok(roots.includes(path.join('C:\\AppData\\Local', 'antigravity-cli')));
    });
  });

  test('resolveAntigravityPath returns existing candidate or falls back to primary root', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'paths-test-'));
    try {
      const fakeAppdata = path.join(tmp, 'Roaming');
      const fakeRoot = path.join(fakeAppdata, 'antigravity-cli');
      fs.mkdirSync(fakeRoot, { recursive: true });
      fs.writeFileSync(path.join(fakeRoot, 'settings.json'), '{}');

      withEnv({
        AGY_HUD_DATA_DIR: undefined,
        XDG_DATA_HOME: undefined,
        APPDATA: fakeAppdata,
        LOCALAPPDATA: undefined,
        HOME: path.join(tmp, 'nonexistent-home'),
        USERPROFILE: path.join(tmp, 'nonexistent-home'),
      }, () => {
        assert.equal(resolveAntigravityPath('settings.json'), path.join(fakeRoot, 'settings.json'));
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('resolveSafeExecutable resolves absolute node path and skips relative entries', () => {
    const nodePath = resolveSafeExecutable('node');
    assert.ok(nodePath && path.isAbsolute(nodePath));
    withEnv({ PATH: ['.', 'relative_dir', path.dirname(nodePath)].join(path.delimiter) }, () => {
      assert.equal(resolveSafeExecutable('node'), nodePath);
    });
  });
});

describe('runtime / encoding', () => {
  test('honors env overrides, Windows codepage, Linux LANG, and macOS defaults', () => {
    assert.equal(detectUnicodeSupport({ env: { AGY_HUD_FORCE_ASCII: '1' }, platform: 'darwin' }), false);
    assert.equal(detectUnicodeSupport({ env: { AGY_HUD_FORCE_UNICODE: '1' }, platform: 'win32', readCodepage: () => '936' }), true);
    assert.equal(detectUnicodeSupport({ env: {}, platform: 'win32', readCodepage: () => '936' }), false);
    assert.equal(detectUnicodeSupport({ env: { WT_SESSION: 'abc' }, platform: 'win32', readCodepage: () => '936' }), false);
    assert.equal(detectUnicodeSupport({ env: {}, platform: 'win32', readCodepage: () => '65001' }), true);
    assert.equal(detectUnicodeSupport({ env: { LANG: 'en_US.UTF-8' }, platform: 'linux' }), true);
    assert.equal(detectUnicodeSupport({ env: { LANG: 'POSIX' }, platform: 'linux' }), false);
    assert.equal(detectUnicodeSupport({ env: {}, platform: 'darwin' }), true);
  });
});

describe('runtime / update-checker & verify-display', () => {
  test('isRemoteVersionNewer compares semver numerically without downgrades', () => {
    assert.equal(isRemoteVersionNewer('0.4.0', '0.3.8'), true);
    assert.equal(isRemoteVersionNewer('0.3.10', '0.3.9'), true);
    assert.equal(isRemoteVersionNewer('v1.0.0', '0.9.9'), true);
    assert.equal(isRemoteVersionNewer('0.4.0', '0.4.0'), false);
    assert.equal(isRemoteVersionNewer('0.3.9', '0.4.0'), false);
    assert.equal(isRemoteVersionNewer(null, '0.4.0'), false);
  });

  test('detectHudRender validates v0.4 minimal 2-line and ZH/ASCII HUDs', () => {
    const enHud = '\x1b[36m[Gemini 3 Pro (High)]\x1b[0m │ \x1b[33magy-hud\x1b[0m\n\x1b[32mContext\x1b[0m ███░░░░░░░ 25% │ Usage ██░░░░░░░░ 15%';
    const zhHud = '[Gemini 3 Pro] │ proj\n上下文 ███░░░░░░░ 42% │ 用量 ██░░░░░░░░ 20%';
    assert.equal(detectHudRender(enHud, renderTerminalScreen(enHud), stripAnsi(enHud)), true);
    assert.equal(detectHudRender(zhHud), true);
    assert.equal(detectHudRender('', 'random output', 'Usage of agy:'), false);
  });
});

describe('scripts / diagnose-auth', () => {
  test('summarizes file, Linux keyring, and macOS keychain tokens without leaking secrets', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-diag-'));
    try {
      const home = path.join(tmp, 'home');
      fs.mkdirSync(path.join(home, '.gemini', 'antigravity-cli'), { recursive: true });
      fs.writeFileSync(path.join(home, '.gemini', 'oauth_creds.json'), JSON.stringify({
        access_token: 'secret-access-token',
        refresh_token: 'secret-refresh-token',
        expiry_date: Date.parse('2026-12-20T12:10:00Z'),
      }));

      withEnv({ HOME: home, USERPROFILE: home, XDG_DATA_HOME: undefined, APPDATA: undefined, LOCALAPPDATA: undefined }, () => {
        const d1 = buildAuthDiagnostic({
          resolveAgyInfo: () => ({ found: false, candidates: [] }),
          platform: 'linux',
          keyringReader: () => null,
          keyringProbe: () => ({ available: false, reason: 'secret-tool-missing' }),
        });
        assert.equal(d1.readToken.found, true);
        assert.equal(d1.readToken.sourceFormat, 'oauth-creds');
        assert.equal(d1.keyringProbe.reason, 'secret-tool-missing');
        assert.doesNotMatch(JSON.stringify(d1), /secret-access-token|secret-refresh-token/);

        const d2 = buildAuthDiagnostic({
          resolveAgyInfo: () => ({ found: false, candidates: [] }),
          platform: 'darwin',
          keychainReader: () => ({ accessToken: 'secret-kc', sourceFormat: 'macos-keychain', email: 'u@example.com', all: [{ accessToken: 'secret-kc' }] }),
          keychainProbe: () => ({ available: true, security: '/usr/bin/security' }),
        });
        assert.equal(d2.readToken.sourceFormat, 'macos-keychain');
        assert.equal(d2.readToken.hasEmail, true);
        assert.doesNotMatch(JSON.stringify(d2), /secret-kc|u@example\.com/);
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('runtime / uninstall & windows shims', () => {
  test('removeExtraFiles, clearStatusLine, writeCmdShim, and removeWindowsShShims clean cleanly', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uninstall-test-'));
    try {
      const payloadFile = path.join(tmp, 'agy-hud-payload.json');
      const hudDir = path.join(tmp, 'agy-hud');
      const keepFile = path.join(tmp, 'other.json');
      fs.writeFileSync(payloadFile, '{}');
      fs.mkdirSync(hudDir, { recursive: true });
      fs.writeFileSync(path.join(hudDir, 'statusline.mjs'), 'x');
      fs.writeFileSync(keepFile, '{}');

      const removed = removeExtraFiles(tmp);
      assert.ok(removed.includes(payloadFile));
      assert.ok(removed.includes(hudDir));
      assert.equal(fs.existsSync(keepFile), true);

      const settingsPath = path.join(tmp, 'settings.json');
      const runtimeDir = path.join(tmp, 'agy-hud-runtime');
      fs.writeFileSync(settingsPath, JSON.stringify({ statusLine: { type: 'command', command: `node "${tmp}/agy-hud/statusline.mjs"` }, theme: 'dark' }));
      assert.equal(clearStatusLine(settingsPath, runtimeDir).changed, true);
      assert.equal(JSON.parse(fs.readFileSync(settingsPath, 'utf8')).statusLine, undefined);
      assert.equal(JSON.parse(fs.readFileSync(settingsPath, 'utf8')).theme, 'dark');

      fs.writeFileSync(settingsPath, JSON.stringify({ statusLine: { type: 'command', command: 'echo other' } }));
      assert.equal(clearStatusLine(settingsPath, runtimeDir).reason, 'foreign_status_line');

      const shim = writeCmdShim(path.join(tmp, 'statusline.mjs'), 'win32');
      assert.ok(shim && shim.endsWith('.cmd') && fs.readFileSync(shim, 'utf8').includes('statusline.mjs'));
      assert.equal(createStatusLineCommand('C:\\x\\statusline.mjs', 'node.exe', 'win32'), 'C:\\x\\statusline.cmd');
      assert.equal(buildShShimContents().includes('cmd.exe /d /c'), true);
      assert.deepEqual(removeWindowsShShims('linux', {}), []);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('scripts / bootstrap', () => {
  test('installs complete ESM/TS runtime and statusline launcher into isolated HOME', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-boot-home-'));
    try {
      const result = spawnSync(process.execPath, ['scripts/bootstrap.js'], {
        cwd: projectRoot,
        env: { ...process.env, HOME: home, USERPROFILE: home, AGY_HUD_SETUP_SOURCE_DIR: projectRoot, AGY_HUD_DATA_DIR: '', APPDATA: '', LOCALAPPDATA: '', XDG_DATA_HOME: '' },
        encoding: 'utf8',
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);

      const base = path.join(home, '.gemini', 'antigravity-cli');
      const runtime = path.join(base, 'agy-hud-runtime');
      const settings = JSON.parse(fs.readFileSync(path.join(base, 'settings.json'), 'utf8'));

      for (const rel of RUNTIME_FILES) {
        assert.equal(fs.existsSync(path.join(runtime, ...rel.split('/'))), true, `Missing runtime file: ${rel}`);
      }
      assert.equal(settings.statusLine.type, 'command');
      assert.ok(settings.statusLine.command.includes(home));
      assert.match(settings.statusLine.command, /agy-hud[/\\]statusline\.(?:mjs|cmd)/);
      assert.match(result.stdout, /AGY-HUD bootstrap complete/);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('refreshes quota cache when active token exists, skips expired tokens, cleans stale plugin files, and swaps atomically', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-boot-quota-'));
    const incompleteSource = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-incomplete-'));
    const previousFetch = globalThis.fetch;
    try {
      const base = path.join(home, '.gemini', 'antigravity-cli');
      const tokenPath = path.join(base, 'antigravity-oauth-token');
      const pluginDir = path.join(home, '.gemini', 'config', 'plugins', 'agy-hud');
      fs.mkdirSync(base, { recursive: true });
      fs.mkdirSync(pluginDir, { recursive: true });
      fs.writeFileSync(path.join(pluginDir, 'hooks.json'), '{}');

      // 1. Expired token skips network calls
      fs.writeFileSync(tokenPath, JSON.stringify({ token: { access_token: 'exp', expiry: '2000-01-01T00:00:00.000Z' } }));
      let fetchCalls = 0;
      globalThis.fetch = async () => { fetchCalls += 1; return { ok: false, status: 401, json: async () => ({}) }; };

      const expiredRes = await installRuntime({
        homeDir: home,
        sourceDir: projectRoot,
        platform: 'linux',
        keyringReader: () => null,
        env: { ...process.env, HOME: home, USERPROFILE: home, AGY_HUD_DATA_DIR: '' },
      });
      assert.deepEqual(expiredRes.quotaRefresh, { status: 'skipped', reason: 'expired_token' });
      assert.equal(fetchCalls, 0);
      assert.equal(fs.existsSync(path.join(pluginDir, 'hooks.json')), false);

      // 2. Valid token refreshes quota cache cleanly
      fs.writeFileSync(tokenPath, JSON.stringify({ token: { access_token: 'valid', expiry: new Date(Date.now() + 3600_000).toISOString() } }));
      globalThis.fetch = async (url) => {
        if (String(url).includes('loadCodeAssist')) {
          return { ok: true, status: 200, json: async () => ({ paidTier: { name: 'Google AI Pro' } }) };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            models: { 'gemini-3-flash-agent': { displayName: 'Gemini 3.5 Flash (High)', quotaInfo: { remainingFraction: 0.77, resetTime: new Date(Date.now() + 3600_000).toISOString() } } },
          }),
        };
      };
      const okRes = await installRuntime({
        homeDir: home,
        sourceDir: projectRoot,
        platform: 'linux',
        keyringReader: () => null,
        env: { ...process.env, HOME: home, USERPROFILE: home, AGY_HUD_DATA_DIR: '' },
      });
      assert.deepEqual(okRes.quotaRefresh, { status: 'refreshed', count: 1, tier: 'Google AI Pro' });
      const { readCache } = await import(`${pathToFileURL(path.join(okRes.runtimeDir, 'runtime', 'quota.mjs')).href}?t=${Date.now()}`);
      const cached = readCache({ accessToken: 'rotated', sourcePath: tokenPath }, path.join(base, 'agy-hud-quota-cache.json'));
      assert.equal(cached?.[0]?.remainingFraction, 0.77);

      // 3. Atomic failure preserves existing runtime
      const sentinel = path.join(okRes.runtimeDir, 'hud.mjs');
      assert.ok(cleanStalePluginFiles(base, { homeDir: home }).length === 0);
      await assert.rejects(
        () => installRuntime({ homeDir: home, sourceDir: incompleteSource, env: { ...process.env, HOME: home, USERPROFILE: home, AGY_HUD_DATA_DIR: '' } }),
        /ENOENT/,
      );
      assert.equal(fs.existsSync(sentinel), true);
    } finally {
      globalThis.fetch = previousFetch;
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(incompleteSource, { recursive: true, force: true });
    }
  });
});
