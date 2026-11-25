import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createKernelControlPlane } from '../src/host/kernel/control-plane-runtime.js';
import { allStepsPassed } from '../src/kernel/run/run-step-ledger.js';
import { assertTestPresent, assertTestRecord } from './helpers/assert-value.js';

const setupFixture = async (extraScripts: Record<string, string> = {}) => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'krn-bottleneck-home-'));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'krn-bottleneck-proj-'));
  spawnSync('git', ['init'], { cwd: projectRoot, encoding: 'utf8' });
  await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({
    name: 'bottleneck-fixture',
    version: '0.0.1',
    scripts: {
      'test:ok': 'node -e "process.exit(0)"',
      'test:fail': 'node -e "process.exit(1)"',
      lint: 'node -e "process.exit(0)"',
      ...extraScripts,
    },
  }, null, 2));
  await mkdir(path.join(projectRoot, 'src', 'app'), { recursive: true });
  await mkdir(path.join(projectRoot, 'tests'), { recursive: true });
  await writeFile(path.join(projectRoot, 'src', 'app', 'index.mjs'), 'export const value = 0;\n');
  await writeFile(path.join(projectRoot, 'tests', 'app.test.mjs'), 'export const ok = true;\n');
  spawnSync('git', ['add', '--all'], { cwd: projectRoot, encoding: 'utf8' });
  spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-m', 'init', '--quiet'], { cwd: projectRoot, encoding: 'utf8' });
  return { runtimeHome, projectRoot };
};

const cleanupFixture = async ({ runtimeHome, projectRoot }: { runtimeHome: string; projectRoot: string }) => {
  await rm(runtimeHome, { recursive: true, force: true });
  await rm(projectRoot, { recursive: true, force: true });
};

