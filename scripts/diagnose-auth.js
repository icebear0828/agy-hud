#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { getAntigravityRoots, resolveSafeExecutable } = require('../runtime/paths.js');
const {
  getTokenCandidates,
  parseTokenPayload,
  readToken,
} = require('../runtime/quota.js');

function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined)
  );
}

function pathExists(target) {
  try {
    fs.accessSync(target, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function listJsonKeys(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.keys(value).sort();
}

function summarizeTokenCandidate(candidatePath) {
  const summary = {
    path: candidatePath,
    exists: false,
    readable: false,
    parseable: false,
  };

  try {
    const stat = fs.statSync(candidatePath);
    summary.exists = stat.isFile();
    summary.size = stat.size;
  } catch {
    summary.reason = 'not_found';
    return summary;
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
    summary.readable = true;
  } catch {
    summary.reason = 'invalid_or_unreadable_json';
    return summary;
  }

  summary.keys = listJsonKeys(parsed);
  if (parsed && typeof parsed === 'object' && parsed.token) {
    summary.tokenKeys = listJsonKeys(parsed.token);
  }

  const token = parseTokenPayload(parsed);
  if (!token) {
    summary.reason = 'unsupported_token_shape';
    return summary;
  }

  summary.parseable = true;
  summary.sourceFormat = token.sourceFormat;
  summary.hasExpiry = Boolean(token.expiry);
  return summary;
}

function getAgyCandidates() {
  const candidates = [process.env.AGY_BIN].filter(Boolean);

  const resolved = resolveSafeExecutable('agy');
  if (resolved) candidates.push(resolved);

  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA ||
      path.join(os.homedir(), 'AppData', 'Local');
    candidates.push(path.join(localAppData, 'agy', 'bin', 'agy.exe'));
  } else {
    candidates.push(
      '/opt/homebrew/bin/agy',
      '/usr/local/bin/agy',
      '/usr/bin/agy'
    );
  }

  return [...new Set(candidates)];
}

function summarizeAgyCandidates(candidates) {
  const existingCandidates = candidates.filter(pathExists);
  return compactObject({
    candidateCount: candidates.length,
    existingCandidates: existingCandidates.length > 0 ? existingCandidates.slice(0, 10) : undefined,
  });
}

function resolveAgyInfo() {
  const candidates = getAgyCandidates();
  let lastError;

  for (const candidate of candidates) {
    if (!pathExists(candidate)) continue;
    try {
      const version = execFileSync(candidate, ['--version'], {
        encoding: 'utf8',
        timeout: 3000,
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
      return {
        found: true,
        path: candidate,
        version: version.split(/\r?\n/)[0] || null,
        candidateCount: candidates.length,
      };
    } catch (error) {
      lastError = error && error.code ? error.code : 'version_check_failed';
      return compactObject({
        found: true,
        path: candidate,
        version: null,
        versionError: lastError,
        candidateCount: candidates.length,
      });
    }
  }

  return compactObject({
    found: false,
    ...summarizeAgyCandidates(candidates),
    lastError,
  });
}

function sanitizeReadTokenResult(token) {
  if (!token) return { found: false };

  return compactObject({
    found: true,
    sourceFormat: token.sourceFormat || (Array.isArray(token.all) ? 'windows-credential' : undefined),
    sourcePath: token.sourcePath || undefined,
    hasExpiry: Boolean(token.expiry),
    tokenCount: Array.isArray(token.all) ? token.all.length : 1,
  });
}

function buildAuthDiagnostic(options = {}) {
  const roots = getAntigravityRoots();
  const resolveAgy = options.resolveAgyInfo || resolveAgyInfo;
  const platform = options.platform || process.platform;

  return {
    schemaVersion: 1,
    platform,
    arch: process.arch,
    node: process.version,
    home: os.homedir(),
    cwd: process.cwd(),
    agy: resolveAgy(),
    antigravityRoots: roots.map(root => ({
      path: root,
      exists: pathExists(root),
    })),
    tokenCandidates: getTokenCandidates(roots).map(summarizeTokenCandidate),
    readToken: sanitizeReadTokenResult(readToken({ platform })),
  };
}

function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stdout.write('Usage: node scripts/diagnose-auth.js\n');
    process.stdout.write('Prints a JSON auth diagnostic without token values.\n');
    return;
  }

  process.stdout.write(`${JSON.stringify(buildAuthDiagnostic(), null, 2)}\n`);
}

if (require.main === module) main();

module.exports = {
  buildAuthDiagnostic,
  resolveAgyInfo,
  summarizeTokenCandidate,
  sanitizeReadTokenResult,
};
