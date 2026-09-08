import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createKernelControlPlane } from '../scripts/kernel/control-plane.mjs';
import { openKernelStateStore } from '../scripts/kernel/state-store.mjs';
import { hashSessionId } from '../scripts/kernel/run/model-route-contract.mjs';
import { evaluateReviewReceipt } from '../scripts/kernel/proof/review-receipt.mjs';
import { kernelCommit } from '../scripts/kernel/standalone/kernel-commit.mjs';

const IMPLEMENTER = hashSessionId('implementer-session');
const kernelCli = path.join(process.cwd(), 'bin', 'moon-relay-kernel.mjs');

const SCRIPTS = {
  'test:ok': 'node -e "process.exit(0)"',
  lint: 'node -e "process.exit(0)"',
};

const setupFixture = async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'krn-opapp-home-'));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'krn-opapp-proj-'));
  spawnSync('git', ['init'], { cwd: projectRoot, encoding: 'utf8' });
  spawnSync('git', ['config', 'user.name', 'Tester'], { cwd: projectRoot });
  spawnSync('git', ['config', 'user.email', 'tester@test.com'], { cwd: projectRoot });
  await mkdir(path.join(projectRoot, '.moon-relay'), { recursive: true });
  await writeFile(
    path.join(projectRoot, '.moon-relay', 'track.yaml'),
    'schemaVersion: 1\ntrack: kernel\nproduct: moon-relay-kernel\n',
  );
  await writeFile(
    path.join(projectRoot, '.moon-relay', 'project.identity.yaml'),
    'projectId: opapp-fixture\n',
  );
  await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({ name: 'opapp-fixture', version: '0.0.1', scripts: SCRIPTS }, null, 2));
  await writeFile(path.join(projectRoot, 'app.mjs'), 'export const v = 0;\n');
  spawnSync('git', ['add', '.'], { cwd: projectRoot });
  spawnSync('git', ['commit', '-m', 'initial commit'], { cwd: projectRoot });
  return { runtimeHome, projectRoot };
};

const cleanupFixture = async ({ runtimeHome, projectRoot }) => {
  await rm(runtimeHome, { recursive: true, force: true });
  await rm(projectRoot, { recursive: true, force: true });
};

const mutate = (projectRoot, value) => writeFile(path.join(projectRoot, 'app.mjs'), `export const v = ${value};\n`);

const routeAndRun = async (cp, runId, actionKind, actorSessionId) => {
  const decision = await cp.decideModelRoute(runId, { actionKind, obligationId: 'default' });
  const receipt = await cp.recordModelUsage(runId, {
    decisionId: decision.decisionId,
    runId,
    hostSurface: 'codex',
    actorSessionId,
    resolvedModel: 'configured-model',
    enforcementStatus: 'enforced',
    resultStatus: 'completed',
  });
  return { decision, receipt };
};

