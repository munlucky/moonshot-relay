import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { openKernelStateStore } from '../src/kernel/state-store.js';
import { openSqliteDb } from '../src/kernel/sqlite-adapter.js';
import { createKnowledgeLifecycleStore } from '../src/kernel/persistence/knowledge-lifecycle-store.js';

test('Knowledge revision advances through the SQLite CAS authority only', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-rev-test-'));
  const store = await openKernelStateStore({ runtimeHome });
  try {
    assert.equal(store.getProjectKnowledgeRevision('test-proj'), 1);
    assert.equal(store.updateProjectKnowledgeRevision('test-proj', 1, 2), true);
    assert.equal(store.getProjectKnowledgeRevision('test-proj'), 2);

    assert.equal(
      store.updateProjectKnowledgeRevision('test-proj', 1, 3),
      false,
      'stale revision writers must lose the CAS',
    );
    assert.equal(store.getProjectKnowledgeRevision('test-proj'), 2);

    assert.equal(store.updateProjectKnowledgeRevision('test-proj', 2, 3), true);
    assert.equal(store.getProjectKnowledgeRevision('test-proj'), 3);
  } finally {
    store.close();
    await rm(runtimeHome, { recursive: true, force: true });
  }
});

test('W5 distinct required-verification commands survive canonical persistence while exact duplicates do not advance revision', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-w5-identity-'));
  const store = await openKernelStateStore({ runtimeHome });
  const projectId = 'w5-canonical-proof';
  const sourceIdentity = `sha256:${'a'.repeat(64)}`;
  const prepare = (runId: string) => {
    store.createRun({ runId, projectId, objective: 'preserve distinct proof contracts', sourceIdentity });
    store.recordCompletionDecision(runId, {
      decision: 'accepted', sourceIdentity, mutationRevision: 0,
      evidenceDigest: `sha256:${'b'.repeat(64)}`, decisionJson: { decision: 'accepted' },
    });
  };
  const record = (id: string, command: string) => ({
    id, projectId, type: 'required_verification',
    statement: 'Service verification required', scope: ['src/service.ts'],
    trustTier: 'verified', verification: { commandRefs: [command], method: 'command', evidenceLevel: 'work' },
  });
  try {
    prepare('w5-first');
    const committed = store.commitKnowledgeTransaction({
      transactionId: 'w5-first-tx', runId: 'w5-first', projectId, expectedRevision: '1',
      records: [record('w5-unit', 'test:unit'), record('w5-integration', 'test:integration')],
      provenance: { runId: 'w5-first' },
    });
    assert.equal(committed.status, 'committed');
    const rows = store.listKnowledgeRecords({ projectId, statuses: ['committed'] });
    assert.deepEqual(rows.map((entry) => (entry.verification as { commandRefs?: string[] } | undefined)?.commandRefs?.[0]).sort(), ['test:integration', 'test:unit']);
    prepare('w5-retry');
    const repeated = store.commitKnowledgeTransaction({
      transactionId: 'w5-retry-tx', runId: 'w5-retry', projectId, expectedRevision: '2',
      records: [record('w5-duplicate-id', 'test:unit')], provenance: { runId: 'w5-retry' },
    });
    assert.equal(repeated.status, 'no_change');
    assert.equal(store.getProjectKnowledgeRevision(projectId), 2);
    assert.equal(store.listKnowledgeRecords({ projectId, statuses: ['committed'] }).length, 2);
  } finally {
    store.close();
    await rm(runtimeHome, { recursive: true, force: true });
  }
});

