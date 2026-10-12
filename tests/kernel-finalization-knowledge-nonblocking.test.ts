import { assertTestArray, assertTestPresent, assertTestRecord, assertTestString, optionalTestRecord } from './helpers/assert-value.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createKernelControlPlane } from '../src/host/kernel/control-plane-runtime.js';

const setup = async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'krn-fin-kn-home-'));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'krn-fin-kn-proj-'));
  spawnSync('git', ['init'], { cwd: projectRoot, encoding: 'utf8' });
  spawnSync('git', ['config', 'user.name', 'Kernel Test'], { cwd: projectRoot, encoding: 'utf8' });
  spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: projectRoot, encoding: 'utf8' });
  await mkdir(path.join(projectRoot, '.moon-relay'), { recursive: true });
  await writeFile(path.join(projectRoot, '.moon-relay', 'track.yaml'), 'track: kernel\nproduct: moon-relay-kernel\n');
  await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({
    name: 'finalization-knowledge-nonblocking',
    version: '0.0.1',
    scripts: { test: 'node -e "process.exit(0)"' },
  }));
  await writeFile(path.join(projectRoot, 'app.mjs'), 'export const ready = true;\n');
  spawnSync('git', ['add', '.'], { cwd: projectRoot, encoding: 'utf8' });
  spawnSync('git', ['commit', '-m', 'Initial commit'], { cwd: projectRoot, encoding: 'utf8' });
  return { runtimeHome, projectRoot };
};

