import type { Messages } from "./types.ts";

export const zhHans: Messages = {
  // Labels
  "label.context": "上下文",
  "label.usage": "用量",
  "label.weekly": "本周",
  "label.approxRam": "内存",
  "label.promptCache": "缓存",
  "label.cacheHitRate": "缓存命中",
  "label.rules": "规则",
  "label.hooks": "钩子",
  "label.cost": "费用",
  "label.today": "今日",
  "label.week": "本周",
  "label.tokens": "词元",
  "label.sessionStarted": "开始",
  "label.lastReply": "上次回复",
  "label.advisor": "顾问",
  "label.compactions": "压缩次数",
  "label.imageQuota": "生图额度",

  // Status
  "status.limitReached": "已达上限",
  "status.allTodosComplete": "全部完成",
  "status.expired": "已过期",
  "status.imageExhausted": "生图额度已耗尽",

  // Quota diagnostics
  "quota.unavailable": "额度不可用",
  "quota.loading": "额度加载中",
  "quota.notLoggedIn": "未登录 Antigravity",
  "quota.expiredToken": "Antigravity token 已过期",
  "quota.authFailed": "Antigravity 认证失败",
  "quota.fetchFailed": "额度获取失败",

  // Format
  "format.resets": "重置于",
  "format.resetsIn": "重置剩余",
  "format.absoluteTime": "{time}",
  "format.untilTime": "至 {time}",
  "format.in": "输入",
  "format.cache": "缓存",
  "format.out": "输出",
  "format.tok": "词元",
  "format.tokPerSec": "tok/s",
  "format.justNow": "刚刚",
  "format.relativeTime": "{value} 前",
  "format.elapsed": "已过 {value}%",

  // Init
  "init.initializing": "[agy-hud] 正在初始化...",
  "init.macosNote":
    "[agy-hud] 注意：在 macOS 上，您可能需要重启 Antigravity CLI 才能显示 HUD。",
};
