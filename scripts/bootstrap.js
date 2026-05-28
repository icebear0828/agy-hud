#!/usr/bin/env node
'use strict';

const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');

const DEFAULT_SOURCE_BASE = 'https://raw.githubusercontent.com/icebear0828/agy-hud/main';

const RUNTIME_FILES = [
  'package.json',
  'runtime/agy-hud.config.json',
  'runtime/bin/agy-hud.js',
  'runtime/config.js',
  'runtime/encoding.js',
  'runtime/parser.js',
  'runtime/paths.js',
  'runtime/quota.js',
  'runtime/quota/cache.js',
  'runtime/quota/cloud.js',
  'runtime/quota/models.js',
  'runtime/quota/token.js',
  'runtime/renderer.js',
  'runtime/statusline-installer.js',
  'runtime/uninstall.js',
  'runtime/update-checker.js',
];

function getAntigravityRoots(env = process.env, homeDir = os.homedir()) {
  return [
    path.join(homeDir, '.gemini', 'antigravity-cli'),
    env.XDG_DATA_HOME ? path.join(env.XDG_DATA_HOME, 'antigravity-cli') : null,
    env.APPDATA ? path.join(env.APPDATA, 'antigravity-cli') : null,
    env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'antigravity-cli') : null,
  ].filter(Boolean);
}

function pickAntigravityRoot(env = process.env, homeDir = os.homedir()) {
  const roots = getAntigravityRoots(env, homeDir);
  for (const root of roots) {
    if (getPluginDirs(root, { env, homeDir }).some(pluginDir =>
      fs.existsSync(path.join(pluginDir, 'plugin.json'))
    )) {
      return root;
    }
  }
  for (const root of roots) {
    if (fs.existsSync(path.join(root, 'settings.json'))) return root;
  }
  return roots[0];
}

function sourceUrl(sourceBase, relativePath) {
  return `${sourceBase.replace(/\/+$/, '')}/${relativePath}`;
}

function requestBuffer(url, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = parsed.protocol === 'http:' ? http : https;
    const req = client.get(parsed, response => {
      const status = response.statusCode || 0;
      if (status >= 300 && status < 400 && response.headers.location && redirectsLeft > 0) {
        response.resume();
        const nextUrl = new URL(response.headers.location, parsed);
        if (parsed.protocol === 'https:' && nextUrl.protocol === 'http:') {
          reject(new Error(`insecure redirect from https to http forbidden: ${url} -> ${nextUrl.toString()}`));
          return;
        }
        resolve(requestBuffer(nextUrl.toString(), redirectsLeft - 1));
        return;
      }
      if (status < 200 || status >= 300) {
        response.resume();
        reject(new Error(`download failed (${status}): ${url}`));
        return;
      }

      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.setTimeout(30_000, () => {
      req.destroy(new Error(`download timed out: ${url}`));
    });
    req.on('error', reject);
  });
}

async function readRuntimeFile(relativePath, options) {
  if (options.sourceDir) {
    return fs.readFileSync(path.join(options.sourceDir, ...relativePath.split('/')));
  }
  return requestBuffer(sourceUrl(options.sourceBase, relativePath));
}

// Files staged by older agy-hud versions that the current spec-compliant
// layout no longer ships. `agy plugin install` only OVERWRITES same-named
// files — it never deletes ones that disappeared between releases. So an
// upgrade from v0.1.x leaves an active hooks.json behind that fires its old
// base64-blob bootstrap on every model step and clobbers settings.json.
const STALE_PLUGIN_FILES = ['hooks.json', 'mcp_config.json'];
const STALE_PLUGIN_DIRS = ['agents', 'commands', 'rules', 'extensions'];

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function getPluginDirs(antigravityRoot, options = {}) {
  const env = options.env || process.env;
  const homeDir = options.homeDir || os.homedir();
  const dirs = [
    // agy 1.0.x stages imported plugins under ~/.gemini/config/plugins.
    path.join(homeDir, '.gemini', 'config', 'plugins', 'agy-hud'),
    // Older agy-hud releases and early agy builds used antigravity-cli/plugins.
    path.join(antigravityRoot, 'plugins', 'agy-hud'),
  ];

  if (env.XDG_CONFIG_HOME) {
    dirs.push(path.join(env.XDG_CONFIG_HOME, 'gemini', 'plugins', 'agy-hud'));
  }
  if (env.APPDATA) {
    dirs.push(path.join(env.APPDATA, 'gemini', 'plugins', 'agy-hud'));
  }

  return unique(dirs.map(dir => path.resolve(dir)));
}

function cleanStalePluginFiles(antigravityRoot, options = {}) {
  const removed = [];
  for (const pluginDir of getPluginDirs(antigravityRoot, options)) {
    if (!fs.existsSync(pluginDir)) continue;
    for (const f of STALE_PLUGIN_FILES) {
      const p = path.join(pluginDir, f);
      if (fs.existsSync(p)) {
        fs.rmSync(p, { force: true });
        removed.push(p);
      }
    }
    for (const d of STALE_PLUGIN_DIRS) {
      const p = path.join(pluginDir, d);
      if (fs.existsSync(p)) {
        fs.rmSync(p, { recursive: true, force: true });
        removed.push(p);
      }
    }
  }
  return removed;
}

