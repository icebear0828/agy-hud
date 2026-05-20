import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { getSessionState } from './parser.mjs';
import { renderHUD } from './renderer.mjs';
import { loadConfig } from './config.mjs';
import { getGitInfo } from './git.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BASE_DIR = path.join(os.homedir(), '.gemini', 'antigravity-cli');
const BRAIN_DIR = path.join(BASE_DIR, 'brain');
const PROJECT_DIR = path.resolve(__dirname, '..', '..');

function getLatestConversationId() {
  try {
    const dirs = fs.readdirSync(BRAIN_DIR)
      .filter(d => fs.statSync(path.join(BRAIN_DIR, d)).isDirectory() && d !== 'scratch')
      .sort((a, b) => fs.statSync(path.join(BRAIN_DIR, b)).mtimeMs - fs.statSync(path.join(BRAIN_DIR, a)).mtimeMs);
    return dirs[0];
  } catch (e) {
    return null;
  }
}

async function main() {
  const config = loadConfig(PROJECT_DIR);
  const isUpdate = process.argv.includes('--update');
  const convId = process.env.ANTIGRAVITY_CONVERSATION_ID || getLatestConversationId();
  const cacheFile = path.join(PROJECT_DIR, 'state.json');

  if (!convId) {
    if (!isUpdate) console.log('\x1b[1mAGY\x1b[0m | \x1b[90mIDLE\x1b[0m');
    return;
  }

  const logFile = path.join(BRAIN_DIR, convId, '.system_generated/logs/transcript.jsonl');
  if (!fs.existsSync(logFile)) {
    if (!isUpdate) console.log('AGY | READY');
    return;
  }

  try {
    // Optimization: only read last 5KB for update
    const content = fs.readFileSync(logFile, 'utf8');
    const lines = content.split('\n').filter(Boolean);
    const state = getSessionState(lines, logFile);
    state.gitInfo = getGitInfo();
    const lang = process.env.LANG?.startsWith('zh') ? 'zh' : 'en';
    const output = renderHUD(state, config, lang);

    if (isUpdate) {
      fs.writeFileSync(cacheFile, output);
    } else {
      // If we have a cache and it's fresh, use it. Otherwise, render now.
      if (fs.existsSync(cacheFile)) {
        console.log(fs.readFileSync(cacheFile, 'utf8'));
      } else {
        console.log(output);
      }
    }
  } catch (e) {
    if (!isUpdate) console.log('AGY | ERROR');
  }
}

main();
