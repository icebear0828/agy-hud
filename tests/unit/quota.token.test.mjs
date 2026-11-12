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
  clearTokenTemp,
} = quotaModule;
const tokenModule = quotaModule.tokenMod || (await import('../../runtime/quota/token.js'));
const { decodeKeyringRaw, extractEmailFromIdToken } = tokenModule;

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

    test('extracts email from id_token in token payload', () => {
      const mockIdToken = 'eyJhbGciOiJSUzI1NiJ9.' +
        Buffer.from(JSON.stringify({ email: 'active@example.com' })).toString('base64') +
        '.signature';
      assert.deepEqual(
        parseTokenPayload({
          token: {
            access_token: 'cli-token',
            expiry: '2026-05-20T20:10:00Z',
          },
          id_token: mockIdToken,
        }),
        {
          accessToken: 'cli-token',
          expiry: '2026-05-20T20:10:00Z',
          sourceFormat: 'antigravity-cli',
          email: 'active@example.com',
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
          assert.equal(readToken({ platform: 'linux', keyringReader: () => null }).accessToken, 'antigravity-token');

          fs.rmSync(antigravityTokenPath);
          assert.equal(readToken({ platform: 'linux', keyringReader: () => null }), null);
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
          const token = readToken({ platform: 'linux', keyringReader: () => null });
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
              return { accessToken: 'credential-token', sourceFormat: 'windows-credential' };
            },
          });

          assert.equal(token.accessToken, 'credential-token');
          assert.equal(token.sourceFormat, 'windows-credential');
          assert.equal(credentialReads, 1);
        });
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
    test('reads token from Linux Keyring when no token file exists', () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-token-linux-keyring-'));
      try {
        const home = path.join(tmp, 'home');
        fs.mkdirSync(path.join(home, '.gemini'), { recursive: true });
        let keyringReads = 0;

        withEnv({
          HOME: home,
          USERPROFILE: home,
          XDG_DATA_HOME: undefined,
          APPDATA: undefined,
          LOCALAPPDATA: undefined,
        }, () => {
          const token = readToken({
            platform: 'linux',
            keyringReader: () => {
              keyringReads += 1;
              return {
                accessToken: 'linux-keyring-token',
                sourceFormat: 'linux-keyring',
                all: [{ accessToken: 'linux-keyring-token' }],
              };
            },
          });

          assert.equal(token.accessToken, 'linux-keyring-token');
          assert.equal(token.sourceFormat, 'linux-keyring');
          assert.equal(keyringReads, 1);
        });
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    test('falls back to token file when Linux Keyring returns null', () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-token-linux-fallback-'));
      try {
        const home = path.join(tmp, 'home');
        fs.mkdirSync(path.join(home, '.gemini', 'antigravity-cli'), { recursive: true });
        fs.writeFileSync(
          path.join(home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'),
          JSON.stringify({ token: { access_token: 'file-token' } })
        );

        withEnv({
          HOME: home,
          USERPROFILE: home,
          XDG_DATA_HOME: undefined,
          APPDATA: undefined,
          LOCALAPPDATA: undefined,
        }, () => {
          const token = readToken({
            platform: 'linux',
            keyringReader: () => null,
          });

          assert.equal(token.accessToken, 'file-token');
        });
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    test('accepts raw Linux Keyring token strings', () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-token-linux-raw-'));
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
          const token = readToken({
            platform: 'linux',
            keyringReader: () => 'linux-raw-token',
          });

          assert.equal(token.accessToken, 'linux-raw-token');
          assert.equal(token.sourceFormat, 'linux-keyring');
        });
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    test('passes platform and roots arguments to keyringReader on Linux', () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-token-linux-args-'));
      try {
        const home = path.join(tmp, 'home');
        fs.mkdirSync(path.join(home, '.gemini'), { recursive: true });
        let passedPlatform = null;
        let passedRoots = null;

        withEnv({
          HOME: home,
          USERPROFILE: home,
          XDG_DATA_HOME: undefined,
          APPDATA: undefined,
          LOCALAPPDATA: undefined,
        }, () => {
          readToken({
            platform: 'linux',
            keyringReader: (platform, roots) => {
              passedPlatform = platform;
              passedRoots = roots;
              return null;
            },
          });

          assert.equal(passedPlatform, 'linux');
          assert.equal(Array.isArray(passedRoots), true);
        });
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    test('prefers macOS Keychain reader over file tokens on darwin', () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-token-darwin-'));
      try {
        const home = path.join(tmp, 'home');
        fs.mkdirSync(path.join(home, '.gemini', 'antigravity-cli'), { recursive: true });
        fs.writeFileSync(
          path.join(home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'),
          JSON.stringify({ token: { access_token: 'stale-file-token' } })
        );

        withEnv({
          HOME: home,
          USERPROFILE: home,
          XDG_DATA_HOME: undefined,
          APPDATA: undefined,
          LOCALAPPDATA: undefined,
        }, () => {
          const token = readToken({
            platform: 'darwin',
            keychainReader: () => ({
              accessToken: 'active-keychain-token',
              sourceFormat: 'macos-keychain',
              email: 'active@example.com',
              all: [{ accessToken: 'active-keychain-token', email: 'active@example.com' }],
            }),
          });

          assert.equal(token.accessToken, 'active-keychain-token');
          assert.equal(token.sourceFormat, 'macos-keychain');
          assert.equal(token.email, 'active@example.com');
        });
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    test('macOS Keychain reader is not shadowed by stale temp token file', () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-token-darwin-temp-'));
      try {
        const home = path.join(tmp, 'home');
        const cliDir = path.join(home, '.gemini', 'antigravity-cli');
        fs.mkdirSync(cliDir, { recursive: true });
        fs.writeFileSync(
          path.join(cliDir, 'agy-hud-token.json'),
          JSON.stringify({
            tokens: [{
              accessToken: 'stale-temp-token',
              expiry: '2026-10-30T22:00:00Z',
              sourceFormat: 'macos-keychain',
              email: 'stale@example.com',
            }],
            writtenAt: Date.now(),
          })
        );

        withEnv({
          HOME: home,
          USERPROFILE: home,
          XDG_DATA_HOME: undefined,
          APPDATA: undefined,
          LOCALAPPDATA: undefined,
        }, () => {
          const token = readToken({
            platform: 'darwin',
            roots: [cliDir],
            keychainReader: () => ({
              accessToken: 'live-keychain-token',
              sourceFormat: 'macos-keychain',
              email: 'live@example.com',
              all: [{ accessToken: 'live-keychain-token', email: 'live@example.com' }],
            }),
          });

          assert.equal(token.accessToken, 'live-keychain-token');
          assert.equal(token.sourceFormat, 'macos-keychain');
          assert.equal(token.email, 'live@example.com');
        });
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    test('clearTokenTemp removes existing temporary token cache file', () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-token-clear-'));
      try {
        const home = path.join(tmp, 'home');
        const cliDir = path.join(home, '.gemini', 'antigravity-cli');
        fs.mkdirSync(cliDir, { recursive: true });
        const tokenFile = path.join(cliDir, 'agy-hud-token.json');
        fs.writeFileSync(tokenFile, JSON.stringify({ tokens: [{ accessToken: 'stale' }] }));

        withEnv({
          HOME: home,
          USERPROFILE: home,
          XDG_DATA_HOME: undefined,
          APPDATA: undefined,
          LOCALAPPDATA: undefined,
        }, () => {
          clearTokenTemp([cliDir]);
          assert.equal(fs.existsSync(tokenFile), false);
        });
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  });

  describe('decodeKeyringRaw', () => {
    test('decodes go-keyring-base64 prefixed JSON string', () => {
      const payload = { token: { access_token: 'go-token' } };
      const raw = 'go-keyring-base64:' + Buffer.from(JSON.stringify(payload)).toString('base64');
      assert.deepEqual(decodeKeyringRaw(raw), payload);
    });

    test('decodes standard JSON string', () => {
      const payload = { token: { access_token: 'json-token' } };
      assert.deepEqual(decodeKeyringRaw(JSON.stringify(payload)), payload);
    });

    test('returns plain trimmed string when not JSON', () => {
      assert.equal(decodeKeyringRaw('  plain-token  '), 'plain-token');
    });

    test('returns null on empty or invalid inputs', () => {
      assert.equal(decodeKeyringRaw(''), null);
      assert.equal(decodeKeyringRaw(null), null);
      assert.equal(decodeKeyringRaw('   '), null);
    });
  });
});
