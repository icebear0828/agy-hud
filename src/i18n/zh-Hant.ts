import type { Messages } from "./types.ts";

export const zhHant: Messages = {
  // Labels
  "label.context": "上下文",
  "label.usage": "用量",
  "label.weekly": "本週",
  "label.approxRam": "記憶體",
  "label.promptCache": "快取",
  "label.cacheHitRate": "快取命中",
  "label.rules": "規則",
  "label.hooks": "Hook",
  "label.cost": "費用",
  "label.today": "今日",
  "label.week": "本週",
  "label.tokens": "Token",
  "label.sessionStarted": "開始",
  "label.lastReply": "上次回覆",
  "label.advisor": "顧問",
  "label.compactions": "壓縮次數",
  "label.imageQuota": "生圖額度",

  // Status
  "status.limitReached": "已達上限",
  "status.allTodosComplete": "全部完成",
  "status.expired": "已過期",
  "status.imageExhausted": "生圖額度已耗盡",

  // Quota diagnostics
  "quota.unavailable": "額度不可用",
  "quota.loading": "額度載入中",
  "quota.notLoggedIn": "未登入 Antigravity",
  "quota.expiredToken": "Antigravity token 已過期",
  "quota.authFailed": "Antigravity 認證失敗",
  "quota.fetchFailed": "額度取得失敗",

  // Format
  "format.resets": "重置於",
  "format.resetsIn": "重置剩餘",
  "format.absoluteTime": "{time}",
  "format.untilTime": "至 {time}",
  "format.in": "輸入",
  "format.cache": "快取",
  "format.out": "輸出",
  "format.tok": "tok",
  "format.tokPerSec": "tok/s",
  "format.justNow": "剛剛",
  "format.relativeTime": "{value} 前",
  "format.elapsed": "已過 {value}%",

  // Init
  "init.initializing": "[agy-hud] 正在初始化...",
  "init.macosNote":
    "[agy-hud] 注意：在 macOS 上，您可能需要重新啟動 Antigravity CLI 才能顯示 HUD。",
};