test('W2: committed Knowledge retains Kernel-verified authority without relying on Run reads, and rejects forged or stale completion', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-w2-durable-authority-'));
  const store = await openKernelStateStore({ runtimeHome });
  const projectId = 'w2-durable-project';
  const sourceIdentity = `sha256:${'a'.repeat(64)}`;
  const completionDigest = `sha256:${'b'.repeat(64)}`;
  const reviewDigest = `sha256:${'c'.repeat(64)}`;
  try {
    const makeRun = (runId: string, mutationRevision = 0) => {
      store.createRun({ runId, projectId, objective: 'Knowledge provenance proof', sourceIdentity });
      store.recordCompletionDecision(runId, {
        decision: 'accepted', sourceIdentity, mutationRevision,
        evidenceDigest: completionDigest,
        decisionJson: { decision: 'accepted' },
      });
    };

    makeRun('w2-stale', 1);
    assert.throws(() => store.commitKnowledgeTransaction({
      transactionId: 'w2-stale-tx', runId: 'w2-stale', projectId, expectedRevision: 1,
      records: [{ id: 'w2-forbidden', type: 'semantic_fact', statement: 'unverified data' }],
    }), /STALE_COMPLETION_DECISION/);
    assert.equal(store.getProjectKnowledgeRevision(projectId), 1);
    assert.equal(store.listKnowledgeRecords({ projectId }).length, 0);

    makeRun('w2-valid');
    store.recordKnowledgeReviewReceipt('w2-valid', {
      projectId, status: 'passed', reviewDigest,
      candidateCount: 1, verifiedCount: 1,
    });

    const committed = store.commitKnowledgeTransaction({
      transactionId: 'w2-valid-tx', runId: 'w2-valid', projectId, expectedRevision: 1,
      records: [{
        id: 'w2-record', type: 'semantic_fact', statement: 'verified project knowledge',
        scope: ['src'], trustTier: 'verified',
        knowledgeAuthority: {
          runId: 'forged-run', sourceIdentity: 'forged-source',
          completionDecisionRef: 'forged-proof',
        },
      }],
      provenance: { sourceIdentity: 'unverified-caller-source' },
    });
    assert.equal(committed.status, 'committed');
    assert.equal(store.getProjectKnowledgeRevision(projectId), 2);
    const [record] = store.listKnowledgeRecords({ projectId, statuses: ['committed'] });
    assert.ok(record);
    const authority = record.knowledgeAuthority as Record<string, unknown>;
    assert.equal(authority.runId, 'w2-valid');
    assert.equal(authority.projectId, projectId);
    assert.equal(authority.sourceIdentity, sourceIdentity);
    assert.equal(authority.mutationRevision, 0);
    assert.equal(authority.completionDecisionRef, completionDigest);
    assert.equal(authority.knowledgeReviewRef, reviewDigest);
    assert.match(String(authority.contentDigest), /^sha256:[a-f0-9]{64}$/);

    // Reading retained Knowledge and its revision does not consult Run,
    // Completion Decision or Review receipts.
    const formerGetRun = store.getRun;
    const formerGetCompletion = store.getCompletionDecision;
    try {
      store.getRun = () => { throw new Error('Run history unavailable'); };
      store.getCompletionDecision = () => { throw new Error('Completion history unavailable'); };
      const [retained] = store.listKnowledgeRecords({ projectId, statuses: ['committed'] });
      assert.equal(retained.knowledgeAuthority && (retained.knowledgeAuthority as Record<string, unknown>).completionDecisionRef, completionDigest);
      assert.equal(store.getProjectKnowledgeRevision(projectId), 2);
      assert.throws(() => store.appendKnowledgeEvidence({
        projectId, recordId: 'w2-record', evidenceRefs: ['evidence://new'],
        expectedKnowledgeRevision: 1,
      }), /STALE_KNOWLEDGE_REVISION/);
    } finally {
      store.getRun = formerGetRun;
      store.getCompletionDecision = formerGetCompletion;
    }

    makeRun('w2-supersession');
    const result = store.commitKnowledgeTransaction({
      transactionId: 'w2-supersession-tx', runId: 'w2-supersession',
      projectId, expectedRevision: 2, records: [], supersessions: ['w2-record'],
    });
    assert.equal(result.status, 'committed');
    assert.equal(store.getProjectKnowledgeRevision(projectId), 3);
    const [superseded] = store.listKnowledgeRecords({ projectId, statuses: ['superseded'] });
    assert.equal(superseded.id, 'w2-record');
    assert.equal((superseded.knowledgeAuthority as Record<string, unknown>).completionDecisionRef, completionDigest);
  } finally {
    store.close();
    await rm(runtimeHome, { recursive: true, force: true });
  }
});

