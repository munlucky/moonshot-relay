import { decideTestModelRoute, testStagnationSignal } from './helpers/kernel-host-test-api.mjs';
// K2-6/7: a step that keeps failing is replanned, not retried forever. A replan
// supersedes the live steps at a new plan revision instead of editing what was
// already attempted.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createKernelControlPlane } from '../scripts/kernel/control-plane.mjs';
import { allStepsPassed, detectStepStagnation } from '../scripts/kernel/run/run-step-ledger.mjs';
import { buildWorkAuthorityView } from '../scripts/kernel/run/work-authority.mjs';
import { openKernelStateStore } from '../scripts/kernel/state-store.mjs';

const CONTRACT = {
  complex: true,
  riskTier: 'T2',
  acceptance: [
    { acceptance: 'auth rejects expired tokens', evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test:ok', 'test:fail'], obligationId: 'auth-work' } },
    { acceptance: 'the suite stays clean', evidencePlan: { class: 'hard', method: 'static-analysis', commandRefs: ['lint'], obligationId: 'tests-work' } },
  ],
  steps: [
    { objective: 'Implement token expiry', allowedPaths: ['src/auth/**'], acceptanceIds: ['AC-1'], obligationIds: ['auth-work'] },
    { objective: 'Cover it', allowedPaths: ['tests/**'], acceptanceIds: ['AC-2'], obligationIds: ['tests-work'] },
  ],
};

const setup = async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'krn-replan-home-'));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'krn-replan-proj-'));
  spawnSync('git', ['init'], { cwd: projectRoot, encoding: 'utf8' });
  await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({
    name: 'replan-fixture', version: '0.0.1', scripts: { 'test:ok': 'node -e "process.exit(0)"', 'test:fail': 'node -e "process.exit(1)"', lint: 'node -e "process.exit(0)"' },
  }, null, 2));
  await mkdir(path.join(projectRoot, 'src', 'auth'), { recursive: true });
  await mkdir(path.join(projectRoot, 'tests'), { recursive: true });
  await writeFile(path.join(projectRoot, 'src', 'auth', 'service.mjs'), 'export const v = 0;\n');
  await writeFile(path.join(projectRoot, 'tests', 'auth.test.mjs'), 'export const t = 0;\n');
  spawnSync('git', ['add', '--all'], { cwd: projectRoot, encoding: 'utf8' });
  spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-m', 'fixture', '--quiet'], { cwd: projectRoot, encoding: 'utf8' });
  return { runtimeHome, projectRoot };
};

const cleanup = async ({ runtimeHome, projectRoot }) => {
  await rm(runtimeHome, { recursive: true, force: true });
  await rm(projectRoot, { recursive: true, force: true });
};

test('K2-6: three failures on the same step raise stagnation and recommend a replan', async () => {
  const fixture = await setup();
  const cp = await createKernelControlPlane(fixture);
  try {
    await cp.startRun({ runId: 'r-stag', objective: 'Harden auth', taskContract: CONTRACT });
    const [first] = cp.getRunSteps('r-stag');

    let last;
    for (const value of [1, 2, 3]) {
      await writeFile(path.join(fixture.projectRoot, 'src', 'auth', 'service.mjs'), `export const v = ${value};\n`);
      last = await cp.report('r-stag', {
        summary: `attempt ${value}`,
        stepId: first.stepId,
        changedPaths: ['src/auth/service.mjs'],
        verifications: [{ obligationId: 'auth-work', commandRef: 'test:fail' }],
      });
      assert.equal(last.step.state, 'failed');
    }

    assert.equal(last.step.stagnation.stagnant, true);
    assert.equal(last.step.stagnation.signals.consecutiveFailures, true);
    assert.equal(last.step.stagnation.recommendation, 'replan');
    assert.equal(cp.getRunSteps('r-stag')[0].attemptCount, 3);
  } finally {
    await cp.close();
    await cleanup(fixture);
  }
});

