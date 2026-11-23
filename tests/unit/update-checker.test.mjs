import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  parseSemver,
  isNewerVersion,
  fetchRemoteVersion,
  checkForUpdates,
} = require('../../runtime/update-checker.js');

test('isNewerVersion compares semver correctly and rejects downgrades and invalid versions', () => {
  assert.equal(isNewerVersion('0.3.4', '0.3.3'), true);
  assert.equal(isNewerVersion('0.10.0', '0.9.9'), true);
  assert.equal(isNewerVersion('1.0.0', '0.99.99'), true);
  assert.equal(isNewerVersion('v0.4.0', '0.3.3'), true);
  assert.equal(isNewerVersion('1.0.0', '1.0.0-beta.1'), true);
  assert.equal(isNewerVersion('1.0.0-beta.2', '1.0.0-beta.1'), true);

  // Equal or downgrades
  assert.equal(isNewerVersion('0.3.3', '0.3.3'), false);
  assert.equal(isNewerVersion('0.3.2', '0.3.3'), false);
  assert.equal(isNewerVersion('0.2.9', '0.3.0'), false);
  assert.equal(isNewerVersion('1.0.0-beta.1', '1.0.0'), false);

  // Invalid / missing versions
  assert.equal(isNewerVersion(undefined, '0.3.3'), false);
  assert.equal(isNewerVersion(null, '0.3.3'), false);
  assert.equal(isNewerVersion('', '0.3.3'), false);
  assert.equal(isNewerVersion('not-a-version', '0.3.3'), false);
  assert.equal(isNewerVersion('1.2', '0.3.3'), false);
  assert.equal(isNewerVersion('0.3.4', undefined), false);
  assert.equal(parseSemver('bad'), null);
});

test('fetchRemoteVersion parses version from HTTP 200 and rejects non-200', async () => {
  let mode = 'ok';
  const server = http.createServer((req, res) => {
    if (mode === 'ok') {
      res.statusCode = 200;
      res.end(JSON.stringify({ name: 'agy-hud', version: '0.4.0' }));
    } else {
      res.statusCode = 503;
      res.end('unavailable');
    }
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}/package.json`;

  try {
    const version = await fetchRemoteVersion(url, { timeoutMs: 2000 });
    assert.equal(version, '0.4.0');

    mode = 'error';
    await assert.rejects(
      () => fetchRemoteVersion(url, { timeoutMs: 2000 }),
      /Failed to fetch version: 503/
    );
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('fetchRemoteVersion aborts hung sockets on timeout', async () => {
  const openSockets = new Set();
  const server = http.createServer((req, res) => {
    openSockets.add(res.socket);
    // Intentionally never respond to simulate a hung socket
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}/package.json`;

  try {
    await assert.rejects(
      () => fetchRemoteVersion(url, { timeoutMs: 80 }),
      /timeout/i
    );
  } finally {
    for (const sock of openSockets) sock.destroy();
    await new Promise(resolve => server.close(resolve));
  }
});

test('checkForUpdates writes semver-verified status and preserves lastCheck on errors', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-update-check-'));
  const pkgPath = path.join(tmp, 'package.json');
  const statusFile = path.join(tmp, 'agy-hud-update-status.json');
  try {
    fs.writeFileSync(pkgPath, JSON.stringify({ version: '0.3.3' }));

    // Newer remote version
    const newer = await checkForUpdates({
      localPkgPath: pkgPath,
      statusFile,
      fetchVersion: async () => '0.4.0',
    });
    assert.equal(newer.updateAvailable, true);
    assert.equal(newer.latestVersion, '0.4.0');
    assert.equal(newer.localVersion, '0.3.3');

    // Downgrade or invalid remote must NOT flag updateAvailable
    const downgrade = await checkForUpdates({
      localPkgPath: pkgPath,
      statusFile,
      fetchVersion: async () => '0.3.2',
    });
    assert.equal(downgrade.updateAvailable, false);

    const invalid = await checkForUpdates({
      localPkgPath: pkgPath,
      statusFile,
      fetchVersion: async () => undefined,
    });
    assert.equal(invalid.updateAvailable, false);
    assert.equal(invalid.latestVersion, null);

    // Fetch failure still updates lastCheck
    const failed = await checkForUpdates({
      localPkgPath: pkgPath,
      statusFile,
      fetchVersion: async () => { throw new Error('network down'); },
    });
    assert.equal(failed, null);
    const saved = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
    assert.equal(typeof saved.lastCheck, 'number');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
