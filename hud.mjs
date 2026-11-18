import { spawn } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as collector from './collector.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const LOGIC = path.join(ROOT, 'src', 'main.ts');
const FENCE = pathToFileURL(path.join(ROOT, 'fence.mjs')).href;
const MAX_OUTPUT_BYTES = 64 * 1024;
const WALL_MS = 10_000;

export function isHudDisabled(env = process.env) {
  const value = (env.AGY_HUD_DISABLE ?? env.CLAUDE_HUD_DISABLE)?.trim().toLowerCase();
  return Boolean(value) && !['0', 'false', 'off', 'no'].includes(value);
}

const upgradeLine = (runtime) => `agy-hud needs Node 22.18+ (this is ${runtime}). Type /hud to fix it.`;

// Whole escape sequences (CSI, OSC, other ESC), then single control and bidi characters.
const ESCAPES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[ -/]*[0-~]?|[\x00-\x1f\x7f-\x9f؜‎‏‪-‮⁦-⁩]/g;
const SGR = /^\x1b\[[0-9;]*m$/;
const OSC8 = /^\x1b\]8;;(.*)\x1b\\$/s;
const GITHUB_NAME = /^[A-Za-z0-9_.-]+$/;

export function terminalFilter(stdin, fallbackRepo = null) {
  const repo = stdin?.workspace?.repo ?? fallbackRepo;
  const pages = repo?.host === 'github.com' && GITHUB_NAME.test(repo.owner ?? '') && GITHUB_NAME.test(repo.name ?? '')
    ? `https://github.com/${repo.owner}/${repo.name}/`
    : null;
  const linkAllowed = (target) => {
    if (target === '') return true;
    try {
      const url = new URL(target);
      return url.protocol === 'file:' || (pages !== null && url.href === target && target.startsWith(pages));
    } catch {
      return false;
    }
  };
  const keep = (sequence) => {
    const link = OSC8.exec(sequence);
    return SGR.test(sequence) || (link !== null && linkAllowed(link[1]));
  };
  return (line) => String(line).replace(ESCAPES, (sequence) => (keep(sequence) ? sequence : ''));
}

function print(lines, stdin = null, fallbackRepo = null) {
  if (lines.length === 0) return;
  const filter = terminalFilter(stdin, fallbackRepo);
  process.stdout.write(lines.map((line) => `${filter(line)}\n`).join(''));
}

const NO_DATA_TIMEOUT_MS = 250;
const IDLE_TIMEOUT_MS = 250;
const MAX_STDIN_BYTES = 256 * 1024;

export function readStdin(stream = process.stdin) {
  if (stream.isTTY) return Promise.resolve(null);
  return new Promise((resolve) => {
    let raw = '';
    let done = false;
    let idleTimer;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(noDataTimer);
      clearTimeout(idleTimer);
      stream.pause();
      resolve(value);
    };
    const parse = () => {
      try {
        const value = JSON.parse(raw);
        return value !== null && typeof value === 'object' ? value : null;
      } catch {
        return null;
      }
    };
    const noDataTimer = setTimeout(() => {
      if (!raw) finish(null);
    }, NO_DATA_TIMEOUT_MS);
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > MAX_STDIN_BYTES) return finish(null);
      const parsed = parse();
      if (parsed) return finish(parsed);
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => finish(parse()), IDLE_TIMEOUT_MS);
    });
    stream.on('end', () => finish(parse()));
    stream.on('error', () => finish(null));
  });
}

const PASSED_ENV = [
  'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'SystemRoot', 'TZ',
  'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'LC_TIME', 'LC_MESSAGES',
  'COLUMNS', 'DEBUG', 'CLAUDE_CONFIG_DIR', 'AGY_CONFIG_DIR', 'AGY_HUD_DATA_DIR',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX',
  'AGY_HUD_FORCE_ASCII', 'AGY_HUD_FORCE_UNICODE', 'AGY_HUD_BASELINE_ON_EMPTY',
];

