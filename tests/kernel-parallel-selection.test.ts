// Characterization of Step Ledger parallel selection after lifecycle removal.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dependenciesSatisfied, selectExecutableSteps, type RunStep } from '../src/kernel/run/run-step-ledger.js';

const ready = (stepId: string, sequence: number, allowedPaths: string[], dependencyIds: string[] = []): RunStep => ({
  stepId,
  sequence,
  state: 'ready',
  planRevision: 1,
  allowedPaths,
  dependencyIds,
});

test('Step Ledger selects the deterministic lowest-sequence runnable step', () => {
  const steps: RunStep[] = [
    ready('later', 2, ['b/**']),
    ready('first', 1, ['a/**']),
  ];
  assert.deepEqual(selectExecutableSteps(steps, { planRevision: 1 }).steps.map((step) => step.stepId), ['first']);
});

test('parallel selection is a pure projection over passed dependencies', () => {
  const steps: RunStep[] = [
    { ...ready('a', 1, ['a/**']), state: 'passed' },
    ready('b', 2, ['b/**'], ['a']),
    ready('c', 3, ['c/**']),
  ];
  assert.equal(dependenciesSatisfied(steps[1], steps), true);
  const selected = selectExecutableSteps(steps, { planRevision: 1, parallel: true, maxWorkers: 2 });
  assert.deepEqual(selected.steps.map((step) => step.stepId), ['b', 'c']);
  assert.equal(selected.reason, 'parallel');
});
