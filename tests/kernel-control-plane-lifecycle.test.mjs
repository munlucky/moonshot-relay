import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { createKernelControlPlane } from '../scripts/kernel/control-plane.mjs';
import { normalizeSessionBinding } from '../scripts/kernel/run/session-binding.mjs';
import { resolveKernelProjectIdentity } from '../scripts/kernel/project-identity.mjs';
import { buildResumeView } from '../scripts/kernel/state-projector.mjs';

test('KernelControlPlane wires full knowledge lifecycle end-to-end', async () => {
  const tmpRuntimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-cp-test-'));

  const cp = await createKernelControlPlane({
    runtimeHome: tmpRuntimeHome,
    projectRoot: process.cwd(),
  });

  // Step 1: startRun automatically resolves project identity & records FRAME knowledge context receipt
  const run = await cp.startRun({
    runId: 'cp-run-1',
    objective: 'Implement end-to-end knowledge lifecycle',
    taskContract: { filesChanged: ['scripts/kernel/control-plane.mjs'] },
  });

  assert.ok(run.projectId);
  assert.equal(run.state, 'FRAME');

  // Step 2: buildStageContext loads knowledge context for EXECUTE
  await cp.transition('cp-run-1', 'EXECUTE');
  const executeContext = await cp.buildStageContext('cp-run-1', {
    stage: 'EXECUTE',
    taskContract: { changedFiles: ['scripts/kernel/control-plane.mjs'] },
  });

  assert.ok(executeContext.knowledgeContext);
  assert.equal(executeContext.knowledgeContext.status, 'ready-empty');

  // Step 3: recordProof in PROVE extracts and reviews candidates
  await cp.transition('cp-run-1', 'PROVE');
  const proofRun = await cp.recordProof('cp-run-1', {
    obligationId: 'default',
    status: 'passed',
    command: 'node --test tests/kernel-git-closeout.test.mjs',
    evidenceRef: 'proof-1',
    evidenceDigest: 'sha256:' + 'a'.repeat(64),
    acceptanceCoverage: [],
    changedFiles: ['scripts/kernel/control-plane.mjs'],
  });

  assert.equal(proofRun.state, 'PROVE');

  // Step 4: finalizeRun yields accepted decision & triggers knowledge commit
  const finalizationReceipt = await cp.finalizeRun('cp-run-1');

  if (finalizationReceipt.completionStatus !== 'accepted') {
    throw new Error(`Completion not accepted: status=${finalizationReceipt.completionStatus}`);
  }
  assert.equal(finalizationReceipt.completionStatus, 'accepted');
  assert.ok(finalizationReceipt.knowledgeCommitReceipt, `Expected knowledgeCommitReceipt but got error: ${finalizationReceipt.knowledgeCommitError}`);
  assert.ok(['committed', 'no_change'].includes(finalizationReceipt.knowledgeCommitReceipt.status));

  await cp.close();
});

test('public Kernel control-plane bootstrap reconciles terminal bindings from prior sessions', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-cp-binding-cleanup-'));
  const first = await createKernelControlPlane({
    runtimeHome,
    projectRoot: process.cwd(),
  });
  const projectId = resolveKernelProjectIdentity({
    cwd: process.cwd(),
    env: { ...process.env, MOON_RELAY_KERNEL_HOME: runtimeHome },
  }).projectId;
  try {
    first.stateStore.createRun({
      runId: 'cp-terminal-binding',
      objective: 'terminal binding cleanup',
      sourceIdentity: `sha256:${'e'.repeat(64)}`,
      projectId,
    });
    first.stateStore.persistCompletionDecision('cp-terminal-binding', {
      decision: 'accepted',
      digest: `sha256:${'f'.repeat(64)}`,
      run: first.stateStore.getRun('cp-terminal-binding'),
      decisionPayload: { decision: 'accepted' },
    });
    first.stateStore.createSessionBinding(normalizeSessionBinding({
      bindingId: 'cp-terminal-binding-owner',
      provider: 'codex',
      sessionId: 'codex:old-cp-session',
      runId: 'cp-terminal-binding',
      projectId,
      accessMode: 'owner',
    }));
    assert.equal(
      first.stateStore.getActiveOwnerBinding({ projectId, sessionId: 'codex:old-cp-session' }).bindingId,
      'cp-terminal-binding-owner',
    );
    await first.close();

    const second = await createKernelControlPlane({
      runtimeHome,
      projectRoot: process.cwd(),
    });
    try {
      assert.equal(
        second.stateStore.getActiveOwnerBinding({ projectId, sessionId: 'codex:old-cp-session' }),
        null,
      );
      assert.equal(second.stateStore.diagnoseLifecycleState({ projectId }).counts.terminal_run_active_binding || 0, 0);
    } finally {
      await second.close();
    }
  } finally {
    try { await first.close(); } catch {}
    await rm(runtimeHome, { recursive: true, force: true });
  }
});