export function cageEnv(env = process.env) {
  const caged = { PATH: '' };
  for (const name of PASSED_ENV) if (typeof env[name] === 'string') caged[name] = env[name];
  if (env.ANTHROPIC_API_KEY?.trim()) caged.ANTHROPIC_API_KEY = 'set';
  for (const name of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_BASE_URL']) {
    try {
      const url = new URL(env[name]?.trim() ?? '');
      caged[name] = `${url.origin}${url.pathname}`;
    } catch {}
  }
  return caged;
}

export function cageArgs({ grants, dataDir, entry = LOGIC, audit = false }) {
  return [
    audit ? '--permission-audit' : '--permission',
    ...grants.map((grant) => `--allow-fs-read=${grant}`),
    ...(dataDir ? [`--allow-fs-write=${dataDir}`] : []),
    '--disallow-code-generation-from-strings',
    `--import=${FENCE}`,
    entry,
  ];
}

const isInside = (file, dir) => {
  const relative = path.relative(dir, file);
  return !relative.startsWith('..') && !path.isAbsolute(relative);
};

export async function runCage({ stdin = null, now = Date.now(), probes = async () => ({}), env = process.env, entry = LOGIC, audit = false, command }) {
  const paths = collector.agyPaths(env);
  let dataDir = null;
  try {
    dataDir = collector.prepareDataDir(paths);
  } catch {}
  if (dataDir && isInside(dataDir, fs.realpathSync(ROOT))) dataDir = null;

  const named = collector.logicPaths(paths, command ? { ...stdin, cwd: command.facts.cwd } : stdin);
  if (dataDir) named.data = dataDir;
  const stripped = collector.stripLogic(paths.strippedDir, ROOT);
  const grants = collector.readGrants(ROOT, { ...named, stripped: stripped?.dir });

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, cageArgs({ grants, dataDir, entry, audit }), {
      env: {
        ...cageEnv(env),
        ...(stripped ? { AGY_HUD_STRIPPED: JSON.stringify({ dir: path.join(stripped.dir, path.sep), files: stripped.files }) } : {}),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let settled = false;
    let output = null;
    let stderr = '';
    const settle = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin.end();
      if (error) {
        child.kill('SIGKILL');
        reject(error);
      } else {
        resolve(value);
      }
    };
    const timer = setTimeout(() => settle(new Error('timed out')), WALL_MS);
    const send = (message) => {
      if (!settled) child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    let buffered = '';
    let bytes = 0;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_OUTPUT_BYTES) return settle(new Error('output too large'));
      buffered += chunk;
      for (let newline = buffered.indexOf('\n'); newline !== -1; newline = buffered.indexOf('\n')) {
        let message;
        try {
          message = JSON.parse(buffered.slice(0, newline));
        } catch {
          return settle(new Error('unreadable output'));
        }
        buffered = buffered.slice(newline + 1);
        if (Array.isArray(message?.lines)) {
          output = { lines: message.lines.map(String), snapshot: message.snapshot, config: message.config, failed: message.failed === true };
          if (audit) child.stdin.end();
          else return settle(null, output);
        } else if (Number.isSafeInteger(message?.id)) {
          Promise.resolve().then(() => probes(message.ask)).catch(() => ({})).then((answers) => send({ id: message.id, answers }));
        }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      if (audit) stderr = (stderr + chunk).slice(-MAX_OUTPUT_BYTES);
      if (env.DEBUG) process.stderr.write(chunk);
    });
    child.stdin.on('error', () => {});
    child.on('error', (error) => settle(error));
    child.on('close', (code) => {
      if (!output) return settle(new Error(`logic exited with code ${code}`));
      const report = stderr.split('\n').findLast((line) => line.startsWith('agy-hud audit '));
      settle(null, audit ? { ...output, outside: report ? JSON.parse(report.slice('agy-hud audit '.length)) : ['no audit report'] } : output);
    });
    probes.start?.();
    send({ stdin, now, paths: named, ...(command ? { command } : {}) });
  });
}

