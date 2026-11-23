'use strict';

const fs = require('fs');
const path = require('path');
const { resolveAntigravityPath } = require('./paths.js');

const DEFAULT_CONFIG = {
  enabled: true,
  theme: {
    primary: 'green',
    secondary: 'gray',
    warning: 'yellow',
    critical: 'red',
  },
  display: {
    showTokenBar: true,
    showBreadcrumbs: true,
    showGitBranch: true,
    showCurrentDir: true,
    breadcrumbCount: 3,
    useNerdFonts: false,
    showUsername: true,
    showSpeed: false,
    showCost: false,
    showDailyCost: false,
    showWeeklyCost: false,
    showQuotaCapacity: true,
  },
  thresholds: {
    warning: 0.7,
    critical: 0.9,
  },
  language: 'auto',
};

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function deepMerge(target, source) {
  const output = isPlainObject(target) ? { ...target } : {};
  if (!isPlainObject(source)) return output;

  for (const [key, value] of Object.entries(source)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    if (value === undefined) continue;
    if (isPlainObject(value) && isPlainObject(output[key])) {
      output[key] = deepMerge(output[key], value);
    } else if (isPlainObject(value)) {
      output[key] = deepMerge({}, value);
    } else {
      output[key] = value;
    }
  }
  return output;
}

function getBundledConfigPath() {
  return path.join(__dirname, 'agy-hud.config.json');
}

function getLocalConfigPath(cwd = process.cwd()) {
  return path.join(cwd || process.cwd(), 'agy-hud.config.json');
}

function getGlobalConfigPath(env, homeDir) {
  return resolveAntigravityPath('agy-hud.config.json', env, homeDir);
}

function readJsonFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function loadConfig(cwd, options = {}) {
  const effectiveCwd = typeof cwd === 'string' && cwd ? cwd : process.cwd();
  const bundledPath = options.bundledConfigPath || getBundledConfigPath();
  const globalPath = getGlobalConfigPath(options.env, options.homeDir);
  const localPath = getLocalConfigPath(effectiveCwd);

  let config = deepMerge({}, DEFAULT_CONFIG);

  const bundledConfig = readJsonFile(bundledPath);
  if (bundledConfig) {
    config = deepMerge(config, bundledConfig);
  }

  const globalConfig = readJsonFile(globalPath);
  if (globalConfig) {
    config = deepMerge(config, globalConfig);
  }

  const localConfig = readJsonFile(localPath);
  if (localConfig) {
    config = deepMerge(config, localConfig);
  }

  if (config.enabled === undefined) {
    config.enabled = true;
  }

  return config;
}

async function saveConfig(config, isGlobal, options = {}) {
  const targetPath = isGlobal
    ? getGlobalConfigPath(options.env, options.homeDir)
    : getLocalConfigPath(options.cwd);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, JSON.stringify(config, null, 2), 'utf8');
}

module.exports = {
  DEFAULT_CONFIG,
  deepMerge,
  loadConfig,
  getBundledConfigPath,
  getLocalConfigPath,
  getGlobalConfigPath,
  saveConfig,
};
