'use strict';

const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const { resolveAntigravityPath } = require('./paths.js');

const REMOTE_PKG_URL = 'https://raw.githubusercontent.com/icebear0828/agy-hud/main/package.json';
const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

function parseSemver(version) {
  if (typeof version !== 'string') return null;
  const match = SEMVER_RE.exec(version.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

function comparePrerelease(a, b) {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;

  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (i >= a.length) return -1;
    if (i >= b.length) return 1;
    const ai = a[i];
    const bi = b[i];
    if (ai === bi) continue;

    const aNum = /^\d+$/.test(ai);
    const bNum = /^\d+$/.test(bi);
    if (aNum && bNum) return Number(ai) - Number(bi);
    if (aNum) return -1;
    if (bNum) return 1;
    return ai < bi ? -1 : 1;
  }
  return 0;
}

function isNewerVersion(remote, local) {
  const r = parseSemver(remote);
  const l = parseSemver(local);
  if (!r || !l) return false;

  if (r.major !== l.major) return r.major > l.major;
  if (r.minor !== l.minor) return r.minor > l.minor;
  if (r.patch !== l.patch) return r.patch > l.patch;
  return comparePrerelease(r.prerelease, l.prerelease) > 0;
}

function fetchRemoteVersion(url = REMOTE_PKG_URL, options = {}) {
  const timeoutMs = options.timeoutMs !== undefined ? options.timeoutMs : 10000;
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = parsed.protocol === 'http:' ? http : https;
    const req = client.get(parsed, { timeout: timeoutMs }, response => {
      if (response.statusCode !== 200) {
        response.resume();
        return reject(new Error(`Failed to fetch version: ${response.statusCode}`));
      }
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        try {
          const body = Buffer.concat(chunks).toString('utf8');
          const pkg = JSON.parse(body);
          resolve(pkg && typeof pkg.version === 'string' ? pkg.version : undefined);
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('timeout', () => {
      req.destroy(new Error('timeout'));
    });
    req.on('error', reject);
  });
}

async function checkForUpdates(options = {}) {
  const statusFile = options.statusFile || resolveAntigravityPath('agy-hud-update-status.json');
  try {
    let localPkgPath = options.localPkgPath || path.join(__dirname, '..', 'package.json');
    if (!fs.existsSync(localPkgPath)) {
      // In dev or test environments, package.json might be in the root directory
      localPkgPath = path.join(__dirname, '..', '..', 'package.json');
    }
    if (!fs.existsSync(localPkgPath)) {
      return null;
    }
    const localPkg = JSON.parse(fs.readFileSync(localPkgPath, 'utf8'));
    const localVersion = localPkg.version;

    const remoteVersion = options.fetchVersion
      ? await options.fetchVersion()
      : await fetchRemoteVersion(options.url || REMOTE_PKG_URL, { timeoutMs: options.timeoutMs });

    const updateAvailable = isNewerVersion(remoteVersion, localVersion);

    const status = {
      lastCheck: Date.now(),
      updateAvailable,
      latestVersion: typeof remoteVersion === 'string' ? remoteVersion : null,
      localVersion,
    };

    fs.mkdirSync(path.dirname(statusFile), { recursive: true });
    fs.writeFileSync(statusFile, JSON.stringify(status, null, 2));
    return status;
  } catch {
    // Write check time even on failure to avoid hitting rate limits
    try {
      const current = fs.existsSync(statusFile)
        ? JSON.parse(fs.readFileSync(statusFile, 'utf8'))
        : {};
      current.lastCheck = Date.now();
      fs.mkdirSync(path.dirname(statusFile), { recursive: true });
      fs.writeFileSync(statusFile, JSON.stringify(current, null, 2));
    } catch {}
    return null;
  }
}

if (require.main === module) {
  checkForUpdates().finally(() => {
    process.exit(0);
  });
}

module.exports = {
  REMOTE_PKG_URL,
  parseSemver,
  isNewerVersion,
  fetchRemoteVersion,
  checkForUpdates,
};
