import test from 'node:test';
import assert from 'node:assert/strict';
import { commitProjectKnowledge, KernelKnowledgeCommitError, type CommitProjectKnowledgeInput } from '../src/kernel/knowledge/commit.js';

test('commitProjectKnowledge fails closed when completion is not accepted or OCC revision mismatches', async () => {
  const mockBlockedStore: NonNullable<CommitProjectKnowledgeInput['stateStore']> = {
    getProjectKnowledgeRevision: () => 0,
    commitKnowledgeTransaction: () => { throw new Error('unexpected transaction'); },
    getKnowledgeCandidates: () => [],
    listKnowledgeRecords: () => [],
    getRun: () => ({ runId: 'run-gate-1', projectId: 'test-project', sourceIdentity: 'source-1', mutationRevision: 1 }),
    getCompletionDecision: () => ({ decision: 'blocked', sourceIdentity: 'source-1', mutationRevision: 1 }),
  };

  // Test 1: Fail closed when completion is blocked
  await assert.rejects(
    async () =>
      commitProjectKnowledge({
        runId: 'run-gate-1',
        projectId: 'test-project',
        stateStore: mockBlockedStore,
      }),
    (err) => err instanceof KernelKnowledgeCommitError && err.code === 'COMPLETION_NOT_ACCEPTED'
  );

  const mockAcceptedStore: NonNullable<CommitProjectKnowledgeInput['stateStore']> = {
    getKnowledgeCandidates: () => [],
    listKnowledgeRecords: () => [],
    getRun: () => ({ runId: 'run-gate-2', projectId: 'test-project', sourceIdentity: 'source-2', mutationRevision: 1 }),
    getCompletionDecision: () => ({ decision: 'accepted', sourceIdentity: 'source-2', mutationRevision: 1 }),
    getProjectKnowledgeRevision: () => 1,
    commitKnowledgeTransaction: ({ expectedRevision }) => {
      if (expectedRevision !== null && expectedRevision !== undefined && String(expectedRevision) !== '1') {
        throw new Error('STALE_KNOWLEDGE_REVISION: expected 1 but found ' + expectedRevision);
      }
      return { revisionBefore: '1', revisionAfter: '2', status: 'committed' };
    },
  };

  // Test 2: Reject STALE_KNOWLEDGE_REVISION when OCC revision mismatches
  await assert.rejects(
    async () =>
      commitProjectKnowledge({
        runId: 'run-gate-2',
        projectId: 'test-project',
        stateStore: mockAcceptedStore,
        expectedKnowledgeRevision: '9999', // Mismatched revision
        candidates: [{ candidateId: 'c1', status: 'verified', statement: 'Test statement' }],
      }),
    (err) => err instanceof KernelKnowledgeCommitError && err.code === 'STALE_KNOWLEDGE_REVISION'
  );
});