test('W2: settled Knowledge replays with no Run, Completion or Review tables; new authority is denied', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-w2-runless-replay-'));
  const projectId = 'w2-runless-project';
  const runId = 'w2-runless-original';
  const sourceIdentity = `sha256:${'a'.repeat(64)}`;
  const store = await openKernelStateStore({ runtimeHome });
  const originalRecords = [{
    id: 'w2-runless-fact', projectId, type: 'semantic_fact',
    statement: 'Knowledge committed while work is active', scope: ['src'],
    trustTier: 'verified',
  }];
  try {
    store.createRun({ runId, projectId, objective: 'settle knowledge before discarding work', sourceIdentity });
    store.recordCompletionDecision(runId, {
      decision: 'accepted', sourceIdentity, mutationRevision: 0,
      evidenceDigest: `sha256:${'b'.repeat(64)}`, decisionJson: { decision: 'accepted' },
    });
    const committed = store.commitKnowledgeTransaction({
      transactionId: 'w2-runless-tx', runId, projectId, expectedRevision: 1,
      records: originalRecords, provenance: { runId },
    });
    assert.equal(committed.status, 'committed');
    assert.equal(store.getProjectKnowledgeRevision(projectId), 2);
    store.createRun({ runId: 'w2-runless-empty', projectId, objective: 'no new Knowledge', sourceIdentity });
    store.recordCompletionDecision('w2-runless-empty', {
      decision: 'accepted', sourceIdentity, mutationRevision: 0,
      evidenceDigest: `sha256:${'c'.repeat(64)}`, decisionJson: { decision: 'accepted' },
    });
    const empty = store.commitKnowledgeTransaction({
      transactionId: 'w2-no-change-tx', runId: 'w2-runless-empty',
      projectId, expectedRevision: 2, records: [], noChange: true,
    });
    assert.equal(empty.status, 'no_change');
  } finally {
    store.close();
  }

  const sourceDb = path.join(runtimeHome, 'state', 'runtime-state.sqlite');
  const isolated = await openSqliteDb(':memory:');
  try {
    const original = await openSqliteDb(sourceDb);
    try {
      const row = original.prepare(
        'SELECT COUNT(*) AS count FROM knowledge_transactions WHERE run_id=?',
      ).get('w2-runless-empty') as { count: number };
      assert.equal(row.count, 0);
    } finally {
      original.close();
    }
    // Only copy the independent Knowledge tables. No runs, completion_decisions,
    // or knowledge_review_receipts tables exist in this database at all.
    isolated.exec(`ATTACH DATABASE '${sourceDb.replaceAll("'", "''")}' AS source;`);
    for (const table of ['knowledge_transactions', 'knowledge_records', 'knowledge_revisions']) {
      isolated.exec(`CREATE TABLE ${table} AS SELECT * FROM source.${table};`);
    }
    isolated.exec('DETACH DATABASE source');
    assert.equal(
      (isolated.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='runs'").get() as { count: number }).count,
      0,
    );
    const readOnlyAuthority = createKnowledgeLifecycleStore({
      db: isolated,
      getRun: () => { throw new Error('NEW_KNOWLEDGE_REQUIRES_ACTIVE_RUN'); },
      getCompletionDecision: () => { throw new Error('COMPLETION_UNAVAILABLE'); },
    });
    const committed = readOnlyAuthority.commitKnowledgeTransaction({
      transactionId: 'w2-runless-tx', runId, projectId,
    });
    assert.equal(committed.status, 'committed');
    assert.equal(committed.replayed, true);
    assert.equal(committed.revisionBefore, '1');
    assert.equal(committed.revisionAfter, '2');
    assert.equal(readOnlyAuthority.listKnowledgeRecords({ projectId, statuses: ['committed'] }).length, 1);
    assert.equal(readOnlyAuthority.getProjectKnowledgeRevision(projectId), 2);

    assert.throws(() => readOnlyAuthority.commitKnowledgeTransaction({
      transactionId: 'w2-runless-tx', runId, projectId,
      records: [{ id: 'unapproved', type: 'semantic_fact', statement: 'forged content' }],
    }), /KNOWLEDGE_TRANSACTION_REPLAY_PAYLOAD_MISMATCH/);
    assert.throws(() => readOnlyAuthority.commitKnowledgeTransaction({
      transactionId: 'w2-runless-tx', runId, projectId: 'other-project',
    }), /KNOWLEDGE_TRANSACTION_IDENTITY_MISMATCH/);
    assert.throws(() => readOnlyAuthority.commitKnowledgeTransaction({
      transactionId: 'w2-runless-tx', runId, projectId, expectedRevision: 99,
    }), /KNOWLEDGE_TRANSACTION_REPLAY_REVISION_MISMATCH/);
    assert.throws(() => readOnlyAuthority.commitKnowledgeTransaction({
      transactionId: 'w2-unsettled-tx', runId, projectId,
      records: originalRecords,
    }), /NEW_KNOWLEDGE_REQUIRES_ACTIVE_RUN/);
    assert.equal(readOnlyAuthority.getProjectKnowledgeRevision(projectId), 2);
    assert.equal(readOnlyAuthority.listKnowledgeRecords({ projectId, statuses: ['committed'] }).length, 1);
  } finally {
    isolated.close();
    await rm(runtimeHome, { recursive: true, force: true });
  }
});