test('P0-R (RCA-1): equivalent contract revision without declared acceptanceIds/obligationIds does not replan, while real scope changes replan', async () => {
  const fixture = await setupFixture();
  const cp = await createKernelControlPlane(fixture);
  try {
    const runId = 'rca1-normalized-replan';
    const baseContract = {
      complex: true,
      riskTier: 'T1',
      acceptance: [
        { id: 'AC-1', acceptance: 'core behavior passes tests', evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test:ok'], obligationId: 'default' } },
        { id: 'AC-2', acceptance: 'design review confirmed', evidencePlan: { class: 'judgment', method: 'review', obligationId: 'judgment-ac-2' } },
      ],
      // Declared step omits acceptanceIds and obligationIds; planner auto-binds them.
      steps: [
        { objective: 'Implement core feature', allowedPaths: ['src/app/**'] },
      ],
      constraints: ['Keep changes minimal'],
    };

    await cp.ensureRun({ runId, objective: 'Build feature', taskContract: baseContract });
    const initialRun = assertTestPresent(await cp.getRun(runId));
    const initialSteps = cp.getRunSteps(runId);
    assert.equal(initialRun.contractRevision, 1);
    assert.equal(initialRun.planRevision, 1);
    assert.equal(initialRun.replanCount, 0);
    assert.equal(initialSteps.length, 1);
    assert.deepEqual([...(initialSteps[0].acceptanceIds || [])].sort(), ['AC-1', 'AC-2']);
    assert.ok((initialSteps[0].obligationIds || []).includes('default'));
    assert.ok((initialSteps[0].obligationIds || []).includes('judgment-ac-2'));

    // Revise non-scope contract metadata while keeping the same declared step
    // (still omitting acceptanceIds / obligationIds).
    const equivalentRevision = {
      ...baseContract,
      constraints: ['Keep changes minimal', 'Preserve existing API surface'],
    };
    await cp.ensureRun({ runId, objective: 'Build feature', taskContract: equivalentRevision });
    const afterEquivalent = assertTestPresent(await cp.getRun(runId));
    const stepsAfterEquivalent = cp.getRunSteps(runId);
    assert.equal(afterEquivalent.contractRevision, 2, 'contractRevision still advances on revision');
    assert.equal(afterEquivalent.planRevision, 1, 'equivalent normalized scope must not replan');
    assert.equal(afterEquivalent.replanCount, 0, 'replanCount remains 0 for equivalent scope');
    assert.equal(stepsAfterEquivalent.length, 1);
    assert.equal(stepsAfterEquivalent[0].stepId, initialSteps[0].stepId, 'step identity is preserved');

    // Now actually change allowedPaths: replan MUST trigger.
    const scopeChangedRevision = {
      ...equivalentRevision,
      steps: [
        { objective: 'Implement core feature', allowedPaths: ['src/app/**', 'tests/**'] },
      ],
    };
    await cp.ensureRun({ runId, objective: 'Build feature', taskContract: scopeChangedRevision });
    const afterScopeChange = assertTestPresent(await cp.getRun(runId));
    const stepsAfterScopeChange = cp.getRunSteps(runId);
    assert.equal(afterScopeChange.contractRevision, 3);
    assert.equal(afterScopeChange.planRevision, 2, 'real allowedPaths change must replan');
    assert.equal(afterScopeChange.replanCount, 1);
    assert.equal(stepsAfterScopeChange.find((step) => step.stepId === initialSteps[0].stepId)?.state, 'superseded');
    const activeStep = assertTestPresent(cp.getCurrentStep(runId));
    assert.equal(activeStep.planRevision, 2);
    assert.deepEqual([...(activeStep.allowedPaths || [])].sort(), ['src/app/**', 'tests/**']);
  } finally {
    await cp.close();
    await cleanupFixture(fixture);
  }
});

test('P0-F (RCA-2): passing hard proof with pending judgment is classified as judgment-pending and does not trigger false proof stagnation', async () => {
  const fixture = await setupFixture();
  const cp = await createKernelControlPlane(fixture);
  try {
    const runId = 'rca2-judgment-pending';
    const contract = {
      complex: true,
      riskTier: 'T1',
      acceptance: [
        { id: 'AC-1', acceptance: 'unit tests pass', evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test:ok'], obligationId: 'default' } },
        { id: 'AC-2', acceptance: 'reviewer confirms behavior', evidencePlan: { class: 'judgment', method: 'review', obligationId: 'judgment-ac-2' } },
      ],
      steps: [
        { objective: 'Implement and verify', allowedPaths: ['src/app/**'] },
      ],
    };

    await cp.startRun({ runId, objective: 'Feature with judgment', taskContract: contract });
    const [step] = cp.getRunSteps(runId);

    let lastReport;
    for (const iteration of [1, 2, 3]) {
      await writeFile(path.join(fixture.projectRoot, 'src', 'app', 'index.mjs'), `export const value = ${iteration};\n`);
      lastReport = await cp.report(runId, {
        summary: `iteration ${iteration} with passing hard proof`,
        stepId: step.stepId,
        changedPaths: ['src/app/index.mjs'],
        verifications: [{ obligationId: 'default', commandRef: 'test:ok', acceptanceCoverage: ['AC-1'] }],
      });
    }

    const attempts = cp.stateStore.getStepAttempts(runId, { stepId: step.stepId });
    assert.equal(attempts.length, 3);
    for (const attempt of attempts) {
      assert.equal(attempt.failureCategory, 'judgment-pending', 'pending judgment must not be misclassified as proof failure');
    }
    const stagnation = assertTestRecord(assertTestRecord(assertTestRecord(assertTestPresent(lastReport)).step).stagnation);
    assert.equal(stagnation.stagnant, false, 'pending judgment attempts must not trigger failure-based stagnation');

    // Counterexample: real hard proof failure still records failureCategory='proof' and triggers stagnation.
    await cp.abandon(runId, { reason: 'switch_to_counterexample' });
    const failRunId = 'rca2-real-proof-failure';
    await cp.startRun({
      runId: failRunId,
      objective: 'Real proof failure',
      taskContract: {
        complex: true,
        riskTier: 'T1',
        acceptance: [
          { id: 'AC-1', acceptance: 'unit tests pass', evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test:fail'], obligationId: 'default' } },
        ],
        steps: [
          { objective: 'Broken implementation', allowedPaths: ['src/app/**'] },
        ],
      },
    });
    const [failStep] = cp.getRunSteps(failRunId);
    let lastFailReport;
    for (const iteration of [1, 2, 3]) {
      await writeFile(path.join(fixture.projectRoot, 'src', 'app', 'index.mjs'), `export const broken = ${iteration};\n`);
      lastFailReport = await cp.report(failRunId, {
        summary: `failing iteration ${iteration}`,
        stepId: failStep.stepId,
        changedPaths: ['src/app/index.mjs'],
        verifications: [{ obligationId: 'default', commandRef: 'test:fail', acceptanceCoverage: ['AC-1'] }],
      });
    }
    const failAttempts = cp.stateStore.getStepAttempts(failRunId, { stepId: failStep.stepId });
    assert.equal(failAttempts.length, 3);
    for (const attempt of failAttempts) {
      assert.equal(attempt.failureCategory, 'proof');
    }
    const failStagnation = assertTestRecord(assertTestRecord(assertTestRecord(assertTestPresent(lastFailReport)).step).stagnation);
    assert.equal(failStagnation.stagnant, true);
    assert.equal(failStagnation.recommendation, 'replan');
  } finally {
    await cp.close();
    await cleanupFixture(fixture);
  }
});

test('P0-S (RCA-3): direct finalizeRun settles previously failed step when late judgment completes evidence, and blocks when required steps remain unsettled', async () => {
  const fixture = await setupFixture();
  const cp = await createKernelControlPlane(fixture);
  try {
    // Part A: late judgment arrives after step settled as failed; direct finalizeRun
    // must settle the step to passed before completing so Run and Step Ledger agree.
    const runId = 'rca3-late-judgment-finalize';
    const contract = {
      complex: true,
      riskTier: 'T1',
      acceptance: [
        { id: 'AC-1', acceptance: 'unit tests pass', evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test:ok'], obligationId: 'default' } },
        { id: 'AC-2', acceptance: 'judgment passed', evidencePlan: { class: 'judgment', method: 'review', obligationId: 'judgment-ac-2' } },
      ],
      steps: [
        { objective: 'Implement feature', allowedPaths: ['src/app/**'] },
      ],
    };
    await cp.startRun({ runId, objective: 'Late judgment finalization', taskContract: contract });
    const [step] = cp.getRunSteps(runId);

    await writeFile(path.join(fixture.projectRoot, 'src', 'app', 'index.mjs'), 'export const value = 42;\n');
    const reportResult = await cp.report(runId, {
      summary: 'hard proof passed, judgment pending',
      stepId: step.stepId,
      changedPaths: ['src/app/index.mjs'],
      verifications: [{ obligationId: 'default', commandRef: 'test:ok', acceptanceCoverage: ['AC-1'] }],
    });
    assert.equal(assertTestRecord(assertTestRecord(assertTestPresent(reportResult)).step).state, 'failed');

    // Direct finalizeRun before judgment arrives must stay blocked.
    const blockedBeforeJudgment = await cp.finalizeRun(runId);
    assert.equal(assertTestRecord(blockedBeforeJudgment).completionStatus, 'blocked');

    // Late judgment is recorded on the same source.
    await cp.recordProof(runId, {
      obligationId: 'judgment-ac-2',
      status: 'passed',
      command: 'review',
      evidenceClass: 'judgment',
      evidenceRef: 'judgment://late-review-1',
      evidenceDigest: `sha256:${'a'.repeat(64)}`,
      acceptanceCoverage: ['AC-2'],
    });

    const finalized = await cp.finalizeRun(runId);
    assert.equal(assertTestRecord(finalized).completionStatus, 'accepted');
    assert.equal(assertTestRecord(finalized).finalizationStatus, 'completed');
    const finalRun = assertTestPresent(await cp.getRun(runId));
    assert.equal(finalRun.status, 'completed');
    const finalSteps = cp.getRunSteps(runId, { planRevision: finalRun.planRevision });
    assert.equal(allStepsPassed(finalSteps, finalRun.planRevision), true, 'completed run must not leave failed step');
    assert.equal(finalSteps[0].state, 'passed');

    // Part B: multi-step plan where step 1 passed and step 2 was never executed
    // must be blocked by direct finalizeRun even if all Trust proofs were recorded.
    const multiRunId = 'rca3-unexecuted-second-step';
    await cp.startRun({
      runId: multiRunId,
      objective: 'Multi-step consistency',
      taskContract: {
        complex: true,
        riskTier: 'T0',
        acceptance: [
          { id: 'AC-1', acceptance: 'part 1', evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test:ok'], obligationId: 'part-1', evidenceLevel: 'work' } },
          { id: 'AC-2', acceptance: 'part 2', evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test:ok'], obligationId: 'default', evidenceLevel: 'goal' } },
        ],
        steps: [
          { objective: 'Part 1', allowedPaths: ['src/app/**'], acceptanceIds: ['AC-1'], obligationIds: ['part-1'] },
          { objective: 'Part 2', allowedPaths: ['tests/**'], acceptanceIds: ['AC-2'], obligationIds: ['default'] },
        ],
      },
    });
    const [step1, step2] = cp.getRunSteps(multiRunId);
    await writeFile(path.join(fixture.projectRoot, 'src', 'app', 'index.mjs'), 'export const value = 99;\n');
    await cp.report(multiRunId, {
      summary: 'complete step 1',
      stepId: step1.stepId,
      changedPaths: ['src/app/index.mjs'],
      verifications: [{ obligationId: 'part-1', commandRef: 'test:ok', acceptanceCoverage: ['AC-1'] }],
    });
    assert.equal(cp.stateStore.getRunStep(multiRunId, step1.stepId)?.state, 'passed');
    assert.equal(cp.stateStore.getRunStep(multiRunId, step2.stepId)?.state, 'ready');

    // Record goal proof out-of-band via executeProof without executing step 2.
    await cp.executeProof(multiRunId, {
      obligationId: 'default',
      commandRef: 'test:ok',
      acceptanceCoverage: ['AC-2'],
    });
    assert.equal((await cp.assessCompletion(multiRunId)).readyExceptClose, true, 'all Trust gates are met');

    const blockedMulti = await cp.finalizeRun(multiRunId);
    assert.equal(assertTestRecord(blockedMulti).completionStatus, 'blocked');
    assert.equal(assertTestRecord(blockedMulti).reason, 'work_steps_unsettled');
    assert.notEqual(assertTestPresent(await cp.getRun(multiRunId)).status, 'completed');
  } finally {
    await cp.close();
    await cleanupFixture(fixture);
  }
});

test('P1-E (RCA-4): executeProof never reuses a prior failed verification, reuses exact PASS, and respects allowEvidenceReuse=false', async () => {
  const counterDir = await mkdtemp(path.join(os.tmpdir(), 'krn-rca4-counter-'));
  const counterFile = path.join(counterDir, 'attempts.txt');
  const scriptCode = [
    `const fs = require('node:fs');`,
    `const p = ${JSON.stringify(counterFile)};`,
    `const n = (fs.existsSync(p) ? Number(fs.readFileSync(p, 'utf8')) : 0) + 1;`,
    `fs.writeFileSync(p, String(n));`,
    `if (n === 1) { console.error('HTTP 503 Service Unavailable'); process.exit(1); }`,
    `console.log('242 passed'); process.exit(0);`,
  ].join(' ');
  const fixture = await setupFixture({
    'test:external': `node -e ${JSON.stringify(scriptCode)}`,
  });
  const cp = await createKernelControlPlane(fixture);
  try {
    const runId = 'rca4-pass-only-reuse';
    await cp.startRun({
      runId,
      objective: 'Recover from transient 503 without reusing prior FAIL',
      taskContract: {
        riskTier: 'T0',
        acceptance: [
          { id: 'AC-1', acceptance: 'external suite passes', evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test:external'], obligationId: 'default' } },
        ],
      },
    });
    await cp.transition(runId, 'EXECUTE');
    await cp.transition(runId, 'PROVE');

    // 1st execution fails with simulated HTTP 503.
    const first = await cp.executeProof(runId, {
      obligationId: 'default',
      commandRef: 'test:external',
      acceptanceCoverage: ['AC-1'],
      allowEvidenceReuse: true,
    });
    assert.equal(first.execution.status, 'failed');
    assert.equal(first.execution.actualCommandExecution, true);
    assert.ok(!first.execution.reused);

    // 2nd execution on the EXACT same workspace / mutationRevision / evidenceIdentity
    // must NOT reuse the prior FAIL; it must execute fresh and pass.
    const second = await cp.executeProof(runId, {
      obligationId: 'default',
      commandRef: 'test:external',
      acceptanceCoverage: ['AC-1'],
      allowEvidenceReuse: true,
    });
    assert.equal(second.execution.status, 'passed');
    assert.equal(second.execution.actualCommandExecution, true, 'must execute command fresh instead of reusing prior FAIL');
    assert.ok(!second.execution.reused);
    assert.ok(!second.execution.reuseOfVerificationId);

    // 3rd execution on the same evidenceIdentity with allowEvidenceReuse=true
    // SHOULD reuse the exact PASS.
    const third = await cp.executeProof(runId, {
      obligationId: 'default',
      commandRef: 'test:external',
      acceptanceCoverage: ['AC-1'],
      allowEvidenceReuse: true,
    });
    assert.equal(third.execution.status, 'passed');
    assert.equal(third.execution.reused, true);
    assert.equal(third.execution.actualCommandExecution, false);
    assert.ok(third.execution.reuseOfVerificationId);

    // 4th execution with allowEvidenceReuse=false must execute fresh.
    const fourth = await cp.executeProof(runId, {
      obligationId: 'default',
      commandRef: 'test:external',
      acceptanceCoverage: ['AC-1'],
      allowEvidenceReuse: false,
    });
    assert.equal(fourth.execution.status, 'passed');
    assert.equal(fourth.execution.actualCommandExecution, true);
    assert.ok(!fourth.execution.reused);
  } finally {
    await cp.close();
    await cleanupFixture(fixture);
    await rm(counterDir, { recursive: true, force: true });
  }
});
