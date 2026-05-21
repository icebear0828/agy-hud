#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { getSessionState, parseAgyInput } = require('../parser.js');
const { renderHUD } = require('../renderer.js');
const { loadConfig } = require('../config.js');
const { getQuota } = require('../quota.js');
const { resolveAntigravityPath } = require('../paths.js');

async function main() {
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
      const stats = fs.existsSync(transcriptPath) ? fs.statSync(transcriptPath) : { size: 0 };
      const [state, config, quotaData] = await Promise.all([
        getSessionState(transcriptPath, stats.size),
        loadConfig(),
        getQuota().catch(() => []),
      ]);

      const hudOutput = renderHUD(state, agyData, config, quotaData);
      process.stdout.write(hudOutput);
    } catch (err) {
      // Write debug error to tmp directory
      try {
        const os = require('os');
        fs.writeFileSync(path.join(os.tmpdir(), 'agy-hud-error.log'), err.stack || String(err));
      } catch {}
    }
    process.exit(0);
  }

  process.stdin.on('data', chunk => stdinData.push(chunk));
  process.stdin.on('end', handleInputAndRender);
}

main();