test('resume view identifies an interrupted independent review as the next action', () => {
  const view = buildResumeView({
    run: {
      runId: 'run-resume-review',
      status: 'blocked',
      blockedReason: 'security-review',
      state: 'PROVE',
      mutationRevision: 4,
      finalizationStatus: 'pending',
      taskContract: { completionPredicate: { requiredOutcomes: [] } },
    },
    obligations: [{ obligationId: 'security-review', status: 'required', evidenceClass: 'judgment' }],
    routeDecisions: [{ decisionId: 'route-review', role: 'reviewer', actionKind: 'review_engineering' }],
    usageReceipts: [{ decisionId: 'route-review', resultStatus: 'interrupted' }],
  });
  assert.equal(view.kernel.overall, 'blocked');
  assert.equal(view.kernel.reason, 'security-review');
  assert.equal(view.review.status, 'pending');
  assert.equal(view.review.execution, 'interrupted');
  assert.equal(view.resume.action, 'resume-independent-review');
});

test('resume view keeps pushed Git state distinct from pending Kernel finalization', () => {
  const view = buildResumeView({
    run: {
      runId: 'run-resume-git',
      status: 'active',
      state: 'CLOSE',
      mutationRevision: 2,
      finalizationStatus: 'pending',
      taskContract: { completionPredicate: { requiredOutcomes: [] } },
    },
    step: { state: 'passed' },
    obligations: [{ obligationId: 'default', status: 'required', evidenceClass: 'hard' }],
    verifications: [{ obligationId: 'default', status: 'passed', evidenceDigest: 'sha256:evidence' }],
    completionDecision: { decision: 'accepted' },
    gitCloseout: { status: 'completed', pushStatus: 'completed', parity: 'matched', commitSha: 'abc123' },
  });
  assert.equal(view.kernel.overall, 'active');
  assert.equal(view.git.status, 'pushed');
  assert.equal(view.git.head, 'abc123');
  assert.equal(view.finalization.status, 'pending');
  assert.equal(view.resume.action, 'retry-finalization');
});

test('resume view marks a requested Git closeout without a receipt as retryable', () => {
  const view = buildResumeView({
    run: {
      runId: 'run-resume-git-missing-receipt',
      status: 'completed',
      state: 'CLOSE',
      mutationRevision: 2,
      finalizationStatus: 'partial',
      taskContract: { completionPredicate: { requiredOutcomes: [] } },
    },
    completionDecision: { decision: 'accepted' },
    finalizationReceipt: {
      finalizationStatus: 'partial',
      gitCloseoutRequest: { requested: true, mode: 'commit_and_push' },
      gitCloseoutStatus: 'failed',
    },
  });
  assert.equal(view.git.requested, true);
  assert.equal(view.git.status, 'failed');
  assert.equal(view.resume.action, 'retry-finalization');
});

test('resume view keeps active implementation ahead of pending verification and review', () => {
  const view = buildResumeView({
    run: {
      runId: 'run-resume-implementation',
      status: 'active',
      state: 'FRAME',
      mutationRevision: 0,
      taskContract: { completionPredicate: { requiredOutcomes: [] } },
    },
    step: { state: 'active' },
    obligations: [
      { obligationId: 'unit-test', status: 'required', evidenceClass: 'hard' },
      { obligationId: 'security-review', status: 'required', evidenceClass: 'judgment' },
    ],
  });
  assert.equal(view.implementation.status, 'active');
  assert.equal(view.verification.status, 'pending');
  assert.equal(view.review.status, 'pending');
  assert.equal(view.resume.action, 'continue-implementation');
});

