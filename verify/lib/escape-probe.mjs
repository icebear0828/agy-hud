// Hostile probe module run *inside* fence.mjs + node --permission by verify/escape.check.mjs.
// Every single escape vector MUST throw or be denied, reporting results back over the channel.
import fs from 'node:fs';
import { createChannel } from '../../src/channel.ts';

const { init, reply } = createChannel();
const msg = await init;

const probes = [];
const tryEscape = async (name, fn) => {
  try {
    const value = await fn();
    probes.push({ name, escaped: true, detail: String(value ?? 'succeeded').slice(0, 120) });
  } catch (err) {
    probes.push({ name, escaped: false, detail: err instanceof Error ? err.message.slice(0, 80) : 'thrown' });
  }
};

// 1. Forbidden builtin imports (dynamic import bypass attempts)
for (const mod of ['node:child_process', 'child_process', 'node:net', 'net', 'node:http', 'node:https', 'node:worker_threads', 'node:vm', 'node:inspector']) {
  await tryEscape(`import(${mod})`, async () => {
    await import(mod);
    return 'imported';
  });
}

// 2. Data / HTTP URL dynamic import
await tryEscape('import(data:...)', async () => {
  await import('data:text/javascript,export default 1');
  return 'imported data url';
});

// 3. process.getBuiltinModule bypass
await tryEscape('getBuiltinModule(child_process)', () => {
  const fn = process.getBuiltinModule;
  return fn ? fn('child_process') : (() => { throw new Error('missing'); })();
});

// 4. Sealed globals & code generation
for (const g of ['fetch', 'WebSocket', 'EventSource', 'navigator']) {
  await tryEscape(`global.${g}`, () => {
    if (globalThis[g] !== undefined) return 'present';
    throw new Error('sealed');
  });
}

await tryEscape('eval', () => (0, eval)('1+1'));
await tryEscape('new Function', () => new Function('return 1')());
await tryEscape('process.stdin sealed', () => {
  if (process.stdin !== undefined) return 'stdin exposed';
  throw new Error('sealed');
});

// 5. Filesystem escape outside read/write grants
const secretFile = typeof msg.stdin?.secretFile === 'string' ? msg.stdin.secretFile : '/etc/hosts';
await tryEscape('read outside grants', () => fs.readFileSync(secretFile, 'utf8'));
await tryEscape('write outside dataDir', () => {
  fs.writeFileSync(`${msg.paths.config}.pwned`, 'x');
  return 'wrote config';
});
await tryEscape('readdir root', () => fs.readdirSync('/'));

// 6. Attempt unsafe terminal escapes in output lines (hud.mjs terminalFilter must strip them)
const escaped = probes.filter((p) => p.escaped);
reply({
  lines: [
    escaped.length === 0 ? 'SAFE_ALL_DENIED' : `ESCAPED:${escaped.map((e) => e.name).join(',')}`,
    '\x1b[31mKEEP_COLOR\x1b[0m \x1b]8;;https://evil.example/phish\x1b\\DROP_URL\x1b]8;;\x1b\\ \x1b[2JCLEAR_STRIPPED \u202eBIDI_STRIPPED',
  ],
  failed: escaped.length > 0,
});
