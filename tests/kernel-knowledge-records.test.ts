import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateKnowledgeRecord,
  transitionStatus,
  validateSupersession,
  KernelKnowledgeRecordError,
  KernelKnowledgeTransitionError,
  KernelKnowledgeIsolationError,
} from '../src/kernel/knowledge/records.js';

test('validateKnowledgeRecord accepts valid record fixture', () => {
  const record = {
    id: 'rec-001',
    projectId: 'test-project',
    type: 'semantic_fact',
    statement: 'The API uses snake_case JSON response payloads.',
    status: 'observed',
    trustTier: 'verified',
    createdAt: '2026-07-23T00:00:00.000Z',
  };
  assert.ok(validateKnowledgeRecord(record));
});

test('validateKnowledgeRecord rejects invalid status and missing fields', () => {
  assert.throws(() => validateKnowledgeRecord(null), KernelKnowledgeRecordError);
  assert.throws(() => validateKnowledgeRecord({ id: 'rec-1' }), KernelKnowledgeRecordError);
  assert.throws(
    () =>
      validateKnowledgeRecord({
        id: 'rec-1',
        projectId: 'proj',
        type: 'semantic_fact',
        status: 'invalid_status',
        trustTier: 'verified',
        createdAt: '2026-07-23T00:00:00.000Z',
      }),
    KernelKnowledgeRecordError
  );
});

test('transitionStatus enforces valid status transitions and evidence rules', () => {
  const record = {
    id: 'rec-001',
    projectId: 'test-project',
    type: 'semantic_fact',
    statement: 'Sample statement',
    status: 'observed',
    trustTier: 'verified',
    createdAt: '2026-07-23T00:00:00.000Z',
  };

  const staged = transitionStatus(record, 'staged');
  assert.equal(staged.status, 'staged');

  // verified transition requires evidence for semantic_fact
  assert.throws(() => transitionStatus(staged, 'verified'), KernelKnowledgeTransitionError);

  const verified = transitionStatus(staged, 'verified', { evidence: { testRun: 'pass' } });
  assert.equal(verified.status, 'verified');
  assert.deepEqual(verified.evidence, { testRun: 'pass' });

  // forbidden transition
  assert.throws(() => transitionStatus(verified, 'observed'), KernelKnowledgeTransitionError);
});

test('validateSupersession rejects cross-project supersession and cycles', () => {
  const recA = {
    id: 'rec-a',
    projectId: 'proj-1',
    type: 'semantic_fact',
    statement: 'A',
    status: 'committed',
    trustTier: 'verified',
    createdAt: '2026-07-23T00:00:00.000Z',
    supersedes: ['rec-b'],
  };
  const recB = {
    id: 'rec-b',
    projectId: 'proj-2',
    type: 'semantic_fact',
    statement: 'B',
    status: 'superseded',
    trustTier: 'verified',
    createdAt: '2026-07-23T00:00:00.000Z',
  };

  assert.throws(() => validateSupersession([recA, recB], 'rec-b', 'rec-a'), KernelKnowledgeIsolationError);
});