test('K2-7: a replan supersedes the live steps and writes the replacement at a new revision', async () => {
  const fixture = await setup();
  const cp = await createKernelControlPlane(fixture);
  try {
    await cp.startRun({ runId: 'r-replan', objective: 'Harden auth', taskContract: CONTRACT });
    const original = cp.getRunSteps('r-replan');
    await writeFile(path.join(fixture.projectRoot, 'src', 'auth', 'service.mjs'), 'export const v = 1;\n');
    await cp.report('r-replan', {
      summary: 'first unit done',
      stepId: original[0].stepId,
      changedPaths: ['src/auth/service.mjs'],
      verifications: [{ obligationId: 'auth-work', commandRef: 'test:ok', acceptanceCoverage: ['AC-1'] }],
    });

    const replanned = await cp.replanSteps('r-replan', {
      steps: [
        { objective: 'Rework expiry with the clock injected', allowedPaths: ['src/auth/**'], acceptanceIds: ['AC-1'], obligationIds: ['auth-work'] },
        { objective: 'Cover it', allowedPaths: ['tests/**'], acceptanceIds: ['AC-2'], obligationIds: ['tests-work'] },
      ],
    });

    assert.equal(replanned.planRevision, 2);
    const all = cp.getRunSteps('r-replan');
    const byId = Object.fromEntries(all.map((step) => [step.stepId, step]));
    // A passed step is history, not something a replan rewrites.
    assert.equal(byId[original[0].stepId].state, 'passed');
    assert.equal(byId[original[1].stepId].state, 'superseded');
    assert.equal(all.filter((step) => step.planRevision === 2).length, 2);
    assert.equal((await cp.getRun('r-replan')).replanCount, 1, 'a replan is a measured event');

    // The cursor now points at the new plan, and the old steps cannot be
    // reported against.
    assert.equal(cp.getCurrentStep('r-replan').planRevision, 2);
    const stale = await cp.report('r-replan', { summary: 'old plan', stepId: original[1].stepId, changedPaths: [] });
    assert.equal(stale.status, 'step-rejected');
    assert.match(stale.failures[0].errorSummary, /belongs to plan revision 1/);
  } finally {
    await cp.close();
    await cleanup(fixture);
  }
});

test('S-16: replan preserves completed Work history while new work stays current', async () => {
  const fixture = await setup();
  const cp = await createKernelControlPlane(fixture);
  try {
    await cp.startRun({ runId: 'r-monotonic-replan', objective: 'Harden auth', taskContract: CONTRACT });
    const original = cp.getRunSteps('r-monotonic-replan');
    await writeFile(path.join(fixture.projectRoot, 'src', 'auth', 'service.mjs'), 'export const v = 1;\n');
    await cp.report('r-monotonic-replan', {
      summary: 'auth work complete',
      stepId: original[0].stepId,
      changedPaths: ['src/auth/service.mjs'],
      verifications: [{ obligationId: 'auth-work', commandRef: 'test:ok', acceptanceCoverage: ['AC-1'] }],
    });

    await cp.replanSteps('r-monotonic-replan', {
      steps: [
        { objective: 'Rework tests only', allowedPaths: ['tests/**'], acceptanceIds: ['AC-2'], obligationIds: ['tests-work'] },
      ],
    });

    const run = await cp.getRun('r-monotonic-replan');
    const steps = cp.getRunSteps('r-monotonic-replan');
    const view = buildWorkAuthorityView({ run, steps });
    assert.ok(view.progress.completedWorkUnitIds.includes(original[0].stepId));
    assert.equal(view.progress.completedCurrentPlanCount, 0);
    assert.equal(view.progress.remainingCount, 1);
    assert.equal(view.goal.coverage.completedAcceptanceCount, 1);
    assert.equal(view.currentWorkUnit.planRevision, 2);
    assert.notEqual(view.currentWorkUnit.stepId, original[0].stepId);
  } finally {
    await cp.close();
    await cleanup(fixture);
  }
});

test('K2: stagnation also fires on repeated no-op reports and repeated identical results', () => {
  const step = { stepId: 'step-1-1' };
  const workspace = `sha256:${'a'.repeat(64)}`;
  const noProgress = [
    { stepId: 'step-1-1', status: 'failed', workspaceIdentityStart: workspace, workspaceIdentityEnd: workspace },
    { stepId: 'step-1-1', status: 'failed', workspaceIdentityStart: workspace, workspaceIdentityEnd: workspace },
  ];
  const detected = detectStepStagnation({ step, attempts: noProgress });
  assert.equal(detected.stagnant, true);
  assert.equal(detected.signals.workspaceUnchanged, true);

  const repeated = detectStepStagnation({
    step,
    attempts: [
      { stepId: 'step-1-1', status: 'failed', resultDigest: 'sha256:same' },
      { stepId: 'step-1-1', status: 'failed', resultDigest: 'sha256:same' },
    ],
  });
  assert.equal(repeated.signals.repeatedResult, true);

  // Progress is not stagnation.
  assert.equal(detectStepStagnation({
    step,
    attempts: [{ stepId: 'step-1-1', status: 'failed', resultDigest: 'sha256:a' }, { stepId: 'step-1-1', status: 'passed', resultDigest: 'sha256:b' }],
  }).stagnant, false);
});

