const fs = require('fs');
const path = require('path');

const DEFAULT_CONFIG = { enabled: true, theme: 'default' };

function getLocalConfigPath() {
  return path.join(process.cwd(), 'agy-hud.config.json');
}

function getGlobalConfigPath() {
  return path.join(__dirname, 'agy-hud.config.json');
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

async function loadConfig() {
  const localConfig = getLocalConfigPath();
  const pluginConfig = getGlobalConfigPath();

  const configPath = fs.existsSync(localConfig) ? localConfig : pluginConfig;
  const fileConfig = fs.existsSync(configPath) ? readJsonFile(configPath) : null;
  const config = fileConfig
    ? { ...DEFAULT_CONFIG, ...fileConfig }
    : { ...DEFAULT_CONFIG };

  if (config.enabled === undefined) {
    config.enabled = true;
  }

  return config;
}

async function saveConfig(config, isGlobal) {
  const targetPath = isGlobal ? getGlobalConfigPath() : getLocalConfigPath();
  fs.writeFileSync(targetPath, JSON.stringify(config, null, 2), 'utf8');
}

module.exports = {
  loadConfig,
  getLocalConfigPath,
  getGlobalConfigPath,
  saveConfig,
};

