import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertBoundRunAccess } from '../src/kernel/run/binding-preflight.js';
import { normalizeSessionBinding } from '../src/kernel/run/session-binding.js';
import { openKernelStateStore } from '../src/kernel/state-store.js';

const sourceIdentity = `sha256:${'e'.repeat(64)}`;

type TestStore = Awaited<ReturnType<typeof openKernelStateStore>>;
const register = (store: TestStore, projectId: string, workspaceId: string) => store.registerProjectWorkspace({
  workspaceId,
  identity: { projectId },
  canonicalRoot: `C:\\fixtures\\${workspaceId}`,
  gitCommonDir: null,
  gitWorktreeDir: null,
});

const createRun = (store: TestStore, runId: string, projectId: string, workspaceId: string) => store.createRun({
  runId,
  objective: runId,
  sourceIdentity,
  projectId,
  workspaceId,
});

test('workspace mutation locks allow different worktrees and fence the same checkout', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-workspace-lock-'));
  const store = await openKernelStateStore({ runtimeHome });
  try {
    register(store, 'project-1', 'workspace-a');
    register(store, 'project-1', 'workspace-b');
    createRun(store, 'run-1', 'project-1', 'workspace-a');
    createRun(store, 'run-2', 'project-1', 'workspace-b');
    assert.throws(
      () => createRun(store, 'run-3', 'project-1', 'workspace-a'),
      (error) => error instanceof Error && 'code' in error && error.code === 'worktree_run_conflict',
    );
    const first = store.acquireWorkspaceMutationLockV2({ workspaceId: 'workspace-a', projectId: 'project-1', runId: 'run-1', sessionToken: 'session-1', ttlMs: 60000 });
    assert.equal(first.acquired, true);
    const parallel = store.acquireWorkspaceMutationLockV2({ workspaceId: 'workspace-b', projectId: 'project-1', runId: 'run-2', sessionToken: 'session-2', ttlMs: 60000 });
    assert.equal(parallel.acquired, true);
    const blocked = store.acquireWorkspaceMutationLockV2({ workspaceId: 'workspace-a', projectId: 'project-1', runId: 'run-1', sessionToken: 'session-3', ttlMs: 60000 });
    assert.equal(blocked.acquired, false);
    assert.equal(blocked.lock.holderRunId, 'run-1');
    assert.throws(
      () => store.releaseWorkspaceMutationLockV2({
        workspaceId: 'workspace-a',
        runId: 'run-1',
        sessionToken: 'session-1',
        fencingToken: first.lock.fencingToken + 1,
      }),
      (error) => error instanceof Error && 'code' in error && error.code === 'workspace_lock_handoff_failed',
    );
    assert.equal(store.releaseWorkspaceMutationLockV2({
      workspaceId: 'workspace-a',
      runId: 'run-1',
      sessionToken: 'session-1',
      fencingToken: first.lock.fencingToken,
    }).released, true);
    assert.equal(store.getWorkspaceMutationLockV2('workspace-a'), null);
  } finally {
    store.close();
    await rm(runtimeHome, { recursive: true, force: true });
  }
});

test('reviewer and read-only bindings may share an owner workspace but cannot mutate its Run', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-workspace-reviewers-'));
  const store = await openKernelStateStore({ runtimeHome });
  const projectId = 'project-review';
  const workspaceId = 'workspace-review';
  try {
    register(store, projectId, workspaceId);
    createRun(store, 'run-review', projectId, workspaceId);
    for (const [accessMode, sessionId] of [
      ['owner', 'codex:owner'],
      ['reviewer', 'claude:reviewer'],
      ['read_only', 'codex:reader'],
    ]) {
      store.createSessionBinding(normalizeSessionBinding({
        bindingId: `binding-${accessMode}`,
        provider: sessionId.split(':')[0],
        sessionId,
        runId: 'run-review',
        projectId,
        workspaceId,
        accessMode,
      }));
    }

    for (const sessionId of ['claude:reviewer', 'codex:reader']) {
      assert.equal(assertBoundRunAccess({
        stateStore: store,
        requestedRunId: 'run-review',
        currentProject: { projectId },
        currentWorkspace: workspaceId,
        sessionId,
        requiredAccess: 'status',
      }).accessMode === 'owner', false);
      assert.throws(
        () => assertBoundRunAccess({
          stateStore: store,
          requestedRunId: 'run-review',
          currentProject: { projectId },
          currentWorkspace: workspaceId,
          sessionId,
          requiredAccess: 'next',
        }),
        (error) => error instanceof Error && 'code' in error && error.code === 'run_access_denied',
      );
    }
  } finally {
    store.close();
    await rm(runtimeHome, { recursive: true, force: true });
  }
});
