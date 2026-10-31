import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { openKernelStateStore } from '../src/kernel/state-store.js';

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
