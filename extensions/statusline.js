'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

function getSettingsPath() {
  const candidates = [
    path.join(os.homedir(), '.gemini', 'antigravity-cli', 'settings.json'),
    process.env.XDG_DATA_HOME ? path.join(process.env.XDG_DATA_HOME, 'antigravity-cli', 'settings.json') : null,
    process.env.APPDATA ? path.join(process.env.APPDATA, 'antigravity-cli', 'settings.json') : null,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'antigravity-cli', 'settings.json') : null,
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return path.join(os.homedir(), '.gemini', 'antigravity-cli', 'settings.json');
}

function createStatusLineCommand(hudScriptPath, nodePath = process.execPath || 'node', platform = process.platform) {
  if (platform === 'win32') {
    return `node "${hudScriptPath}"`;
  }
  return `"${nodePath}" "${hudScriptPath}"`;
}

function configureStatusLine(baseDir = __dirname) {
  const settingsPath = getSettingsPath();
  const hudScriptPath = path.resolve(baseDir, 'bin', 'agy-hud.js');
  const targetCommand = createStatusLineCommand(hudScriptPath);

  let settings = {};
  if (fs.existsSync(settingsPath)) {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  }

  if (!settings.statusLine || settings.statusLine.command !== targetCommand) {
    settings.statusLine = {
      type: 'command',
      command: targetCommand,
    };
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
  }

  return { settingsPath, command: targetCommand };
}

module.exports = {
  createStatusLineCommand,
  configureStatusLine,
  getSettingsPath,
};
