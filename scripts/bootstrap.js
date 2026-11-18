#!/usr/bin/env node
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const DEFAULT_SOURCE_BASE = 'https://raw.githubusercontent.com/icebear0828/agy-hud/main';

export const RUNTIME_FILES = [
  'package.json',
  'plugin.json',
  'gemini-extension.json',
  'ARCHITECTURE.md',
  'dist/index.js',
  'hud.mjs',
  'collector.mjs',
  'fence.mjs',
  'install.mjs',
  'scripts/statusline.mjs',
  'runtime/bin/agy-hud.js',
  'runtime/bin/agy-hud.cmd',
  'runtime/config-wizard.mjs',
  'runtime/encoding.mjs',
  'runtime/paths.mjs',
  'runtime/quota.mjs',
  'runtime/uninstall.mjs',
  'runtime/update-checker.mjs',
  'runtime/quota/cache.mjs',
  'runtime/quota/cloud.mjs',
  'runtime/quota/models.mjs',
  'runtime/quota/token.mjs',
  'src/agy-quota.ts',
  'src/auth.ts',
  'src/channel.ts',
  'src/commands.ts',
  'src/config-reader.ts',
  'src/config.ts',
  'src/cost.ts',
  'src/daily-cost.ts',
  'src/debug.ts',
  'src/effort.ts',
  'src/external-usage.ts',
  'src/extra-cmd.ts',
  'src/git.ts',
  'src/i18n/en.ts',
  'src/i18n/index.ts',
  'src/i18n/types.ts',
  'src/i18n/zh-Hans.ts',
  'src/i18n/zh-Hant.ts',
  'src/index.ts',
  'src/jj.ts',
  'src/main.ts',
  'src/memory.ts',
  'src/model-source.ts',
  'src/render/activity.ts',
  'src/render/ansi.ts',
  'src/render/colors.ts',
  'src/render/compact.ts',
  'src/render/context.ts',
  'src/render/derive.ts',
  'src/render/expanded.ts',
  'src/render/frame.ts',
  'src/render/index.ts',
  'src/render/labels.ts',
  'src/render/lines.ts',
  'src/render/order.ts',
  'src/render/parts.ts',
  'src/render/quota-table.ts',
  'src/render/time.ts',
  'src/render/usage.ts',
  'src/render/vcs.ts',
  'src/schema.ts',
  'src/speed.ts',
  'src/stdin.ts',
  'src/transcript.ts',
  'src/types.ts',
  'src/usage-pace.ts',
  'src/utils/format.ts',
  'src/utils/hyperlinks.ts',
  'src/utils/sanitize.ts',
  'src/utils/terminal.ts',
  'src/utils/truncate.ts',
];

export const STALE_PLUGIN_FILES = ['hooks.json', 'mcp_config.json'];
export const STALE_PLUGIN_DIRS = ['agents', 'commands', 'rules', 'extensions'];

export function getAntigravityRoots(env = process.env, homeDir = os.homedir()) {
  if (env.AGY_HUD_DATA_DIR?.trim()) {
    return [path.resolve(env.AGY_HUD_DATA_DIR.trim())];
  }
  return [
    path.join(homeDir, '.gemini', 'antigravity-cli'),
    env.XDG_DATA_HOME ? path.join(env.XDG_DATA_HOME, 'antigravity-cli') : null,
    env.APPDATA ? path.join(env.APPDATA, 'antigravity-cli') : null,
    env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'antigravity-cli') : null,
  ].filter(Boolean);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

export function getPluginDirs(antigravityRoot, options = {}) {
  const env = options.env || process.env;
  const homeDir = options.homeDir || os.homedir();
  const dirs = [
    path.join(homeDir, '.gemini', 'config', 'plugins', 'agy-hud'),
    path.join(antigravityRoot, 'plugins', 'agy-hud'),
  ];
  if (env.XDG_CONFIG_HOME) dirs.push(path.join(env.XDG_CONFIG_HOME, 'gemini', 'plugins', 'agy-hud'));
  if (env.APPDATA) dirs.push(path.join(env.APPDATA, 'gemini', 'plugins', 'agy-hud'));
  return unique(dirs.map((dir) => path.resolve(dir)));
}

