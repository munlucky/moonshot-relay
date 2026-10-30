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
