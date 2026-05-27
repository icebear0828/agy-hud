'use strict';

const fs = require('fs');
const https = require('https');
const path = require('path');
const { resolveAntigravityPath } = require('./paths.js');

const REMOTE_PKG_URL = 'https://raw.githubusercontent.com/icebear0828/agy-hud/main/package.json';
const STATUS_FILE = resolveAntigravityPath('agy-hud-update-status.json');

function fetchRemoteVersion() {
  return new Promise((resolve, reject) => {
    const parsed = new URL(REMOTE_PKG_URL);
    const req = https.get(parsed, { timeout: 10000 }, response => {
      if (response.statusCode !== 200) {
        response.resume();
        return reject(new Error(`Failed to fetch version: ${response.statusCode}`));
      }
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        try {
          const body = Buffer.concat(chunks).toString();
          const pkg = JSON.parse(body);
          resolve(pkg.version);
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
  });
}

async function main() {
  try {
    let localPkgPath = path.join(__dirname, '..', 'package.json');
    if (!fs.existsSync(localPkgPath)) {
      // In dev or test environments, package.json might be in the root directory
      localPkgPath = path.join(__dirname, '..', '..', 'package.json');
    }
    if (!fs.existsSync(localPkgPath)) {
      return;
    }
    const localPkg = JSON.parse(fs.readFileSync(localPkgPath, 'utf8'));
    const localVersion = localPkg.version;

    const remoteVersion = await fetchRemoteVersion();

    // Simple version comparison: remote !== local
    const updateAvailable = remoteVersion !== localVersion;

    const status = {
      lastCheck: Date.now(),
      updateAvailable,
      latestVersion: remoteVersion,
      localVersion
    };

    fs.writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2));
  } catch (err) {
    // Write check time even on failure to avoid hitting rate limits
    try {
      const current = fs.existsSync(STATUS_FILE)
        ? JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'))
        : {};
      current.lastCheck = Date.now();
      fs.writeFileSync(STATUS_FILE, JSON.stringify(current, null, 2));
    } catch {}
  }
  process.exit(0);
}

main();