const cleanup = async ({ runtimeHome, projectRoot }: { runtimeHome: string; projectRoot: string }) => {
  await rm(runtimeHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
  await rm(projectRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
};

test('Finalization Wave 5: Knowledge conflict does not fail accepted code delivery and defers knowledge safely', async () => {
  const fixture = await setup();
  const cp = await createKernelControlPlane(fixture);
  try {
    const runId = 'r-kn-nonblocking';
    await cp.startRun({
      runId,
      objective: 'deliver feature despite knowledge conflict',
      taskContract: {
        riskTier: 'T0',
        acceptance: [{
          acceptance: 'basic unit works',
          evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test'], obligationId: 'default' },
        }],
        allowedPaths: ['app.mjs'],
      },
    });

    await cp.transition(runId, 'EXECUTE');
    await cp.transition(runId, 'PROVE');
    await cp.recordProof(runId, {
      obligationId: 'default',
      status: 'passed',
      evidenceRef: 'ev-fin-pass',
      commandRef: 'test',
      command: 'node -e "process.exit(0)"',
      exitCode: 0,
      evidenceDigest: `sha256:${'a'.repeat(64)}`,
      acceptanceCoverage: ['basic unit works'],
    });
    await cp.transition(runId, 'CLOSE');

    const store = cp.stateStore;
    const run = store.getRun(runId);
    const projectId = assertTestPresent(run).projectId;

    // Simulate an accepted completion decision
    store.recordCompletionDecision(runId, {
      decision: 'accepted',
      sourceIdentity: assertTestPresent(run).sourceIdentity,
      mutationRevision: assertTestPresent(run).mutationRevision,
      evidenceDigest: `sha256:${'a'.repeat(64)}`,
      decisionJson: { decision: 'accepted' },
    });

    // Advance project knowledge revision in background from 1 to 2 by committing real records
    store.createRun({
      runId: 'r-bg-advance',
      objective: 'bg advance',
      sourceIdentity: assertTestPresent(run).sourceIdentity,
      projectId,
      taskContract: { acceptance: [{ statement: 'bg works' }] },
    });
    store.recordCompletionDecision('r-bg-advance', {
      decision: 'accepted',
      sourceIdentity: assertTestPresent(run).sourceIdentity,
      mutationRevision: 1,
      evidenceDigest: `sha256:${'c'.repeat(64)}`,
      decisionJson: { decision: 'accepted' },
    });
    store.commitKnowledgeTransaction({
      transactionId: 'tx-conflict-advance',
      runId: 'r-bg-advance',
      projectId,
      expectedRevision: '1',
      records: [{ id: 'rec-bg-1', type: 'semantic_fact', statement: 'bg fact' }],
      supersessions: [],
      provenance: { runId: 'r-bg-advance', committedCount: 1 },
      noChange: false,
    });
    assert.equal(store.getProjectKnowledgeRevision(assertTestString(projectId)), 2, 'Project revision should be advanced to 2');

    // Now finalize runId: knowledge start revision is 1, but store revision is 2.
    // Attempt 1 fails CAS, reloads revision 2, and succeeds on Attempt 2!
    const receipt = await cp.finalizeRun(runId, {
      knowledgeObservations: [
        { proposedType: 'semantic_fact', statement: 'statement recovered on attempt 2' },
      ],
    });
    assert.equal(assertTestRecord(receipt).completionStatus, 'accepted', 'Code delivery must remain accepted');
    assert.equal(assertTestRecord(receipt).knowledgeStatus, 'committed', 'CAS retry should commit successfully');
    assert.equal(assertTestRecord(receipt).knowledgeCommitAttempts, 2, 'Must succeed on attempt 2 after CAS reload');
    assert.equal(store.getProjectKnowledgeRevision(assertTestString(projectId)), 3, 'Revision should advance to 3');
    assert.equal(assertTestRecord(receipt).finalizationStatus, 'completed', 'Finalization should complete');

    // Case 2: Continuous revision conflict across all 3 retries defers knowledge, but Git Closeout still completes!
    let attemptCount = 0;
    const origCommit = store.commitKnowledgeTransaction.bind(store);
    store.commitKnowledgeTransaction = (args) => {
      attemptCount++;
      const current = store.getProjectKnowledgeRevision(assertTestString(projectId));
      store.updateProjectKnowledgeRevision(assertTestString(projectId), current, current + 1);
      throw new Error(`STALE_KNOWLEDGE_REVISION: concurrent race attempt ${attemptCount}`);
    };
    try {
      const deferredRunId = 'r-kn-deferred';
      await writeFile(path.join(fixture.projectRoot, 'change.txt'), 'kernel change\n');
      await cp.startRun({
        runId: deferredRunId,
        objective: 'deferred knowledge test',
        taskContract: {
          riskTier: 'T0',
          acceptance: [{
            acceptance: 'deferred unit works',
            evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test'], obligationId: 'default' },
          }],
          allowedPaths: ['change.txt'],
        },
      });
      await cp.transition(deferredRunId, 'EXECUTE');
      await cp.transition(deferredRunId, 'PROVE');
      await cp.recordProof(deferredRunId, {
        obligationId: 'default',
        status: 'passed',
        evidenceRef: 'ev-fin-pass-2',
        commandRef: 'test',
        command: 'npm test',
        exitCode: 0,
        evidenceDigest: `sha256:${'b'.repeat(64)}`,
        acceptanceCoverage: ['deferred unit works'],
      });

      const deferredReceipt = await cp.finalizeRun(deferredRunId, {
        knowledgeObservations: [
          { proposedType: 'semantic_fact', statement: 'fact that cannot be committed' },
        ],
        gitCloseoutRequest: {
          requested: true,
          mode: 'soft',
          approvalReceipt: 'approval-deferred-test',
        },
        changedPaths: ['change.txt'],
      });
      assert.equal(attemptCount, 3, 'Must attempt exactly 3 CAS retries');
      assert.equal(assertTestRecord(deferredReceipt).completionStatus, 'accepted', 'Code delivery must remain accepted');
      assert.equal(assertTestRecord(deferredReceipt).knowledgeStatus, 'deferred', 'Knowledge status should be marked deferred');
      assert.equal(assertTestRecord(deferredReceipt).gitCloseoutStatus, 'completed', 'Git closeout must complete successfully despite deferred knowledge');
      assert.ok(assertTestRecord(deferredReceipt).gitCloseoutReceipt, 'Git closeout receipt must exist');
      assert.ok(assertTestString(assertTestRecord(assertTestRecord(deferredReceipt).gitCloseoutReceipt).commitSha), 'Git closeout commitSha must exist');

      // Verify that the commit actually exists in git history
      const headLog = spawnSync('git', ['log', '-1', '--oneline', assertTestString(assertTestRecord(assertTestRecord(deferredReceipt).gitCloseoutReceipt).commitSha)], {
        cwd: fixture.projectRoot,
        encoding: 'utf8',
      });
      assert.equal(headLog.status, 0, `Git commit must exist: ${headLog.stderr}`);
      assert.match(headLog.stdout, new RegExp(assertTestString(assertTestString(assertTestRecord(assertTestRecord(deferredReceipt).gitCloseoutReceipt).commitSha)).slice(0, 7)));

      // Verify deferred receipt was recorded in store
      const persistedReceipt = store.getKnowledgeCommitReceipt(deferredRunId)?.receiptJson;
      assert.equal(optionalTestRecord(persistedReceipt)?.status, 'deferred');
      assert.equal(optionalTestRecord(persistedReceipt)?.reason, 'cas_retry_exhausted');
    } finally {
      store.commitKnowledgeTransaction = origCommit;
    }

    // Verify deferred knowledge survives control plane restart and can be processed
    await cp.close();
    const cp2 = await createKernelControlPlane(fixture);
    try {
      const persistedAfterRestart = cp2.stateStore.getKnowledgeCommitReceipt('r-kn-deferred')?.receiptJson;
      assert.equal(optionalTestRecord(persistedAfterRestart)?.status, 'deferred');
      const candidates = cp2.stateStore.getKnowledgeCandidates('r-kn-deferred');
      assert.ok(candidates.length > 0);
    } finally {
      await cp2.close();
    }
  } finally {
    try { await cp.close(); } catch { /* Already closed after the restart checkpoint. */ }
    await cleanup(fixture);
  }
});

test('Wave 5: Knowledge review rejection defers knowledge without blocking code completion or git closeout', async () => {
  const fixture = await setup();
  const cp = await createKernelControlPlane(fixture);
  try {
    const runId = 'r-kn-rejected-nonblocking';
    await writeFile(path.join(fixture.projectRoot, 'feature.mjs'), 'export const feature = 42;\n');
    await cp.startRun({
      runId,
      objective: 'deliver feature despite rejected knowledge candidate',
      taskContract: {
        riskTier: 'T0',
        acceptance: [{
          acceptance: 'feature works',
          evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test'], obligationId: 'default' },
        }],
        allowedPaths: ['feature.mjs'],
      },
    });

    await cp.transition(runId, 'EXECUTE');
    await cp.transition(runId, 'PROVE');
    await cp.recordProof(runId, {
      obligationId: 'default',
      status: 'passed',
      evidenceRef: 'ev-rej-pass',
      commandRef: 'test',
      command: 'npm test',
      exitCode: 0,
      evidenceDigest: `sha256:${'e'.repeat(64)}`,
      acceptanceCoverage: ['feature works'],
    });

    // Finalize with a candidate that triggers rejection (e.g. raw_transcript_body forbidden leak)
    const receipt = await cp.finalizeRun(runId, {
      knowledgeObservations: [
        { proposedType: 'semantic_fact', statement: 'observation containing raw_transcript_body forbidden leak' },
      ],
      gitCloseoutRequest: {
        requested: true,
        mode: 'soft',
        approvalReceipt: 'approval-rejection-test',
      },
      changedPaths: ['feature.mjs'],
    });

    // Critical assertion: Code completion MUST be accepted and Git closeout MUST succeed!
    assert.equal(assertTestRecord(receipt).completionStatus, 'accepted', 'Code completion must be accepted despite knowledge rejection');
    assert.equal(assertTestRecord(receipt).finalizationStatus, 'completed', 'Finalization must be completed');
    assert.equal(assertTestRecord(receipt).gitCloseoutStatus, 'completed', 'Git closeout must complete');
    assert.equal(assertTestRecord(receipt).knowledgeStatus, 'deferred', 'Knowledge status must be deferred');
    assert.equal(assertTestRecord(assertTestRecord(receipt).reviewResult).status, 'failed', 'Review result status must be failed when all candidates rejected');
    assert.equal(assertTestArray(assertTestRecord(assertTestRecord(receipt).reviewResult).rejectedCandidates).length, 1, 'Candidate must be in rejectedCandidates');

    // Verify git commit was created
    assert.ok(optionalTestRecord(assertTestRecord(receipt).gitCloseoutReceipt)?.commitSha, 'Git commitSha must be present');
    const headLog = spawnSync('git', ['log', '-1', '--oneline', assertTestString(assertTestRecord(assertTestRecord(receipt).gitCloseoutReceipt).commitSha)], {
      cwd: fixture.projectRoot,
      encoding: 'utf8',
    });
    assert.equal(headLog.status, 0);
  } finally {
    await cp.close();
    await cleanup(fixture);
  }
});

test('S-18: required Knowledge can keep Task finalization incomplete without erasing accepted code', async () => {
  const fixture = await setup();
  const cp = await createKernelControlPlane(fixture);
  try {
    const runId = 'r-kn-required-incomplete';
    await writeFile(path.join(fixture.projectRoot, 'feature.mjs'), 'export const feature = 43;\n');
    await cp.startRun({
      runId,
      objective: 'require durable knowledge after code acceptance',
      taskContract: {
        riskTier: 'T0',
        flags: { knowledgeRequired: true },
        acceptance: [{
          acceptance: 'feature works',
          evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test'], obligationId: 'default' },
        }],
        allowedPaths: ['feature.mjs'],
      },
    });
    await cp.transition(runId, 'EXECUTE');
    await cp.transition(runId, 'PROVE');
    await cp.recordProof(runId, {
      obligationId: 'default',
      status: 'passed',
      evidenceRef: 'ev-required-kn',
      commandRef: 'test',
      command: 'npm test',
      exitCode: 0,
      evidenceDigest: `sha256:${'f'.repeat(64)}`,
      acceptanceCoverage: ['feature works'],
    });
    const receipt = await cp.finalizeRun(runId, {
      knowledgeObservations: [
        { proposedType: 'semantic_fact', statement: 'observation containing raw_transcript_body forbidden leak' },
      ],
      changedPaths: ['feature.mjs'],
    });
    assert.equal(assertTestRecord(receipt).completionStatus, 'accepted');
    assert.equal(assertTestRecord(receipt).codeAccepted, true);
    assert.equal(assertTestRecord(receipt).knowledgeRequired, true);
    assert.equal(assertTestRecord(receipt).knowledgeStatus, 'deferred');
    assert.equal(assertTestRecord(receipt).finalizationStatus, 'partial');
    assert.equal(assertTestRecord(receipt).reason, 'required_knowledge_incomplete');
    assert.equal(assertTestPresent(cp.stateStore.getRun(runId)).finalizationStatus, 'partial');
  } finally {
    await cp.close();
    await cleanup(fixture);
  }
});

test('Wave 5: Restart recovery independently reconciles deferred knowledge from previous run post-finalization', async () => {
  const fixture = await setup();
  const cp1 = await createKernelControlPlane(fixture);
  try {
    const runId1 = 'r-kn-defer-restart-1';
    await writeFile(path.join(fixture.projectRoot, 'module1.mjs'), 'export const m1 = 1;\n');
    await cp1.startRun({
      runId: runId1,
      objective: 'run 1 to be deferred',
      taskContract: {
        riskTier: 'T0',
        acceptance: [{
          acceptance: 'm1 works',
          evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test'], obligationId: 'default' },
        }],
        allowedPaths: ['module1.mjs'],
      },
    });
    await cp1.transition(runId1, 'EXECUTE');
    await cp1.transition(runId1, 'PROVE');
    await cp1.recordProof(runId1, {
      obligationId: 'default',
      status: 'passed',
      evidenceRef: 'ev-m1-pass',
      commandRef: 'test',
      command: 'npm test',
      exitCode: 0,
      evidenceDigest: `sha256:${'f'.repeat(64)}`,
      acceptanceCoverage: ['m1 works'],
    });

    // Cause run 1 to be deferred by simulating revision conflict
    const store1 = cp1.stateStore;
    const origCommit = store1.commitKnowledgeTransaction.bind(store1);
    let forceConflict = true;
    store1.commitKnowledgeTransaction = (args) => {
      if (forceConflict) {
        throw new Error('STALE_KNOWLEDGE_REVISION: forced conflict for run 1');
      }
      return origCommit(args);
    };

    const receipt1 = await cp1.finalizeRun(runId1, {
      knowledgeObservations: [
        { proposedType: 'semantic_fact', statement: 'valid observation from run 1 that was deferred' },
      ],
      changedPaths: ['module1.mjs'],
    });
    assert.equal(assertTestRecord(receipt1).completionStatus, 'accepted');
    assert.equal(assertTestRecord(receipt1).knowledgeStatus, 'deferred');

    // Simulate process restart
    await cp1.close();

    // Reopen control plane in fresh process instance
    const cp2 = await createKernelControlPlane(fixture);
    try {
      const runId2 = 'r-kn-clean-restart-2';
      await writeFile(path.join(fixture.projectRoot, 'module2.mjs'), 'export const m2 = 2;\n');
      await cp2.startRun({
        runId: runId2,
        objective: 'run 2 triggering post-finalization recovery',
        taskContract: {
          riskTier: 'T0',
          acceptance: [{
            acceptance: 'm2 works',
            evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test'], obligationId: 'default' },
          }],
          allowedPaths: ['module2.mjs'],
        },
      });
      await cp2.transition(runId2, 'EXECUTE');
      await cp2.transition(runId2, 'PROVE');
      await cp2.recordProof(runId2, {
        obligationId: 'default',
        status: 'passed',
        evidenceRef: 'ev-m2-pass',
        commandRef: 'test',
        command: 'npm test',
        exitCode: 0,
        evidenceDigest: `sha256:${'1'.repeat(64)}`,
        acceptanceCoverage: ['m2 works'],
      });

      // Finalize run 2 cleanly
      const receipt2 = await cp2.finalizeRun(runId2, {
        knowledgeObservations: [
          { proposedType: 'semantic_fact', statement: 'observation from run 2' },
        ],
        changedPaths: ['module2.mjs'],
      });

      assert.equal(assertTestRecord(receipt2).completionStatus, 'accepted');
      assert.equal(assertTestRecord(receipt2).knowledgeStatus, 'committed');
      assert.equal(assertTestRecord(receipt2).finalizationStatus, 'completed');

      // Post-finalization bounded recovery must have recovered runId1's deferred knowledge!
      const store2 = cp2.stateStore;
      const run1Receipt = store2.getKnowledgeCommitReceipt(runId1)?.receiptJson;
      assert.equal(optionalTestRecord(run1Receipt)?.status, 'committed', 'Run 1 deferred knowledge should be independently recovered');

      // Both Run 1 and Run 2 knowledge records should be committed in the store
      const committedRecords = store2.listKnowledgeRecords({ projectId: assertTestString(assertTestRecord(receipt2).projectId), statuses: ['committed'] });
      const statements = committedRecords.map((r) => r.statement);
      assert.ok(statements.some((s) => assertTestString(s).includes('from run 1')), 'Run 1 knowledge must be present in committed records');
      assert.ok(statements.some((s) => assertTestString(s).includes('from run 2')), 'Run 2 knowledge must be present in committed records');
    } finally {
      await cp2.close();
    }
  } finally {
    await cleanup(fixture);
  }
});

test('Invariant S1: Git closeout does not require knowledgeCommitReceipt and succeeds when null', async () => {
  const fixture = await setup();
  let store: TestStateStore | null = null;
  try {
    const { executeKernelGitCloseout } = await import('../src/kernel/git/closeout.js');
    const { createGitCloseoutHost } = await import('../src/host/kernel/git/closeout-operations.js');
    const { openKernelStateStore } = await import('../src/kernel/state-store.js');
    const { observeWorkspaceIdentity } = await import('../src/host/kernel/workspace/workspace-identity.js');
    store = await openKernelStateStore({ runtimeHome: fixture.runtimeHome });
    const runId = 'r-git-no-kn';
    const projectId = 'proj-git-no-kn';
    const compatibilityInput1 = {
      runId,
      projectId,
      sourceIdentity: 'test-source',
      objective: 'git closeout without knowledge receipt',
      riskTier: 'T0',
      allowedPaths: ['app.mjs'],
    };
    assertTestPresent(store).createRun(compatibilityInput1);
    const baseline = observeWorkspaceIdentity({ projectRoot: fixture.projectRoot });
    assertTestPresent(store).observeWorkspaceIdentity(runId, baseline.identity);

    await writeFile(path.join(fixture.projectRoot, 'app.mjs'), 'export const updated = true;\n');
    const mutation = observeWorkspaceIdentity({ projectRoot: fixture.projectRoot });
    assertTestPresent(store).observeWorkspaceIdentity(runId, mutation.identity, {
      provenance: {
        projectId,
        sourceIdentity: 'test-source',
        changedPaths: ['app.mjs'],
        mutationDigest: mutation.identity,
      },
    });
    const currentRun = assertTestPresent(store).getRun(runId);
    assertTestPresent(store).recordCompletionDecision(runId, {
      decision: 'accepted',
      sourceIdentity: assertTestPresent(currentRun).sourceIdentity,
      mutationRevision: assertTestPresent(currentRun).mutationRevision,
      evidenceDigest: `sha256:${'b'.repeat(64)}`,
      decisionJson: {
        decision: 'accepted',
        sourceIdentity: assertTestPresent(currentRun).sourceIdentity,
        mutationRevision: assertTestPresent(currentRun).mutationRevision,
        currentWorkspaceIdentity: assertTestPresent(currentRun).currentWorkspaceIdentity,
      },
    });

    const result = await executeKernelGitCloseout({
      runId,
      projectId,
      stateStore: store,
      repoRoot: fixture.projectRoot,
      observeWorkspaceIdentity,
      gitCloseoutRequest: {
        requested: true,
        mode: 'commit',
        approvalReceipt: 'approval://test/git-no-kn',
        message: 'fix: deliver code without knowledge receipt',
      },
      knowledgeCommitReceipt: null, // S1: MUST NOT THROW KNOWLEDGE_RECEIPT_REQUIRED
      changedFiles: ['app.mjs'],
      gitCloseoutHost: createGitCloseoutHost(),
    });

    assert.equal(result.status, 'completed');
  } finally {
    await assertTestPresent(store)?.close();
    await cleanup(fixture);
  }
});

test('Invariant S2: Projection failure does not set finalizationStatus to partial and keeps completed', async () => {
  const fixture = await setup();
  const cp = await createKernelControlPlane(fixture);
  try {
    const runId = 'r-proj-fail-nonblock';
    await cp.startRun({
      runId,
      objective: 'projection fail nonblock',
      taskContract: {
        riskTier: 'T0',
        acceptance: [{
          acceptance: 'unit works',
          evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test'], obligationId: 'default' },
        }],
        allowedPaths: ['app.mjs'],
      },
    });
    await cp.transition(runId, 'EXECUTE');
    await cp.transition(runId, 'PROVE');
    await cp.recordProof(runId, {
      obligationId: 'default',
      status: 'passed',
      evidenceRef: 'ev-pf',
      commandRef: 'test',
      command: 'node -e "process.exit(0)"',
      exitCode: 0,
      evidenceDigest: `sha256:${'c'.repeat(64)}`,
      acceptanceCoverage: ['unit works'],
    });
    await cp.transition(runId, 'CLOSE');

    const store = cp.stateStore;
    const run = store.getRun(runId);
    store.recordCompletionDecision(runId, {
      decision: 'accepted',
      sourceIdentity: assertTestPresent(run).sourceIdentity,
      mutationRevision: assertTestPresent(run).mutationRevision,
      evidenceDigest: `sha256:${'c'.repeat(64)}`,
      decisionJson: { decision: 'accepted' },
    });

    // Fail only the derived projection read. Ontology/review reads remain
    // available so this fixture reaches the projection boundary it is testing.
    const listKnowledgeRecords = store.listKnowledgeRecords.bind(store);
    store.listKnowledgeRecords = (query = {}) => {
      if (Array.isArray(query.statuses)
        && query.statuses.length === 2
        && query.statuses.includes('committed')
        && query.statuses.includes('verified')) {
        throw new Error('simulated projection failure');
      }
      return listKnowledgeRecords(query);
    };

    const receipt = await cp.finalizeRun(runId, {
      knowledgeObservations: [{ proposedType: 'semantic_fact', statement: 'projection test fact' }],
      changedPaths: ['app.mjs'],
    });
    assert.equal(assertTestRecord(receipt).completionStatus, 'accepted');
    assert.equal(assertTestRecord(receipt).projectionStatus, 'failed');
    // Invariant S2: projectionStatus === 'failed' must NOT set finalizationStatus to 'partial'
    assert.equal(assertTestRecord(receipt).finalizationStatus, 'completed', 'finalizationStatus must remain completed despite projection failure');
    assert.equal(assertTestPresent(store.getRun(runId)).finalizationStatus, 'completed');
  } finally {
    await cp.close();
    await cleanup(fixture);
  }
});

test('Invariant H2: Unhandled exception in reviewKnowledgeCandidates does not block completion, git closeout, or finalization', async () => {
  const fixture = await setup();
  const cp = await createKernelControlPlane(fixture);
  try {
    const runId = 'r-review-crash';
    await cp.startRun({
      runId,
      objective: 'review crash test',
      taskContract: {
        riskTier: 'T0',
        acceptance: [{
          acceptance: 'unit works',
          evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test'], obligationId: 'default' },
        }],
        allowedPaths: ['app.mjs'],
      },
    });
    await cp.transition(runId, 'EXECUTE');
    await cp.transition(runId, 'PROVE');
    await cp.recordProof(runId, {
      obligationId: 'default',
      status: 'passed',
      evidenceRef: 'ev-rc',
      commandRef: 'test',
      command: 'node -e "process.exit(0)"',
      exitCode: 0,
      evidenceDigest: `sha256:${'e'.repeat(64)}`,
      acceptanceCoverage: ['unit works'],
    });
    await cp.transition(runId, 'CLOSE');

    const store = cp.stateStore;
    const run = store.getRun(runId);
    store.recordCompletionDecision(runId, {
      decision: 'accepted',
      sourceIdentity: assertTestPresent(run).sourceIdentity,
      mutationRevision: assertTestPresent(run).mutationRevision,
      evidenceDigest: `sha256:${'e'.repeat(64)}`,
      decisionJson: { decision: 'accepted' },
    });

    // Plant a corrupted canonical ontology record. Knowledge review must
    // read SQLite authority rather than a projection file.
    store.saveKnowledgeRecord(assertTestString(assertTestPresent(run).projectId), 'rec-broken-pattern', {
      recordType: 'ontology_constraint',
      status: 'committed',
      trustTier: 'verified',
      recordJson: {
        id: 'rec-broken-pattern',
        projectId: assertTestPresent(run).projectId,
        type: 'ontology_constraint',
        status: 'committed',
        trustTier: 'verified',
        scope: ['app.mjs'],
        pattern: '[unclosed regex',
        severity: 'never',
      },
      revision: store.getProjectKnowledgeRevision(assertTestString(assertTestPresent(run).projectId)),
    });

    // Invariant H2: reviewKnowledgeCandidates throwing SyntaxError must be caught gracefully
    const receipt = await cp.finalizeRun(runId, {
      knowledgeObservations: [{
        proposedType: 'semantic_fact',
        statement: 'test observation against broken regex',
        scope: ['app.mjs'],
      }],
      changedPaths: ['app.mjs'],
    });

    assert.equal(assertTestRecord(receipt).completionStatus, 'accepted');
    assert.equal(assertTestRecord(receipt).knowledgeStatus, 'deferred');
    assert.equal(assertTestRecord(receipt).finalizationStatus, 'completed');
    assert.equal(assertTestRecord(receipt).reason, 'knowledge_review_error');
  } finally {
    await cp.close();
    await cleanup(fixture);
  }
});

test('Invariant H3: HOL starvation prevention in deferred recovery (rejected does not starve retryable)', async () => {
  const fixture = await setup();
  const cp = await createKernelControlPlane(fixture);
  try {
    const store = cp.stateStore;
    const projectId = 'proj-hol-starvation';

    // Insert Run A as deferred with non-retryable reason ('knowledge_review_rejected')
    const runIdA = 'r-hol-a-rejected';
    const compatibilityInput2 = { runId: runIdA, projectId, sourceIdentity: 'src-a', objective: 'rejected run', status: 'completed' };
    store.createRun(compatibilityInput2);
    store.recordCompletionDecision(runIdA, { decision: 'accepted', sourceIdentity: 'src-a', mutationRevision: 0, evidenceDigest: 'd1', decisionJson: { decision: 'accepted' } });
    store.recordKnowledgeCommitReceipt(runIdA, {
      projectId,
      revisionBefore: '1',
      revisionAfter: '1',
      status: 'deferred',
      receiptJson: { status: 'deferred', reason: 'knowledge_review_rejected', candidateCount: 1 },
    });
    // Run A has a rejected candidate
    store.recordKnowledgeCandidate('cand-a', runIdA, {
      projectId,
      proposedType: 'semantic_fact',
      status: 'rejected',
      candidateJson: { statement: 'rejected fact' },
    });

    // Wait 25ms to ensure createdAt order
    await new Promise((r) => setTimeout(r, 25));

    // Insert Run B as deferred with retryable reason ('cas_retry_exhausted')
    const runIdB = 'r-hol-b-retryable';
    const compatibilityInput3 = { runId: runIdB, projectId, sourceIdentity: 'src-b', objective: 'retryable run', status: 'completed' };
    store.createRun(compatibilityInput3);
    store.recordCompletionDecision(runIdB, { decision: 'accepted', sourceIdentity: 'src-b', mutationRevision: 0, evidenceDigest: 'd2', decisionJson: { decision: 'accepted' } });
    store.recordKnowledgeCommitReceipt(runIdB, {
      projectId,
      revisionBefore: '1',
      revisionAfter: '1',
      status: 'deferred',
      receiptJson: { status: 'deferred', reason: 'cas_retry_exhausted', candidateCount: 1 },
    });
    // Run B has a verified candidate
    store.recordKnowledgeCandidate('cand-b', runIdB, {
      projectId,
      proposedType: 'semantic_fact',
      status: 'verified',
      candidateJson: { statement: 'retryable valid fact', proposedType: 'semantic_fact' },
    });

    const { recoverBoundedDeferredKnowledge } = await import('../src/kernel/run/finalization.js');
    const recovered = await recoverBoundedDeferredKnowledge({
      store,
      runtimeHome: fixture.runtimeHome,
      projectId,
      currentRunId: 'r-current',
      maxDeferredRuns: 1,
    });

    // Invariant H3: The single recovered run must be Run B! Run A must not cause HOL starvation!
    assert.equal(recovered.length, 1, 'Should recover exactly 1 run');
    assert.equal(recovered[0].runId, runIdB, 'Run B must be recovered without being starved by Run A');
  } finally {
    await cp.close();
    await cleanup(fixture);
  }
});

type TestControlPlane = Awaited<ReturnType<typeof import('../src/host/kernel/control-plane-runtime.js').createKernelControlPlane>>;
type TestStateStore = Awaited<ReturnType<typeof import('../src/kernel/state-store.js').openKernelStateStore>>;
