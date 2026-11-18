import * as fs from 'node:fs';
import { displayLabel } from './utils/sanitize.ts';
import { truncateString } from './utils/truncate.ts';

export interface AuthInfo {
  method: string | null;
  user: string | null;
  email: string | null;
}

const EMPTY_AUTH_INFO: AuthInfo = { method: null, user: null, email: null };
const API_KEY_AUTH_INFO: AuthInfo = { method: 'API Key', user: null, email: null };
const AUTH_VALUE_MAX_LEN = 128;

function hasApiKey(env: NodeJS.ProcessEnv): boolean {
  return typeof env.ANTHROPIC_API_KEY === 'string' && env.ANTHROPIC_API_KEY.trim().length > 0;
}

function readString(obj: Record<string, unknown>, key: string): string | null {
  return displayLabel(obj[key], AUTH_VALUE_MAX_LEN) || null;
}

function formatOrgType(orgType: string): string {
  return orgType
    .split('_')
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(' ');
}

function extractTierSuffix(rateLimitTier: string): string | null {
  const match = /_(\d+x)$/i.exec(rateLimitTier);
  return match ? match[1] : null;
}

export function deriveAuthInfo(claudeJson: unknown, env: NodeJS.ProcessEnv = process.env): AuthInfo {
  if (hasApiKey(env)) return API_KEY_AUTH_INFO;

  const root = claudeJson && typeof claudeJson === 'object' ? (claudeJson as Record<string, unknown>) : null;
  const account = root?.oauthAccount && typeof root.oauthAccount === 'object' ? (root.oauthAccount as Record<string, unknown>) : null;
  if (!account) return EMPTY_AUTH_INFO;

  let method: string | null = null;
  const orgType = readString(account, 'organizationType');
  if (orgType) {
    method = formatOrgType(orgType);
    const rateLimitTier = readString(account, 'organizationRateLimitTier');
    const tier = rateLimitTier ? extractTierSuffix(rateLimitTier) : null;
    if (tier && !method.toLowerCase().includes(tier.toLowerCase())) {
      method += ` ${tier}`;
    }
  }

  const email = readString(account, 'emailAddress');
  const user = email ? email.split('@')[0] : readString(account, 'displayName');
  return { method, user, email };
}

export function readAuthInfo(
  claudeJson: string,
  agyAccount?: { email?: string | null; tier?: string | null } | null,
): AuthInfo {
  const base = (() => {
    if (hasApiKey(process.env)) return API_KEY_AUTH_INFO;
    try {
      return deriveAuthInfo(JSON.parse(fs.readFileSync(claudeJson, 'utf8')));
    } catch {
      return EMPTY_AUTH_INFO;
    }
  })();

  const agyEmail = displayLabel(agyAccount?.email, AUTH_VALUE_MAX_LEN) || null;
  const agyTier = displayLabel(agyAccount?.tier, AUTH_VALUE_MAX_LEN) || null;
  if (!agyEmail && !agyTier) return base;

  const email = agyEmail ?? base.email;
  const user = agyEmail ? agyEmail.split('@')[0] : base.user;
  const method = base.method ?? agyTier;
  return { method, user, email };
}

export function truncateUser(user: string, maxLength: number): string {
  if (maxLength <= 0 || user.length <= maxLength) return user;
  return `${truncateString(user, maxLength, '')}…`;
}

export function formatAuthSegment(
  info: AuthInfo | null | undefined,
  display: {
    showAuth?: boolean;
    showAuthUser?: boolean;
    authUserFullEmail?: boolean;
    authUserLength?: number;
    authUserOverride?: string;
  } | undefined,
): string | null {
  const overrideUser = displayLabel(display?.authUserOverride, AUTH_VALUE_MAX_LEN) || null;
  if (!info && !overrideUser) return null;

  const parts: string[] = [];
  if (display?.showAuth && info?.method) {
    parts.push(info.method);
  }
  const user = overrideUser ?? (display?.authUserFullEmail && info?.email ? info.email : info?.user);
  if (display?.showAuthUser && user) {
    parts.push(truncateUser(user, display?.authUserLength ?? 8));
  }

  return parts.length > 0 ? parts.join(' · ') : null;
}
