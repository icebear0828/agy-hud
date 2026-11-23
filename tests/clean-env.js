import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const cleanHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-test-home-'));
process.env.HOME = cleanHome;
process.env.USERPROFILE = cleanHome;
delete process.env.AGY_HUD_DATA_DIR;
delete process.env.AGY_CONFIG_DIR;
delete process.env.CLAUDE_CONFIG_DIR;
delete process.env.XDG_DATA_HOME;
delete process.env.XDG_CONFIG_HOME;
delete process.env.APPDATA;
delete process.env.LOCALAPPDATA;
delete process.env.AGY_HUD_ALLOW_EXTRA_CMD;
delete process.env.CLAUDE_HUD_ALLOW_EXTRA_CMD;
delete process.env.AGY_HUD_DISABLE;
delete process.env.CLAUDE_HUD_DISABLE;
delete process.env.AGY_HUD_FORCE_ASCII;
delete process.env.AGY_HUD_FORCE_UNICODE;
process.env.LANG = 'en_US.UTF-8';
process.env.TZ = 'UTC';

process.on('exit', () => {
  try {
    fs.rmSync(cleanHome, { recursive: true, force: true });
  } catch {}
});
