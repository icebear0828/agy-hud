// Spawns the real permission cage against verify/lib/escape-probe.mjs and poisoned inputs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCage, terminalFilter } from '../hud.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const probeEntry = path.join(root, 'verify', 'lib', 'escape-probe.mjs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-escape-'));
const errors = [];

try {
  const home = path.join(tmp, 'home');
  const agyDir = path.join(home, '.gemini', 'antigravity-cli');
  const cwd = path.join(tmp, 'workspace');
  fs.mkdirSync(agyDir, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });

  // Fake secret outside logic grants (e.g. OAuth creds next to agyDir)
  const secretFile = path.join(agyDir, 'antigravity-oauth-token');
  fs.writeFileSync(secretFile, JSON.stringify({ access_token: 'SECRET_OAUTH_TOKEN_NEVER_LEAK' }));

  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    AGY_HUD_DATA_DIR: agyDir,
  };

  const out = await runCage({
    entry: probeEntry,
    stdin: { cwd, secretFile, workspace: { repo: { host: 'github.com', owner: 'icebear0828', name: 'agy-hud' } } },
    env,
  });

  if (out.failed || out.lines[0] !== 'SAFE_ALL_DENIED') {
    errors.push(`Cage escape probe succeeded: ${out.lines[0]}`);
  }

  const filter = terminalFilter({ workspace: { repo: { host: 'github.com', owner: 'icebear0828', name: 'agy-hud' } } });
  const filteredLine = filter(out.lines[1] ?? '');
  if (!filteredLine.includes('\x1b[31mKEEP_COLOR\x1b[0m')) {
    errors.push('terminalFilter stripped valid SGR color');
  }
  if (filteredLine.includes('https://evil.example') || filteredLine.includes('\x1b[2J') || filteredLine.includes('\u202e')) {
    errors.push(`terminalFilter leaked dangerous escape sequence: ${JSON.stringify(filteredLine)}`);
  }

  // Test prototype-pollution / path-traversal / bidi poisoning through real src/main.ts
  const realOut = await runCage({
    stdin: {
      cwd,
      model: { id: 'gemini-3-pro', display_name: '\x1b[2Jevil\u202eModel' },
      workspace: { current_dir: cwd, added_dirs: ['/etc/shadow'] },
    },
    probes: async (names) => {
      const ans = {};
      if (names.includes('agy.quota')) {
        ans['agy.quota'] = {
          models: [],
          providerQuota: null,
          unavailableReason: '\x1b]8;;https://evil.example\x1b\\bad_reason',
          tierName: 'Pro',
          accountEmail: null,
          updateInfo: null,
        };
      }
      if (names.includes('agy.unicode')) ans['agy.unicode'] = true;
      return ans;
    },
    env,
  });

  const joined = realOut.lines.map((l) => filter(l)).join('\n');
  if (joined.includes('\x1b[2J') || joined.includes('\u202e') || joined.includes('https://evil.example')) {
    errors.push('Real pipeline leaked unsafe control/bidi/URL sequence');
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

if (errors.length > 0) {
  for (const e of errors) console.log(`FAIL ${e}`);
  process.exit(1);
}
console.log('  ok escape: all fs, network, child_process, eval, and terminal-escape probes blocked');
