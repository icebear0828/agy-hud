import { execFileSync } from 'node:child_process';
import { resolveSafeExecutable } from './paths.mjs';

export function readWindowsCodepage(env = process.env) {
  try {
    const chcpPath = resolveSafeExecutable('chcp', env, 'win32');
    if (!chcpPath) return '';
    const out = execFileSync(chcpPath, [], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 500 }).toString();
    const match = out.match(/(\d{3,5})/);
    return match ? match[1] : '';
  } catch {
    return '';
  }
}

export function detectUnicodeSupport(opts = {}) {
  const env = opts.env || process.env;
  const platform = opts.platform || process.platform;
  const readCodepage = opts.readCodepage || (() => readWindowsCodepage(env));

  if (env.AGY_HUD_FORCE_ASCII === '1') return false;
  if (env.AGY_HUD_FORCE_UNICODE === '1') return true;

  if (platform === 'win32') {
    return readCodepage() === '65001';
  }

  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG || '';
  if (/utf-?8/i.test(locale)) return true;
  if (locale && locale.toUpperCase().includes('POSIX')) return false;
  if (!locale) return true;
  return false;
}

let cached = null;
export function supportsUnicode() {
  if (cached === null) cached = detectUnicodeSupport();
  return cached;
}
