'use strict';

const PROVIDER_LABELS = {
  MODEL_PROVIDER_GOOGLE: 'Google',
  MODEL_PROVIDER_ANTHROPIC: 'Anthropic',
  MODEL_PROVIDER_OPENAI: 'OpenAI',
};

const LANGUAGE_TEXT = {
  en: {
    cacheLabel: 'cache',
    costLabel: 'Cost',
    todayLabel: 'Today',
    weekLabel: 'Week',
    outLabel: 'out',
    tokPerSec: 'tok/s',
    estLabel: 'Est',
    fiveHourShort: '5h',
    weekShort: 'week',
    tokUnit: 'tok',
    estCalibrating: 'calibrating',
    quotaLabel: 'Quota',
    imageQuotaLabel: 'Image Quota',
    imageQuotaExhausted: 'Image Quota Exhausted',
    resetsIn: 'Resets in',
    rulesLabel: 'rules',
    mcpsLabel: 'MCPs',
    hooksLabel: 'hooks',
    quotaUnavailable: 'Quota unavailable',
    quotaLoading: 'Quota loading',
    quotaReasons: {
      not_logged_in: 'not logged into Antigravity',
      expired_token: 'Antigravity token expired',
      auth_failed: 'Antigravity auth failed',
      quota_fetch_failed: 'quota fetch failed',
    },
  },
  zh: {
    cacheLabel: 'cache',
    costLabel: '费用',
    todayLabel: '今日',
    weekLabel: '本周',
    outLabel: '输出',
    tokPerSec: 'tok/s',
    estLabel: '估算',
    fiveHourShort: '5h',
    weekShort: '周',
    tokUnit: 'tok',
    estCalibrating: '校准中',
    quotaLabel: '额度',
    imageQuotaLabel: '图像额度',
    imageQuotaExhausted: '图像额度已耗尽',
    resetsIn: '重置倒计时',
    rulesLabel: '规则',
    mcpsLabel: 'MCP',
    hooksLabel: '钩子',
    quotaUnavailable: '额度不可用',
    quotaLoading: '额度加载中',
    quotaReasons: {
      not_logged_in: '未登录 Antigravity',
      expired_token: 'Antigravity token 已过期',
      auth_failed: 'Antigravity 认证失败',
      quota_fetch_failed: '额度获取失败',
    },
  },
};

function resolveLanguage(config, env = process.env) {
  const language = config?.language;
  if (language === 'en' || language === 'zh') return language;
  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG || '';
  return /^zh(?:_|-|$)/i.test(locale) ? 'zh' : 'en';
}

module.exports = {
  PROVIDER_LABELS,
  LANGUAGE_TEXT,
  resolveLanguage,
};
