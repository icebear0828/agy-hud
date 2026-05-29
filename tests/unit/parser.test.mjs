import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSessionState } from '../../runtime/parser.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..', '..');

// Env vars that hijack `git` subprocesses regardless of cwd. The git pre-push
// hook environment sets GIT_DIR/GIT_WORK_TREE for its own use; without
// scrubbing them, the parser's spawned `git rev-parse` returns the host
// repo's hooks path instead of the test's fixture, then writeFileSync of
// fixture data lands in the real .git/hooks/ — silent pollution.
const GIT_ENV_VARS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR'];

function withScrubbedGitEnv(fn) {
  const saved = {};
  for (const key of GIT_ENV_VARS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  try {
    return fn();
  } finally {
    for (const key of GIT_ENV_VARS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

function scrubbedGitEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const key of GIT_ENV_VARS) delete env[key];
  return env;
}

test('getSessionState should initialize state properly even for missing files', async () => {
  assert.strictEqual(typeof getSessionState, 'function');
  const state = await getSessionState('missing-transcript-nonexistent.jsonl');
  assert.strictEqual(state.currentDir, path.basename(process.cwd()));
});

test('getSessionState reads the highest transcript step index', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-parser-steps-'));
  try {
    const transcriptPath = path.join(tempDir, 'transcript.jsonl');
    fs.writeFileSync(transcriptPath, [
      JSON.stringify({ step_index: 1 }),
      'not-json',
      JSON.stringify({ step_index: 4 }),
      JSON.stringify({ step_index: 2 }),
      '',
    ].join('\n'));

    const state = await getSessionState(transcriptPath);

    assert.equal(state.steps, 4);
    assert.equal(typeof state.branch, 'string');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('getSessionState detects workspace config metadata correctly', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-parser-metadata-'));
  const originalCwd = process.cwd;
  process.cwd = () => tempDir;

  try { await withScrubbedGitEnv(async () => {
    // 1. Create CLAUDE.md
    fs.writeFileSync(path.join(tempDir, 'CLAUDE.md'), '# rules');

    // 2. Create rules folders and md files
    const ruleDir = path.join(tempDir, '.claude', 'rules');
    fs.mkdirSync(ruleDir, { recursive: true });
    fs.writeFileSync(path.join(ruleDir, 'rule1.md'), 'content');
    fs.writeFileSync(path.join(ruleDir, 'rule2.md'), 'content');

    // 3. Create active git hooks
    const hooksDir = path.join(tempDir, '.git', 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(path.join(hooksDir, 'pre-commit'), 'hook content');
    fs.writeFileSync(path.join(hooksDir, 'pre-push.sample'), 'sample hook content');

    const state = await getSessionState('missing-transcript.jsonl');

    assert.equal(state.memoryFile, 'CLAUDE.md');
    assert.equal(state.rulesCount, 2);
    assert.equal(state.hooksCount, 1);
  }); } finally {
    process.cwd = originalCwd;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('getSessionState captures context window token usage from transcript lines', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-parser-usage-'));
  try {
    const transcriptPath = path.join(tempDir, 'transcript.jsonl');
    fs.writeFileSync(transcriptPath, [
      JSON.stringify({ step_index: 1 }),
      JSON.stringify({
        step_index: 2,
        context_window: {
          total_input_tokens: 138206000,
          total_output_tokens: 202000,
          current_usage: {
            input_tokens: 6000,
            cache_read_input_tokens: 138200000
          }
        }
      }),
      '',
    ].join('\n'));

    const state = await getSessionState(transcriptPath);

    assert.equal(state.usage.total_input_tokens, 138206000);
    assert.equal(state.usage.total_output_tokens, 202000);
    assert.equal(state.usage.current_usage.input_tokens, 6000);
    assert.equal(state.usage.current_usage.cache_read_input_tokens, 138200000);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('getSessionState reads project memory from HOME without counting memory docs as rules', () => {
  const workspaceDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-parser-home-workspace-')));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-parser-home-'));
  const normalizedCwd = workspaceDir.replace(/\\/g, '/');
  const projectKey = normalizedCwd.replace(/:/g, '').replace(/\//g, '-');
  const projectMemoryDir = path.join(homeDir, '.claude', 'projects', projectKey, 'memory');
  const ruleDir = path.join(workspaceDir, '.claude', 'rules');

  try {
    fs.mkdirSync(projectMemoryDir, { recursive: true });
    fs.writeFileSync(path.join(projectMemoryDir, 'MEMORY.md'), '# memory');
    fs.writeFileSync(path.join(projectMemoryDir, 'feedback.md'), '# feedback');
    fs.mkdirSync(ruleDir, { recursive: true });
    fs.writeFileSync(path.join(ruleDir, 'rule.md'), '# rule');

    const script = `
      process.chdir(${JSON.stringify(workspaceDir)});
      const { getSessionState } = require(${JSON.stringify(path.join(projectRoot, 'runtime', 'parser.js'))});
      getSessionState('missing-transcript.jsonl')
        .then(state => process.stdout.write(JSON.stringify(state)));
    `;

    const env = { ...process.env, HOME: homeDir, USERPROFILE: homeDir };
    delete env.GIT_DIR;
    delete env.GIT_WORK_TREE;

    const result = spawnSync(process.execPath, ['-e', script], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });

    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.memoryFile, 'MEMORY.md');
    assert.equal(parsed.rulesCount, 1);
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('getSessionState counts git hooks from subdirectories', () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-parser-hooks-'));
  const nestedDir = path.join(repoDir, 'nested');
  const env = scrubbedGitEnv();

  try {
    const init = spawnSync('git', ['init'], {
      cwd: repoDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
    assert.equal(init.status, 0, init.stderr);

    const hooksPathResult = spawnSync('git', ['rev-parse', '--git-path', 'hooks'], {
      cwd: repoDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
    assert.equal(hooksPathResult.status, 0, hooksPathResult.stderr);
    const hooksDir = path.resolve(repoDir, hooksPathResult.stdout.trim());
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(path.join(hooksDir, 'pre-commit'), 'hook');
    fs.writeFileSync(path.join(hooksDir, 'pre-push.sample'), 'sample');

    fs.mkdirSync(nestedDir, { recursive: true });
    const script = `
      process.chdir(${JSON.stringify(nestedDir)});
      const { getSessionState } = require(${JSON.stringify(path.join(projectRoot, 'runtime', 'parser.js'))});
      getSessionState('missing-transcript.jsonl')
        .then(state => process.stdout.write(JSON.stringify(state)));
    `;

    const result = spawnSync(process.execPath, ['-e', script], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });

    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.hooksCount, 1);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('getSessionState falls back outside git repositories without stderr noise', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-parser-non-git-'));
  const script = `
    const { getSessionState } = require(${JSON.stringify(path.join(projectRoot, 'runtime', 'parser.js'))});
    getSessionState('missing-transcript.jsonl')
      .then(state => process.stdout.write(JSON.stringify(state)));
  `;

  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;

  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: tempDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.steps, 0);
  assert.equal(parsed.branch, 'main');
});

test('getSessionState resolves username from id_token in oauth_creds.json', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-parser-username-'));
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  process.env.HOME = tempDir;
  process.env.USERPROFILE = tempDir;

  try {
    const geminiDir = path.join(tempDir, '.gemini');
    fs.mkdirSync(geminiDir, { recursive: true });

    // Mock an ID token with an email claim: shetterelland@gmail.com
    const header = Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    const payload = Buffer.from(JSON.stringify({ email: 'shetterelland@gmail.com' })).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    const signature = 'dummy-sig';
    const mockIdToken = `${header}.${payload}.${signature}`;

    fs.writeFileSync(path.join(geminiDir, 'oauth_creds.json'), JSON.stringify({
      id_token: mockIdToken
    }));

    const state = await getSessionState('missing-transcript-nonexistent.jsonl');
    assert.strictEqual(state.username, 'shetterelland@gmail.com');
  } finally {
    process.env.HOME = originalHome;
    process.env.USERPROFILE = originalUserProfile;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('getSessionState falls back to OS username if oauth_creds.json is invalid or missing', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-parser-username-fallback-'));
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  process.env.HOME = tempDir;
  process.env.USERPROFILE = tempDir;

  try {
    const state = await getSessionState('missing-transcript-nonexistent.jsonl');
    assert.strictEqual(typeof state.username, 'string');
    assert.ok(state.username.length > 0);
    assert.strictEqual(state.username, os.userInfo().username);
  } finally {
    process.env.HOME = originalHome;
    process.env.USERPROFILE = originalUserProfile;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64')
  .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
const mockIdToken = (payload) => `${b64url({ alg: 'RS256' })}.${b64url(payload)}.dummy-sig`;

const withTempHome = async (fn) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-parser-account-'));
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  process.env.HOME = tempDir;
  process.env.USERPROFILE = tempDir;
  const geminiDir = path.join(tempDir, '.gemini');
  fs.mkdirSync(geminiDir, { recursive: true });
  try {
    return await fn(geminiDir);
  } finally {
    process.env.HOME = originalHome;
    process.env.USERPROFILE = originalUserProfile;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
};

test('getSessionState prefers google_accounts.json active over the oauth_creds id_token', async () => {
  await withTempHome(async (geminiDir) => {
    // Authoritative active account differs from the stale oauth_creds email.
    fs.writeFileSync(path.join(geminiDir, 'google_accounts.json'), JSON.stringify({
      active: 'active-user@gmail.com',
      old: ['stale-user@gmail.com']
    }));
    fs.writeFileSync(path.join(geminiDir, 'oauth_creds.json'), JSON.stringify({
      id_token: mockIdToken({ email: 'stale-user@gmail.com' })
    }));
    const state = await getSessionState('missing-transcript-nonexistent.jsonl');
    assert.strictEqual(state.username, 'active-user@gmail.com');
  });
});

test('getSessionState returns the oauth_creds email even when the id_token is expired', async () => {
  // Real-world state: oauth_creds is the Gemini-CLI file agy never refreshes, so
  // its id_token is routinely expired while the email is still the right account.
  await withTempHome(async (geminiDir) => {
    fs.writeFileSync(path.join(geminiDir, 'oauth_creds.json'), JSON.stringify({
      id_token: mockIdToken({ email: 'shetterelland@gmail.com', exp: Math.floor((Date.now() - 10000) / 1000) }),
      expiry_date: Date.now() - 10000
    }));
    const state = await getSessionState('missing-transcript-nonexistent.jsonl');
    assert.strictEqual(state.username, 'shetterelland@gmail.com');
  });
});

test('getSessionState falls back to oauth_creds email when google_accounts.json is malformed', async () => {
  await withTempHome(async (geminiDir) => {
    fs.writeFileSync(path.join(geminiDir, 'google_accounts.json'), JSON.stringify({ active: null }));
    fs.writeFileSync(path.join(geminiDir, 'oauth_creds.json'), JSON.stringify({
      id_token: mockIdToken({ email: 'shetterelland@gmail.com' })
    }));
    const state = await getSessionState('missing-transcript-nonexistent.jsonl');
    assert.strictEqual(state.username, 'shetterelland@gmail.com');
  });
});

