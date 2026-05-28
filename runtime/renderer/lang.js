'use strict';

const PROVIDER_LABELS = {
  MODEL_PROVIDER_GOOGLE: 'Google',
  MODEL_PROVIDER_ANTHROPIC: 'Anthropic',
  MODEL_PROVIDER_OPENAI: 'OpenAI',
};

const LANGUAGE_TEXT = {
  en: {
    quotaUnavailable: 'Quota unavailable',
    quotaLoading: 'Quota loading',
    quotaHeaders: {
      model: 'Model',
      fiveHour: '5h remaining & reset',
      weekly: 'Weekly trend',
    },
    quotaNoData: 'no data',
    quotaReasons: {
      not_logged_in: 'not logged into Antigravity',
      expired_token: 'Antigravity token expired',
      auth_failed: 'Antigravity auth failed',
      quota_fetch_failed: 'quota fetch failed',
    },
  },
  zh: {
    quotaUnavailable: '额度不可用',
    quotaLoading: '额度加载中',
    quotaHeaders: {
      model: '模型名称',
      fiveHour: '5h 剩余配额与可用时间',
      weekly: '周趋势',
    },
    quotaNoData: '暂无数据',
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
