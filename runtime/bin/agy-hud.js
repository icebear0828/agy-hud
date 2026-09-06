#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { spawn } = require('child_process');
const { getSessionState, parseAgyInput, parseAgyQuota } = require('../parser.js');
const { renderHUD } = require('../renderer.js');
const { loadConfig } = require('../config.js');
const { getQuota, getCachedTier } = require('../quota.js');
const { enrichModelsWithQuotaSummary } = require('../quota/cloud.js');
const { resolveAntigravityPath } = require('../paths.js');

async function handleSelfUpdate() {
  console.log('Checking for latest installer...');
  const bootstrapUrl = 'https://raw.githubusercontent.com/icebear0828/agy-hud/main/scripts/bootstrap.js';
  const tempPath = path.join(os.tmpdir(), `agy-hud-bootstrap-${Date.now()}.js`);

  try {
    await new Promise((resolve, reject) => {
      https.get(bootstrapUrl, response => {
        if (response.statusCode !== 200) {
          return reject(new Error(`Failed to fetch bootstrap: ${response.statusCode}`));
        }
        const fileStream = fs.createWriteStream(tempPath);
        response.pipe(fileStream);
        fileStream.on('finish', () => {
          fileStream.close();
          resolve();
        });
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
    console.log('Update initiated. Exiting current process...');
    process.exit(0);
  } catch (err) {
    console.error(`Update failed: ${err.message}`);
    process.exit(1);
  }
}

function maybeCheckUpdates() {
  const updateStatusPath = resolveAntigravityPath('agy-hud-update-status.json');
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
      fs.writeFileSync(updateStatusPath, JSON.stringify(status, null, 2));
    } catch {}

    const checkerPath = path.join(__dirname, '..', 'update-checker.js');
    if (fs.existsSync(checkerPath)) {
      const checker = spawn(process.execPath, [checkerPath], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      checker.unref();
    }
  }
}

async function main() {
  if (process.argv.includes('--update')) {
    await handleSelfUpdate();
    return;
  }

  if (process.argv.includes('--config')) {
    const { startWizard } = require('../config-wizard.js');
    await startWizard();
    return;
  }

  const stdinData = [];
  let hasHandled = false;

  // Hard cap: if neither 'end' nor enough data arrives within 1.5s, give up.
  // 1.5s tolerates slow Windows pipes that occasionally fail to emit 'end'
  // while still keeping the statusLine snappy.
  const timeout = setTimeout(() => handleInputAndRender(), 1500);

  async function handleInputAndRender() {
    if (hasHandled) return;
    hasHandled = true;
    clearTimeout(timeout);

    const inputStr = Buffer.concat(stdinData).toString();
    // agy on Windows can invoke the statusline before it has a payload ready.
    // Render a baseline HUD instead of returning an empty successful result.
    const agyData = inputStr.trim() ? parseAgyInput(inputStr) : null;

    const targetCwd = agyData?.workspace?.current_dir || agyData?.cwd || process.cwd();

    // Fallback transcript path if not provided in stdin or if path does not exist — uses paths.js
    // so we honour XDG_DATA_HOME / APPDATA / LOCALAPPDATA in addition to ~/.gemini.
    let transcriptPath = agyData?.transcript_path;
    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      const candidate = resolveAntigravityPath(path.join(
        'brain',
        agyData?.conversation_id || '',
        '.system_generated',
        'logs',
        'transcript.jsonl'
      ));
      if (fs.existsSync(candidate) || !transcriptPath) {
        transcriptPath = candidate;
      }
    }

    try {
      const updateStatusPath = resolveAntigravityPath('agy-hud-update-status.json');
      let updateInfo = null;
      try {
        if (fs.existsSync(updateStatusPath)) {
          updateInfo = JSON.parse(fs.readFileSync(updateStatusPath, 'utf8'));
        }
      } catch {}

      const [state, config, quotaData, tierName] = await Promise.all([
        getSessionState(transcriptPath, targetCwd),
        loadConfig(),
        getQuota({ fast: true }).catch(() => []),
        getCachedTier(),
      ]);

      let effectiveQuotaData = quotaData;
      // Authoritative live quota passed directly in stdin by agy CLI
      const stdinProviderQuota = parseAgyQuota(agyData?.quota);
      if (stdinProviderQuota) {
        if (Array.isArray(effectiveQuotaData)) {
          effectiveQuotaData = enrichModelsWithQuotaSummary(effectiveQuotaData, stdinProviderQuota);
          effectiveQuotaData.providerQuota = { ...(quotaData.providerQuota || {}), ...stdinProviderQuota };
        }
      }

      const hudOutput = renderHUD(state, agyData, config, effectiveQuotaData, tierName, updateInfo);
      process.stdout.write(hudOutput);

      // Trigger background check for updates after writing output
      maybeCheckUpdates();
    } catch (err) {
      // Write debug error to Antigravity directory
      try {
        const errorLogPath = resolveAntigravityPath('agy-hud-error.log');
        fs.writeFileSync(errorLogPath, err.stack || String(err), { mode: 0o600 });
      } catch {}
    }
    process.exit(0);
  }

  process.stdin.on('data', chunk => stdinData.push(chunk));
  process.stdin.on('end', handleInputAndRender);
}

main();

