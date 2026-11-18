import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';
import { resolveAntigravityPath } from '../paths.mjs';
import {
  FALLBACK_AGENT_MODEL_IDS,
  discoverAgentModelIds,
  resolveDeprecatedIds,
  normalizeQuotaModels,
  createUnavailableQuotaResult,
} from './models.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ENDPOINTS = ['https://daily-cloudcode-pa.googleapis.com'];
export const AICODE_ENDPOINT = 'https://aicode.googleapis.com';
const USERINFO_ENDPOINTS = [
  'https://openidconnect.googleapis.com/v1/userinfo',
  'https://www.googleapis.com/oauth2/v3/userinfo',
];

function isNativeFetch(fn) {
  if (typeof fn !== 'function') return false;
  const src = Function.prototype.toString.call(fn);
  return src.includes('internal/deps/undici/undici') || src.includes('[native code]');
}

function readCloudConfig() {
  const candidates = [
    path.join(process.cwd(), 'agy-hud.config.json'),
    resolveAntigravityPath('agy-hud.json'),
    resolveAntigravityPath(path.join('agy-hud', 'config.json')),
    resolveAntigravityPath(path.join('agy-hud-runtime', 'runtime', 'agy-hud.config.json')),
  ];
  for (const file of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {}
  }
  return {};
}

function getEnvProxyUrl(targetUrl, env = process.env) {
  if (!env) return null;
  let parsedTarget;
  try {
    parsedTarget = new URL(String(targetUrl));
  } catch {
    return null;
  }
  const noProxy = env.NO_PROXY || env.no_proxy;
  if (noProxy) {
    const host = parsedTarget.hostname.toLowerCase();
    for (const entry of noProxy.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)) {
      if (entry === '*' || host === entry || host.endsWith(entry.startsWith('.') ? entry : `.${entry}`)) {
        return null;
      }
    }
  }
  if (parsedTarget.protocol === 'https:') {
    return env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || env.ALL_PROXY || env.all_proxy || null;
  }
  return env.HTTP_PROXY || env.http_proxy || env.ALL_PROXY || env.all_proxy || null;
}

function fetchViaEnvProxy(targetUrl, options = {}, proxyUrl) {
  return new Promise((resolve, reject) => {
    let target;
    let proxy;
    try {
      target = new URL(String(targetUrl));
      proxy = new URL(String(proxyUrl));
    } catch (err) {
      reject(err);
      return;
    }
    const method = options.method || 'GET';
    const headers = { Connection: 'close', ...(options.headers || {}) };
    const bodyBuffer = options.body !== undefined && options.body !== null ? Buffer.from(String(options.body), 'utf8') : null;
    if (bodyBuffer && !headers['Content-Length'] && !headers['content-length']) {
      headers['Content-Length'] = String(bodyBuffer.length);
    }

    let settled = false;
    let connectReq = null;
    let innerReq = null;
    let tunnelSocket = null;

    const cleanup = () => {
      if (options.signal) options.signal.removeEventListener('abort', onAbort);
    };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      try { connectReq?.destroy(); } catch {}
      try { innerReq?.destroy(); } catch {}
      try { tunnelSocket?.destroy(); } catch {}
      reject(err);
    };
    const onAbort = () => {
      const abortErr = new Error('The operation was aborted');
      abortErr.name = 'AbortError';
      fail(abortErr);
    };
    if (options.signal) {
      if (options.signal.aborted) {
        onAbort();
        return;
      }
      options.signal.addEventListener('abort', onAbort, { once: true });
    }
    const handleResponse = (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        if (settled) return;
        settled = true;
        cleanup();
        try { tunnelSocket?.destroy(); } catch {}
        const rawText = Buffer.concat(chunks).toString('utf8');
        const status = res.statusCode || 0;
        resolve({
          ok: status >= 200 && status < 300,
          status,
          text: async () => rawText,
          json: async () => JSON.parse(rawText),
        });
      });
      res.on('error', fail);
    };

    const proxyPort = Number(proxy.port) || (proxy.protocol === 'https:' ? 443 : 80);
    const proxyAuth = (proxy.username || proxy.password)
      ? `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}`
      : null;

    if (target.protocol === 'https:') {
      const targetPort = Number(target.port) || 443;
      const connectHeaders = { Host: `${target.hostname}:${targetPort}` };
      if (proxyAuth) connectHeaders['Proxy-Authorization'] = proxyAuth;
      connectReq = (proxy.protocol === 'https:' ? https : http).request({
        host: proxy.hostname,
        port: proxyPort,
        method: 'CONNECT',
        path: `${target.hostname}:${targetPort}`,
        headers: connectHeaders,
      });
      connectReq.on('connect', (res, socket, head) => {
        if (res.statusCode !== 200) {
          socket.destroy();
          fail(new Error(`Proxy CONNECT failed with status ${res.statusCode}`));
          return;
        }
        if (head && head.length > 0) socket.unshift(head);
        tunnelSocket = tls.connect({ socket, servername: target.hostname });
        tunnelSocket.on('error', fail);
        innerReq = http.request({
          host: target.hostname,
          port: targetPort,
          method,
          path: `${target.pathname}${target.search}`,
          headers,
          createConnection: () => tunnelSocket,
        }, handleResponse);
        innerReq.on('error', fail);
        if (bodyBuffer) innerReq.write(bodyBuffer);
        innerReq.end();
      });
      connectReq.on('error', fail);
      connectReq.end();
    } else {
      const reqHeaders = { ...headers, Host: target.host };
      if (proxyAuth) reqHeaders['Proxy-Authorization'] = proxyAuth;
      innerReq = (proxy.protocol === 'https:' ? https : http).request({
        host: proxy.hostname,
        port: proxyPort,
        method,
        path: target.toString(),
        headers: reqHeaders,
      }, handleResponse);
      innerReq.on('error', fail);
      if (bodyBuffer) innerReq.write(bodyBuffer);
      innerReq.end();
    }
  });
}