function replaceRuntimeDirAtomically(runtimeDir, tempRuntimeDir) {
  const backupDir = `${runtimeDir}.bak-${process.pid}-${Date.now()}`;
  let backedUp = false;

  try {
    if (fs.existsSync(runtimeDir)) {
      fs.renameSync(runtimeDir, backupDir);
      backedUp = true;
    }
    fs.renameSync(tempRuntimeDir, runtimeDir);
    if (backedUp) fs.rmSync(backupDir, { recursive: true, force: true });
  } catch (error) {
    if (backedUp && fs.existsSync(runtimeDir)) {
      fs.rmSync(runtimeDir, { recursive: true, force: true });
    }
    if (backedUp && fs.existsSync(backupDir)) {
      fs.renameSync(backupDir, runtimeDir);
    }
    throw error;
  }
}

async function installRuntime(options = {}) {
  const env = options.env || process.env;
  const homeDir = options.homeDir || os.homedir();
  const sourceDir = options.sourceDir || env.AGY_HUD_SETUP_SOURCE_DIR || '';
  const sourceBase = options.sourceBase || env.AGY_HUD_REPO_RAW || env.AGY_HUD_SETUP_SOURCE_BASE || DEFAULT_SOURCE_BASE;
  const antigravityRoot = options.antigravityRoot || pickAntigravityRoot(env, homeDir);
  const runtimeDir = path.join(antigravityRoot, 'agy-hud-runtime');
  const tempRuntimeDir = `${runtimeDir}.tmp-${process.pid}-${Date.now()}`;

  const stalePluginFiles = cleanStalePluginFiles(antigravityRoot, { env, homeDir });
  fs.rmSync(tempRuntimeDir, { recursive: true, force: true });

  try {
    for (const relativePath of RUNTIME_FILES) {
      const body = await readRuntimeFile(relativePath, { sourceDir, sourceBase });
      const target = path.join(tempRuntimeDir, ...relativePath.split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, body);
    }
    replaceRuntimeDirAtomically(runtimeDir, tempRuntimeDir);
  } catch (error) {
    fs.rmSync(tempRuntimeDir, { recursive: true, force: true });
    throw error;
  }

  const installerPath = path.join(runtimeDir, 'runtime', 'statusline-installer.js');
  delete require.cache[require.resolve(installerPath)];
  const { configureStatusLine } = require(installerPath);
  const result = configureStatusLine(path.join(runtimeDir, 'runtime'), {
    settingsPath: path.join(antigravityRoot, 'settings.json'),
  });
  const quotaRefresh = await refreshQuotaCache(runtimeDir, { env, homeDir, platform: options.platform });

  return {
    antigravityRoot,
    runtimeDir,
    settingsPath: result.settingsPath,
    command: result.command,
    files: RUNTIME_FILES,
    stalePluginFiles,
    quotaRefresh,
  };
}

async function refreshQuotaCache(runtimeDir, options = {}) {
  try {
    const quotaPath = path.join(runtimeDir, 'runtime', 'quota.js');
    delete require.cache[require.resolve(quotaPath)];
    const { readToken, fetchQuotaFromCloud, fetchTierFromCloud, writeCache, isTokenExpired } = require(quotaPath);
    const env = options.env || process.env;
    const roots = getAntigravityRoots(env, options.homeDir || os.homedir());
    const token = readToken({ roots, platform: options.platform || process.platform });
    if (!token) return { status: 'skipped', reason: 'not_logged_in' };
    if (isTokenExpired(token)) return { status: 'skipped', reason: 'expired_token' };

    const [quota, tier] = await Promise.all([
      fetchQuotaFromCloud(token.accessToken),
      fetchTierFromCloud(token.accessToken).catch(() => null),
    ]);
    if (!Array.isArray(quota) || quota.length === 0) {
      return {
        status: 'skipped',
        reason: quota && quota.unavailableReason ? quota.unavailableReason : 'empty_quota',
      };
    }

    writeCache(quota, token, tier);
    return { status: 'refreshed', count: quota.length, tier: tier || null };
  } catch (error) {
    return { status: 'failed', reason: error.message };
  }
}

if (require.main === module) {
  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
  const run = async () => {
    if (process.argv.includes('--delay-start')) {
      await sleep(1000);
    }
    return installRuntime();
  };

  run()
    .then(result => {
      process.stdout.write(`AGY-HUD bootstrap complete\n`);
      process.stdout.write(`runtime: ${result.runtimeDir}\n`);
      process.stdout.write(`settings: ${result.settingsPath}\n`);
      process.stdout.write(`statusLine: ${result.command}\n`);
      if (result.stalePluginFiles.length > 0) {
        process.stdout.write(`cleaned ${result.stalePluginFiles.length} stale plugin file(s) from prior install\n`);
      }
      if (result.quotaRefresh.status === 'refreshed') {
        process.stdout.write(`quota: refreshed ${result.quotaRefresh.count}\n`);
      } else {
        process.stdout.write(`quota: ${result.quotaRefresh.status} ${result.quotaRefresh.reason || ''}\n`);
      }
    })
    .catch(error => {
      process.stderr.write(`${error.stack || error.message}\n`);
      process.exit(1);
    });
}

module.exports = {
  DEFAULT_SOURCE_BASE,
  RUNTIME_FILES,
  STALE_PLUGIN_FILES,
  STALE_PLUGIN_DIRS,
  getPluginDirs,
  getAntigravityRoots,
  pickAntigravityRoot,
  cleanStalePluginFiles,
  replaceRuntimeDirAtomically,
  installRuntime,
  refreshQuotaCache,
};
