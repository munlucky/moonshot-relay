import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveBoundInvocation } from '../scripts/kernel/run/invocation-resolver.mjs';

const run = { runId: 'old', projectId: 'p', worktreeId: 'w', status: 'completed', finalizationStatus: 'completed', currentWorkspaceIdentity: 'old-snapshot', objective: 'old task' };
const resolve = (overrides = {}) => resolveBoundInvocation({
  stateStore: { listRuns: () => [], getLatestRunForWorktree: () => run },
  projectId: 'p', worktreeId: 'w', observedWorkspaceIdentity: 'current-snapshot',
  invocationIntent: 'new-task',
  taskContract: { objective: 'new task', acceptance: ['fresh proof'], workspaceRecovery: { acknowledgedIdentity: 'current-snapshot' } },
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
  assert.equal(resolve({ stateStore: { listRuns: () => [], getLatestRunForWorktree: () => ({ ...run, finalizationStatus: 'pending' }) } }).mode, 'finalization-retry');
});
