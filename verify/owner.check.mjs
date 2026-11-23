// Static ownership, contract sync, version sync, and capability-boundary checks.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RUNTIME_FILES } from '../scripts/bootstrap.js';
import { configKeys } from '../src/config.ts';
import { DESCRIPTIONS } from '../src/schema.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const errors = [];

// 1. Version consistency across manifests
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const plugin = JSON.parse(fs.readFileSync(path.join(root, 'plugin.json'), 'utf8'));
const ext = JSON.parse(fs.readFileSync(path.join(root, 'gemini-extension.json'), 'utf8'));
if (plugin.version !== pkg.version || ext.version !== pkg.version) {
  errors.push(`Version mismatch: package=${pkg.version}, plugin=${plugin.version}, gemini-extension=${ext.version}`);
}

// 2. bootstrap RUNTIME_FILES must exist and cover all src/**/*.ts and capability runtime files
const manifestSet = new Set(RUNTIME_FILES);
for (const rel of RUNTIME_FILES) {
  if (!fs.existsSync(path.join(root, rel))) {
    errors.push(`bootstrap RUNTIME_FILES entry missing on disk: ${rel}`);
  }
}
const srcFiles = fs.readdirSync(path.join(root, 'src'), { recursive: true })
  .map((f) => `src/${f.replace(/\\/g, '/')}`)
  .filter((f) => f.endsWith('.ts'));
for (const rel of srcFiles) {
  if (!manifestSet.has(rel)) {
    errors.push(`src file missing from scripts/bootstrap.js RUNTIME_FILES: ${rel}`);
  }
}

// 3. Every schema key has a description in src/schema.ts
for (const entry of configKeys()) {
  if (!Object.hasOwn(DESCRIPTIONS, entry.key)) {
    errors.push(`Missing schema description for config key: ${entry.key}`);
  }
}

// 4. Logic source must stay strictly free of capability/credential identifiers
const FORBIDDEN_PATTERNS = [
  ['child_process', /\bnode:child_process\b|['"]child_process['"]/],
  ['http/https/net', /\bnode:(?:https?|net)\b/],
  ['fetch()', /\bfetch\s*\(/],
  ['antigravity-oauth-token', /antigravity-oauth-token/],
  ['oauth_creds.json', /oauth_creds\.json/],
];
for (const rel of srcFiles) {
  const code = fs.readFileSync(path.join(root, rel), 'utf8');
  for (const [label, re] of FORBIDDEN_PATTERNS) {
    if (re.test(code)) {
      errors.push(`Capability boundary violation: ${rel} mentions forbidden ${label}`);
    }
  }
}

if (errors.length > 0) {
  for (const e of errors) console.log(`FAIL ${e}`);
  process.exit(1);
}
console.log(`  ok owner: v${pkg.version}, ${RUNTIME_FILES.length} bootstrap files, ${configKeys().length} schema keys, clean boundary`);
