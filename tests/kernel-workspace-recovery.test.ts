import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createFinalizationIncompleteError,
  resolveBoundInvocation,
} from '../src/kernel/run/invocation-resolver.js';
import { normalizeTaskContract } from '../src/kernel/task/task-contract.js';

const run = { runId: 'old', projectId: 'p', worktreeId: 'w', status: 'completed', finalizationStatus: 'completed', currentWorkspaceIdentity: 'old-snapshot', objective: 'old task' };
const recoveryContract = normalizeTaskContract({
  objective: 'new task',
  acceptance: ['fresh proof'],
  workspaceRecovery: { acknowledgedIdentity: 'current-snapshot' },
});
const resolve = (overrides: Partial<Parameters<typeof resolveBoundInvocation>[0]> = {}) => resolveBoundInvocation({
  stateStore: { getRun: () => run, listRuns: () => [], getLatestRunForWorktree: () => run },
  projectId: 'p', worktreeId: 'w', observedWorkspaceIdentity: 'current-snapshot',
  invocationIntent: 'new-task',
  taskContract: recoveryContract,
  ...overrides,
});
test('acknowledged changed workspace creates fresh run without altering predecessor evidence', () => {
  assert.equal(resolve().mode, 'create');
  assert.equal(resolve().predecessorRunId, null);
  assert.equal(run.currentWorkspaceIdentity, 'old-snapshot');
});
test('stale acknowledgement, missing intent and unfinished finalization cannot reset baseline', () => {
  assert.equal(resolve({ observedWorkspaceIdentity: 'changed-again' }).mode, 'successor');
  assert.equal(resolve({ invocationIntent: null }).mode, 'successor');
  assert.equal(resolve({ stateStore: { getRun: () => run, listRuns: () => [], getLatestRunForWorktree: () => ({ ...run, finalizationStatus: 'pending' }) } }).mode, 'finalization-retry');
});

test('unrecoverable blocked/incomplete_gates finalization recovers cleanly with workspaceRecovery even after identity refresh', () => {
  const blockedRefreshedRun = {
    ...run,
    finalizationStatus: 'blocked',
    mutationRevision: 3,
    currentWorkspaceIdentity: 'current-snapshot',
  };
  const blockedStore = {
    getRun: () => blockedRefreshedRun,
    listRuns: () => [],
    getLatestRunForWorktree: () => blockedRefreshedRun,
    getFinalizationReceipt: () => ({ finalizationStatus: 'incomplete_gates' }),
    getCompletionDecision: () => ({ decision: 'accepted', mutationRevision: 1 }),
  };

  const recovered = resolve({ stateStore: blockedStore });
  assert.equal(recovered.mode, 'create');
  assert.equal(recovered.predecessorRunId, null);
  assert.equal(recovered.reason, 'user-acknowledged-new-workspace-baseline-after-blocked-finalization');

  // Without recovery acknowledgement (or without new-task intent), surface explicit recovery remediation.
  const withoutRecovery = resolve({
    stateStore: blockedStore,
    taskContract: normalizeTaskContract({ objective: 'new task', acceptance: ['fresh proof'] }),
  });
  assert.equal(withoutRecovery.mode, 'finalization-retry');
  assert.equal(withoutRecovery.finalizationRecovery?.unrecoverable, true);
  const blockedError = createFinalizationIncompleteError(withoutRecovery) as Error & {
    nextAction?: string;
    details?: {
      remediation?: {
        abandonCommand?: string;
        workspaceRecovery?: { acknowledgedIdentity?: string; invocationIntent?: string } | null;
      };
    };
  };
  assert.equal(blockedError.nextAction, 'abandon-or-recover-workspace-baseline');
  assert.equal(blockedError.details?.remediation?.abandonCommand, 'kernel abandon --run-id old --reason external-workspace-change');
  assert.deepEqual(blockedError.details?.remediation?.workspaceRecovery, {
    invocationIntent: 'new-task',
    acknowledgedIdentity: 'current-snapshot',
  });

  // Stale acknowledgement or missing new-task intent still fails closed.
  const staleAck = resolve({ stateStore: blockedStore, observedWorkspaceIdentity: 'other-snapshot' });
  assert.equal(staleAck.mode, 'finalization-retry');
  const missingIntent = resolve({ stateStore: blockedStore, invocationIntent: null });
  assert.equal(missingIntent.mode, 'finalization-retry');

  // Pending/partial finalization without unrecoverable receipt stays retry-finalization.
  const pendingResolution = resolve({
    stateStore: {
      getRun: () => ({ ...run, finalizationStatus: 'pending' }),
      listRuns: () => [],
      getLatestRunForWorktree: () => ({ ...run, finalizationStatus: 'pending' }),
      getFinalizationReceipt: () => null,
      getCompletionDecision: () => null,
    },
    taskContract: normalizeTaskContract({ objective: 'new task', acceptance: ['fresh proof'] }),
  });
  assert.equal(pendingResolution.mode, 'finalization-retry');
  assert.equal(createFinalizationIncompleteError(pendingResolution).nextAction, 'retry-finalization');
});

test('mismatched completion mutationRevision treats finalization as unrecoverable for workspaceRecovery', () => {
  const driftedRun = {
    ...run,
    finalizationStatus: 'partial',
    mutationRevision: 2,
    currentWorkspaceIdentity: 'current-snapshot',
  };
  const recovered = resolve({
    stateStore: {
      getRun: () => driftedRun,
      listRuns: () => [],
      getLatestRunForWorktree: () => driftedRun,
      getFinalizationReceipt: () => ({ finalizationStatus: 'partial' }),
      getCompletionDecision: () => ({ decision: 'accepted', mutationRevision: 1 }),
    },
  });
  assert.equal(recovered.mode, 'create');
  assert.equal(recovered.predecessorRunId, null);
});
