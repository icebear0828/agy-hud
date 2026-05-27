#!/usr/bin/env node
'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const projectRoot = path.resolve(__dirname, '..');
const zipPath = path.join(projectRoot, 'agy-hud.zip');
const agyBin = process.env.AGY_BIN || 'agy';
const currentHome = process.argv.includes('--current-home');
const timeoutArg = process.argv.find(arg => arg.startsWith('--observe-timeout-ms='));
const observeTimeoutMs = timeoutArg ? Number(timeoutArg.split('=')[1]) : 12_000;

function stripAnsi(value) {
  return value
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
}

function detectHudRender(...values) {
  return values
    .filter(value => typeof value === 'string' && value.trim())
    .some(value => {
      const plain = stripAnsi(value);
      const hasBranch = /(?:⎇||\[B\])\s*\S+/.test(plain);
      const hasContext = /(?:⛁|󱔐|\[C\])\s*\d+(?:\.\d+)?[kM]?\/\d+(?:\.\d+)?[kM]?/i.test(plain);
      const hasTokenBreakdown = /(?:⚿|󰚩|\[Tk\]|Tokens)\s*(?:Tokens\s+)?\d+(?:\.\d+)?[kM]?\s*(?:↑|\^|\(in:)/i.test(plain);

      return hasBranch && hasContext && hasTokenBreakdown;
    });
}

function renderTerminalScreen(value, width = 160) {
  const rows = [[]];
  let row = 0;
  let col = 0;
  let i = 0;

  function ensureRow(index) {
    while (rows.length <= index) rows.push([]);
  }

  function clearLineFromCursor() {
    ensureRow(row);
    rows[row].length = Math.min(rows[row].length, col);
  }

  while (i < value.length) {
    const ch = value[i];

    if (ch === '\x1b') {
      if (value[i + 1] === ']') {
        const end = value.indexOf('\x07', i + 2);
        i = end === -1 ? value.length : end + 1;
        continue;
      }

      if (value[i + 1] === '[') {
        const match = value.slice(i).match(/^\x1b\[([0-9;?]*)(?:[ -/]*)([@-~])/);
        if (match) {
          const params = match[1].replace(/\?/g, '').split(';').filter(Boolean).map(Number);
          const command = match[2];
          if (command === 'H' || command === 'f') {
            row = Math.max(0, (params[0] || 1) - 1);
            col = Math.max(0, (params[1] || 1) - 1);
            ensureRow(row);
          } else if (command === 'C') {
            col += params[0] || 1;
          } else if (command === 'D') {
            col = Math.max(0, col - (params[0] || 1));
          } else if (command === 'A') {
            row = Math.max(0, row - (params[0] || 1));
          } else if (command === 'B') {
            row += params[0] || 1;
            ensureRow(row);
          } else if (command === 'K') {
            clearLineFromCursor();
          } else if (command === 'J' && (params[0] || 0) === 2) {
            rows.length = 0;
            rows.push([]);
            row = 0;
            col = 0;
          }
          i += match[0].length;
          continue;
        }
      }

      i += 1;
      continue;
    }

    if (ch === '\r') {
      col = 0;
      i += 1;
      continue;
    }

    if (ch === '\n') {
      row += 1;
      col = 0;
      ensureRow(row);
      i += 1;
      continue;
    }

    ensureRow(row);
    if (col < width) rows[row][col] = ch;
    col += 1;
    i += 1;
  }

  return rows
    .map(chars => chars.join('').replace(/\s+$/g, ''))
    .join('\n');
}

function fail(message, details) {
  process.stderr.write(`${message}\n`);
  if (details) process.stderr.write(`${JSON.stringify(details, null, 2)}\n`);
  process.exit(1);
}

function run(command, args, options = {}) {
  // MUST be async: spawnSync blocks the Node event loop, which deadlocks the
  // in-process zip HTTP server. agy download hangs → SIGTERM at timeout.
  return new Promise(resolve => {
    const child = spawn(command, args, {
      cwd: options.cwd || projectRoot,
      env: options.env || process.env,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 1000).unref();
    }, options.timeout || 90_000);
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stdout, stderr, timedOut, error: null });
    });
    child.on('error', error => {
      clearTimeout(timer);
      resolve({ status: null, signal: null, stdout, stderr, timedOut, error });
    });
  });
}

function startZipServer() {
  const server = http.createServer((req, res) => {
    if (req.url !== '/agy-hud.zip') {
      res.writeHead(404);
      res.end();
      return;
    }
    const stat = fs.statSync(zipPath);
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Length': stat.size,
    });
    fs.createReadStream(zipPath).pipe(res);
  });

  return new Promise(resolve => {
    server.listen(0, () => {
      resolve({
        server,
        url: `http://localhost:${server.address().port}/agy-hud.zip`,
      });
    });
  });
}

