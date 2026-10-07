// K4: the four additions are one chain, not four features. This walks the chain
// end to end — task contract -> step -> capsule -> admission -> usage receipt ->
// evidence -> review receipt -> completion — and then tries to break each link.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createKernelControlPlane } from '../scripts/kernel/control-plane.mjs';
import { openKernelStateStore } from '../scripts/kernel/state-store.mjs';
import { dispatchKernelTurn } from '../scripts/host/kernel/turn-dispatcher.mjs';
import { createModelRegistry } from '../scripts/host/kernel/model-registry.mjs';
import { createClaudeAdapter } from '../scripts/host/kernel/adapters/claude.mjs';

const CONFIGURED = { MOON_RELAY_KERNEL_MODEL_FRONTIER: 'configured-frontier', MOON_RELAY_KERNEL_MODEL_VALUE: 'configured-value' };

const setup = async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'krn-k4-home-'));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'krn-k4-proj-'));
  spawnSync('git', ['init'], { cwd: projectRoot, encoding: 'utf8' });
  await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({
    name: 'k4-fixture',
    version: '0.0.1',
    scripts: { 'test:ok': 'node -e "process.exit(0)"', 'test:fail': 'node -e "process.exit(1)"', lint: 'node -e "process.exit(0)"', 'lint:fail': 'node -e "process.exit(1)"' },
  }, null, 2));
  for (const relative of ['src/auth/service.mjs', 'src/billing/invoice.mjs', 'tests/auth.test.mjs']) {
    await mkdir(path.join(projectRoot, path.dirname(relative)), { recursive: true });
    await writeFile(path.join(projectRoot, relative), 'export const v = 0;\n');
  }
  spawnSync('git', ['add', '--all'], { cwd: projectRoot, encoding: 'utf8' });
  spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-m', 'fixture', '--quiet'], { cwd: projectRoot, encoding: 'utf8' });
  return { runtimeHome, projectRoot };
};

const cleanup = async ({ runtimeHome, projectRoot }) => {
  await rm(runtimeHome, { recursive: true, force: true });
  await rm(projectRoot, { recursive: true, force: true });
};

const edit = (fixture, relative, value) => writeFile(path.join(fixture.projectRoot, relative), `export const v = ${value};\n`);

const adapterFor = (sessionId) => createClaudeAdapter({
  launch: async ({ invocation }) => ({ resolvedModel: invocation.model, sessionId, inputTokens: 100, outputTokens: 20 }),
});

const dispatch = (cp, runId, sessionId, actionContext = {}) => dispatchKernelTurn({
  controlPlane: cp,
  runId,
  adapter: adapterFor(sessionId),
  registry: createModelRegistry({ surface: 'claude', env: CONFIGURED }),
  actionContext: {
    executionMode: 'native-subagent',
    delegationRequested: true,
    ...actionContext,
  },
});

test('K4 scenario A: a simple brownfield change walks contract -> step -> capsule -> admission -> evidence -> completion', async () => {
  const fixture = await setup();
  const cp = await createKernelControlPlane(fixture);
  try {
    await cp.startRun({
      runId: 'r-a',
      objective: 'Reject expired tokens',
      taskContract: {
        acceptance: [{
          acceptance: 'expired tokens are rejected',
          evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test:ok'], obligationId: 'unit-test' },
        }],
        behaviorChanging: true,
        allowedPaths: ['src/auth/**'],
      },
    });

    // One synthetic step; the model-visible loop is unchanged.
    const steps = cp.getRunSteps('r-a');
    assert.equal(steps.length, 1);
    assert.equal(steps[0].synthetic, true);

    const turn = await dispatch(cp, 'r-a', 'implementer-session');
    assert.equal(turn.dispatched, true);
    assert.equal(turn.admission.decision, 'admitted');
    assert.equal(turn.executionCapsule.stepId, steps[0].stepId);
    assert.deepEqual(turn.executionCapsule.workUnit.allowedPaths, ['src/auth/**']);
    assert.equal(turn.receipt.capsuleDigest, turn.executionCapsule.provenance.capsuleDigest);
    assert.equal(turn.receipt.admissionId, turn.admission.admissionId);

    await edit(fixture, 'src/auth/service.mjs', 1);
    const reported = await cp.report('r-a', {
      summary: 'expiry check added',
      capsuleId: turn.executionCapsule.capsuleId,
      stepId: steps[0].stepId,
      changedPaths: ['src/auth/service.mjs'],
      verifications: [{ obligationId: 'unit-test', commandRef: 'test:ok', acceptanceCoverage: ['expired tokens are rejected'] }],
    });

    assert.equal(reported.step.state, 'passed');
    assert.equal(reported.status, 'completed');
    assert.equal(reported.finalization.completionStatus, 'accepted');
  } finally {
    await cp.close();
    await cleanup(fixture);
  }
});

