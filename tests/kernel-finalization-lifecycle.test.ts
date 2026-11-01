import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { runGit } from '../src/shared/git-safe.js';
import { createKernelControlPlane } from '../src/host/kernel/control-plane-runtime.js';
import { openSqliteDb } from '../src/kernel/sqlite-adapter.js';
import { kernelDbPath } from '../src/kernel/state-store.js';
import { assessRunSettlement } from '../src/kernel/run/finalization.js';

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

  assert.ok(finalizationReceipt && typeof finalizationReceipt === 'object' && 'completionStatus' in finalizationReceipt);
  assert.equal(finalizationReceipt.completionStatus, 'accepted');
  assert.ok(finalizationReceipt && typeof finalizationReceipt === 'object' && 'knowledgeStatus' in finalizationReceipt);
  assert.equal(finalizationReceipt.knowledgeStatus, 'committed');
  assert.ok(finalizationReceipt && typeof finalizationReceipt === 'object' && 'gitCloseoutStatus' in finalizationReceipt);
  assert.equal(finalizationReceipt.gitCloseoutStatus, 'skipped');
  assert.ok(finalizationReceipt && typeof finalizationReceipt === 'object' && 'knowledgeCommitReceipt' in finalizationReceipt);
  assert.ok(finalizationReceipt.knowledgeCommitReceipt);
  assert.ok(finalizationReceipt.knowledgeCommitReceipt && typeof finalizationReceipt.knowledgeCommitReceipt === 'object' && 'status' in finalizationReceipt.knowledgeCommitReceipt);
  assert.equal(finalizationReceipt.knowledgeCommitReceipt.status, 'committed');

  const settled = assessRunSettlement(cp.stateStore, runId);
  assert.deepEqual(settled, { settled: true, blockers: [] });
  const missingProof = assessRunSettlement({
    ...cp.stateStore, getCompletionDecision: () => null,
  }, runId);
  assert.equal(missingProof.settled, false);
  assert.ok(missingProof.blockers.includes('completion_authority_unsettled'));
  const missingKnowledge = assessRunSettlement({
    ...cp.stateStore, getSettledKnowledgeTransaction: () => null,
  }, runId);
  assert.equal(missingKnowledge.settled, false);
  assert.ok(missingKnowledge.blockers.includes('knowledge_ledger_unsettled'));
  const alteredCloseout = assessRunSettlement({
    ...cp.stateStore,
    getFinalizationReceipt: () => {
      const original = cp.stateStore.getFinalizationReceipt(runId)!;
      return {
        ...original,
        receiptJson: {
          ...(original.receiptJson as Record<string, unknown>),
          gitCloseoutRequest: { requested: true },
          gitCloseoutStatus: 'completed',
        },
      };
    },
  }, runId);
  assert.equal(alteredCloseout.settled, false);
  assert.ok(alteredCloseout.blockers.includes('git_closeout_unsettled'));

  // W4 isolated pilot: a settled single-step Run may be retired only with a
  // fresh revision and no active ownership. Its Knowledge ledger must survive.
  const store = cp.stateStore;
  const before = store.getRun(runId)!;
  const steps = store.getRunSteps(runId);
  assert.equal(steps.length, 1);
  assert.equal(steps[0]?.state, 'cancelled', 'accepted output cancels never-executed Step without fabricating a passed Step');
  assert.equal(steps[0]?.blockedReason, 'completion_accepted_without_step_execution');
  const projectId = before.projectId!;
  const revision = before.mutationRevision;
  const knowledgeBefore = store.listKnowledgeRecords({ projectId, statuses: ['committed'] });
  assert.ok(knowledgeBefore.length > 0);
  const knowledgeRevision = store.getProjectKnowledgeRevision(projectId);
  const commitReceipt = store.getKnowledgeCommitReceipt(runId)!;
  const ledgerBefore = store.getSettledKnowledgeTransaction(
    runId, projectId, String(commitReceipt.revisionAfter),
  );
  assert.equal(ledgerBefore?.outcome && (ledgerBefore.outcome as { status: string }).status, 'committed');
  const journalBefore = store.getRunJournal(runId);

  assert.throws(() => store.retireSettledSingleStepRun(runId, {
    projectId, expectedMutationRevision: revision + 1,
  }), /EPHEMERAL_MUTATION_REVISION_STALE/);
  assert.throws(() => store.retireSettledSingleStepRun(runId, {
    projectId: 'unrelated-project', expectedMutationRevision: revision,
  }), /EPHEMERAL_RUN_IDENTITY_MISMATCH/);
  const otherRun = 'w5-other-active-run';
  store.createRun({ runId: otherRun, projectId, objective: 'unrelated live work', sourceIdentity: before.sourceIdentity });
  const otherJournal = store.getRunJournal(otherRun);
  assert.ok(otherJournal.length > 0);
  // The append-only guard must still reject deletes outside atomic retirement.
  const protectedDb = await openSqliteDb(kernelDbPath(tmpHome));
  try {
    assert.throws(() => protectedDb.prepare('DELETE FROM run_journal WHERE run_id=?').run(runId), /run_journal_append_only/);
    assert.throws(() => protectedDb.prepare('DELETE FROM run_journal WHERE run_id=?').run(otherRun), /run_journal_append_only/);
  } finally {
    protectedDb.close();
  }

  store.recordLease(runId, {
    holder: 'w4-owner', expiresAt: new Date(Date.now() + 60000).toISOString(),
    fencingToken: 1,
  });
  assert.throws(() => store.retireSettledSingleStepRun(runId, {
    projectId, expectedMutationRevision: revision,
  }), /EPHEMERAL_ACTIVE_OWNERSHIP/);
  assert.equal(store.releaseLease(runId, { holder: 'w4-owner', fencingToken: 1 }), true);

  // Crash/fault after child deletion must roll back the whole graph.
  const rawDb = await openSqliteDb(kernelDbPath(tmpHome));
  try {
    rawDb.exec("CREATE TRIGGER w4_fault BEFORE DELETE ON runs WHEN OLD.run_id='fin-run-1' BEGIN SELECT RAISE(ABORT,'w4_injected_failure'); END");
  } finally {
    rawDb.close();
  }
  assert.throws(() => store.retireSettledSingleStepRun(runId, {
    projectId, expectedMutationRevision: revision,
  }), /w4_injected_failure/);
  assert.ok(store.getRun(runId), 'SQL transaction must restore Run on failed deletion');
  assert.ok(store.getCompletionDecision(runId), 'SQL rollback must restore Trust receipts');
  assert.deepEqual(store.getRunJournal(runId), journalBefore, 'journal deletion must roll back with Run deletion');
  const rollbackDb = await openSqliteDb(kernelDbPath(tmpHome));
  try {
    assert.equal(rollbackDb.prepare('SELECT value FROM meta WHERE key=?').get('retired-run:' + runId), undefined,
      'failed retirement must not leave an identity marker');
  } finally { rollbackDb.close(); }
  assert.equal(store.listKnowledgeRecords({ projectId, statuses: ['committed'] }).length, knowledgeBefore.length);

  const cleanDb = await openSqliteDb(kernelDbPath(tmpHome));
  try {
    cleanDb.exec('DROP TRIGGER w4_fault');
  } finally {
    cleanDb.close();
  }
  const retirement = store.retireSettledSingleStepRun(runId, {
    projectId, expectedMutationRevision: revision,
  });
  assert.deepEqual(retirement, { status: 'retired', runId, retired: true });
  assert.equal(store.getRun(runId), null);
  assert.equal(store.getCompletionDecision(runId), null);
  assert.equal(store.getRunSteps(runId).length, 0);
  assert.equal(store.getProjectKnowledgeRevision(projectId), knowledgeRevision);
  assert.deepEqual(store.listKnowledgeRecords({ projectId, statuses: ['committed'] }), knowledgeBefore);
  assert.deepEqual(store.getSettledKnowledgeTransaction(
    runId, projectId, String(commitReceipt.revisionAfter),
  ), ledgerBefore, 'FK-free settled Knowledge transaction survives Run retirement');
  assert.deepEqual(store.getRunJournal(runId), [], 'settled Run leaves no permanent execution journal');
  assert.deepEqual(store.getRunJournal(otherRun), otherJournal, 'other active Run journal remains immutable');
  assert.ok(store.getRun(otherRun), 'unrelated active Run survives');
  // Retry of the same successful retirement is idempotent, including across
  // new SQLite connections. Reusing its Run ID must never impersonate
  // the immutable Knowledge provenance that survives the cleanup.
  assert.deepEqual(store.retireSettledSingleStepRun(runId, {
    projectId, expectedMutationRevision: revision,
  }), retirement);
  assert.throws(() => store.retireSettledSingleStepRun(runId, {
    projectId, expectedMutationRevision: revision + 1,
  }), /EPHEMERAL_MUTATION_REVISION_STALE/);
  assert.throws(() => store.retireSettledSingleStepRun(runId, {
    projectId: 'foreign-project', expectedMutationRevision: revision,
  }), /EPHEMERAL_RUN_IDENTITY_MISMATCH/);
  assert.throws(() => store.createRun({
    runId, projectId, objective: 'wrongly reuse a retired identity',
    sourceIdentity: before.sourceIdentity,
  }), /EPHEMERAL_RUN_ID_RETIRED/);

  await cp.close();
  const reopened = await (await import('../src/kernel/state-store.js')).openKernelStateStore({ runtimeHome: tmpHome });
  try {
    assert.equal(reopened.getRun(runId), null);
    assert.deepEqual(reopened.retireSettledSingleStepRun(runId, {
      projectId, expectedMutationRevision: revision,
    }), retirement);
    assert.throws(() => reopened.createRun({
      runId, projectId, objective: 'reuse after restart',
      sourceIdentity: before.sourceIdentity,
    }), /EPHEMERAL_RUN_ID_RETIRED/);
  } finally { reopened.close(); }
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
    for (const state of ['EXECUTE', 'PROVE'] as const) await cp.transition(runId, state);
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
      changedPaths: ['scripts/kernel/git/closeout.js'],
    });

    assert.ok(receipt && typeof receipt === 'object' && 'completionStatus' in receipt);
    assert.equal(receipt.completionStatus, 'blocked');
    assert.ok(receipt && typeof receipt === 'object' && 'finalizationStatus' in receipt);
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
    for (const state of ['EXECUTE', 'PROVE'] as const) await cp.transition(runId, state);
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
    assert.ok(first && typeof first === 'object' && 'completionStatus' in first);
    assert.equal(first.completionStatus, 'accepted');
    assert.ok(first && typeof first === 'object' && 'codeAccepted' in first);
    assert.equal(first.codeAccepted, true);
    assert.ok(first && typeof first === 'object' && 'finalizationStatus' in first);
    assert.equal(first.finalizationStatus, 'partial');
    assert.ok(first && typeof first === 'object' && 'gitCloseoutStatus' in first);
    assert.equal(first.gitCloseoutStatus, 'failed');
    const partialReceipt = cp.stateStore.getGitCloseoutReceipt(runId);
    assert.ok(partialReceipt);
    assert.equal(partialReceipt.status, 'push_failed');
    const commitSha = partialReceipt.commitSha;

    runGit(repoRoot, ['remote', 'add', 'origin', originRoot]);
    const retried = await cp.report(runId, {});
    assert.ok(retried);
    assert.equal(retried.status, 'completed');
    assert.ok(retried && typeof retried === 'object' && 'finalization' in retried);
    assert.ok(retried.finalization && typeof retried.finalization === 'object');
    assert.ok(retried.finalization && typeof retried.finalization === 'object' && 'completionStatus' in retried.finalization);
    assert.equal(retried.finalization.completionStatus, 'accepted');
    assert.ok(retried.finalization && typeof retried.finalization === 'object' && 'codeAccepted' in retried.finalization);
    assert.equal(retried.finalization.codeAccepted, true);
    assert.ok(retried.finalization && typeof retried.finalization === 'object' && 'finalizationStatus' in retried.finalization);
    assert.equal(retried.finalization.finalizationStatus, 'completed');
    assert.ok(retried.finalization && typeof retried.finalization === 'object' && 'gitCloseoutStatus' in retried.finalization);
    assert.equal(retried.finalization.gitCloseoutStatus, 'completed');
    assert.ok(retried.finalization && typeof retried.finalization === 'object' && 'gitCloseoutReceipt' in retried.finalization);
    assert.ok(retried.finalization.gitCloseoutReceipt && typeof retried.finalization.gitCloseoutReceipt === 'object' && 'commitSha' in retried.finalization.gitCloseoutReceipt);
    assert.equal(retried.finalization.gitCloseoutReceipt.commitSha, commitSha);
    const deliveredSettlement = assessRunSettlement(cp.stateStore, runId);
    assert.deepEqual(deliveredSettlement, { settled: true, blockers: [] },
      'A completed Git retry with settled Knowledge can retire transient work after later atomic checks');
    assert.equal(String(runGit(repoRoot, ['rev-parse', 'HEAD']).stdout).trim(), commitSha);
    assert.equal(String(runGit(repoRoot, ['status', '--porcelain']).stdout).trim(), '');
  } finally {
    if (cp) await cp.close();
    await rm(repoRoot, { recursive: true, force: true });
    await rm(runtimeHome, { recursive: true, force: true });
    await rm(originRoot, { recursive: true, force: true });
  }
});