function buildEnv(tmpRoot) {
  if (currentHome) return process.env;
  const home = path.join(tmpRoot, 'home');
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
  };
  if (process.platform === 'win32') {
    env.APPDATA = path.join(home, 'AppData', 'Roaming');
    env.LOCALAPPDATA = path.join(home, 'AppData', 'Local');
  } else {
    env.XDG_DATA_HOME = path.join(tmpRoot, 'xdg');
  }
  // Mirror the real OAuth token so agy in the isolated HOME can pass sign-in
  // and actually render its TUI (including the statusLine). Without this, agy
  // boots into the sign-in screen and never invokes statusLine_runner.
  const realToken = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
  if (fs.existsSync(realToken)) {
    const dst = path.join(home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(realToken, dst);
  }
  return env;
}

function readInstallState(env) {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  const base = path.join(home, '.gemini', 'antigravity-cli');
  const settingsPath = path.join(base, 'settings.json');
  const pluginDirs = getPluginDirs(env);
  const runtimeDir = path.join(base, 'agy-hud-runtime');
  let settings = null;
  try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch { /* missing */ }
  return {
    base,
    settingsExists: fs.existsSync(settingsPath),
    statusLine: settings && settings.statusLine ? settings.statusLine : null,
    pluginExists: pluginDirs.some(pluginDir => fs.existsSync(pluginDir)),
    pluginDirs: pluginDirs.filter(pluginDir => fs.existsSync(pluginDir)),
    runtimeExists: fs.existsSync(runtimeDir),
    runtimeHudExists: fs.existsSync(path.join(runtimeDir, 'runtime', 'bin', 'agy-hud.js')),
  };
}

function getPluginDirs(env) {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  const base = path.join(home, '.gemini', 'antigravity-cli');
  const dirs = [
    path.join(home, '.gemini', 'config', 'plugins', 'agy-hud'),
    path.join(base, 'plugins', 'agy-hud'),
  ];
  if (env.XDG_CONFIG_HOME) {
    dirs.push(path.join(env.XDG_CONFIG_HOME, 'gemini', 'plugins', 'agy-hud'));
  }
  if (env.APPDATA) {
    dirs.push(path.join(env.APPDATA, 'gemini', 'plugins', 'agy-hud'));
  }
  return [...new Set(dirs.map(dir => path.resolve(dir)))];
}

function observeLocalAgy(env) {
  return new Promise(resolve => {
    // Need a real PTY so agy renders its TUI (including statusLine). `script`
    // requires a TTY on its own stdin, but node spawn() always gives a pipe.
    // Workaround: use `expect` which natively allocates a PTY. Falls back to
    // `script` with /dev/null stdin (degraded but better than plain pipe).
    const hasExpect = fs.existsSync('/usr/bin/expect');
    const hasScript = process.platform !== 'win32' && fs.existsSync('/usr/bin/script');
    let command;
    let args;
    let mode;
    if (hasExpect) {
      command = '/usr/bin/expect';
      // agy requires a PTY *with dimensions* to render its TUI. `stty rows X
      // cols Y` inside the spawned bash sets the PTY size. After agy is up,
      // send a prompt to trigger a model step — statusLine_runner only fires
      // per-step, not at startup. Then wait for the response + statusLine
      // render. SIGINT (^C) at the end so agy exits cleanly.
      const observeSecs = Math.max(5, Math.floor(observeTimeoutMs / 1000) - 8);
      args = ['-c', [
        'set timeout 120',
        `spawn -noecho bash -c "stty rows 40 cols 180; ${agyBin}"`,
        'sleep 6',
        'send "hello\\r"',
        `sleep ${observeSecs}`,
        'send "\\003"',
        'expect eof',
      ].join('; ')];
      mode = 'expect-pty';
    } else if (hasScript) {
      command = 'bash';
      args = ['-c', `/usr/bin/script -q /dev/null ${agyBin} < /dev/null`];
      mode = 'script-tty';
    } else {
      command = agyBin;
      args = [];
      mode = 'plain';
    }
    const child = spawn(command, args, {
      env: { ...env, TERM: env.TERM || 'xterm-256color' },
      cwd: os.homedir(),
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 1000).unref();
    }, observeTimeoutMs);

    child.stdout.on('data', data => {
      stdout += data.toString();
    });
    child.stderr.on('data', data => {
      stderr += data.toString();
    });
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, timedOut, stdout, stderr, mode });
    });
    child.on('error', error => {
      clearTimeout(timer);
      resolve({ status: null, signal: null, timedOut, stdout, stderr, error: error.message, mode });
    });
  });
}

