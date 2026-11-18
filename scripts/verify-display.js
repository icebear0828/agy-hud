#!/usr/bin/env node
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const zipPath = path.join(projectRoot, 'agy-hud.zip');
const agyBin = process.env.AGY_BIN || 'agy';
const currentHome = process.argv.includes('--current-home');
const timeoutArg = process.argv.find((arg) => arg.startsWith('--observe-timeout-ms='));
const observeTimeoutMs = timeoutArg ? Number(timeoutArg.split('=')[1]) : 12_000;

export function stripAnsi(value) {
  return value
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
}

export function detectHudRender(...values) {
  return values
    .filter((value) => typeof value === 'string' && value.trim())
    .some((value) => {
      const plain = stripAnsi(value).replace(/\u00A0/g, ' ');
      const hasModelBadge = /\[[A-Za-z0-9][^\]]*\]/.test(plain);
      const hasContextBar = /(?:Context|上下文)\s+(?:[█░#-]{3,}\s+)?\d+%/i.test(plain);
      return hasModelBadge && hasContextBar;
    });
}

export function renderTerminalScreen(value, width = 160) {
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
        const bell = value.indexOf('\x07', i + 2);
        const st = value.indexOf('\x1b\\', i + 2);
        const end = bell !== -1 && (st === -1 || bell < st) ? bell + 1 : st !== -1 ? st + 2 : value.length;
        i = end;
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
    .map((chars) => chars.join('').replace(/\s+$/g, ''))
    .join('\n');
}

function fail(message, details) {
  process.stderr.write(`${message}\n`);
  if (details) process.stderr.write(`${JSON.stringify(details, null, 2)}\n`);
  process.exit(1);
}

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd || projectRoot,
      env: options.env || process.env,
      shell: options.shell || false,
    });
    if (options.stdin !== undefined) {
      child.stdin.end(options.stdin);
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 1000).unref();
    }, options.timeout || 90_000);
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stdout, stderr, timedOut, error: null });
    });
    child.on('error', (error) => {
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

  return new Promise((resolve) => {
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
  for (const rel of [
    path.join('antigravity-cli', 'antigravity-oauth-token'),
    'oauth_creds.json',
    'google_accounts.json',
  ]) {
    const src = path.join(os.homedir(), '.gemini', rel);
    if (fs.existsSync(src)) {
      const dst = path.join(home, '.gemini', rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
    }
  }
  return env;
}

function getPluginDirs(env) {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  const base = path.join(home, '.gemini', 'antigravity-cli');
  const dirs = [
    path.join(home, '.gemini', 'config', 'plugins', 'agy-hud'),
    path.join(base, 'plugins', 'agy-hud'),
  ];
  if (env.XDG_CONFIG_HOME) dirs.push(path.join(env.XDG_CONFIG_HOME, 'gemini', 'plugins', 'agy-hud'));
  if (env.APPDATA) dirs.push(path.join(env.APPDATA, 'gemini', 'plugins', 'agy-hud'));
  return [...new Set(dirs.map((dir) => path.resolve(dir)))];
}

function readInstallState(env) {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  const base = path.join(home, '.gemini', 'antigravity-cli');
  const settingsPath = path.join(base, 'settings.json');
  const pluginDirs = getPluginDirs(env);
  const runtimeDir = path.join(base, 'agy-hud-runtime');
  let settings = null;
  try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch {}
  return {
    base,
    settingsExists: fs.existsSync(settingsPath),
    statusLine: settings && settings.statusLine ? settings.statusLine : null,
    pluginExists: pluginDirs.some((pluginDir) => fs.existsSync(pluginDir)),
    pluginDirs: pluginDirs.filter((pluginDir) => fs.existsSync(pluginDir)),
    runtimeExists: fs.existsSync(runtimeDir),
    runtimeHudExists: fs.existsSync(path.join(runtimeDir, 'hud.mjs')) && fs.existsSync(path.join(base, 'agy-hud', 'statusline.mjs')),
  };
}

function findExecutableOnPath(name) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function observeLocalAgy(env) {
  return new Promise((resolve) => {
    const hasExpect = fs.existsSync('/usr/bin/expect');
    const python3Bin = findExecutableOnPath('python3');
    const hasScript = process.platform !== 'win32' && fs.existsSync('/usr/bin/script');
    let command;
    let args;
    let mode;
    const observeSecs = Math.max(5, Math.floor(observeTimeoutMs / 1000) - 8);
    if (hasExpect) {
      command = '/usr/bin/expect';
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
    } else if (process.platform !== 'win32' && python3Bin) {
      const pyScript = [
        'import fcntl, os, pty, select, struct, sys, termios, time',
        'pid, fd = pty.fork()',
        'if pid == 0:',
        `    os.execvp(${JSON.stringify(agyBin)}, [${JSON.stringify(agyBin)}])`,
        'fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 180, 0, 0))',
        'def drain(sec):',
        '    end = time.monotonic() + sec',
        '    while time.monotonic() < end:',
        '        r, _, _ = select.select([fd], [], [], max(0.05, end - time.monotonic()))',
        '        if fd in r:',
        '            try:',
        '                data = os.read(fd, 8192)',
        '                if not data: return False',
        '                sys.stdout.buffer.write(data)',
        '                sys.stdout.buffer.flush()',
        '            except OSError: return False',
        '    return True',
        'if drain(6):',
        '    try: os.write(fd, b"hello\\r")',
        '    except OSError: pass',
        `    if drain(${observeSecs}):`,
        '        try: os.write(fd, b"\\x03")',
        '        except OSError: pass',
        '        drain(2)',
        'try: os.close(fd)',
        'except OSError: pass',
        'os.waitpid(pid, 0)',
      ].join('\n');
      command = python3Bin;
      args = ['-c', pyScript];
      mode = 'python-pty';
    } else if (hasScript) {
      command = 'bash';
      args = process.platform === 'darwin'
        ? ['-c', `/usr/bin/script -q /dev/null ${agyBin} < /dev/null`]
        : ['-c', `/usr/bin/script -q -c "${agyBin}" /dev/null < /dev/null`];
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

    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { stderr += data.toString(); });
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, timedOut, stdout, stderr, mode });
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ status: null, signal: null, timedOut, stdout, stderr, error: error.message, mode });
    });
  });
}

