import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildAuthDiagnostic } = require('../../scripts/diagnose-auth.js');

function withEnv(overrides, fn) {
  const snapshot = {};
  for (const key of Object.keys(overrides)) {
    snapshot[key] = process.env[key];
    if (overrides[key] === undefined) delete process.env[key];
    else process.env[key] = overrides[key];
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(snapshot)) {
      if (snapshot[key] === undefined) delete process.env[key];
      else process.env[key] = snapshot[key];
    }
  }
}

test('auth diagnostic reuses token parsing without leaking token values', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-diagnose-auth-'));
  try {
    const home = path.join(tmp, 'home');
    fs.mkdirSync(path.join(home, '.gemini'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.gemini', 'oauth_creds.json'),
      JSON.stringify({
        access_token: 'secret-access-token',
        refresh_token: 'secret-refresh-token',
        expiry_date: Date.parse('2026-05-20T12:10:00Z')
      })
    );

    withEnv({
      HOME: home,
      USERPROFILE: home,
      XDG_DATA_HOME: undefined,
      APPDATA: undefined,
      LOCALAPPDATA: undefined,
    }, () => {
      const diagnostic = buildAuthDiagnostic({
        resolveAgyInfo: () => ({ found: false, candidates: [] }),
        platform: 'linux',
      });
      const serialized = JSON.stringify(diagnostic);

      assert.equal(diagnostic.readToken.found, true);
      assert.equal(diagnostic.readToken.sourceFormat, 'oauth-creds');
      assert.equal(
        diagnostic.readToken.sourcePath.endsWith(path.join('.gemini', 'oauth_creds.json')),
        true
      );
      assert.equal(
        diagnostic.tokenCandidates.some(candidate =>
          candidate.sourceFormat === 'oauth-creds' && candidate.parseable === true
        ),
        true
      );
      assert.doesNotMatch(serialized, /secret-access-token/);
      assert.doesNotMatch(serialized, /secret-refresh-token/);
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
