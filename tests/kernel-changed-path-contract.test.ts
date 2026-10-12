import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveProofRoute } from '../src/kernel/proof-route.js';

test('Proof route accepts numeric changedFileCount without using file count as semantic risk', () => {
  const small = { filesChanged: 3, requestedTier: 'T0' };
  const routeSmall = resolveProofRoute(small);
  assert.equal(routeSmall.proofTier, 'T0');

  const large = { filesChanged: 9, requestedTier: 'T0' };
  const routeLarge = resolveProofRoute(large);
  assert.equal(routeLarge.proofTier, 'T0');
});
