import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { quotaModule, withEnv } from './_helpers/quota-test-utils.mjs';

const {
  selectUsableTokens,
  isTokenExpired,
  parseTokenPayload,
  readToken,
} = quotaModule;

describe('quota / token', () => {
  describe('selectUsableTokens', () => {
    test('keeps Windows temp tokens until token expiry', () => {
      const now = Date.parse('2026-05-20T20:00:00Z');
      const oldWrittenAt = now - 60 * 60 * 1000;

      const tokens = selectUsableTokens([
        { accessToken: 'valid-with-expiry', expiry: '2026-05-20T20:10:00Z' },
        { accessToken: 'nearly-expired', expiry: '2026-05-20T20:00:30Z' },
        { accessToken: 'no-expiry-old-cache' },
        { accessToken: 'no-expiry-fresh-cache' },
      ], oldWrittenAt, now);

      assert.deepEqual(tokens.map(t => t.accessToken), ['valid-with-expiry']);

      const freshNoExpiry = selectUsableTokens([
        { accessToken: 'no-expiry-fresh-cache' },
      ], now - 1000, now);
      assert.deepEqual(freshNoExpiry.map(t => t.accessToken), ['no-expiry-fresh-cache']);
    });
  });

  describe('isTokenExpired', () => {
    test('detects expired file tokens with expiry skew', () => {
      const now = Date.parse('2026-05-21T20:00:00Z');

      assert.equal(
        isTokenExpired({ accessToken: 'old-token', expiry: '2026-05-21T19:59:30Z' }, now),
        true
      );
      assert.equal(
        isTokenExpired({ accessToken: 'fresh-token', expiry: '2026-05-21T20:05:00Z' }, now),
        false
      );
      assert.equal(
        isTokenExpired({ accessToken: 'no-expiry-token' }, now),
        false
      );
    });
  });

  describe('parseTokenPayload', () => {
    test('supports antigravity-cli and oauth_creds token shapes', () => {
      assert.deepEqual(
        parseTokenPayload({
          token: {
            access_token: 'cli-token',
            expiry: '2026-05-20T20:10:00Z'
          }
        }),
        {
          accessToken: 'cli-token',
          expiry: '2026-05-20T20:10:00Z',
          sourceFormat: 'antigravity-cli'
        }
      );

      assert.deepEqual(
        parseTokenPayload({
          access_token: 'oauth-creds-token',
          expiry_date: Date.parse('2026-05-20T12:10:00Z')
        }),
        {
          accessToken: 'oauth-creds-token',
          expiry: '2026-05-20T12:10:00.000Z',
          sourceFormat: 'oauth-creds'
        }
      );
    });
  });

  describe('readToken', () => {
    test('only accepts Antigravity token files from configured data roots', () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-token-roots-'));
      try {
        const home = path.join(tmp, 'home');
        const xdg = path.join(tmp, 'xdg');
        fs.mkdirSync(path.join(home, '.gemini'), { recursive: true });
        fs.mkdirSync(path.join(xdg, 'antigravity-cli'), { recursive: true });
        fs.writeFileSync(
          path.join(home, '.gemini', 'jetski-standalone-oauth-token'),
          JSON.stringify({ access_token: 'legacy-token' })
        );
        const antigravityTokenPath = path.join(xdg, 'antigravity-cli', 'antigravity-oauth-token');
        fs.writeFileSync(
          antigravityTokenPath,
          JSON.stringify({ token: { access_token: 'antigravity-token' } })
        );

        withEnv({
          HOME: home,
          USERPROFILE: home,
          XDG_DATA_HOME: xdg,
          APPDATA: undefined,
          LOCALAPPDATA: undefined,
        }, () => {
          assert.equal(readToken({ platform: 'linux' }).accessToken, 'antigravity-token');

          fs.rmSync(antigravityTokenPath);
          assert.equal(readToken({ platform: 'linux' }), null);
        });
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    test('falls back to ~/.gemini/oauth_creds.json when antigravity-cli token is missing', () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-oauth-creds-'));
      try {
        const home = path.join(tmp, 'home');
        fs.mkdirSync(path.join(home, '.gemini'), { recursive: true });
        fs.writeFileSync(
          path.join(home, '.gemini', 'oauth_creds.json'),
          JSON.stringify({
            access_token: 'oauth-creds-token',
            expiry_date: Date.parse('2026-05-20T12:10:00Z'),
            refresh_token: 'refresh-token'
          })
        );

        withEnv({
          HOME: home,
          USERPROFILE: home,
          XDG_DATA_HOME: undefined,
          APPDATA: undefined,
          LOCALAPPDATA: undefined,
        }, () => {
          const token = readToken({ platform: 'linux' });
          assert.equal(token.accessToken, 'oauth-creds-token');
          assert.equal(token.sourceFormat, 'oauth-creds');
          assert.equal(token.sourcePath.endsWith(path.join('.gemini', 'oauth_creds.json')), true);
        });
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    test('can skip Windows Credential Manager for statusline fast path', () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-token-fast-'));
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
          assert.equal(readToken({ platform: 'win32', skipWindowsCredential: true }), null);
        });
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    test('can read Windows Credential Manager when the fast path is not requested', () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-token-credential-'));
      try {
        const home = path.join(tmp, 'home');
        fs.mkdirSync(path.join(home, '.gemini'), { recursive: true });
        let credentialReads = 0;

        withEnv({
          HOME: home,
          USERPROFILE: home,
          XDG_DATA_HOME: undefined,
          APPDATA: undefined,
          LOCALAPPDATA: undefined,
        }, () => {
          const token = readToken({
            platform: 'win32',
            credentialReader: () => {
              credentialReads += 1;
              return { accessToken: 'credential-token' };
            },
          });

          assert.equal(token.accessToken, 'credential-token');
          assert.equal(credentialReads, 1);
        });
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  });
});
