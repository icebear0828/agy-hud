import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveAntigravityPath } from './paths.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REMOTE_PKG_URL = 'https://raw.githubusercontent.com/icebear0828/agy-hud/main/package.json';
const STATUS_FILE = resolveAntigravityPath('agy-hud-update-status.json');

export function fetchRemoteVersion(url = REMOTE_PKG_URL) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = https.get(parsed, { timeout: 10_000 }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        return reject(new Error(`Failed to fetch version: ${response.statusCode}`));
      }
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        try {
          const pkg = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve(pkg.version);
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('error', reject);
  });
}

function parseVersionParts(version) {
  if (typeof version !== 'string') return null;
  const cleaned = version.trim().replace(/^v/i, '').split('-')[0];
  if (!/^\d+(?:\.\d+)*$/.test(cleaned)) return null;
  return cleaned.split('.').map((n) => parseInt(n, 10));
}

export function isRemoteVersionNewer(remoteVersion, localVersion) {
  const remote = parseVersionParts(remoteVersion);
  const local = parseVersionParts(localVersion);
  if (!remote || !local) return false;
  const len = Math.max(remote.length, local.length);
  for (let i = 0; i < len; i++) {
    const r = remote[i] || 0;
    const l = local[i] || 0;
    if (r > l) return true;
    if (r < l) return false;
  }
  return false;
}

export function getLocalPackageVersion() {
  const candidates = [
    path.join(__dirname, '..', 'package.json'),
    path.join(__dirname, '..', '..', 'package.json'),
  ];
  for (const pkgPath of candidates) {
    try {
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        if (pkg && typeof pkg.version === 'string') return pkg.version;
      }
    } catch {}
  }
  return null;
}

export async function runUpdateCheck(statusFile = STATUS_FILE) {
  try {
    const localVersion = getLocalPackageVersion();
    if (!localVersion) return;

    const remoteVersion = await fetchRemoteVersion();
    const updateAvailable = isRemoteVersionNewer(remoteVersion, localVersion);
    const status = {
      lastCheck: Date.now(),
      updateAvailable,
      latestVersion: remoteVersion,
      localVersion,
    };
    fs.mkdirSync(path.dirname(statusFile), { recursive: true });
    fs.writeFileSync(statusFile, JSON.stringify(status, null, 2));
  } catch {
    try {
      const current = fs.existsSync(statusFile)
        ? JSON.parse(fs.readFileSync(statusFile, 'utf8'))
        : {};
      current.lastCheck = Date.now();
      fs.mkdirSync(path.dirname(statusFile), { recursive: true });
      fs.writeFileSync(statusFile, JSON.stringify(current, null, 2));
    } catch {}
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runUpdateCheck();
  process.exit(0);
}
