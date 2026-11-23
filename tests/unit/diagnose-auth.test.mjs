import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildAuthDiagnostic, resolveAgyInfo } = require('../../scripts/diagnose-auth.js');

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
        keyringReader: () => null,
        keyringProbe: () => null,
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

test('auth diagnostic reports Linux keyring source without leaking token values', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-diagnose-keyring-'));
  try {
    const home = path.join(tmp, 'home');
    fs.mkdirSync(path.join(home, '.gemini'), { recursive: true });

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
        keyringReader: () => ({
          accessToken: 'secret-keyring-token',
          sourceFormat: 'linux-keyring',
          all: [{ accessToken: 'secret-keyring-token' }],
        }),
        keyringProbe: () => null,
      });
      const serialized = JSON.stringify(diagnostic);

      assert.equal(diagnostic.readToken.found, true);
      assert.equal(diagnostic.readToken.sourceFormat, 'linux-keyring');
      assert.equal(diagnostic.readToken.tokenCount, 1);
      assert.doesNotMatch(serialized, /secret-keyring-token/);
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('auth diagnostic surfaces Linux keyring probe result', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-diagnose-probe-'));
  try {
    const home = path.join(tmp, 'home');
    fs.mkdirSync(path.join(home, '.gemini'), { recursive: true });

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
        keyringReader: () => null,
        keyringProbe: () => ({ available: false, reason: 'python-not-found' }),
      });

      assert.equal(diagnostic.keyringProbe.available, false);
      assert.equal(diagnostic.keyringProbe.reason, 'python-not-found');
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('auth diagnostic reports macOS Keychain source and probe without leaking token values', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-diagnose-macos-'));
  try {
    const home = path.join(tmp, 'home');
    fs.mkdirSync(path.join(home, '.gemini'), { recursive: true });

    withEnv({
      HOME: home,
      USERPROFILE: home,
      XDG_DATA_HOME: undefined,
      APPDATA: undefined,
      LOCALAPPDATA: undefined,
    }, () => {
      const diagnostic = buildAuthDiagnostic({
        resolveAgyInfo: () => ({ found: false, candidates: [] }),
        platform: 'darwin',
        keychainReader: () => ({
          accessToken: 'secret-keychain-token',
          sourceFormat: 'macos-keychain',
          email: 'secret-user@example.com',
          all: [{ accessToken: 'secret-keychain-token' }],
        }),
        keychainProbe: () => ({ available: true, security: '/usr/bin/security' }),
      });
      const serialized = JSON.stringify(diagnostic);

      assert.equal(diagnostic.readToken.found, true);
      assert.equal(diagnostic.readToken.sourceFormat, 'macos-keychain');
      assert.equal(diagnostic.readToken.hasEmail, true);
      assert.equal(diagnostic.keychainProbe.available, true);
      assert.doesNotMatch(serialized, /secret-keychain-token/);
      assert.doesNotMatch(serialized, /secret-user@example.com/);
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('resolveAgyInfo continues to subsequent candidates when first candidate --version fails', () => {
  const calls = [];
  const info = resolveAgyInfo({
    candidates: ['/broken/agy', '/working/agy'],
    pathExists: () => true,
    execFileSync: (candidate) => {
      calls.push(candidate);
      if (candidate === '/broken/agy') {
        const err = new Error('permission denied');
        err.code = 'EACCES';
        throw err;
      }
      return 'agy 1.2.3\n';
    },
  });

  assert.deepEqual(calls, ['/broken/agy', '/working/agy']);
  assert.equal(info.found, true);
  assert.equal(info.path, '/working/agy');
  assert.equal(info.version, 'agy 1.2.3');
});

test('resolveAgyInfo records lastError when all existing candidates fail --version', () => {
  const info = resolveAgyInfo({
    candidates: ['/broken1/agy', '/broken2/agy'],
    pathExists: () => true,
    execFileSync: (candidate) => {
      const err = new Error(`failed ${candidate}`);
      err.code = candidate === '/broken1/agy' ? 'EACCES' : 'ETIMEDOUT';
      throw err;
    },
  });

  assert.equal(info.found, false);
  assert.equal(info.lastError, 'ETIMEDOUT');
  assert.deepEqual(info.existingCandidates, ['/broken1/agy', '/broken2/agy']);
});

test('buildAuthDiagnostic passes resolved roots to readToken', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-diagnose-roots-'));
  try {
    const customRoot = path.join(tmp, 'custom-antigravity-cli');
    fs.mkdirSync(customRoot, { recursive: true });
    fs.writeFileSync(path.join(customRoot, 'antigravity-oauth-token'), JSON.stringify({
      token: {
        access_token: 'custom-root-secret',
        expiry: '2026-05-20T12:10:00Z',
      },
    }));

    const diagnostic = buildAuthDiagnostic({
      roots: [customRoot],
      resolveAgyInfo: () => ({ found: false, candidates: [] }),
      platform: 'linux',
      keyringReader: () => null,
      keyringProbe: () => null,
      keychainProbe: () => null,
    });

    assert.equal(diagnostic.readToken.found, true);
    assert.equal(diagnostic.readToken.sourcePath, path.join(customRoot, 'antigravity-oauth-token'));
    assert.doesNotMatch(JSON.stringify(diagnostic), /custom-root-secret/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
