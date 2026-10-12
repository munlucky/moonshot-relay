import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assessCompletionProvenance,
  assertCompletionProvenance,
  CompletionProvenanceError,
} from '../src/kernel/proof/completion-provenance.js';
import {
  executeKernelGitCloseout,
  KernelGitCloseoutError,
} from '../src/kernel/git/closeout.js';
import { createGitCloseoutHost } from '../src/host/kernel/git/closeout-operations.js';

const gitCloseoutHost = createGitCloseoutHost();

const currentRun = () => ({
  runId: 'run-provenance',
  projectId: 'project-provenance',
  workspaceId: 'workspace-provenance',
  sourceIdentity: 'source-provenance',
  mutationRevision: 2,
  currentWorkspaceIdentity: 'workspace-identity-2',
});

const currentCompletion = () => ({
  runId: 'run-provenance',
  decision: 'accepted',
  sourceIdentity: 'source-provenance',
  mutationRevision: 2,
  decisionJson: {
    runId: 'run-provenance',
    decision: 'accepted',
    sourceIdentity: 'source-provenance',
    mutationRevision: 2,
    currentWorkspaceIdentity: 'workspace-identity-2',
  },
});

const currentMutationProvenance = () => ({
  runId: 'run-provenance',
  projectId: 'project-provenance',
  workspaceId: 'workspace-provenance',
  sourceIdentity: 'source-provenance',
  mutationRevision: 2,
  workspaceIdentity: 'workspace-identity-2',
  mutationDigest: 'sha256:current',
  attemptId: 'attempt-2',
});

test('completion provenance accepts completion and mutation authority for the same current revision', () => {
  const assessment = assessCompletionProvenance({
    run: currentRun(),
    completionDecision: currentCompletion(),
    mutationProvenance: currentMutationProvenance(),
  });

  assert.equal(assessment.current, true);
  assert.equal(assessment.mutated, true);
  assert.equal(assessment.mutationRevision, 2);
  assert.deepEqual(assessment.reasons, []);
  assert.doesNotThrow(() => assertCompletionProvenance({
    run: currentRun(),
    completionDecision: currentCompletion(),
    mutationProvenance: currentMutationProvenance(),
  }));
});

test('completion provenance rejects an accepted decision from a stale mutation revision', () => {
  const staleCompletion = {
    ...currentCompletion(),
    mutationRevision: 1,
    decisionJson: {
      ...currentCompletion().decisionJson,
      mutationRevision: 1,
    },
  };

  assert.throws(
    () => assertCompletionProvenance({
      run: currentRun(),
      completionDecision: staleCompletion,
      mutationProvenance: currentMutationProvenance(),
    }),
    (error) => (
      error instanceof CompletionProvenanceError
      && error.code === 'delivery_mutation_revision_stale'
      && error.reasons.includes('completion-mutation-revision-stale')
    ),
  );
});

test('Git closeout rejects stale mutation provenance before staging or Git mutation', async () => {
  const staleMutation = {
    ...currentMutationProvenance(),
    mutationRevision: 1,
    workspaceIdentity: 'workspace-identity-1',
  };
  const stateStore = {
    getRun: () => currentRun(),
    getCompletionDecision: () => currentCompletion(),
    getMutationProvenance: () => staleMutation,
  };

  await assert.rejects(
    () => executeKernelGitCloseout({
      runId: 'run-provenance',
      projectId: 'project-provenance',
      stateStore,
      gitCloseoutRequest: {
        requested: true,
        mode: 'commit',
        approvalReceipt: 'approval-provenance',
      },
      changedFiles: ['must-not-be-staged.txt'],
      gitCloseoutHost,
    }),
    (error) => (
      error instanceof KernelGitCloseoutError
      && error.code === 'delivery_mutation_revision_stale'
      && Array.isArray(error.details?.reasons) && error.details.reasons.includes('mutation-revision-stale')
    ),
  );
});

test('Git closeout accepts current provenance authority before a no-change closeout is skipped', async () => {
  const stateStore = {
    getRun: () => currentRun(),
    getCompletionDecision: () => currentCompletion(),
    getMutationProvenance: () => currentMutationProvenance(),
  };

  const receipt = await executeKernelGitCloseout({
    runId: 'run-provenance',
    projectId: 'project-provenance',
    stateStore,
    gitCloseoutRequest: {
      requested: true,
      mode: 'soft',
      approvalReceipt: 'approval-provenance',
    },
    changedFiles: [],
    gitCloseoutHost,
  });

  assert.equal(receipt.status, 'skipped');
  assert.equal(receipt.reason, 'no_selected_changes');
});