function relayToNode(argv) {
  const node = process.platform === 'win32' ? collector.resolveWindowsExecutable('node') : 'node';
  return new Promise((resolve) => {
    if (!node) {
      print([upgradeLine(`Bun ${process.versions.bun}`)]);
      return resolve();
    }
    const child = spawn(node, [path.join(ROOT, 'hud.mjs'), ...argv.slice(2)], { stdio: 'inherit' });
    child.on('error', () => resolve(print([upgradeLine(`Bun ${process.versions.bun}`)])));
    child.on('close', (code) => {
      if (code) process.exitCode = code;
      resolve();
    });
  });
}

async function handleSelfUpdate() {
  console.log('Checking for latest installer...');
  const bootstrapUrl = 'https://raw.githubusercontent.com/icebear0828/agy-hud/main/scripts/bootstrap.js';
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-update-'));
  const tempPath = path.join(tempDir, 'bootstrap.mjs');
  try {
    await new Promise((resolve, reject) => {
      https.get(bootstrapUrl, (response) => {
        if (response.statusCode !== 200) return reject(new Error(`Failed to fetch bootstrap: ${response.statusCode}`));
        const fileStream = fs.createWriteStream(tempPath);
        response.pipe(fileStream);
        fileStream.on('finish', () => { fileStream.close(); resolve(); });
        fileStream.on('error', reject);
      }).on('error', reject);
    });
    console.log('Spawning update process in background...');
    const child = spawn(process.execPath, [tempPath, '--delay-start'], {
      detached: true,
      stdio: 'inherit',
      windowsHide: true,
    });
    child.unref();
    process.exit(0);
  } catch (err) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    console.error(`Update failed: ${err.message}`);
    process.exit(1);
  }
}

function maybeCheckUpdates(paths) {
  const updateStatusPath = paths.updateStatusPath;
  let lastCheck = 0;
  let status = {};
  try {
    if (fs.existsSync(updateStatusPath)) {
      status = JSON.parse(fs.readFileSync(updateStatusPath, 'utf8'));
      lastCheck = status.lastCheck || 0;
    }
  } catch {}
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;
  if (Date.now() - lastCheck > ONE_DAY_MS) {
    status.lastCheck = Date.now();
    try {
      fs.mkdirSync(path.dirname(updateStatusPath), { recursive: true });
      fs.writeFileSync(updateStatusPath, JSON.stringify(status, null, 2));
    } catch {}
    const checkerPath = path.join(ROOT, 'runtime', 'update-checker.mjs');
    if (fs.existsSync(checkerPath)) {
      const checker = spawn(process.execPath, [checkerPath], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: { ...process.env, NODE_USE_ENV_PROXY: '1' },
      });
      checker.unref();
    }
  }
}

const COMMANDS = ['doctor', 'schema', 'preview', 'set', 'preset', 'report', 'install'];
const FACTS = ['doctor', 'report'];

export function asJson(lines) {
  let value;
  try {
    value = JSON.parse(lines.join('\n'));
  } catch {
    value = lines;
  }
  return JSON.stringify(value, null, 2).split('\n');
}

