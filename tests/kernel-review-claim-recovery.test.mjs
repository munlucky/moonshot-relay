import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { createKernelControlPlane } from '../scripts/kernel/control-plane.mjs';
import { resolveModelRoute } from '../scripts/kernel/run/model-routing.mjs';
import { dispatchKernelTurn } from '../scripts/host/kernel/turn-dispatcher.mjs';

const setupStore = async (prefix) => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), `${prefix}-home-`));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), `${prefix}-project-`));
  await writeFile(path.join(projectRoot, 'package.json'), '{}');
  const cp = await createKernelControlPlane({ runtimeHome, projectRoot, holder: `${prefix}-holder` });
  return { cp, runtimeHome, projectRoot };
};

const reviewAttempt = ({ cp, runId, stepId, planRevision, mutationRevision, attemptId, sequence = 1 }) => {
  const decision = resolveModelRoute({
    runId,
    actionKind: 'review_engineering',
    riskTier: 'T3',
    attemptNumber: sequence,
    currentPlanRevision: planRevision,
    obligationId: 'security-review',
    independentReviewRequired: true,
  });
  cp.stateStore.recordModelRouteDecision(runId, decision);
  const attempt = cp.stateStore.recordStepAttempt(runId, {
    stepId,
    attemptId,
    routeDecisionId: decision.decisionId,
    provenanceKind: 'routed',
    planRevision,
    mutationRevision,
  });
  return { decision, attempt };
};

test('expired review claims are reclaimed atomically and claim scope follows plan and step', async () => {
  const fixture = await setupStore('kernel-review-claim-recovery');
  const { cp, runtimeHome, projectRoot } = fixture;
  try {
    const runId = 'review-claim-recovery';
    await cp.startRun({ runId, objective: 'review claim recovery', taskContract: { acceptance: [] } });
    const firstRun = await cp.getRun(runId);
    const firstStep = cp.stateStore.getRunSteps(runId, { planRevision: firstRun.planRevision })[0];
    const first = reviewAttempt({
      cp,
      runId,
      stepId: firstStep.stepId,
      planRevision: firstRun.planRevision,
      mutationRevision: firstRun.mutationRevision,
      attemptId: 'attempt-00000000-0000-4000-8000-000000000011',
    });
    const claimKey = 'same-review-label';
    const expired = cp.stateStore.claimReviewAttempt({
      runId,
      stepId: firstStep.stepId,
      claimKey,
      holder: 'crashed-host',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
      role: 'reviewer',
      actionKind: first.decision.actionKind,
      obligationId: first.decision.obligationId,
      planRevision: firstRun.planRevision,
      mutationRevision: firstRun.mutationRevision,
    });
    assert.equal(expired.claimed, true);

    const reclaimed = cp.stateStore.claimReviewAttempt({
      runId,
      stepId: firstStep.stepId,
      claimKey,
      holder: 'recovery-host',
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      role: 'reviewer',
      actionKind: first.decision.actionKind,
      obligationId: first.decision.obligationId,
      planRevision: firstRun.planRevision,
      mutationRevision: firstRun.mutationRevision,
    });
    assert.equal(reclaimed.claimed, true);
    assert.equal(reclaimed.existing.attemptId, first.attempt.attemptId);

    const replacement = cp.stateStore.replaceRunPlanAtomic(runId, {
      currentPlanRevision: firstRun.planRevision,
      nextPlanRevision: firstRun.planRevision + 1,
      steps: [{
        stepId: 'step-new-plan',
        sequence: 1,
        objective: 'review the new plan',
        state: 'planned',
        planRevision: firstRun.planRevision + 1,
        allowedPaths: [],
        forbiddenPaths: [],
        dependencyIds: [],
        acceptanceIds: [],
        obligationIds: [],
        expectedOutputs: [],
        assignedRole: 'implementer',
        synthetic: false,
      }],
    });
    const secondRun = replacement.run;
    const second = reviewAttempt({
      cp,
      runId,
      stepId: 'step-new-plan',
      planRevision: secondRun.planRevision,
      mutationRevision: secondRun.mutationRevision,
      attemptId: 'attempt-00000000-0000-4000-8000-000000000012',
      sequence: 2,
    });
    const newPlanClaim = cp.stateStore.claimReviewAttempt({
      runId,
      stepId: 'step-new-plan',
      claimKey,
      holder: 'new-plan-host',
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      role: 'reviewer',
      actionKind: second.decision.actionKind,
      obligationId: second.decision.obligationId,
      planRevision: secondRun.planRevision,
      mutationRevision: secondRun.mutationRevision,
    });
    assert.equal(newPlanClaim.claimed, true, 'the same label must not collide across plan/step subjects');
    assert.equal(newPlanClaim.existing.attemptId, second.attempt.attemptId);
  } finally {
    await cp.close();
    await rm(runtimeHome, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('review dispatch fails closed when claim acquisition does not establish ownership', async () => {
  const { cp, runtimeHome, projectRoot } = await setupStore('kernel-review-claim-fail-closed');
  const runId = 'review-claim-fail-closed';
  try {
    await cp.startRun({ runId, objective: 'review current changes', taskContract: {
      riskTier: 'T3', acceptance: [],
    } });
    cp.stateStore.claimReviewAttempt = () => ({ claimed: false, reason: 'no-review-attempt' });
    let providerCalls = 0;
    const adapter = {
      surface: 'claude',
      nativeDelegationAvailable: true,
      capabilities: { surface: 'claude', supportsIndependentContext: true, supportsReadOnlyReview: true },
      dispatch: async () => { providerCalls += 1; return { status: 'completed' }; },
    };
    const result = await dispatchKernelTurn({
      controlPlane: cp, runId, adapter,
      actionContext: { actionKind: 'review_engineering', obligationId: 'security-review' },
    });
    assert.equal(result.dispatched, false);
    assert.equal(result.reason, 'no-review-attempt');
    assert.equal(result.review.blockedReason, 'no-review-attempt');
    assert.equal(providerCalls, 0);
    const attempts = cp.stateStore.getStepAttempts(runId);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].status, 'interrupted');
    assert.deepEqual(attempts[0].failureReasons, ['no-review-attempt']);
  } finally {
    await cp.close();
    await rm(runtimeHome, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  }
});