export function pickAntigravityRoot(env = process.env, homeDir = os.homedir()) {
  const roots = getAntigravityRoots(env, homeDir);
  for (const root of roots) {
    if (getPluginDirs(root, { env, homeDir }).some((pluginDir) => fs.existsSync(path.join(pluginDir, 'plugin.json')))) {
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

function makeHttpError(message, status, retryAfterSec = null) {
  const err = new Error(message);
  err.status = status;
  err.retryAfterSec = retryAfterSec;
  err.retryable = status === 408 || status === 429 || status >= 500;
  return err;
}

function requestBuffer(url, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = parsed.protocol === 'http:' ? http : https;
    const req = client.get(parsed, {
      headers: {
        'User-Agent': 'agy-hud-bootstrap',
        Connection: 'close',
      },
    }, (response) => {
      const status = response.statusCode || 0;
      if (status >= 300 && status < 400 && response.headers.location && redirectsLeft > 0) {
        response.resume();
        const nextUrl = new URL(response.headers.location, parsed);
        if (parsed.protocol === 'https:' && nextUrl.protocol === 'http:') {
          reject(makeHttpError(`insecure redirect from https to http forbidden: ${url} -> ${nextUrl.toString()}`, 400));
          return;
        }
        resolve(requestBuffer(nextUrl.toString(), redirectsLeft - 1));
        return;
      }
      if (status < 200 || status >= 300) {
        response.resume();
        const retryAfter = Number(response.headers['retry-after']);
        reject(makeHttpError(
          `download failed (${status}): ${url}`,
          status,
          Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
        ));
        return;
      }

      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.setTimeout(30_000, () => {
      req.destroy(new Error(`download timed out: ${url}`));
    });
    req.on('error', reject);
  });
}

async function requestBufferWithRetry(url, maxAttempts = 5, retryBaseMs = 1000) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await requestBuffer(url);
    } catch (err) {
      lastErr = err;
      if (err && err.retryable === false) throw err;
      if (attempt < maxAttempts) {
        const expMs = Math.min(8, Math.pow(2, attempt - 1)) * retryBaseMs;
        const headerMs = err?.retryAfterSec ? Math.min(10, err.retryAfterSec) * retryBaseMs : 0;
        const delayMs = Math.max(expMs, headerMs);
        const label = delayMs >= 1000 ? `${Math.round(delayMs / 1000)}s` : `${delayMs}ms`;
        process.stderr.write(`[agy-hud] download attempt ${attempt} failed (${err.message}), retrying in ${label}...\n`);
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }
  throw lastErr;
}

async function readRuntimeFile(relativePath, options) {
  if (options.sourceDir) {
    return fs.readFileSync(path.join(options.sourceDir, ...relativePath.split('/')));
  }
  return requestBufferWithRetry(sourceUrl(options.sourceBase, relativePath), options.maxAttempts, options.retryBaseMs);
}

export function cleanStalePluginFiles(antigravityRoot, options = {}) {
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

export function replaceRuntimeDirAtomically(runtimeDir, tempRuntimeDir) {
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

async function mapConcurrent(items, limit, fn) {
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const current = items[index++];
      await fn(current);
    }
  });
  await Promise.all(workers);
}

export async function refreshQuotaCache(runtimeDir, options = {}) {
  try {
    const quotaUrl = `${pathToFileURL(path.join(runtimeDir, 'runtime', 'quota.mjs')).href}?t=${Date.now()}`;
    const {
      readToken,
      fetchQuotaFromCloud,
      fetchTierFromCloud,
      fetchAccountEmail,
      writeCache,
      isTokenExpired,
    } = await import(quotaUrl);
    const env = options.env || process.env;
    const roots = getAntigravityRoots(env, options.homeDir || os.homedir());
    const token = readToken({ roots, platform: options.platform || process.platform, keyringReader: options.keyringReader });
    if (!token) return { status: 'skipped', reason: 'not_logged_in' };
    if (isTokenExpired(token)) return { status: 'skipped', reason: 'expired_token' };

    const [quota, tier, accountEmail] = await Promise.all([
      fetchQuotaFromCloud(token.accessToken),
      fetchTierFromCloud(token.accessToken).catch(() => null),
      fetchAccountEmail(token.accessToken).catch(() => null),
    ]);
    if (!Array.isArray(quota) || quota.length === 0) {
      return {
        status: 'skipped',
        reason: quota && quota.unavailableReason ? quota.unavailableReason : 'empty_quota',
      };
    }

    const cachePath = path.join(roots[0], 'agy-hud-quota-cache.json');
    writeCache(quota, token, tier, accountEmail, quota.providerQuota, cachePath);
    return { status: 'refreshed', count: quota.length, tier: tier || null };
  } catch (error) {
    return { status: 'failed', reason: error.message };
  }
}

export async function installRuntime(options = {}) {
  const env = options.env || process.env;
  const homeDir = options.homeDir || os.homedir();
  const repoCandidate = path.resolve(__dirname, '..');
  const hasLocalRuntime =
    fs.existsSync(path.join(repoCandidate, 'hud.mjs'))
    && fs.existsSync(path.join(repoCandidate, 'src', 'main.ts'));
  const hasExplicitRemote = Boolean(options.sourceBase || env.AGY_HUD_REPO_RAW || env.AGY_HUD_SETUP_SOURCE_BASE);
  const sourceDir = options.sourceDir || env.AGY_HUD_SETUP_SOURCE_DIR || (!hasExplicitRemote && hasLocalRuntime ? repoCandidate : '');
  const sourceBase = options.sourceBase || env.AGY_HUD_REPO_RAW || env.AGY_HUD_SETUP_SOURCE_BASE || DEFAULT_SOURCE_BASE;
  const antigravityRoot = options.antigravityRoot || pickAntigravityRoot(env, homeDir);
  const runtimeDir = path.join(antigravityRoot, 'agy-hud-runtime');
  const tempRuntimeDir = `${runtimeDir}.tmp-${process.pid}-${Date.now()}`;

  const stalePluginFiles = cleanStalePluginFiles(antigravityRoot, { env, homeDir });
  fs.rmSync(tempRuntimeDir, { recursive: true, force: true });

  if ((options.platform || process.platform) === 'darwin') {
    const legacyTempToken = path.join(antigravityRoot, 'agy-hud-token.json');
    if (fs.existsSync(legacyTempToken)) {
      try { fs.rmSync(legacyTempToken, { force: true }); } catch {}
    }
  }

  try {
    await mapConcurrent(RUNTIME_FILES, sourceDir ? 16 : 3, async (relativePath) => {
      const body = await readRuntimeFile(relativePath, {
        sourceDir,
        sourceBase,
        maxAttempts: options.maxAttempts,
        retryBaseMs: options.retryBaseMs,
      });
      const target = path.join(tempRuntimeDir, ...relativePath.split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, body);
    });
    fs.mkdirSync(path.dirname(runtimeDir), { recursive: true });
    replaceRuntimeDirAtomically(runtimeDir, tempRuntimeDir);
  } catch (error) {
    fs.rmSync(tempRuntimeDir, { recursive: true, force: true });
    throw error;
  }

  const installerUrl = `${pathToFileURL(path.join(runtimeDir, 'install.mjs')).href}?t=${Date.now()}`;
  const { install, writeCmdShim } = await import(installerUrl);
  const installReport = install({
    configDir: antigravityRoot,
    hudDir: path.join(antigravityRoot, 'agy-hud'),
    argv: ['--replace'],
    env,
  });
  if ((options.platform || process.platform) === 'win32') {
    writeCmdShim(path.join(runtimeDir, 'runtime', 'bin', 'agy-hud.js'), options.platform || process.platform);
  }

  const quotaRefresh = await refreshQuotaCache(runtimeDir, {
    env,
    homeDir,
    platform: options.platform,
    keyringReader: options.keyringReader,
  });

  return {
    antigravityRoot,
    runtimeDir,
    settingsPath: installReport.settingsPath,
    command: installReport.command,
    files: RUNTIME_FILES,
    stalePluginFiles,
    quotaRefresh,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const run = async () => {
    if (process.argv.includes('--delay-start')) await sleep(1000);
    return installRuntime();
  };

  run()
    .then((result) => {
      process.stdout.write('AGY-HUD bootstrap complete\n');
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
    .catch((error) => {
      process.stderr.write(`${error.stack || error.message}\n`);
      process.exit(1);
    });
}