async function runCommand(name, args, { paths, env }) {
  const facts = collector.commandFacts({ root: ROOT, paths, env });
  const printJson = (value) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  if (!facts.runtime.supported) {
    if (name === 'doctor') {
      const { runtime, plugin, runtimes, heartbeat } = facts;
      return printJson({
        runtime,
        plugin,
        runtimes,
        lastRender: heartbeat && { at: heartbeat.at, runtime: heartbeat.runtime, path: heartbeat.path, outcome: heartbeat.outcome },
        findings: [`This is ${runtime.name} ${runtime.version}; the HUD needs Node 22.18+. Fix: rerun with a supported runtime from runtimes, or install one.`],
      });
    }
    process.exitCode = 1;
    return print([upgradeLine(process.version)]);
  }
  try {
    if (name === 'install') {
      const { install } = await import('./install.mjs');
      return printJson(install({ configDir: paths.configDir, hudDir: paths.hudDir, argv: args, env }));
    }
    if (name === 'set' && args[0] === '--undo') {
      collector.undoConfig(paths);
      return print(['Restored config.json from before the last `hud set`.']);
    }
    const stdin = facts.heartbeat?.stdin ?? null;
    const probes = collector.createProbes({ cwd: stdin?.workspace?.current_dir ?? stdin?.cwd, argv: [], env, paths, usage: collector.usagePaths(paths, env) });
    const output = await runCage({ stdin, env, probes, command: { name, args, facts } });
    if ((name === 'set' || name === 'preset') && output.config) collector.writeConfig(paths, output.config);
    if (output.failed) process.exitCode = 1;
    print(FACTS.includes(name) ? asJson(output.lines) : output.lines, stdin);
  } catch (error) {
    process.exitCode = 1;
    print([`agy-hud ${name}: ${error instanceof Error ? error.message : 'Unknown error'}`]);
  }
}

export async function main({ argv = process.argv, env = process.env } = {}) {
  if (argv.includes('--update')) {
    await handleSelfUpdate();
    return;
  }
  if (argv.includes('--config')) {
    const { startWizard } = await import('./runtime/config-wizard.mjs');
    await startWizard();
    return;
  }

  const command = COMMANDS.includes(argv[2]) ? argv[2] : null;
  if (!command && isHudDisabled(env)) return;
  if (process.versions.bun) return relayToNode(argv);
  const paths = collector.agyPaths(env);
  if (command) return runCommand(command, argv.slice(3), { paths, env });
  if (!collector.isNodeSupported(process.versions.node)) {
    collector.writeHeartbeat(paths, { outcome: 'upgrade', env });
    return print([upgradeLine(process.version)]);
  }

  const now = Date.now();
  let stdin = null;
  try {
    stdin = await readStdin();
    const effectiveStdin = stdin ?? (env.AGY_HUD_BASELINE_ON_EMPTY === '1' ? { cwd: process.cwd() } : null);
    const setting = collector.userSettings(paths);
    const usage = collector.usagePaths(paths, env, setting);
    const cwd = effectiveStdin?.workspace?.current_dir ?? effectiveStdin?.cwd ?? null;
    const probes = collector.createProbes({
      cwd,
      argv,
      env,
      paths,
      usage,
      early: collector.probesToStart(setting),
    });
    const repoPromise = cwd && !effectiveStdin?.workspace?.repo ? probes(['git.repo']).then((r) => r['git.repo']).catch(() => null) : Promise.resolve(null);
    const output = await runCage({ stdin: effectiveStdin, now, probes, env });
    if (output.snapshot) collector.writeUsageSnapshot(usage.write, output.snapshot);
    const fallbackRepo = await repoPromise;
    print(output.lines, effectiveStdin, fallbackRepo);
    if (stdin) collector.writeHeartbeat(paths, { outcome: output.failed ? output.lines[0] ?? 'failed' : 'ok', stdin, now, env });
    maybeCheckUpdates(paths);
  } catch (error) {
    const message = `[agy-hud] Error: ${error instanceof Error ? error.message : 'Unknown error'}`;
    print([`${message}. Type /hud to fix it.`]);
    collector.writeHeartbeat(paths, { outcome: message, stdin, now, env });
    try {
      const errorLogPath = path.join(paths.configDir, 'agy-hud-error.log');
      fs.mkdirSync(path.dirname(errorLogPath), { recursive: true });
      fs.writeFileSync(errorLogPath, error?.stack || String(error), { mode: 0o600 });
    } catch {}
  }
}

const ENTRIES = [
  path.join(ROOT, 'hud.mjs'),
  path.join(ROOT, 'dist', 'index.js'),
  path.join(ROOT, 'src', 'index.ts'),
  path.join(ROOT, 'runtime', 'bin', 'agy-hud.js'),
];
if (process.argv[1] && ENTRIES.some((entry) => collector.samePath(process.argv[1], entry))) {
  await main();
}
