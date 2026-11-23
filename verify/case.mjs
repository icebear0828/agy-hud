// Shared contract validator for tests/corpus/*.json regression fixtures.
import { terminalFilter } from '../hud.mjs';

export const FIELDS = {
  note: 'string',
  columns: 'number',
  stdin: 'object|string',
  expect: 'array',
  config: 'object',
  versions: 'object',
  platform: 'string',
  tz: 'string',
  now: 'string',
  facts: 'object',
  stdinOpen: 'boolean',
};
const REQUIRED = ['note', 'columns', 'stdin', 'expect'];

const SGR = /\x1b\[[0-9;:]*m/g;
const OSC8 = /\x1b\]8;[^;\x07\x1b]*;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
export const visible = (s) => s.replace(SGR, '').replace(OSC8, '').replace(/\u00A0/g, ' ');
const wide = /[ᄀ-ᅟ⺀-〾ぁ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]|[\u{1f300}-\u{1faff}\u{20000}-\u{3fffd}]/u;
const zero = /[\p{M}\u200b-\u200d\ufe0e-\ufe0f]/u;
export const cells = (s) => [...visible(s)].reduce((n, ch) => n + (zero.test(ch) ? 0 : wide.test(ch) ? 2 : 1), 0);

export function unsafeEscape(text, stdin = null) {
  const filter = terminalFilter(stdin !== null && typeof stdin === 'object' ? stdin : null);
  for (const line of text.split('\n')) {
    const kept = filter(line);
    if (kept === line) continue;
    let at = 0;
    while (line[at] === kept[at]) at++;
    return `escape ${JSON.stringify(line.slice(at, at + 24))}`;
  }
  return null;
}

const openLink = (line) => Boolean([...line.matchAll(OSC8)].at(-1)?.[1]);
const lines = (r) => r.out.replace(/\n$/, '').split('\n').filter((l, i, arr) => !(arr.length === 1 && l === ''));

export const EXPECT = [
  [/^exit 0$/, (r) => r.code === 0 || `exit ${r.code}: ${r.err.slice(0, 200)}`],
  [/^finishes within (\d+)ms$/, (r, c, ms) => r.ms <= Number(ms) || `took ${r.ms}ms`],
  [/^at most (\d+) lines$/, (r, c, n) => lines(r).length <= Number(n) || `${lines(r).length} lines`],
  [/^no line wider than columns$/, (r, c) => lines(r).every((l) => cells(l) <= c.columns) || `a line is ${Math.max(...lines(r).map(cells))} cells (limit ${c.columns})`],
  [/^every line closes its OSC 8 link$/, (r) => !lines(r).some(openLink) || 'a line leaves a link open'],
  [/^only safe escapes$/, (r, c) => !unsafeEscape(r.raw ?? r.out, c.stdin) || `unsafe ${unsafeEscape(r.raw ?? r.out, c.stdin)}`],
  [/^no lone surrogate$/, (r) => !/[\p{Cs}]/u.test(r.out) || 'a character was cut in half'],
  [/^contains (.+)$/s, (r, c, text) => visible(r.out).includes(text) || `no ${JSON.stringify(text)} in ${JSON.stringify(visible(r.out))}`],
  [/^lacks (.+)$/s, (r, c, text) => !visible(r.out).includes(text) || `has ${JSON.stringify(text)}`],
];

export function checkExpect(word, result, c) {
  for (const [pattern, check] of EXPECT) {
    const m = pattern.exec(word);
    if (m) return check(result, c, ...m.slice(1));
  }
  return `unknown expectation ${JSON.stringify(word)}`;
}

export function validateCase(c) {
  if (c === null || typeof c !== 'object' || Array.isArray(c)) return ['a case is a JSON object'];
  const errors = REQUIRED.filter((k) => !(k in c)).map((k) => `missing ${k}`);
  for (const [k, v] of Object.entries(c)) {
    const type = Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v;
    if (!FIELDS[k]) errors.push(`unknown field ${k}`);
    else if (!FIELDS[k].split('|').includes(type)) errors.push(`${k} must be ${FIELDS[k]}`);
  }
  if (Array.isArray(c.expect)) {
    if (!c.expect.length) errors.push('expect is empty');
    for (const w of c.expect) if (typeof w !== 'string' || !EXPECT.some(([p]) => p.test(w))) errors.push(`unknown expectation ${JSON.stringify(w)}`);
  }
  if (typeof c.columns === 'number' && !(c.columns > 0 && c.columns <= 1000)) errors.push('columns must be 1-1000');
  return errors;
}
