import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { getOutputSpeed, formatSpeed, getSpeedCachePath } from '../../runtime/speed.js';

let tempDir;

const frame = (output, apiMs, input = 1000) => ({
  transcript_path: path.join(tempDir, 'session.jsonl'),
  context_window: {
    current_usage: {
      input_tokens: input,
      output_tokens: output,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  },
  cost: { total_api_duration_ms: apiMs },
});

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'agy-speed-test-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

test('speed is the finished response over API time added, held until next response', () => {
  // 1. Initial 0 output tokens returns null
  assert.equal(getOutputSpeed(frame(0, 1000), tempDir), null);

  // 2. First response: 400 tokens in (5000 - 1000 = 4000ms) => 100 tok/s
  assert.equal(getOutputSpeed(frame(400, 5000), tempDir), 100);

  // 3. Same frame keeps the reading
  assert.equal(getOutputSpeed(frame(400, 5000), tempDir), 100);

  // 4. API time increased but usage unchanged (subagents) => folds into baseline
  assert.equal(getOutputSpeed(frame(400, 9000), tempDir), 100);

  // 5. Under 500ms of API time (9200 - 9000 = 200ms) is too noisy => holds previous speed
  assert.equal(getOutputSpeed(frame(300, 9200, 2000), tempDir), 100);

  // 6. Valid new response: 300 tokens in (12000 - 9200 = 2800ms) => 300 / 2.8 tok/s
  assert.equal(
    getOutputSpeed(frame(300, 12000, 3000), tempDir)?.toFixed(1),
    (300 / 2.8).toFixed(1)
  );

  // 7. Counter reset starts over
  assert.equal(getOutputSpeed(frame(300, 100, 4000), tempDir), null);

  // 8. Missing transcript_path returns null
  assert.equal(getOutputSpeed({ ...frame(300, 100), transcript_path: undefined }, tempDir), null);
});

test('falls back to state.totalApiDurationMs when agyData.cost is missing', () => {
  const baseData = {
    transcript_path: path.join(tempDir, 'session.jsonl'),
    context_window: {
      current_usage: { input_tokens: 1000, output_tokens: 0 },
    },
  };
  getOutputSpeed(baseData, tempDir, { totalApiDurationMs: 1000 });

  const agyData = {
    transcript_path: path.join(tempDir, 'session.jsonl'),
    context_window: {
      current_usage: {
        input_tokens: 1000,
        output_tokens: 400,
      },
    },
  };
  const state = {
    totalApiDurationMs: 5000,
  };

  const speed = getOutputSpeed(agyData, tempDir, state);
  assert.equal(speed, 100); // 400 tokens / 4s = 100 tok/s
});

test('formatSpeed formats output speed in en and zh', () => {
  assert.equal(formatSpeed(null, 'en'), null);
  assert.equal(formatSpeed(42.56, 'en'), 'out: 42.6 tok/s');
  assert.equal(formatSpeed(42.56, 'zh'), '输出: 42.6 tok/s');
});
