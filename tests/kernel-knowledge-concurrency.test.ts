import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp } from 'node:fs/promises';
import { ensureKnowledgeStoreDirectories } from '../src/kernel/knowledge/store.js';
import { commitProjectKnowledge, KernelKnowledgeCommitError, type CommitProjectKnowledgeInput } from '../src/kernel/knowledge/commit.js';

test('commitProjectKnowledge rejects concurrent modification when expected revision is stale', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'kernel-occ-test-'));
  const env = { MOON_RELAY_KERNEL_HOME: tmp };
  await ensureKnowledgeStoreDirectories('proj-occ', { env });

  const mockStore: NonNullable<CommitProjectKnowledgeInput['stateStore']> = {
    getKnowledgeCandidates: () => [],
    listKnowledgeRecords: () => [],
    getRun: () => ({ runId: 'run-occ', projectId: 'proj-occ', sourceIdentity: 's1', mutationRevision: 1 }),
    getCompletionDecision: () => ({ decision: 'accepted', sourceIdentity: 's1', mutationRevision: 1 }),
    getProjectKnowledgeRevision: () => 1,
    commitKnowledgeTransaction: ({ expectedRevision }) => {
      if (expectedRevision !== null && expectedRevision !== undefined && String(expectedRevision) !== '1') {
        throw new Error('STALE_KNOWLEDGE_REVISION: expected 1 but found ' + expectedRevision);
      }
      return { revisionBefore: '1', revisionAfter: '2', status: 'committed' };
    },
  };

  // Stale revision '99' vs actual revision '1'
  await assert.rejects(
    async () =>
      commitProjectKnowledge({
        runId: 'run-occ',
        projectId: 'proj-occ',
        stateStore: mockStore,
        expectedKnowledgeRevision: '99',
        candidates: [{ candidateId: 'c1', status: 'verified', statement: 'OCC check', evidenceRefs: ['ev-1'] }],
        env,
      }),
    (err) => err instanceof KernelKnowledgeCommitError && err.code === 'STALE_KNOWLEDGE_REVISION'
  );
});
