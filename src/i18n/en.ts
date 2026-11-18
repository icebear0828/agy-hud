import type { Messages } from "./types.ts";

export const en: Messages = {
  // Labels
  "label.context": "Context",
  "label.usage": "Usage",
  "label.weekly": "Weekly",
  "label.approxRam": "Approx RAM",
  "label.promptCache": "Cache",
  "label.cacheHitRate": "Cache hit",
  "label.rules": "rules",
  "label.hooks": "hooks",
  "label.cost": "Cost",
  "label.today": "Today",
  "label.week": "Week",
  "label.tokens": "Tokens",
  "label.sessionStarted": "Started",
  "label.lastReply": "Last reply",
  "label.advisor": "Advisor",
  "label.compactions": "Compactions",
  "label.imageQuota": "Image Quota",

  // Status
  "status.limitReached": "Limit reached",
  "status.allTodosComplete": "All todos complete",
  "status.expired": "expired",
  "status.imageExhausted": "Image Quota Exhausted",

  // Quota diagnostics
  "quota.unavailable": "Quota unavailable",
  "quota.loading": "Quota loading",
  "quota.notLoggedIn": "not logged into Antigravity",
  "quota.expiredToken": "Antigravity token expired",
  "quota.authFailed": "Antigravity auth failed",
  "quota.fetchFailed": "quota fetch failed",

  // Format
  "format.resets": "resets",
  "format.resetsIn": "resets in",
  "format.absoluteTime": "at {time}",
  "format.untilTime": "until {time}",
  "format.in": "in",
  "format.cache": "cache",
  "format.out": "out",
  "format.tok": "tok",
  "format.tokPerSec": "tok/s",
  "format.justNow": "just now",
  "format.relativeTime": "{value} ago",
  "format.elapsed": "{value}% elapsed",

  // Init
  "init.initializing": "[agy-hud] Initializing...",
  "init.macosNote":
    "[agy-hud] Note: On macOS, you may need to restart Antigravity CLI for the HUD to appear.",
};
