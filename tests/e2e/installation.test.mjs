import { test } from 'node:test';
import assert from 'node:assert';
import { execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import http from 'http';
import os from 'os';
import { fileURLToPath } from 'url';
import pathsModule from '../../extensions/paths.js';

const { resolveAntigravityPath } = pathsModule;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Auto-discover agy binary: prefer $PATH lookup, then common install locations
function findAgyBin() {
  // 1. Try $PATH
  try {
    const cmd = process.platform === 'win32' ? 'where agy' : 'which agy';
    return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().split('\n')[0];
  } catch { /* not in PATH */ }
  // 2. Common install locations
  const candidates = [
    path.join(os.homedir(), '.local', 'bin', 'agy'),
    path.join(os.homedir(), '.local', 'bin', 'agy.exe'),
    '/usr/local/bin/agy',
    '/usr/bin/agy',
    process.env.APPDATA ? path.join(process.env.APPDATA, 'antigravity', 'bin', 'agy.exe') : null,
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error('agy binary not found. Add it to $PATH or install to ~/.local/bin/agy');
}

const AGY_BIN = findAgyBin();
// Project root is two levels up from tests/e2e/
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

test('E2E: Official agy plugin installation from remote URL', async (t) => {
  console.log('🏗️  Building release package...');
  execSync(`SKIP_GH_RELEASE=true ${PROJECT_ROOT}/release.sh`, { cwd: PROJECT_ROOT });
  const zipPath = path.join(PROJECT_ROOT, 'agy-hud.zip');

  // New Debug: Validate the source before packing
  console.log('🔍 Validating source directory...');
  const valOutput = execSync(`${AGY_BIN} plugin validate ${PROJECT_ROOT}`).toString();
  console.log('Validation Output:', valOutput);

  // 2. Start a local HTTP server to host the clean ZIP
  const server = http.createServer((req, res) => {
    console.log(`🌐 Server received request: ${req.url}`);
    if (req.url === '/agy-hud.zip') {
      const stat = fs.statSync(zipPath);
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Length': stat.size
      });
      const readStream = fs.createReadStream(zipPath);
      readStream.on('open', () => console.log('📂 Stream opened for ZIP'));
      readStream.on('end', () => console.log('✅ Stream finished sending ZIP'));
      readStream.pipe(res);
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;
  const url = `http://localhost:${port}/agy-hud.zip`;
  let tempWork = null;

  try {
    console.log(`🔌 Spawning agy plugin install from ${url}`);
    try { execSync(`${AGY_BIN} plugin uninstall agy-hud`, { stdio: 'ignore' }); } catch(e) {}

    const child = spawn(AGY_BIN, ['plugin', 'install', url]);
    
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      const msg = data.toString();
      stdout += msg;
      process.stdout.write(`[agy stdout] ${msg}`);
    });

    child.stderr.on('data', (data) => {
      const msg = data.toString();
      stderr += msg;
      process.stdout.write(`[agy stderr] ${msg}`);
    });

    const exitCode = await new Promise((resolve) => {
      child.on('close', resolve);
    });

    console.log(`🏁 agy exited with code ${exitCode}`);
    
    if (exitCode !== 0) {
      console.error('❌ Installation Failed with stderr:', stderr);
      // Try to extract the path from the error message
      const match = stderr.match(/unsupported extension format at (.*)/);
      if (match && match[1]) {
        const errPath = match[1].trim();
        console.log(`🔍 Inspecting error path: ${errPath}`);
        try {
          const files = execSync(`ls -R ${errPath}`).toString();
          console.log('Contents of temp dir:\n', files);
        } catch(e) {
          console.log('Could not list temp dir (maybe deleted?)');
        }
      }
      throw new Error(`agy failed with code ${exitCode}`);
    }

    console.log('✅ Installation Successful!');
    assert.strictEqual(exitCode, 0);
    assert.match(stdout, /\[ok\]/);
    assert.match(stdout, /hooks\s+: 1 processed/);

    const installedHooksPath = resolveAntigravityPath(path.join('plugins', 'agy-hud', 'hooks.json'));
    const installedHooks = JSON.parse(fs.readFileSync(installedHooksPath, 'utf8'));
    const hookCommand = installedHooks.post_invocation_hooks[0].command;
    assert.doesNotMatch(hookCommand, /extensions\/install-statusline\.js/);

    tempWork = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-hook-'));
    const tempHome = path.join(tempWork, 'home');
    const tempRuntime = path.join(tempWork, 'runtime');
    const sourceRepo = path.join(tempWork, 'source');
    const tempSettingsDir = path.join(tempHome, '.gemini', 'antigravity-cli');
    fs.mkdirSync(tempSettingsDir, { recursive: true });
    fs.mkdirSync(sourceRepo, { recursive: true });
    fs.writeFileSync(path.join(tempSettingsDir, 'settings.json'), '{}');

    const writeSourceHud = (label) => {
      const sourceHudDir = path.join(sourceRepo, 'extensions', 'bin');
      fs.mkdirSync(sourceHudDir, { recursive: true });
      fs.writeFileSync(path.join(sourceHudDir, 'agy-hud.js'), `process.stdout.write("AGY-HUD-${label}");\n`);
    };
    const commitSource = (message) => {
      execSync('git add .', { cwd: sourceRepo, stdio: 'ignore' });
      execSync(`git -c user.name=agy-hud-test -c user.email=agy-hud-test@example.com commit -m "${message}"`, {
        cwd: sourceRepo,
        stdio: 'ignore',
      });
    };
    const runHook = async () => {
      const hookExit = spawn(hookCommand, {
        shell: true,
        env: {
          ...process.env,
          HOME: tempHome,
          USERPROFILE: tempHome,
          AGY_HUD_RUNTIME_DIR: tempRuntime,
          AGY_HUD_REPO_URL: sourceRepo,
        },
      });
      const hookCode = await new Promise(resolve => hookExit.on('close', resolve));
      assert.strictEqual(hookCode, 0);
    };

    writeSourceHud('v1');
    execSync('git init', { cwd: sourceRepo, stdio: 'ignore' });
    commitSource('init');
    await runHook();

    const tempSettings = JSON.parse(fs.readFileSync(path.join(tempSettingsDir, 'settings.json'), 'utf8'));
    assert.equal(tempSettings.statusLine.type, 'command');
    assert.match(tempSettings.statusLine.command, /extensions[/\\]bin[/\\]agy-hud\.js/);
    assert.match(execSync(tempSettings.statusLine.command).toString(), /AGY-HUD-v1/);

    writeSourceHud('v2');
    commitSource('update runtime');
    await runHook();
    assert.match(execSync(tempSettings.statusLine.command).toString(), /AGY-HUD-v2/);
  } finally {
    if (tempWork) fs.rmSync(tempWork, { recursive: true, force: true });
    server.close();
    console.log('🛑 Server closed');
  }
});
