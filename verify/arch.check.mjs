// Verifies ARCHITECTURE.md against real stripped imports in src/**/*.ts and ALLOWED in fence.mjs.
import fs from 'node:fs';
import nodeModule from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const archText = fs.readFileSync(path.join(root, 'ARCHITECTURE.md'), 'utf8');
const fenceText = fs.readFileSync(path.join(root, 'fence.mjs'), 'utf8');

const mermaidMatch = archText.match(/```mermaid\r?\n([\s\S]*?)```/);
if (!mermaidMatch) throw new Error('ARCHITECTURE.md missing mermaid flowchart');

const boxes = new Map();
const builtins = new Set();
const allowedEdges = new Set();

for (const rawLine of mermaidMatch[1].split(/\r?\n/)) {
  const line = rawLine.trim();
  const rect = /^(\w+)\["[^:]+:\s*(.+)"\]$/.exec(line);
  if (rect) {
    boxes.set(rect[1], rect[2].split(/\s+/).filter(Boolean));
    continue;
  }
  const sub = /^(\w+)\[\["([^"]+)"\]\]$/.exec(line);
  if (sub) {
    boxes.set(sub[1], [sub[2]]);
    continue;
  }
  const rounded = /^(\w+)\(\["([^"]+)"\]\)$/.exec(line);
  if (rounded) {
    boxes.set(rounded[1], rounded[2].split(/\s+/).filter(Boolean));
    for (const mod of rounded[2].split(/\s+/).filter(Boolean)) builtins.add(mod);
    continue;
  }
  const arrow = /^(\w+)\s*-->\s*(.+)$/.exec(line);
  if (arrow) {
    const targets = arrow[2].split('&').map((s) => s.trim()).filter(Boolean);
    for (const target of targets) allowedEdges.add(`${arrow[1]}->${target}`);
  }
}

const fenceAllowedMatch = /const ALLOWED = table\(\{([^}]+)\}\)/.exec(fenceText);
if (!fenceAllowedMatch) throw new Error('fence.mjs missing ALLOWED table');
const fenceBuiltins = new Set([...fenceAllowedMatch[1].matchAll(/'(node:[^']+)'/g)].map((m) => m[1]));

const errors = [];
if (builtins.size !== fenceBuiltins.size || [...builtins].some((b) => !fenceBuiltins.has(b))) {
  errors.push(`Builtins mismatch between ARCHITECTURE.md (${[...builtins].sort()}) and fence.mjs (${[...fenceBuiltins].sort()})`);
}

function ownerBox(relPosix) {
  const matches = [];
  for (const [boxId, globs] of boxes) {
    for (const g of globs) {
      if (g.endsWith('/**')) {
        if (relPosix.startsWith(g.slice(0, -2))) matches.push(boxId);
      } else if (relPosix === g) {
        matches.push(boxId);
      }
    }
  }
  return matches;
}

const srcDir = path.join(root, 'src');
const srcFiles = fs.readdirSync(srcDir, { recursive: true })
  .map((f) => f.replace(/\\/g, '/'))
  .filter((f) => f.endsWith('.ts'))
  .sort();

const fileBox = new Map();
for (const rel of srcFiles) {
  const owners = ownerBox(rel);
  if (owners.length === 0) errors.push(`src/${rel} belongs to no box in ARCHITECTURE.md`);
  else if (owners.length > 1) errors.push(`src/${rel} belongs to multiple boxes: ${owners.join(', ')}`);
  else fileBox.set(rel, owners[0]);
}

const emitWarning = process.emitWarning;
process.emitWarning = () => {};
const usedEdges = new Set();

function runtimeSpecifiers(tsSource) {
  const js = nodeModule.stripTypeScriptTypes(tsSource);
  const specs = new Set();
  for (const m of js.matchAll(/\b(?:import|export)\b[\s\S]*?\bfrom\s*['"]([^'"]+)['"]/g)) specs.add(m[1]);
  for (const m of js.matchAll(/\bimport\s*['"]([^'"]+)['"]/g)) specs.add(m[1]);
  return [...specs];
}

try {
  for (const rel of srcFiles) {
    const fromBox = fileBox.get(rel);
    if (!fromBox) continue;
    const full = path.join(srcDir, rel);
    const specs = runtimeSpecifiers(fs.readFileSync(full, 'utf8'));
    for (const spec of specs) {
      let toBox = null;
      if (spec.startsWith('node:')) {
        for (const boxId of ['fsio', 'host']) {
          if (boxes.get(boxId)?.includes(spec)) toBox = boxId;
        }
        if (!toBox) {
          errors.push(`src/${rel} imports disallowed builtin ${spec}`);
          continue;
        }
      } else if (spec.startsWith('.')) {
        const resolvedAbs = path.resolve(path.dirname(full), spec);
        const relRoot = path.relative(root, resolvedAbs).replace(/\\/g, '/');
        if (relRoot === 'hud.mjs') {
          toBox = 'hud';
        } else if (relRoot.startsWith('src/')) {
          toBox = fileBox.get(relRoot.slice(4)) ?? null;
        }
      }
      if (!toBox) {
        errors.push(`src/${rel} imports unresolved or unboxed target ${spec}`);
        continue;
      }
      if (toBox === fromBox) continue;
      const edge = `${fromBox}->${toBox}`;
      usedEdges.add(edge);
      if (!allowedEdges.has(edge)) {
        errors.push(`Architecture violation: src/${rel} (${fromBox}) -> ${spec} (${toBox}) is missing edge ${edge} in ARCHITECTURE.md`);
      }
    }
  }
} finally {
  process.emitWarning = emitWarning;
}

for (const edge of allowedEdges) {
  if (!usedEdges.has(edge)) {
    errors.push(`Unused edge in ARCHITECTURE.md: ${edge}`);
  }
}

if (errors.length > 0) {
  for (const err of errors) console.log(`FAIL ${err}`);
  process.exit(1);
}
console.log(`  ok architecture: ${srcFiles.length} modules, ${allowedEdges.size} box edges match ARCHITECTURE.md and fence.mjs`);