test('resume view follows a failed Step into its pending review instead of reopening implementation', () => {
  const view = buildResumeView({
    run: {
      runId: 'run-resume-failed-step-review',
      status: 'active',
      state: 'PROVE',
      mutationRevision: 1,
      taskContract: { completionPredicate: { requiredOutcomes: [] } },
    },
    step: { state: 'failed', reasons: ['obligation-unsatisfied:security-review'] },
    obligations: [{ obligationId: 'security-review', status: 'required', evidenceClass: 'judgment' }],
  });
  assert.equal(view.implementation.status, 'pending');
  assert.equal(view.review.status, 'pending');
  assert.equal(view.resume.action, 'start-independent-review');
});

test('resume view keeps passed hard obligations visible as passed after the Kernel marks them complete', () => {
  const view = buildResumeView({
    run: {
      runId: 'run-resume-proof-status',
      status: 'active',
      state: 'PROVE',
      mutationRevision: 1,
      taskContract: { completionPredicate: { requiredOutcomes: [] } },
    },
    step: { state: 'failed', reasons: ['obligation-unsatisfied:security-review'] },
    obligations: [
      { obligationId: 'unit-test', status: 'passed', evidenceClass: 'hard' },
      { obligationId: 'security-review', status: 'required', evidenceClass: 'judgment' },
    ],
    verifications: [{ obligationId: 'unit-test', status: 'passed' }],
  });
  assert.equal(view.verification.status, 'passed');
  assert.equal(view.review.status, 'pending');
  assert.equal(view.resume.action, 'start-independent-review');
});

test('resume view ignores a stale review receipt when a later reviewer attempt was interrupted', () => {
  const view = buildResumeView({
    run: {
      runId: 'run-resume-stale-review',
      status: 'active',
      state: 'PROVE',
      mutationRevision: 4,
      currentWorkspaceIdentity: 'sha256:workspace-current',
      taskContract: { completionPredicate: { requiredOutcomes: [] } },
    },
    obligations: [{ obligationId: 'security-review', status: 'required', evidenceClass: 'judgment' }],
    reviews: [{
      createdAt: '2026-09-02T10:00:00.000Z',
      subject: { mutationRevision: 4, workspaceIdentity: 'sha256:workspace-current' },
      reviewer: { usageReceiptId: 'usage-completed', routeDecisionId: 'route-completed' },
    }],
    routeDecisions: [
      { decisionId: 'route-completed', role: 'reviewer' },
      { decisionId: 'route-interrupted', role: 'reviewer' },
    ],
    usageReceipts: [
      { receiptId: 'usage-completed', decisionId: 'route-completed', resultStatus: 'completed', createdAt: '2026-09-02T10:01:00.000Z' },
      { receiptId: 'usage-interrupted', decisionId: 'route-interrupted', resultStatus: 'interrupted', createdAt: '2026-09-02T10:02:00.000Z' },
    ],
  });
  assert.equal(view.review.execution, 'interrupted');
  assert.equal(view.resume.action, 'resume-independent-review');
});

test('resume view does not treat an older mutation review as current completion evidence', () => {
  const view = buildResumeView({
    run: {
      runId: 'run-resume-old-review',
      status: 'active',
      state: 'PROVE',
      mutationRevision: 4,
      currentWorkspaceIdentity: 'sha256:workspace-current',
      taskContract: { completionPredicate: { requiredOutcomes: [] } },
    },
    obligations: [{ obligationId: 'security-review', status: 'required', evidenceClass: 'judgment' }],
    reviews: [{
      subject: { mutationRevision: 3, workspaceIdentity: 'sha256:workspace-old' },
      reviewer: { usageReceiptId: 'usage-old', routeDecisionId: 'route-old' },
    }],
  });
  assert.equal(view.review.execution, 'never-started');
  assert.equal(view.resume.action, 'start-independent-review');
});