async function cloudFetch(url, options = {}) {
  if (!isNativeFetch(globalThis.fetch)) {
    return globalThis.fetch(url, options);
  }
  const envProxyActive = process.env.NODE_USE_ENV_PROXY === '1'
    || (Array.isArray(process.execArgv) && process.execArgv.includes('--use-env-proxy'));
  if (!envProxyActive) {
    const proxyUrl = getEnvProxyUrl(url);
    if (proxyUrl && /^https?:\/\//i.test(proxyUrl)) {
      return fetchViaEnvProxy(url, options, proxyUrl);
    }
  }
  return globalThis.fetch(url, options);
}

let cachedPkgVersion = null;
function getPackageVersion() {
  if (cachedPkgVersion) return cachedPkgVersion;
  try {
    cachedPkgVersion = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')).version;
  } catch {
    cachedPkgVersion = '0.0.0';
  }
  return cachedPkgVersion;
}

function getPlatformArch() {
  const plat = { darwin: 'darwin', linux: 'linux', win32: 'windows' }[process.platform] || process.platform;
  const arch = { x64: 'amd64', arm64: 'arm64', ia32: '386' }[process.arch] || process.arch;
  return `${plat}/${arch}`;
}

export function buildHeaders(accessToken) {
  return {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'User-Agent': `antigravity/${getPackageVersion()} ${getPlatformArch()}`,
    'X-Goog-Api-Client': `gl-node/${process.versions.node}`,
    'Client-Metadata': JSON.stringify({
      ideType: 'IDE_UNSPECIFIED',
      platform: 'PLATFORM_UNSPECIFIED',
      pluginType: 'GEMINI',
    }),
  };
}

export function resolveEndpoints(config = {}) {
  if (process.env.AGY_HUD_ENDPOINTS) {
    return process.env.AGY_HUD_ENDPOINTS.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return (config && config.endpoints) || DEFAULT_ENDPOINTS;
}

export function extractTierName(data) {
  if (data.paidTier && data.paidTier.name) return data.paidTier.name;
  const nonFree = (data.allowedTiers || []).find((t) => t.id !== 'free-tier');
  if (nonFree && nonFree.name) return nonFree.name;
  if (data.allowedTiers && data.allowedTiers.length > 0) return data.allowedTiers[0].name;
  return null;
}

export async function fetchAccountEmail(accessToken) {
  for (const endpoint of USERINFO_ENDPOINTS) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    try {
      const r = await cloudFetch(endpoint, {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: controller.signal,
      });
      if (!r.ok) continue;
      const data = await r.json();
      if (data && typeof data.email === 'string') return data.email;
    } catch {} finally {
      clearTimeout(timeoutId);
    }
  }
  return null;
}

