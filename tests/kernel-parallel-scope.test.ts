// Write-set conflict coverage belongs to derived Step selection, not a
// persisted parallel plan or lifecycle receipt.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scopesOverlap, selectExecutableSteps } from '../src/kernel/run/run-step-ledger.js';

test('overlapping Step scopes select one deterministically', () => {
  const selected = selectExecutableSteps([
    { stepId: 'a', sequence: 1, state: 'ready', planRevision: 1, dependencyIds: [], allowedPaths: ['src/**'] },
    { stepId: 'b', sequence: 2, state: 'ready', planRevision: 1, dependencyIds: [], allowedPaths: ['src/billing/**'] },
  ], { planRevision: 1, parallel: true, maxWorkers: 2 });
  assert.deepEqual(selected.steps.map((step) => step.stepId), ['a']);
  assert.equal(selected.reason, 'parallel-scope-conflict');
});

test('scope matching is case- and separator-insensitive', () => {
  assert.equal(scopesOverlap('SRC/Auth/**', 'src/auth/service.mjs'), true);
  assert.equal(scopesOverlap(String.raw`src\auth\**`, 'src/auth/**'), true);
  assert.equal(scopesOverlap('src/auth/**', 'src/billing/**'), false);
});