async function main() {
  if (!process.env.AGY_HUD_SKIP_BUILD) {
    execFileSync('bash', ['release.sh', '--local'], {
      cwd: projectRoot,
      stdio: process.env.AGY_HUD_VERIFY_VERBOSE ? 'inherit' : 'ignore',
    });
  }

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-verify-'));
  const env = buildEnv(tmpRoot);
  const { server } = await startZipServer();
  try {
    const install = await run(agyBin, ['plugin', 'install', projectRoot], { env, timeout: 120_000 });
    const stagedPluginDir = getPluginDirs(env).find((pluginDir) => fs.existsSync(pluginDir));
    const planted = stagedPluginDir ? path.join(stagedPluginDir, 'hooks.json') : null;
    if (stagedPluginDir) {
      fs.writeFileSync(planted, JSON.stringify({
        post_invocation_hooks: [{ command: 'echo simulated-stale-hook-from-v0.1.x' }],
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

    let observation;
    if (noAuthMode) {
      const stateNow = readInstallState(env);
      const cmd = stateNow.statusLine && stateNow.statusLine.command;
      if (!cmd) {
        observation = { stdout: '', stderr: 'no statusLine.command in settings.json', mode: 'no-auth-direct', status: 1 };
      } else {
        const emptyRes = await run(cmd, [], { env, stdin: '\n', shell: true, timeout: 10_000 });
        const sample = JSON.stringify({
          model: { id: 'gemini-3-pro', display_name: 'Gemini 3 Pro (High)' },
          cwd: projectRoot,
          context_window: { context_window_size: 200_000, used_percentage: 42 },
          rate_limits: { five_hour: { used_percentage: 20, resets_at: Math.floor(Date.now() / 1000) + 7200 } },
        });
        const direct = await run(cmd, [], { env, stdin: `${sample}\n`, shell: true, timeout: 10_000 });
        observation = {
          stdout: direct.stdout,
          stderr: direct.stderr,
          mode: 'no-auth-direct',
          status: emptyRes.status === 0 && emptyRes.stdout === '' ? direct.status : 1,
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

    const artifactDir = process.env.AGY_HUD_E2E_ARTIFACT_DIR || os.tmpdir();
    const artifactPath = path.join(artifactDir, `agy-hud-pty-${Date.now()}.log`);
    try { fs.writeFileSync(artifactPath, observedRaw); } catch {}

    const report = {
      ok: displayReady,
      homeMode: currentHome ? 'current-home' : 'isolated-home',
      install: {
        status: install.status,
        processedSkills: /skills\s+:\s+\d+ processed/.test(stripAnsi(`${install.stdout}\n${install.stderr}`)),
      },
      bootstrap: { status: bootstrap.status },
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

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    fail(error.stack || error.message);
  });
}