export async function fetchTierFromCloud(accessToken) {
  const config = readCloudConfig();
  for (const endpoint of resolveEndpoints(config)) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    try {
      const r = await cloudFetch(`${endpoint}/v1internal:loadCodeAssist`, {
        method: 'POST',
        headers: buildHeaders(accessToken),
        body: JSON.stringify({
          cloudaicompanionProject: '',
          metadata: { ideType: 'IDE_UNSPECIFIED', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' },
        }),
        signal: controller.signal,
      });
      if (!r.ok) continue;
      const data = await r.json();
      return extractTierName(data);
    } catch {} finally {
      clearTimeout(timeoutId);
    }
  }
  return null;
}

export function parseQuotaSummary(data) {
  const groups = Array.isArray(data?.groups)
    ? data.groups
    : (Array.isArray(data?.quotaSummary?.groups) ? data.quotaSummary.groups : null);
  if (!groups) return null;
  const result = { google: {}, claude: {}, argon: {} };
  let hasAny = false;
  for (const group of groups) {
    if (!group || !Array.isArray(group.buckets)) continue;
    const buckets = group.buckets;
    const displayName = (group.displayName || group.groupName || '').toLowerCase();
    const hasArgonBucket = buckets.some((b) => b && typeof b.bucketId === 'string' && b.bucketId.includes('argon'));
    const hasGeminiBucket = buckets.some((b) => b && typeof b.bucketId === 'string' && b.bucketId.startsWith('gemini-') && !b.bucketId.includes('argon'));
    const has3pBucket = buckets.some((b) => b && typeof b.bucketId === 'string' && b.bucketId.startsWith('3p-'));
    let target = null;
    if (displayName.includes('argon') || hasArgonBucket) target = 'argon';
    else if (displayName.includes('gemini') || displayName.includes('google') || hasGeminiBucket) target = 'google';
    else if (displayName.includes('claude') || displayName.includes('gpt') || displayName.includes('3p') || displayName.includes('third') || has3pBucket) target = 'claude';
    else continue;

    for (const b of buckets) {
      if (!b || typeof b.resetTime !== 'string') continue;
      const ts = Date.parse(b.resetTime);
      if (!Number.isFinite(ts)) continue;
      const bucketId = b.bucketId || '';
      const windowRaw = b.window || b.refreshWindowLabel || '';
      let winType = null;
      if (windowRaw === 'weekly' || bucketId.includes('weekly')) winType = 'weekly';
      else if (windowRaw === '5h' || bucketId.includes('5h') || bucketId.includes('fiveHour')) winType = 'fiveHour';
      else continue;
      let rf = typeof b.remainingFraction === 'number' ? b.remainingFraction : 0;
      if (!Number.isFinite(rf) || rf < 0) rf = 0;
      if (rf > 1) rf = 1;

      const existing = result[target][winType];
      if (!existing || rf < existing.remainingFraction) {
        result[target][winType] = { remainingFraction: rf, resetTime: b.resetTime };
        hasAny = true;
      }
    }
  }
  if (!hasAny) return null;
  if (!result.google.weekly && !result.google.fiveHour) delete result.google;
  if (!result.claude.weekly && !result.claude.fiveHour) delete result.claude;
  if (!result.argon.weekly && !result.argon.fiveHour) delete result.argon;
  if (Object.keys(result).length === 0) return null;
  return result;
}

export function enrichModelsWithQuotaSummary(models, summary, now = Date.now()) {
  if (!Array.isArray(models) || !summary) return models;
  const hasGoogle = summary.google && (summary.google.weekly || summary.google.fiveHour);
  const hasClaude = summary.claude && (summary.claude.weekly || summary.claude.fiveHour);
  const hasArgon = summary.argon && (summary.argon.weekly || summary.argon.fiveHour);
  if (!hasGoogle && !hasClaude && !hasArgon) return models;
  return models.map((m) => {
    if (!m || !m.id) return m;
    const isArgon = /argon/i.test(m.id) || /argon/i.test(m.displayName || '');
    const isGoogle = !isArgon && (m.modelProvider === 'MODEL_PROVIDER_GOOGLE' || /gemini/i.test(m.id) || /gemini/i.test(m.displayName || ''));
    const isClaude = m.modelProvider === 'MODEL_PROVIDER_ANTHROPIC' || /claude/i.test(m.id) || /claude/i.test(m.displayName || '') || /gpt/i.test(m.id) || /gpt/i.test(m.displayName || '');
    const key = isArgon ? 'argon' : isGoogle ? 'google' : isClaude ? 'claude' : null;
    if (!key) return m;
    const providerSummary = summary[key];
    if (!providerSummary) return m;
    const windows = { ...(m.windows || {}) };
    if (providerSummary.weekly) {
      windows.weekly = { remainingFraction: providerSummary.weekly.remainingFraction, resetTime: providerSummary.weekly.resetTime, observedAt: now };
    }
    if (providerSummary.fiveHour) {
      windows.fiveHour = { remainingFraction: providerSummary.fiveHour.remainingFraction, resetTime: providerSummary.fiveHour.resetTime, observedAt: now };
    }
    return { ...m, windows };
  });
}

