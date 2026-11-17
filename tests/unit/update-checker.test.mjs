import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isRemoteVersionNewer } = require('../../runtime/update-checker.js');

test('isRemoteVersionNewer compares semver numerically without flagging downgrades', () => {
  assert.equal(isRemoteVersionNewer('0.3.8', '0.3.7'), true);
  assert.equal(isRemoteVersionNewer('0.3.10', '0.3.9'), true);
  assert.equal(isRemoteVersionNewer('v1.0.0', '0.9.9'), true);
  assert.equal(isRemoteVersionNewer('0.3.7', '0.3.7'), false);
  assert.equal(isRemoteVersionNewer('0.3.6', '0.3.7'), false);
  assert.equal(isRemoteVersionNewer('0.3.9', '0.3.10'), false);
  assert.equal(isRemoteVersionNewer(null, '0.3.7'), false);
});
