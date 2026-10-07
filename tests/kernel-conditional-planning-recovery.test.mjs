import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planRunSteps, stepLedgerApplies } from '../scripts/kernel/run/step-planner.mjs';
import { detectOptionalStagnation, resolveOptionalCapabilities } from '../scripts/kernel/run/optional-capabilities.mjs';

const run = { runId: 'run-conditional', objective: 'deliver bounded change' };

test('W-17: simple work enters directly without activating planning or recovery capabilities', () => {
  const contract = {
    objective: run.objective,
    acceptance: [{ id: 'AC-1', statement: 'works' }],
    allowedPaths: ['src/a.mjs'],
    flags: {},
  };
  const decision = stepLedgerApplies({ contract });
  assert.equal(decision.applies, false);
  const planned = planRunSteps({ run, contract, obligations: [], planRevision: 1 });
  assert.equal(planned.steps.length, 1);
  assert.equal(planned.steps[0].synthetic, true);
  const capabilities = resolveOptionalCapabilities({ run: { ...run, taskContract: contract }, actionKind: 'implement' });
  assert.equal(capabilities.active['architecture-planning'], false);
  assert.equal(capabilities.active['stagnation-escalation'], false);
});

test('W-17: declared dependency/scope decomposition activates bounded planning without inventing a second lifecycle', () => {
  const contract = {
    objective: run.objective,
    flags: { complex: true },
    acceptance: [{ id: 'AC-1', statement: 'works' }],
    allowedPaths: ['src/**'],
    steps: [
      { stepId: 'A', objective: 'change A', allowedPaths: ['src/a/**'] },
      { stepId: 'B', objective: 'change B', allowedPaths: ['src/b/**'], dependsOn: ['A'] },
    ],
  };
  const decision = stepLedgerApplies({ contract });
  assert.equal(decision.applies, true);
  const planned = planRunSteps({ run, contract, obligations: [], planRevision: 1 });
  assert.deepEqual(planned.steps.map((step) => step.stepId), ['A', 'B']);
  assert.deepEqual(planned.steps[1].dependencyIds, ['A']);
  assert.deepEqual(planned.steps[0].allowedPaths, ['src/a/**']);
  assert.deepEqual(planned.steps[1].allowedPaths, ['src/b/**']);
});

test('W-17: repeated identical failure has a finite threshold and no ambient recovery loop', () => {
  const verifications = [{ obligationId: 'proof', status: 'failed' }];
  const two = detectOptionalStagnation({
    attempts: [{ status: 'failed' }, { status: 'failed' }],
    verifications,
    threshold: 3,
  });
  assert.equal(two.stagnant, false);
  assert.equal(two.reason, 'optional-capability-disabled');

  const three = detectOptionalStagnation({
    attempts: [{ status: 'failed' }, { status: 'failed' }, { status: 'failed' }],
    verifications,
    threshold: 3,
  });
  assert.equal(three.stagnant, true);
  assert.equal(three.reason, 'repeated-failure-no-progress');
  assert.equal(three.failedAttempts, 3);
  assert.equal(three.repeatedObligation, 'proof');
});