test('K2-6: step stagnation escalates the route, without overtaking retry escalation', async () => {
  const fixture = await setup();
  const cp = await createKernelControlPlane(fixture);
  try {
    await cp.startRun({ runId: 'r-escalate', objective: 'Harden auth', taskContract: CONTRACT });
    const [first] = cp.getRunSteps('r-escalate');
    assert.equal((await decideTestModelRoute(cp, 'r-escalate', { actionKind: 'implement', obligationId: 'auth-work' })).modelClass, 'value_coding');

    for (const value of [1, 2]) {
      await writeFile(path.join(fixture.projectRoot, 'src', 'auth', 'service.mjs'), `export const v = ${value};\n`);
      await cp.report('r-escalate', {
        summary: `attempt ${value}`,
        stepId: first.stepId,
        changedPaths: ['src/auth/service.mjs'],
        verifications: [{ obligationId: 'auth-work', commandRef: 'test:fail' }],
      });
    }
    // Two failures is a retry, not stagnation: the looser step signals must not
    // overtake the retry threshold, or retry escalation becomes unreachable.
    assert.equal(testStagnationSignal(cp, 'r-escalate').stagnant, false);

    await writeFile(path.join(fixture.projectRoot, 'src', 'auth', 'service.mjs'), 'export const v = 3;\n');
    await cp.report('r-escalate', {
      summary: 'attempt 3',
      stepId: first.stepId,
      changedPaths: ['src/auth/service.mjs'],
      verifications: [{ obligationId: 'auth-work', commandRef: 'test:fail' }],
    });

    const signal = testStagnationSignal(cp, 'r-escalate');
    assert.equal(signal.stagnant, true);
    assert.equal(signal.stepLevel.signals.consecutiveFailures, true);

    // The stuck unit is replanned on the frontier class rather than handed back
    // to the implementer that is stuck.
    const escalated = await decideTestModelRoute(cp, 'r-escalate', { actionKind: 'implement', obligationId: 'auth-work' });
    assert.equal(escalated.actionKind, 'replan');
    assert.equal(escalated.modelClass, 'frontier_reasoning');
    assert.equal(escalated.role, 'planner');
  } finally {
    await cp.close();
    await cleanup(fixture);
  }
});

test('K1/K2: a replan invalidates the superseded step capsule and its scope', async () => {
  const fixture = await setup();
  const cp = await createKernelControlPlane(fixture);
  try {
    await cp.startRun({ runId: 'r-capreplan', objective: 'Harden auth', taskContract: CONTRACT });
    const [first] = cp.getRunSteps('r-capreplan');
    const oldCapsule = await cp.buildCapsule('r-capreplan', { step: first });
    assert.deepEqual(oldCapsule.workUnit.allowedPaths, ['src/auth/**']);

    // A replan bumps the plan revision without touching the workspace, so the
    // mutation revision and workspace identity are unchanged.
    const replanned = await cp.replanSteps('r-capreplan', {
      steps: [{ objective: 'Rework in the tests tree', allowedPaths: ['tests/**'], acceptanceIds: ['AC-1'], obligationIds: ['auth-work'] }],
    });
    assert.equal(replanned.planRevision, 2);

    // Naming the superseded capsule is refused outright.
    const named = await cp.report('r-capreplan', {
      summary: 'old capsule after replan',
      capsuleId: oldCapsule.capsuleId,
      stepId: replanned.steps[0].stepId,
      changedPaths: ['tests/auth.test.mjs'],
    });
    assert.equal(named.status, 'scope-rejected');
    assert.match(named.failures[0].errorSummary, /capsule-stale-plan-revision/);

    // And omitting it does not silently fall back to the superseded capsule's
    // scope: the replacement step governs, so its own paths are allowed.
    await writeFile(path.join(fixture.projectRoot, 'tests', 'auth.test.mjs'), 'export const t = 1;\n');
    const unnamed = await cp.report('r-capreplan', {
      summary: 'new step scope',
      stepId: replanned.steps[0].stepId,
      changedPaths: ['tests/auth.test.mjs'],
      verifications: [{ obligationId: 'auth-work', commandRef: 'test:ok', acceptanceCoverage: ['AC-1'] }],
    });
    assert.notEqual(unnamed.status, 'scope-rejected', JSON.stringify(unnamed.failures));
    assert.equal(unnamed.step.state, 'passed');
  } finally {
    await cp.close();
    await cleanup(fixture);
  }
});