async function main() {
  // Skip the zip build when caller already did it (e.g. release.sh's E2E
  // gate). Without this, release.sh → verify-display.js → release.sh =
  // infinite recursion.
  if (!process.env.AGY_HUD_SKIP_BUILD) {
    execFileSync('bash', ['release.sh', '--local'], {
      cwd: projectRoot,
      stdio: process.env.AGY_HUD_VERIFY_VERBOSE ? 'inherit' : 'ignore',
    });
  }

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-verify-'));
  const env = buildEnv(tmpRoot);
  const { server, url } = await startZipServer();
  try {
    const install = await run(agyBin, ['plugin', 'install', url], { env, timeout: 120_000 });

    // Upgrade-from-old-version scenario: plant a fake stale hooks.json in the
    // staged plugin dir BEFORE bootstrap. v0.1.x left this behind in real
    // user installs, fired a base64 blob hook every model step, and clobbered
    // settings.json statusLine. Bootstrap must clean it.
    const stagedPluginDir = getPluginDirs(env).find(pluginDir => fs.existsSync(pluginDir));
    const planted = stagedPluginDir ? path.join(stagedPluginDir, 'hooks.json') : null;
    if (stagedPluginDir) {
      fs.writeFileSync(planted, JSON.stringify({
        post_invocation_hooks: [{ command: 'echo simulated-stale-hook-from-v0.1.x' }]
      }));
    }
    const stalePresentBeforeBootstrap = Boolean(planted && fs.existsSync(planted));
    const noAuthMode = process.env.AGY_HUD_E2E_NO_AUTH_OBSERVE === '1';
    if (install.status !== 0 || !/\[ok\]/.test(install.stdout || '')) {
      fail('agy plugin install failed', {
        status: install.status,
        signal: install.signal,
        stdout: install.stdout,
        stderr: install.stderr,
        error: install.error && install.error.message,
      });
    }

    const afterInstall = readInstallState(env);

    // Two-step install: plugin install does not run JS. Bootstrap explicitly.
    const bootstrap = await run(process.execPath, [path.join(projectRoot, 'scripts', 'bootstrap.js')], {
      env: { ...env, AGY_HUD_SETUP_SOURCE_DIR: projectRoot },
      timeout: 60_000,
    });
    if (bootstrap.status !== 0) {
      fail('agy-hud bootstrap failed', {
        status: bootstrap.status,
        stdout: bootstrap.stdout,
        stderr: bootstrap.stderr,
      });
    }

    // No-auth mode (CI): skip the agy-session PTY spawn (needs OAuth) and
    // directly invoke the configured statusLine command. Catches install,
    // bootstrap, and standalone runtime rendering issues; the auth-required
    // "HUD visible inside live agy session" check stays in dev / release.sh.
    let observation;
    if (noAuthMode) {
      const stateNow = readInstallState(env);
      const cmd = stateNow.statusLine && stateNow.statusLine.command;
      if (!cmd) {
        observation = { stdout: '', stderr: 'no statusLine.command in settings.json', mode: 'no-auth-direct', status: 1 };
      } else {
        const direct = await run('bash', ['-c', `echo '' | ${cmd}`], { env, timeout: 10_000 });
        observation = {
          stdout: direct.stdout,
          stderr: direct.stderr,
          mode: 'no-auth-direct',
          status: direct.status,
        };
      }
    } else {
      observation = await observeLocalAgy(env);
    }
    const observedRaw = `${observation.stdout || ''}\n${observation.stderr || ''}`;
    const observedPlain = stripAnsi(observedRaw);
    const observedScreen = renderTerminalScreen(observedRaw);
    const afterObserve = readInstallState(env);
    const hudVisible = detectHudRender(observedRaw, observedScreen, observedPlain);
    const streamHudPresent = detectHudRender(observedRaw, observedPlain);
    const statusLineReady = Boolean(afterObserve.statusLine && /agy-hud/i.test(String(afterObserve.statusLine.command || '')));
    const runtimeReady = Boolean(afterObserve.runtimeHudExists);
    const staleCleaned = stalePresentBeforeBootstrap ? !fs.existsSync(planted) : true;
    const displayReady = hudVisible && statusLineReady && runtimeReady && staleCleaned;

    // Dump raw PTY bytes as artifact so CI can upload and reviewers can
    // `cat` the file in their own terminal and see the colored HUD render.
    const artifactDir = process.env.AGY_HUD_E2E_ARTIFACT_DIR || os.tmpdir();
    const artifactPath = path.join(artifactDir, `agy-hud-pty-${Date.now()}.log`);
    try {
      fs.writeFileSync(artifactPath, observedRaw);
    } catch { /* artifact best-effort */ }

    const report = {
      ok: displayReady,
      homeMode: currentHome ? 'current-home' : 'isolated-home',
      install: {
        status: install.status,
        processedSkills: /skills\s+:\s+\d+ processed/.test(stripAnsi(`${install.stdout}\n${install.stderr}`)),
      },
      bootstrap: {
        status: bootstrap.status,
      },
      afterInstall,
      observe: {
        mode: observation.mode,
        status: observation.status,
        signal: observation.signal,
        timedOut: observation.timedOut,
        hudVisible,
        streamHudPresent,
        statusLineReady,
        runtimeReady,
        displayReady,
        staleCleaned,
        stalePresentBeforeBootstrap,
        artifactPath,
        outputPreview: observedScreen.split(/\r?\n/).slice(0, 24),
        streamPreview: observedPlain.split(/\r?\n/).slice(0, 24),
        error: observation.error,
      },
      afterObserve,
    };

    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!displayReady) process.exit(1);
  } finally {
    server.close();
    if (!currentHome) fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

module.exports = {
  stripAnsi,
  renderTerminalScreen,
  detectHudRender,
};

if (require.main === module) {
  main().catch(error => {
    fail(error.stack || error.message);
  });
}
