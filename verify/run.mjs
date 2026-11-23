// Runs all offline security, architecture, launcher, owner, and corpus verification checks.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const CHECKS = [
  'arch.check.mjs',
  'owner.check.mjs',
  'escape.check.mjs',
  'launcher.check.mjs',
  'corpus.check.mjs',
];

let failed = 0;
for (const check of CHECKS) {
  const t0 = Date.now();
  const res = spawnSync(process.execPath, [path.join(dir, check)], { stdio: 'inherit' });
  const ms = Date.now() - t0;
  if (res.status !== 0) {
    console.log(`FAIL ${check} (${ms}ms)`);
    failed++;
  }
}

if (failed > 0) {
  console.log(`\nVERIFY FAILED: ${failed}/${CHECKS.length} checks failed`);
  process.exit(1);
}
console.log(`\nALL VERIFIED: ${CHECKS.length}/${CHECKS.length} checks passed`);
