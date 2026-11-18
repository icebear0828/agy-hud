export type MessageKey =
  // Labels
  | "label.context"
  | "label.usage"
  | "label.weekly"
  | "label.approxRam"
  | "label.promptCache"
  | "label.cacheHitRate"
  | "label.rules"
  | "label.hooks"
  | "label.agents"
  | "label.cost"
  | "label.today"
  | "label.week"
  | "label.tokens"
  | "label.sessionStarted"
  | "label.lastReply"
  | "label.advisor"
  | "label.compactions"
  | "label.imageQuota"
  // Status
  | "status.limitReached"
  | "status.allTodosComplete"
  | "status.expired"
  | "status.imageExhausted"
  // Quota diagnostics
  | "quota.unavailable"
  | "quota.loading"
  | "quota.notLoggedIn"
  | "quota.expiredToken"
  | "quota.authFailed"
  | "quota.fetchFailed"
  // Format
  | "format.resets"
  | "format.resetsIn"
  | "format.absoluteTime"
  | "format.untilTime"
  | "format.in"
  | "format.cache"
  | "format.out"
  | "format.tok"
  | "format.tokPerSec"
  | "format.justNow"
  | "format.relativeTime"
  | "format.elapsed"
  // Init
  | "init.initializing"
  | "init.macosNote";

export type Messages = Record<MessageKey, string>;

export type Language = "auto" | "en" | "zh" | "zh-Hans" | "zh-Hant" | "zh-TW";
