import type { Language, MessageKey, Messages } from "./types.ts";
import { en } from "./en.ts";
import { zhHans } from "./zh-Hans.ts";
import { zhHant } from "./zh-Hant.ts";

export type { Language, MessageKey, Messages };

type CanonicalLanguage = "en" | "zh-Hans" | "zh-Hant";

const locales: Record<CanonicalLanguage, Messages> = {
  en,
  "zh-Hans": zhHans,
  "zh-Hant": zhHant,
};

const CANONICAL: Record<Exclude<Language, "auto">, CanonicalLanguage> = {
  en: "en",
  zh: "zh-Hans",
  "zh-Hans": "zh-Hans",
  "zh-Hant": "zh-Hant",
  "zh-TW": "zh-Hant",
};

let currentLanguage: Language = "en";

export function setLanguage(lang: Language): void {
  currentLanguage = lang;
}

function resolveAutoLocale(env: NodeJS.ProcessEnv = process.env): CanonicalLanguage {
  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG || "";
  if (/^zh(?:_|-)(?:TW|HK|MO|Hant)/i.test(locale)) return "zh-Hant";
  if (/^zh(?:_|-|$)/i.test(locale)) return "zh-Hans";
  return "en";
}

function getCanonicalLanguage(): CanonicalLanguage {
  if (currentLanguage === "auto") return resolveAutoLocale();
  return CANONICAL[currentLanguage] ?? "en";
}

export function isCjkLanguage(): boolean {
  const canon = getCanonicalLanguage();
  return canon === "zh-Hans" || canon === "zh-Hant";
}

export function t(key: MessageKey): string {
  const canon = getCanonicalLanguage();
  return locales[canon]?.[key] ?? locales.en[key] ?? key;
}

export function interpolate(pattern: string, params: Record<string, string | number>): string {
  return pattern.replace(/\{(\w+)\}/g, (_, k) => String(params[k] ?? ""));
}