function mergeProviderQuotas(primary, secondary) {
  if (!primary && !secondary) return null;
  if (!primary) return secondary;
  if (!secondary) return primary;
  const merged = { ...secondary, ...primary };
  for (const key of ['google', 'claude', 'argon']) {
    if (secondary[key] || primary[key]) merged[key] = { ...(secondary[key] || {}), ...(primary[key] || {}) };
  }
  return merged;
}

export async function fetchQuotaStatusFromAICode(accessToken, config = {}) {
  const endpoint = (config && config.aicodeEndpoint) || process.env.AGY_HUD_AICODE_ENDPOINT || AICODE_ENDPOINT;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);
  try {
    const r = await cloudFetch(`${endpoint}/v1alpha:fetchQuotaStatus`, {
      method: 'GET',
      headers: buildHeaders(accessToken),
      signal: controller.signal,
    });
    if (!r.ok) return null;
    return parseQuotaSummary(await r.json());
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function fetchUserQuotaSummaryFromCloud(accessToken, injectedConfig) {
  const config = injectedConfig || readCloudConfig();
  let summary = null;
  for (const endpoint of resolveEndpoints(config)) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    try {
      const r = await cloudFetch(`${endpoint}/v1internal:retrieveUserQuotaSummary`, {
        method: 'POST',
        headers: buildHeaders(accessToken),
        body: JSON.stringify({}),
        signal: controller.signal,
      });
      if (!r.ok) continue;
      const parsed = parseQuotaSummary(await r.json());
      if (parsed) {
        summary = parsed;
        break;
      }
    } catch {} finally {
      clearTimeout(timeoutId);
    }
  }
  const hasCustomEndpoints = Boolean(process.env.AGY_HUD_ENDPOINTS || (config && Array.isArray(config.endpoints)));
  const shouldSupplementFromAICode = Boolean((config && config.aicodeEndpoint) || !hasCustomEndpoints);
  if (shouldSupplementFromAICode && (!summary || !summary.google || !summary.claude)) {
    const aicodeSummary = await fetchQuotaStatusFromAICode(accessToken, config);
    if (aicodeSummary) summary = mergeProviderQuotas(summary, aicodeSummary);
  }
  return summary;
}

export async function fetchQuotaFromCloud(accessToken) {
  let sawAuthFailure = false;
  const config = readCloudConfig();
  const endpoints = resolveEndpoints(config);
  const envModelIds = process.env.AGY_HUD_INTERESTING_MODELS
    ? process.env.AGY_HUD_INTERESTING_MODELS.split(',').map((s) => s.trim()).filter(Boolean)
    : null;

  const summaryPromise = fetchUserQuotaSummaryFromCloud(accessToken, config).catch(() => null);
  let normalized = null;
  for (const endpoint of endpoints) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    try {
      const r = await cloudFetch(`${endpoint}/v1internal:fetchAvailableModels`, {
        method: 'POST',
        headers: buildHeaders(accessToken),
        body: JSON.stringify({}),
        signal: controller.signal,
      });
      if (!r.ok) {
        if (r.status === 401 || r.status === 403) sawAuthFailure = true;
        continue;
      }
      const data = await r.json();
      const models = data.models || {};
      let interestingModelIds = envModelIds
        || config.interestingModels
        || resolveDeprecatedIds(discoverAgentModelIds(data) || FALLBACK_AGENT_MODEL_IDS, data);
      if (data && data.models) {
        const imageModelIds = Object.keys(data.models).filter((id) => id.includes('-image') || id.toLowerCase().includes('image'));
        interestingModelIds = [...new Set([...interestingModelIds, ...imageModelIds])];
      }
      normalized = normalizeQuotaModels(models, interestingModelIds);
      break;
    } catch {} finally {
      clearTimeout(timeoutId);
    }
  }
  if (!normalized) {
    return createUnavailableQuotaResult(sawAuthFailure ? 'auth_failed' : 'quota_fetch_failed');
  }
  try {
    const summary = await summaryPromise;
    if (summary) {
      normalized = enrichModelsWithQuotaSummary(normalized, summary, Date.now());
      normalized.providerQuota = summary;
    }
  } catch {}
  return normalized;
}