test('K2: a replacement plan that reuses a declared step id does not swallow the step', async () => {
  const fixture = await setup();
  const cp = await createKernelControlPlane(fixture);
  try {
    await cp.startRun({
      runId: 'r-idreuse',
      objective: 'Harden auth',
      taskContract: {
        complex: true,
        riskTier: 'T2',
        acceptance: [
          { acceptance: 'auth holds', evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test:ok'], obligationId: 'auth-work' } },
          { acceptance: 'suite holds', evidencePlan: { class: 'hard', method: 'static-analysis', commandRefs: ['lint'], obligationId: 'tests-work' } },
        ],
        steps: [
          { stepId: 'auth-slice', objective: 'Auth', allowedPaths: ['src/auth/**'], acceptanceIds: ['AC-1'], obligationIds: ['auth-work'] },
          { stepId: 'test-slice', objective: 'Tests', allowedPaths: ['tests/**'], acceptanceIds: ['AC-2'], obligationIds: ['tests-work'] },
        ],
      },
    });
    assert.deepEqual(cp.getRunSteps('r-idreuse').map((step) => step.stepId), ['auth-slice', 'test-slice']);

    // The replacement reuses both ids. Step ids are unique per run, so the
    // upsert would have silently dropped both rows and left the new revision
    // with no steps at all — which `allStepsPassed` would have read as settled.
    const replanned = await cp.replanSteps('r-idreuse', {
      steps: [
        { stepId: 'auth-slice', objective: 'Auth again', allowedPaths: ['src/auth/**'], acceptanceIds: ['AC-1'], obligationIds: ['auth-work'] },
        { stepId: 'test-slice', objective: 'Tests again', allowedPaths: ['tests/**'], acceptanceIds: ['AC-2'], obligationIds: ['tests-work'] },
      ],
    });
    assert.equal(replanned.steps.length, 2, 'the replacement plan is not swallowed');
    assert.deepEqual(replanned.steps.map((step) => step.stepId), ['auth-slice@r2', 'test-slice@r2']);
    assert.deepEqual(replanned.steps[1].dependencyIds, ['auth-slice@r2'], 'the chain follows the qualified ids');

    // The superseded rows survive at their own revision.
    const all = cp.getRunSteps('r-idreuse');
    assert.equal(all.find((step) => step.stepId === 'auth-slice').planRevision, 1);
    assert.equal(all.find((step) => step.stepId === 'auth-slice').state, 'superseded');
    assert.equal(cp.getCurrentStep('r-idreuse').stepId, 'auth-slice@r2');
  } finally {
    await cp.close();
    await cleanup(fixture);
  }
});

test('K2: a plan with no steps at the current revision is not a settled plan', async () => {
  const fixture = await setup();
  const cp = await createKernelControlPlane(fixture);
  try {
    await cp.startRun({ runId: 'r-emptyplan', objective: 'Harden auth', taskContract: CONTRACT });
    const [first] = cp.getRunSteps('r-emptyplan');
    await writeFile(path.join(fixture.projectRoot, 'src', 'auth', 'service.mjs'), 'export const v = 1;\n');
    await cp.report('r-emptyplan', {
      summary: 'first unit',
      stepId: first.stepId,
      changedPaths: ['src/auth/service.mjs'],
      verifications: [{ obligationId: 'auth-work', commandRef: 'test:ok', acceptanceCoverage: ['AC-1'] }],
    });

    // Steps exist, but none at revision 2 — a broken plan, not a finished one.
    assert.equal(allStepsPassed(cp.getRunSteps('r-emptyplan'), 2), false);
    // A run with no ledger at all is a different case and stays settled.
    assert.equal(allStepsPassed([], 1), true);
  } finally {
    await cp.close();
    await cleanup(fixture);
  }
});

test('K2: a store-level id collision fails loudly instead of dropping the row', async () => {
  const fixture = await setup();
  const cp = await createKernelControlPlane(fixture);
  const store = await openKernelStateStore({ runtimeHome: fixture.runtimeHome });
  try {
    await cp.startRun({ runId: 'r-collide', objective: 'x', taskContract: CONTRACT });
    const [first] = cp.getRunSteps('r-collide');
    assert.throws(
      () => store.createRunSteps('r-collide', [{ ...first, planRevision: 2, state: 'ready' }]),
      /STEP_ID_COLLISION/,
    );
  } finally {
    store.close();
    await cp.close();
    await cleanup(fixture);
  }
});

test('K2: an atomic replacement rolls back supersession and revision on collision', async () => {
  const fixture = await setup();
  const cp = await createKernelControlPlane(fixture);
  const store = await openKernelStateStore({ runtimeHome: fixture.runtimeHome });
  try {
    await cp.startRun({ runId: 'r-atomic-collide', objective: 'x', taskContract: CONTRACT });
    const before = store.getRun('r-atomic-collide');
    const original = store.getRunSteps('r-atomic-collide');
    assert.throws(() => store.replaceRunPlanAtomic('r-atomic-collide', {
      currentPlanRevision: before.planRevision,
      nextPlanRevision: before.planRevision + 1,
      steps: [{ ...original[0], planRevision: before.planRevision + 1 }],
    }), /STEP_ID_COLLISION/);
    assert.equal(store.getRun('r-atomic-collide').planRevision, before.planRevision);
    assert.deepEqual(store.getRunSteps('r-atomic-collide').map((step) => step.state), original.map((step) => step.state));
  } finally {
    store.close();
    await cp.close();
    await cleanup(fixture);
  }
});


test('scope amendment keeps every pending Work unit and preserves completed history', async () => {
  const fixture = await setup();
  const cp = await createKernelControlPlane(fixture);
  try {
    const runId = 'scope-amendment-tail';
    const contract = { ...CONTRACT, steps: [
      { stepId: 'auth', objective: 'Implement token expiry', allowedPaths: ['src/auth/**'], acceptanceIds: ['AC-1'], obligationIds: ['auth-work'] },
      { stepId: 'tests', objective: 'Cover it', allowedPaths: ['tests/**'], acceptanceIds: ['AC-2'], obligationIds: ['tests-work'], dependsOn: ['auth'] },
      { stepId: 'final', objective: 'Final root proof', allowedPaths: ['tests/**'], acceptanceIds: ['AC-1', 'AC-2'], dependsOn: ['tests'] },
    ] };
    await cp.ensureRun({ runId, objective: 'Harden auth', taskContract: contract });
    const amended = { ...contract, steps: contract.steps.map((step, i) => i === 0
      ? { ...step, allowedPaths: ['src/auth/**', 'tests/**'] } : step) };
    await cp.ensureRun({ runId, taskContract: amended });
    const run = await cp.getRun(runId);
    const active = cp.getRunSteps(runId).filter((step) => step.planRevision === run.planRevision);
    assert.deepEqual(active.map((step) => step.objective), contract.steps.map((step) => step.objective));
    assert.equal(active[1].dependencyIds[0], active[0].stepId);
    assert.equal(active[2].dependencyIds[0], active[1].stepId);
    await cp.ensureRun({ runId, taskContract: amended });
    assert.equal((await cp.getRun(runId)).planRevision, run.planRevision);
    cp.completeStep(runId, active[0].stepId);
    const secondAmendment = { ...amended, steps: amended.steps.map((step, i) => i === 1
      ? { ...step, allowedPaths: ['tests/**', 'src/auth/**'] } : step) };
    await cp.ensureRun({ runId, taskContract: secondAmendment });
    const revised = await cp.getRun(runId);
    const remaining = cp.getRunSteps(runId).filter((step) => step.planRevision === revised.planRevision);
    assert.deepEqual(remaining.map((step) => step.objective), ['Cover it', 'Final root proof']);
    assert.equal(cp.stateStore.getRunStep(runId, active[0].stepId).state, 'passed');
    assert.equal(remaining[0].dependencyIds[0], active[0].stepId);
    assert.equal(remaining[0].state, 'ready');
    assert.equal(remaining[1].state, 'planned');
    assert.equal(cp.getCurrentStep(runId).stepId, remaining[0].stepId);
    const next = await cp.next(runId);
    assert.equal(next.workAuthority.currentWorkUnit.stepId, remaining[0].stepId);
    assert.equal(next.workAuthority.cursor.currentStepId, remaining[0].stepId);
    assert.ok(next.workAuthority.progress.completedWorkUnitIds.includes(active[0].stepId));
    assert.equal(next.workAuthority.cursor.stepCount, 2);
  } finally {
    await cp.close();
    await cleanup(fixture);
  }
});
