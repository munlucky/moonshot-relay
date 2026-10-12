import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyRemoteParity } from '../src/host/kernel/git/remote-parity.js';

test('verifyRemoteParity returns structured parity result', () => {
  const result = verifyRemoteParity(process.cwd());
  assert.ok(['matched', 'mismatched'].includes(result.parity));
});
