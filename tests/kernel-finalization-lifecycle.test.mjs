import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { runGit } from '../scripts/lib/git-safe.mjs';
import { createKernelControlPlane } from '../scripts/kernel/control-plane.mjs';

test('Kernel finalization orchestration (finalizeRun) executes full accepted lifecycle', async () => {
  const tmpHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-fin-test-'));
  const cp = await createKernelControlPlane({ runtimeHome: tmpHome, projectRoot: process.cwd() });

  const runId = 'fin-run-1';
  const run = await cp.startRun({
    runId,
    objective: 'Finalize orchestration test',
    taskContract: {
      riskTier: 'T0',
      acceptance: [{ acceptance: 'acc-1', evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test'], obligationId: 'default' } }],
    },
  });

  assert.equal(run.state, 'FRAME');

  await cp.transition(runId, 'EXECUTE');
  await cp.transition(runId, 'PROVE');
  await cp.recordProof(runId, {
    obligationId: 'default',
    status: 'passed',
    evidenceRef: 'ev-fin-1',
    commandRef: 'test',
    command: 'npm test',
    exitCode: 0,
    evidenceDigest: `sha256:${'a'.repeat(64)}`,
    acceptanceCoverage: ['acc-1'],
  });

  const finalizationReceipt = await cp.finalizeRun(runId, {
    knowledgeObservations: [
      {
        proposedType: 'semantic_fact',
        statement: 'Finalization orchestration executed cleanly.',
        scope: ['scripts/kernel/**'],
        evidenceRefs: [`sha256:${'a'.repeat(64)}`],
      },
    ],
    gitCloseoutRequest: { requested: false },
  });

  assert.equal(finalizationReceipt.completionStatus, 'accepted');
  assert.equal(finalizationReceipt.knowledgeStatus, 'committed');
  assert.equal(finalizationReceipt.gitCloseoutStatus, 'skipped');
  assert.ok(finalizationReceipt.knowledgeCommitReceipt);
  assert.equal(finalizationReceipt.knowledgeCommitReceipt.status, 'committed');

  await cp.close();
});

test('evidence-failed finalization cannot commit or close out Git', async () => {
  const tmpHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-fin-failed-test-'));
  const cp = await createKernelControlPlane({ runtimeHome: tmpHome, projectRoot: process.cwd() });
  const runId = 'fin-evidence-failed-1';
  try {
    await cp.startRun({
      runId,
      objective: 'Reject failed evidence closeout',
      taskContract: {
        riskTier: 'T0',
        acceptance: [{ acceptance: 'acc-failed', evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test'], obligationId: 'default' } }],
      },
    });
    for (const state of ['EXECUTE', 'PROVE']) await cp.transition(runId, state);
    await cp.recordProof(runId, {
      obligationId: 'default',
      status: 'failed',
      evidenceRef: 'ev-failed',
      commandRef: 'test',
      command: 'npm test',
      exitCode: 1,
      evidenceDigest: `sha256:${'b'.repeat(64)}`,
      acceptanceCoverage: ['acc-failed'],
    });

    const receipt = await cp.finalizeRun(runId, {
      gitCloseoutRequest: { requested: true, mode: 'commit', approvalReceipt: 'approval-failed' },
      changedPaths: ['scripts/kernel/git/closeout.mjs'],
    });

    assert.equal(receipt.completionStatus, 'blocked');
    assert.equal(receipt.finalizationStatus, 'incomplete_gates');
    assert.equal(cp.stateStore.getGitCloseoutReceipt(runId), null);
    assert.equal(cp.stateStore.getKnowledgeCommitReceipt(runId), null);
  } finally {
    await cp.close();
    await rm(tmpHome, { recursive: true, force: true });
  }
});

test('partial Git finalization retry reuses the Kernel commit without creating a duplicate', async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'kernel-fin-git-retry-repo-'));
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-fin-git-retry-state-'));
  const originRoot = await mkdtemp(path.join(os.tmpdir(), 'kernel-fin-git-retry-origin-'));
  const runId = 'fin-git-retry-1';
  let cp = null;
  try {
    runGit(originRoot, ['init', '--bare']);
    runGit(repoRoot, ['init', '-b', 'main']);
    runGit(repoRoot, ['config', 'user.name', 'Test User']);
    runGit(repoRoot, ['config', 'user.email', 'test@example.com']);
    await writeFile(path.join(repoRoot, 'initial.txt'), 'initial\n');
    await writeFile(path.join(repoRoot, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }));
    runGit(repoRoot, ['add', 'initial.txt', 'package.json']);
    runGit(repoRoot, ['commit', '-m', 'Initial commit']);
    await writeFile(path.join(repoRoot, 'change.txt'), 'kernel change\n');

    cp = await createKernelControlPlane({ runtimeHome, projectRoot: repoRoot });
    await cp.startRun({
      runId,
      objective: 'Reconcile a partial Git closeout',
      taskContract: {
        riskTier: 'T0',
        acceptance: [{ acceptance: 'acc-retry', evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test'], obligationId: 'default' } }],
      },
    });
    for (const state of ['EXECUTE', 'PROVE']) await cp.transition(runId, state);
    await cp.recordProof(runId, {
      obligationId: 'default',
      status: 'passed',
      evidenceRef: 'ev-retry',
      commandRef: 'test',
      command: 'npm test',
      exitCode: 0,
      evidenceDigest: `sha256:${'c'.repeat(64)}`,
      acceptanceCoverage: ['acc-retry'],
    });

    const first = await cp.finalizeRun(runId, {
      gitCloseoutRequest: { requested: true, mode: 'commit_and_push', approvalReceipt: 'approval-retry' },
      changedPaths: ['change.txt'],
    });
    assert.equal(first.completionStatus, 'accepted');
    assert.equal(first.codeAccepted, true);
    assert.equal(first.finalizationStatus, 'partial');
    assert.equal(first.gitCloseoutStatus, 'failed');
    const partialReceipt = cp.stateStore.getGitCloseoutReceipt(runId);
    assert.equal(partialReceipt.status, 'push_failed');
    const commitSha = partialReceipt.commitSha;

    runGit(repoRoot, ['remote', 'add', 'origin', originRoot]);
    const retried = await cp.report(runId, {});
    assert.equal(retried.status, 'completed');
    assert.equal(retried.finalization.completionStatus, 'accepted');
    assert.equal(retried.finalization.codeAccepted, true);
    assert.equal(retried.finalization.finalizationStatus, 'completed');
    assert.equal(retried.finalization.gitCloseoutStatus, 'completed');
    assert.equal(retried.finalization.gitCloseoutReceipt.commitSha, commitSha);
    assert.equal(String(runGit(repoRoot, ['rev-parse', 'HEAD']).stdout).trim(), commitSha);
    assert.equal(String(runGit(repoRoot, ['status', '--porcelain']).stdout).trim(), '');
  } finally {
    if (cp) await cp.close();
    await rm(repoRoot, { recursive: true, force: true });
    await rm(runtimeHome, { recursive: true, force: true });
    await rm(originRoot, { recursive: true, force: true });
  }
});
