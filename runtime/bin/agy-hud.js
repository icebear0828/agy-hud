#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { getSessionState, parseAgyInput } = require('../parser.js');
const { renderHUD } = require('../renderer.js');
const { loadConfig } = require('../config.js');
const { getQuota, getCachedTier } = require('../quota.js');
const { resolveAntigravityPath } = require('../paths.js');

async function main() {
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

    // Fallback transcript path if not provided in stdin — uses paths.js so we
    // honour XDG_DATA_HOME / APPDATA / LOCALAPPDATA in addition to ~/.gemini.
    const transcriptPath = agyData?.transcript_path ||
      resolveAntigravityPath(path.join(
        'brain',
        agyData?.conversation_id || '',
        '.system_generated',
        'logs',
        'transcript.jsonl'
      ));

    try {
      const [state, config, quotaData, tierName] = await Promise.all([
        getSessionState(transcriptPath),
        loadConfig(),
        getQuota({ fast: true }).catch(() => []),
        getCachedTier(),
      ]);

      const hudOutput = renderHUD(state, agyData, config, quotaData, tierName);
      process.stdout.write(hudOutput);
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
