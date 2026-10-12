import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import {
  ensureKnowledgeStoreDirectories,
  projectKnowledgeDirectory,
} from '../src/kernel/knowledge/store.js';
import { commitProjectKnowledge, KernelKnowledgeCommitError, type CommitProjectKnowledgeInput } from '../src/kernel/knowledge/commit.js';

test('commitProjectKnowledge rejects write when completion is not accepted', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'kernel-cmt-test-'));
  const env = { MOON_RELAY_KERNEL_HOME: tmp };
  try {
    await ensureKnowledgeStoreDirectories('test-proj', { env });

    const mockBlockedStore: NonNullable<CommitProjectKnowledgeInput['stateStore']> = {
      getKnowledgeCandidates: () => [],
      listKnowledgeRecords: () => [],
      getProjectKnowledgeRevision: () => 0,
      commitKnowledgeTransaction: () => { throw new Error('unexpected transaction'); },
      getRun: () => ({ runId: 'run-1', projectId: 'test-proj', sourceIdentity: 's1', mutationRevision: 1 }),
      getCompletionDecision: () => ({ decision: 'blocked', sourceIdentity: 's1', mutationRevision: 1 }),
    };

    await assert.rejects(
      async () =>
        commitProjectKnowledge({
          runId: 'run-1',
          projectId: 'test-proj',
          stateStore: mockBlockedStore,
          candidates: [{ candidateId: 'c1', status: 'verified', statement: 'Test' }],
          env,
        }),
      KernelKnowledgeCommitError,
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('commitProjectKnowledge performs atomic commit and advances the SQLite revision', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'kernel-cmt-test-'));
  const env = { MOON_RELAY_KERNEL_HOME: tmp };
  try {
    await ensureKnowledgeStoreDirectories('test-proj', { env });

    let rev = 1;
    const mockAcceptedStore = {
      getKnowledgeCandidates: () => [],
      getRun: () => ({ runId: 'run-1', projectId: 'test-proj', sourceIdentity: 's1', mutationRevision: 1 }),
      getCompletionDecision: () => ({ decision: 'accepted', sourceIdentity: 's1', mutationRevision: 1 }),
      getProjectKnowledgeRevision: () => rev,
      listKnowledgeRecords: () => [{
        id: 'c1',
        projectId: 'test-proj',
        type: 'semantic_fact',
        statement: 'Verified commitment',
        status: 'committed',
      }],
      commitKnowledgeTransaction: () => {
        const before = String(rev);
        rev += 1;
        return { revisionBefore: before, revisionAfter: String(rev), status: 'committed' };
      },
    };

    const revisionBefore = mockAcceptedStore.getProjectKnowledgeRevision();
    const receipt = await commitProjectKnowledge({
      runId: 'run-1',
      projectId: 'test-proj',
      stateStore: mockAcceptedStore,
      candidates: [{ candidateId: 'c1', status: 'verified', statement: 'Verified commitment', evidenceRefs: ['ev-1'] }],
      env,
    });

    assert.equal(receipt.status, 'committed');
    assert.equal(receipt.revisionBefore, String(revisionBefore));
    assert.equal(receipt.revisionAfter, '2');
    assert.equal(mockAcceptedStore.getProjectKnowledgeRevision(), 2);

    const projectionManifest = JSON.parse(await readFile(
      path.join(projectKnowledgeDirectory('test-proj', { env }), 'knowledge', 'revision.json'),
      'utf8',
    ));
    assert.equal(projectionManifest.revision, '2');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