test('K4 scenario B: a long run survives a process boundary, a failure, and a replan', async () => {
  const fixture = await setup();
  const contract = {
    complex: true,
    riskTier: 'T2',
    acceptance: [
      { acceptance: 'auth rejects expired tokens', evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test:ok'], obligationId: 'unit-test' } },
      { acceptance: 'billing stays untouched by auth', evidencePlan: { class: 'hard', method: 'static-analysis', commandRefs: ['lint:fail', 'lint'], obligationId: 'static-analysis' } },
    ],
    steps: [
      { objective: 'Token expiry', allowedPaths: ['src/auth/**'], acceptanceIds: ['AC-1'], obligationIds: ['unit-test'] },
      { objective: 'Static analysis clean', allowedPaths: ['src/billing/**'], acceptanceIds: ['AC-2'], obligationIds: ['static-analysis'] },
    ],
  };

  let stepIds;
  const first = await createKernelControlPlane(fixture);
  try {
    await first.startRun({ runId: 'r-b', objective: 'Harden auth', taskContract: contract });
    stepIds = first.getRunSteps('r-b').map((step) => step.stepId);
    await edit(fixture, 'src/auth/service.mjs', 1);
    const step1 = await first.report('r-b', {
      summary: 'expiry',
      stepId: stepIds[0],
      changedPaths: ['src/auth/service.mjs'],
      verifications: [{ obligationId: 'unit-test', commandRef: 'test:ok', acceptanceCoverage: ['AC-1'] }],
    });
    assert.equal(step1.step.state, 'passed');
  } finally {
    await first.close();
  }

  // A different process picks the run up with nothing but SQLite.
  const second = await createKernelControlPlane(fixture);
  try {
    assert.equal(second.getCurrentStep('r-b').stepId, stepIds[1]);

    // The second unit fails repeatedly until stagnation is declared.
    for (const value of [1, 2, 3]) {
      await edit(fixture, 'src/billing/invoice.mjs', value);
      const failed = await second.report('r-b', {
        summary: `attempt ${value}`,
        stepId: stepIds[1],
        changedPaths: ['src/billing/invoice.mjs'],
        verifications: [{ obligationId: 'static-analysis', commandRef: 'lint:fail' }],
      });
      assert.equal(failed.step.state, 'failed');
      if (value === 3) assert.equal(failed.step.stagnation.recommendation, 'replan');
    }

    const replanned = await second.replanSteps('r-b', {
      steps: [{ objective: 'Analyse billing with the linter', allowedPaths: ['src/billing/**'], acceptanceIds: ['AC-2'], obligationIds: ['static-analysis'] }],
    });
    assert.equal(replanned.planRevision, 2);
    assert.equal(second.getRunSteps('r-b').find((step) => step.stepId === stepIds[1]).state, 'superseded');

    await edit(fixture, 'src/billing/invoice.mjs', 9);
    const final = await second.report('r-b', {
      summary: 'lint clean',
      stepId: replanned.steps[0].stepId,
      changedPaths: ['src/billing/invoice.mjs'],
      // The workspace moved since step one, so its evidence is re-proven here:
      // completion authority still requires current-revision evidence.
      verifications: [
        { obligationId: 'static-analysis', commandRef: 'lint', acceptanceCoverage: ['AC-2'] },
        { obligationId: 'unit-test', commandRef: 'test:ok', acceptanceCoverage: ['AC-1'] },
      ],
    });
    assert.equal(final.step.state, 'passed');
    assert.equal(final.status, 'completed');
  } finally {
    await second.close();
    await cleanup(fixture);
  }
});

test('K4 scenario C: a T3 security change completes only through a routed independent review', async () => {
  const fixture = await setup();
  const cp = await createKernelControlPlane(fixture);
  try {
    await cp.startRun({
      runId: 'r-c',
      objective: 'Tighten the auth boundary',
      taskContract: {
        surfaces: ['security_boundary'],
        acceptance: [{
          acceptance: 'expired tokens are rejected',
          evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test:ok'], obligationId: 'unit-test' },
        }],
        allowedPaths: ['src/auth/**'],
      },
    });
    assert.equal((await cp.getRun('r-c')).proofTier, 'T3');

    const implementTurn = await dispatch(cp, 'r-c', 'implementer-session');
    assert.equal(implementTurn.admission.decision, 'admitted');

    await edit(fixture, 'src/auth/service.mjs', 1);
    await cp.report('r-c', {
      summary: 'boundary tightened',
      capsuleId: implementTurn.executionCapsule.capsuleId,
      changedPaths: ['src/auth/service.mjs'],
      verifications: [
        { obligationId: 'unit-test', commandRef: 'test:ok', acceptanceCoverage: ['expired tokens are rejected'] },
        { obligationId: 'static-analysis', commandRef: 'lint' },
      ],
    });

    // A self-asserted verdict cannot close the protected obligation.
    const forged = await cp.report('r-c', {
      summary: 'reviewed by me',
      implementerId: 'impl-1',
      judgments: [{ obligationId: 'security-review', verdict: 'pass', reviewerId: 'reviewer-2', rationale: 'looks fine' }],
    });
    assert.match(forged.failures[0].errorSummary, /requires a reviewReceiptId/);

    // The reviewer runs as its own routed session, on the frontier class.
    const reviewTurn = await dispatch(cp, 'r-c', 'reviewer-session', { actionKind: 'review_engineering', obligationId: 'security-review' });
    assert.equal(reviewTurn.admission.decision, 'admitted');
    assert.equal(reviewTurn.admission.requested.modelClass, 'frontier_reasoning');
    assert.equal(reviewTurn.executionCapsule.role, 'reviewer');
    assert.equal(reviewTurn.executionCapsule.permissions.filesystem, 'read_only');

    const recorded = await cp.recordReview(
      'r-c',
      { stage: 'engineering', verdict: 'pass', reviewerId: 'reviewer-2' },
      { implementerId: 'impl-1', reviewReceiptId: reviewTurn.receipt.receiptId, obligationId: 'security-review', changedPaths: ['src/auth/service.mjs'] },
    );
    assert.equal(recorded.reviewReceipt.reviewer.enforcementStatus, 'enforced');
    assert.notEqual(recorded.reviewReceipt.reviewer.actorSessionId, recorded.reviewReceipt.implementer.actorSessionId);

    const completion = await cp.assessCompletion('r-c');
    assert.equal(completion.readyExceptClose, true, JSON.stringify(completion.unsatisfiedObligations));

    // The whole chain is resolvable from SQLite alone.
    const store = await openKernelStateStore({ runtimeHome: fixture.runtimeHome });
    try {
      const receipts = store.listModelUsageReceipts('r-c');
      for (const receipt of receipts) {
        assert.ok(store.getRouteAdmission(receipt.admissionId, { runId: 'r-c' }), 'every dispatched turn has an admission');
        assert.ok(store.getExecutionCapsule(receipt.capsuleId, { runId: 'r-c' }), 'every dispatched turn has a capsule');
      }
      const reviewReceipt = store.listReviewReceipts('r-c', { obligationId: 'security-review' })[0];
      assert.equal(reviewReceipt.reviewer.usageReceiptId, reviewTurn.receipt.receiptId);
    } finally {
      store.close();
    }
  } finally {
    await cp.close();
    await cleanup(fixture);
  }
});

test('K4 scenario D: every link of the chain refuses to be forged', async () => {
  const fixture = await setup();
  const cp = await createKernelControlPlane(fixture);
  try {
    await cp.startRun({
      runId: 'r-d',
      objective: 'Harden auth',
      taskContract: {
        complex: true,
        riskTier: 'T2',
        acceptance: [
          { acceptance: 'auth rejects expired tokens', evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test:ok'], obligationId: 'unit-test' } },
          { acceptance: 'billing untouched', evidencePlan: { class: 'hard', method: 'static-analysis', commandRefs: ['lint'], obligationId: 'static-analysis' } },
        ],
        steps: [
          { objective: 'Token expiry', allowedPaths: ['src/auth/**'], acceptanceIds: ['AC-1'], obligationIds: ['unit-test'] },
          { objective: 'Lint', allowedPaths: ['src/billing/**'], acceptanceIds: ['AC-2'], obligationIds: ['static-analysis'] },
        ],
      },
    });
    const [first, second] = cp.getRunSteps('r-d');
    const turn = await dispatch(cp, 'r-d', 'implementer-session');
    const capsuleId = turn.executionCapsule.capsuleId;

    // 2. An unrelated passing command filed under a typed obligation.
    await edit(fixture, 'src/auth/service.mjs', 1);
    const forgedCommand = await cp.report('r-d', {
      summary: 'claiming coverage',
      capsuleId,
      attemptId: turn.attemptId,
      stepId: first.stepId,
      changedPaths: ['src/auth/service.mjs'],
      verifications: [{ obligationId: 'unit-test', commandRef: 'lint' }],
    });
    assert.equal(forgedCommand.status, 'evidence-rejected');

    // 4. Reusing a capsule built before the workspace moved.
    const staleAttempt = await dispatch(cp, 'r-d', 'implementer-session');
    const staleCapsule = await cp.report('r-d', {
      summary: 'old capsule',
      attemptId: staleAttempt.attemptId,
      capsuleId,
      stepId: first.stepId,
      changedPaths: ['src/auth/service.mjs'],
    });
    assert.equal(staleCapsule.status, 'step-rejected');
    assert.match(staleCapsule.failures[0].errorSummary, /capsule does not match/i);

    // 5. Reporting a step that is not the current unit of work.
    const wrongStep = await cp.report('r-d', { summary: 'skipping ahead', stepId: second.stepId, changedPaths: [] });
    assert.equal(wrongStep.status, 'step-rejected');

    // 1/3. Changing files the step never claimed.
    const scopedTurn = await dispatch(cp, 'r-d', 'implementer-session');
    const outOfScope = await cp.report('r-d', {
      summary: 'also billing',
      capsuleId: scopedTurn.executionCapsule.capsuleId,
      attemptId: scopedTurn.attemptId,
      stepId: first.stepId,
      changedPaths: ['src/auth/service.mjs', 'src/billing/invoice.mjs'],
    });
    assert.equal(outOfScope.status, 'scope-rejected');

    // The honest path still works.
    const freshTurn = await dispatch(cp, 'r-d', 'implementer-session');
    const honest = await cp.report('r-d', {
      summary: 'auth only',
      capsuleId: freshTurn.executionCapsule.capsuleId,
      attemptId: freshTurn.attemptId,
      stepId: first.stepId,
      changedPaths: ['src/auth/service.mjs'],
      verifications: [{ obligationId: 'unit-test', commandRef: 'test:ok', acceptanceCoverage: ['auth rejects expired tokens'] }],
    });
    assert.equal(honest.step.state, 'passed');
  } finally {
    await cp.close();
    await cleanup(fixture);
  }
});