test('cp.approveObligation mints valid operator_approved review receipt and satisfies judgment obligation', async () => {
  const fixture = await setupFixture();
  const cp = await createKernelControlPlane(fixture);
  const runId = 'run-op-app-1';
  try {
    await cp.startRun({
      runId,
      objective: 'security feature',
      taskContract: {
        surfaces: ['security_boundary'],
        acceptance: [{ acceptance: 'works', evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test:ok'], obligationId: 'unit-test' } }],
      },
    });
    await mutate(fixture.projectRoot, 1);
    await routeAndRun(cp, runId, 'implement', IMPLEMENTER);
    await cp.report(runId, {
      summary: 'implemented security feature',
      changedPaths: ['app.mjs'],
      verifications: [
        { obligationId: 'unit-test', commandRef: 'test:ok', acceptanceCoverage: ['works'] },
        { obligationId: 'static-analysis', commandRef: 'lint' },
      ],
    });

    const preAssessment = await cp.assessCompletion(runId);
    assert.equal(preAssessment.decision, 'blocked');
    const secStatusPre = preAssessment.obligationStatuses.find((s) => s.obligationId === 'security-review');
    assert.equal(secStatusPre.satisfied, false);

    const result = await cp.approveObligation({
      runId,
      obligationId: 'security-review',
      approver: 'test-operator',
      reason: 'Verified manually by operator',
      approvalRef: 'host-turn:security-approval-1',
      autoFinalize: true,
    });

    assert.equal(result.status, 'approved');
    assert.equal(result.finalizationStatus, 'completed');
    const approved = result.approvedObligations[0];
    assert.equal(approved.obligationId, 'security-review');
    assert.ok(approved.receipt);
    assert.equal(approved.receipt.reviewer.enforcementStatus, 'operator_approved');
    assert.match(approved.receipt.reviewer.approvalRefDigest, /^sha256:[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(approved.receipt).includes('host-turn:security-approval-1'), false);
    assert.equal(approved.decisionBasis, 'operator_approval');

    // Verify evaluateReviewReceipt directly accepts the operator_approved receipt
    const store = await openKernelStateStore({ runtimeHome: fixture.runtimeHome });
    try {
      const run = store.getRun(runId);
      const evalResult = evaluateReviewReceipt({
        receipt: approved.receipt,
        run,
        requireIndependentSession: true,
        requireFrontierClass: true,
      });
      assert.equal(evalResult.usable, true);
      assert.deepEqual(evalResult.reasons, []);
    } finally {
      await store.close();
    }

    // Verify completion assessment now accepts the run
    const postAssessment = await cp.assessCompletion(runId);
    assert.equal(postAssessment.decision, 'accepted');
    const secStatusPost = postAssessment.obligationStatuses.find((s) => s.obligationId === 'security-review');
    assert.equal(secStatusPost.satisfied, true);
  } finally {
    await cp.close();
    await cleanupFixture(fixture);
  }
});

test('cp.approveObligation never substitutes operator approval for hard evidence', async () => {
  const fixture = await setupFixture();
  const cp = await createKernelControlPlane(fixture);
  const runId = 'run-op-app-hard';
  try {
    await cp.startRun({
      runId,
      objective: 'hard evidence task',
      taskContract: {
        acceptance: [{ acceptance: 'unit test works', evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test:ok'], obligationId: 'unit-test' } }],
      },
    });

    await assert.rejects(
      () => cp.approveObligation({
        runId,
        obligationId: 'unit-test',
        approver: 'operator',
        reason: 'Attempting to bypass test',
        approvalRef: 'host-turn:hard-proof-bypass',
        // A legacy caller trying the removed escape hatch must still fail.
        overrideHardEvidence: true,
      }),
      (err) => err.code === 'HARD_EVIDENCE_NOT_OPERATOR_APPROVABLE',
    );

    const store = await openKernelStateStore({ runtimeHome: fixture.runtimeHome });
    try {
      assert.equal(store.getVerifications(runId).length, 0);
    } finally {
      await store.close();
    }
  } finally {
    await cp.close();
    await cleanupFixture(fixture);
  }
});

test('legacy operator-override hard proof is preserved for audit but rejected by completion', async () => {
  const fixture = await setupFixture();
  const cp = await createKernelControlPlane(fixture);
  const runId = 'run-op-app-legacy-hard';
  try {
    await cp.startRun({
      runId,
      objective: 'legacy synthetic proof guard',
      taskContract: {
        acceptance: [{ acceptance: 'unit test works', evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test:ok'], obligationId: 'unit-test' } }],
      },
    });
    await cp.transition(runId, 'EXECUTE');
    await cp.transition(runId, 'PROVE');
    const run = cp.stateStore.getRun(runId);
    cp.stateStore.recordVerification(runId, {
      obligationId: 'unit-test',
      status: 'passed',
      evidenceRef: `operator-override://${runId}/unit-test`,
      sourceIdentity: run.sourceIdentity,
      command: 'operator-override',
      commandRef: 'test:ok',
      exitCode: 0,
      evidenceDigest: `sha256:${'a'.repeat(64)}`,
      acceptanceCoverage: ['unit test works'],
      evidenceClass: 'hard',
      verifiedSourceIdentity: run.currentWorkspaceIdentity,
      executor: 'kernel-runtime',
    });

    const assessment = cp.stateStore.evaluateCompletion(runId);
    const unit = assessment.obligationStatuses.find((item) => item.obligationId === 'unit-test');
    assert.equal(unit.satisfied, false);
    assert.ok(assessment.unsatisfiedObligations.some((item) => item.obligationId === 'unit-test'));
    assert.equal(cp.stateStore.getVerifications(runId).some((item) => item.command === 'operator-override'), true);
  } finally {
    await cp.close();
    await cleanupFixture(fixture);
  }
});

test('cp.approveObligation requires a scoped approval reference and declared outstanding judgment', async () => {
  const fixture = await setupFixture();
  const cp = await createKernelControlPlane(fixture);
  const runId = 'run-op-app-ref';
  try {
    await cp.startRun({
      runId,
      objective: 'security approval reference task',
      taskContract: {
        surfaces: ['security_boundary'],
        acceptance: [{ acceptance: 'works', evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test:ok'], obligationId: 'unit-test' } }],
      },
    });

    await assert.rejects(
      () => cp.approveObligation({
        runId,
        obligationId: 'security-review',
        approver: 'operator',
        reason: 'Missing Host reference',
      }),
      (err) => err.code === 'OPERATOR_APPROVAL_REF_REQUIRED',
    );

    await assert.rejects(
      () => cp.approveObligation({
        runId,
        obligationId: 'invented-review',
        approver: 'operator',
        reason: 'Must not mint undeclared judgment',
        approvalRef: 'host-turn:declared-only',
      }),
      (err) => err.code === 'OPERATOR_APPROVAL_OBLIGATION_NOT_DECLARED',
    );
  } finally {
    await cp.close();
    await cleanupFixture(fixture);
  }
});

test('workspace drift before operator approval keeps stale hard evidence blocking finalization', async () => {
  const fixture = await setupFixture();
  const cp = await createKernelControlPlane(fixture);
  const runId = 'run-op-app-drift';
  try {
    await cp.startRun({
      runId,
      objective: 'security workspace drift task',
      taskContract: {
        surfaces: ['security_boundary'],
        acceptance: [{ acceptance: 'works', evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test:ok'], obligationId: 'unit-test' } }],
      },
    });
    await mutate(fixture.projectRoot, 10);
    await routeAndRun(cp, runId, 'implement', IMPLEMENTER);
    await cp.report(runId, {
      summary: 'verified before later workspace drift',
      changedPaths: ['app.mjs'],
      verifications: [
        { obligationId: 'unit-test', commandRef: 'test:ok', acceptanceCoverage: ['works'] },
        { obligationId: 'static-analysis', commandRef: 'lint' },
      ],
    });

    // Drift after hard proof: operator may approve the judgment, but cannot
    // fabricate fresh hard evidence for the new mutation revision.
    await mutate(fixture.projectRoot, 11);
    const result = await cp.approveObligation({
      runId,
      allJudgments: true,
      approver: 'operator',
      reason: 'Approve judgment only after workspace drift',
      approvalRef: 'host-turn:drift-judgment',
      autoFinalize: true,
    });

    assert.equal(result.status, 'approved');
    assert.equal(result.finalized, null);
    assert.equal(result.completion.readyExceptClose, false);
    assert.ok(result.completion.unsatisfiedObligations.some((entry) => entry.requiredEvidenceClass === 'hard'));

    const store = await openKernelStateStore({ runtimeHome: fixture.runtimeHome });
    try {
      const verifications = store.getVerifications(runId);
      assert.equal(verifications.some((item) => item.command === 'operator-override'), false);
      assert.equal(verifications.some((item) => item.evidenceClass === 'hard' && item.command === 'operator-approval'), false);
    } finally {
      await store.close();
    }
  } finally {
    await cp.close();
    await cleanupFixture(fixture);
  }
});

test('CLI moon-relay-kernel approve command approves obligations and auto-finalizes', async () => {
  const fixture = await setupFixture();
  const cp = await createKernelControlPlane(fixture);
  const runId = 'run-cli-approve';
  try {
    await cp.startRun({
      runId,
      objective: 'cli approve task',
      taskContract: {
        surfaces: ['security_boundary'],
        acceptance: [{ acceptance: 'works', evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test:ok'], obligationId: 'unit-test' } }],
      },
    });
    await mutate(fixture.projectRoot, 2);
    await routeAndRun(cp, runId, 'implement', IMPLEMENTER);
    await cp.report(runId, {
      summary: 'implemented for cli test',
      changedPaths: ['app.mjs'],
      verifications: [
        { obligationId: 'unit-test', commandRef: 'test:ok', acceptanceCoverage: ['works'] },
        { obligationId: 'static-analysis', commandRef: 'lint' },
      ],
    });
  } finally {
    await cp.close();
  }

  const cliArgs = [
    kernelCli,
    'approve',
    runId,
    '--reason',
    'CLI operator approval',
    '--project-root',
    fixture.projectRoot,
    '--runtime-home',
    fixture.runtimeHome,
    '--json',
  ];
  const cliEnv = {
    ...process.env,
    MOON_RELAY_KERNEL_REEXEC: '1',
    MOON_RELAY_KERNEL_HOME: fixture.runtimeHome,
    MOONSHOT_RELAY_HOME: fixture.runtimeHome,
  };

  const missingRef = spawnSync(process.execPath, cliArgs, {
    cwd: fixture.projectRoot,
    encoding: 'utf8',
    env: cliEnv,
  });
  assert.equal(missingRef.status, 1, missingRef.stderr || missingRef.stdout);
  assert.match(missingRef.stderr, /OPERATOR_APPROVAL_REF_REQUIRED/);

  // Host supplies an opaque approval reference only after explicit operator approval.
  const cliRes = spawnSync(process.execPath, cliArgs, {
    cwd: fixture.projectRoot,
    encoding: 'utf8',
    env: {
      ...cliEnv,
      MOON_RELAY_KERNEL_OPERATOR_APPROVAL_REF: 'host-turn:cli-security-approval',
    },
  });

  assert.equal(cliRes.status, 0, cliRes.stderr || cliRes.stdout);
  const payload = JSON.parse(cliRes.stdout);
  assert.equal(payload.status, 'approved');
  assert.equal(payload.finalizationStatus, 'completed');

  // Verify state store shows finalized
  const store = await openKernelStateStore({ runtimeHome: fixture.runtimeHome });
  try {
    const run = store.getRun(runId);
    assert.equal(run.finalizationStatus, 'completed');
  } finally {
    await store.close();
    await cleanupFixture(fixture);
  }
});

test('kernelCommit with approve flag auto-approves pending judgment obligations and commits mutation', async () => {
  const fixture = await setupFixture();
  const cp = await createKernelControlPlane(fixture);
  const runId = 'run-commit-approve';
  try {
    await cp.startRun({
      runId,
      objective: 'commit approve task',
      taskContract: {
        surfaces: ['security_boundary'],
        acceptance: [{ acceptance: 'works', evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test:ok'], obligationId: 'unit-test' } }],
      },
    });
    await mutate(fixture.projectRoot, 3);
    await routeAndRun(cp, runId, 'implement', IMPLEMENTER);
    await cp.report(runId, {
      summary: 'ready to commit',
      changedPaths: ['app.mjs'],
      verifications: [
        { obligationId: 'unit-test', commandRef: 'test:ok', acceptanceCoverage: ['works'] },
        { obligationId: 'static-analysis', commandRef: 'lint' },
      ],
    });
  } finally {
    await cp.close();
  }

  // Call kernelCommit with approve: true
  const result = await kernelCommit({
    cwd: fixture.projectRoot,
    env: {
      ...process.env,
      MOON_RELAY_KERNEL_HOME: fixture.runtimeHome,
      MOONSHOT_RELAY_HOME: fixture.runtimeHome,
      MOON_RELAY_KERNEL_RUN_ID: runId,
      MOON_RELAY_KERNEL_OPERATOR_APPROVAL_REF: 'host-turn:commit-security-approval',
    },
    message: 'test operator approval commit',
    approve: true,
    reason: 'Operator approved during commit',
  });

  assert.equal(result.status, 'committed');
  assert.ok(result.commitHash);

  // Verify git log contains commit
  const logRes = spawnSync('git', ['log', '-1', '--oneline'], { cwd: fixture.projectRoot, encoding: 'utf8' });
  assert.match(logRes.stdout, /test operator approval commit/);

  await cleanupFixture(fixture);
});