test('W5: accepted Completion cancels only never-started Steps and retains attempted work', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-w5-step-settlement-'));
  const store = await (await import('../src/kernel/state-store.js')).openKernelStateStore({ runtimeHome });
  const projectId = 'w5-step-project';
  const sourceIdentity = 'sha256:' + 'a'.repeat(64);
  const start = (runId: string) => {
    store.createRun({ runId, projectId, objective: 'check step settlement authority', sourceIdentity });
    store.createRunSteps(runId, [{
      stepId: 'step-1', sequence: 1, planRevision: 1, state: 'ready',
      dependencyIds: [], acceptanceIds: [], obligationIds: [],
      allowedPaths: ['src'], forbiddenPaths: [], expectedOutputs: [],
    }]);
  };
  try {
    start('w5-untouched');
    store.persistCompletionDecision('w5-untouched', {
      decision: 'accepted', digest: 'sha256:' + 'b'.repeat(64),
      run: store.getRun('w5-untouched')!, decisionPayload: {},
    });
    const cancelled = store.getRunSteps('w5-untouched')[0]!;
    assert.equal(cancelled.state, 'cancelled');
    assert.equal(cancelled.blockedReason, 'completion_accepted_without_step_execution');

    start('w5-attempted');
    const db = await openSqliteDb(kernelDbPath(runtimeHome));
    try {
      db.prepare(
        'INSERT INTO run_step_attempts(run_id,step_id,attempt_number,status,started_at) VALUES(?,?,?,?,?)',
      ).run('w5-attempted', 'step-1', 1, 'started', new Date().toISOString());
    } finally {
      db.close();
    }
    store.persistCompletionDecision('w5-attempted', {
      decision: 'accepted', digest: 'sha256:' + 'c'.repeat(64),
      run: store.getRun('w5-attempted')!, decisionPayload: {},
    });
    assert.equal(store.getRunSteps('w5-attempted')[0]?.state, 'ready',
      'any real Step attempt prevents fabrication of terminal Step state');
  } finally {
    store.close();
    await rm(runtimeHome, { recursive: true, force: true });
  }
});
