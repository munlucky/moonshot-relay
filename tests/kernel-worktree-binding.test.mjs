import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  assertRunWorktreeBinding,
  deriveKernelWorktreeId,
  registerKernelWorktreeBinding,
  resolveKernelWorktreeIdentity,
  validateRunWorktreeBinding,
} from '../scripts/kernel/run/worktree-binding.mjs';
import { resolveBoundInvocation } from '../scripts/kernel/run/invocation-resolver.mjs';
import { openKernelStateStore, kernelDbPath } from '../scripts/kernel/state-store.mjs';
import { openSqliteDb } from '../scripts/kernel/sqlite-adapter.mjs';
import { normalizeTaskContract } from '../scripts/kernel/task/task-contract.mjs';

const runGit = (cwd, args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
};

const kernelEnv = (runtimeHome, overrides = {}) => ({
  ...process.env,
  MOON_RELAY_KERNEL_HOME: runtimeHome,
  MOONSHOT_RELAY_HOME: path.join(path.dirname(runtimeHome), 'relay-home'),
  ...overrides,
});

const createRepository = async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'kernel-worktree-binding-'));
  const repository = path.join(fixtureRoot, 'repository');
  const linkedWorktree = path.join(fixtureRoot, 'linked-worktree');
  const runtimeHome = path.join(fixtureRoot, 'kernel-home');
  await mkdir(path.join(repository, '.moon-relay'), { recursive: true });
  await writeFile(path.join(repository, '.moon-relay', 'project.identity.yaml'), 'projectId: stable-worktree-project\n');
  await writeFile(path.join(repository, 'tracked.txt'), 'fixture\n');
  runGit(repository, ['init']);
  runGit(repository, ['branch', '-m', 'main']);
  runGit(repository, ['config', 'user.email', 'kernel-test@example.invalid']);
  runGit(repository, ['config', 'user.name', 'Kernel Test']);
  runGit(repository, ['add', '.']);
  runGit(repository, ['commit', '-m', 'fixture']);
  runGit(repository, ['worktree', 'add', '-b', 'linked', linkedWorktree, 'HEAD']);
  return { fixtureRoot, repository, linkedWorktree, runtimeHome };
};

test('S-07: recreated worktree metadata preserves user index, diff, untracked bytes and fences the old session', async () => {
  const fixture = await createRepository();
  let store = await openKernelStateStore({ runtimeHome: fixture.runtimeHome });
  try {
    const root = fixture.linkedWorktree;
    await writeFile(path.join(root, 'tracked.txt'), 'staged user content\n');
    runGit(root, ['add', 'tracked.txt']);
    await writeFile(path.join(root, 'tracked.txt'), 'unstaged user content\n');
    await writeFile(path.join(root, 'private.txt'), 'untracked user content\n');
    const before = resolveKernelWorktreeIdentity({ cwd: root, env: kernelEnv(fixture.runtimeHome) });
    const staged = runGit(root, ['diff', '--cached', '--binary']);
    const unstaged = runGit(root, ['diff', '--binary']);
    const index = await readFile(path.join(before.canonicalGitDir, 'index'));
    registerKernelWorktreeBinding({ stateStore: store, cwd: root, env: kernelEnv(fixture.runtimeHome) });
    store.createRun({ runId: 'recreated', sourceIdentity: 'source-recreated', projectId: before.projectId, workspaceId: before.workspaceId, worktreeId: before.worktreeId, objective: 'preserve user work' });
    const first = store.acquireWorkspaceMutationLockV2({ workspaceId: before.workspaceId, projectId: before.projectId, runId: 'recreated', sessionToken: 'old-session', ttlMs: 60000 });
    assert.equal(first.acquired, true);
    // Recreate only Git's worktree attachment. User data and the shared index
    // stay intact; the official repair operation restores the lost gitfile.
    await rm(path.join(root, '.git'));
    await writeFile(path.join(root, '.git'), `gitdir: ${before.canonicalGitDir.replaceAll('\\', '/')}\n`);
    runGit(fixture.repository, ['worktree', 'repair', root]);
    const after = resolveKernelWorktreeIdentity({ cwd: root, env: kernelEnv(fixture.runtimeHome) });
    assert.equal(after.worktreeId, before.worktreeId);
    assert.equal(after.workspaceId, before.workspaceId);
    assert.equal(runGit(root, ['diff', '--cached', '--binary']), staged);
    assert.equal(runGit(root, ['diff', '--binary']), unstaged);
    assert.deepEqual(await readFile(path.join(after.canonicalGitDir, 'index')), index);
    assert.equal(await readFile(path.join(root, 'private.txt'), 'utf8'), 'untracked user content\n');
    store.releaseWorkspaceMutationLockV2({ workspaceId: before.workspaceId, runId: 'recreated', sessionToken: 'old-session', fencingToken: first.lock.fencingToken });
    store.close();
    store = await openKernelStateStore({ runtimeHome: fixture.runtimeHome });
    const fresh = store.acquireWorkspaceMutationLockV2({ workspaceId: after.workspaceId, projectId: after.projectId, runId: 'recreated', sessionToken: 'new-session', ttlMs: 60000 });
    assert.equal(fresh.acquired, true);
    assert.ok(fresh.lock.fencingToken > first.lock.fencingToken);
    assert.throws(() => store.releaseWorkspaceMutationLockV2({ workspaceId: before.workspaceId, runId: 'recreated', sessionToken: 'old-session', fencingToken: first.lock.fencingToken }), /workspace_lock_handoff_failed/);
    assert.equal(store.getWorktreeMutationLease(after.worktreeId).holderRunId, 'recreated');
  } finally { store.close(); await rm(fixture.fixtureRoot, { recursive: true, force: true }); }
});

test('worktree identity is stable across HEAD, branch, provider, and session changes', async () => {
  const fixture = await createRepository();
  try {
    const first = resolveKernelWorktreeIdentity({
      cwd: fixture.repository,
      env: kernelEnv(fixture.runtimeHome, {
        MOON_RELAY_KERNEL_PROVIDER: 'codex',
        MOON_RELAY_KERNEL_SESSION_ID: 'codex:first-session',
      }),
    });

    runGit(fixture.repository, ['branch', '-m', 'renamed-main']);
    runGit(fixture.repository, ['commit', '--allow-empty', '-m', 'move head']);

    const afterMutation = resolveKernelWorktreeIdentity({
      cwd: fixture.repository,
      env: kernelEnv(fixture.runtimeHome, {
        MOON_RELAY_KERNEL_PROVIDER: 'claude',
        MOON_RELAY_KERNEL_SESSION_ID: 'claude:second-session',
      }),
    });

    assert.equal(afterMutation.projectId, first.projectId);
    assert.equal(afterMutation.worktreeId, first.worktreeId);
    assert.equal(afterMutation.workspaceId, first.workspaceId);
    assert.equal(
      first.worktreeId,
      deriveKernelWorktreeId({
        projectId: first.projectId,
        canonicalWorktreeRoot: first.canonicalWorktreeRoot,
        canonicalGitDir: first.canonicalGitDir,
      }),
    );
    assert.equal('provider' in first, false);
    assert.equal('sessionId' in first, false);
  } finally {
    await rm(fixture.fixtureRoot, { recursive: true, force: true });
  }
});

test('linked worktrees share project identity but receive distinct deterministic worktree identities', async () => {
  const fixture = await createRepository();
  try {
    const primary = resolveKernelWorktreeIdentity({
      cwd: fixture.repository,
      env: kernelEnv(fixture.runtimeHome),
    });
    const linked = resolveKernelWorktreeIdentity({
      cwd: fixture.linkedWorktree,
      env: kernelEnv(fixture.runtimeHome),
    });

    assert.equal(linked.projectId, primary.projectId);
    assert.equal(linked.gitCommonDir, primary.gitCommonDir);
    assert.notEqual(linked.canonicalWorktreeRoot, primary.canonicalWorktreeRoot);
    assert.notEqual(linked.canonicalGitDir, primary.canonicalGitDir);
    assert.notEqual(linked.worktreeId, primary.worktreeId);
    assert.notEqual(linked.workspaceId, primary.workspaceId);
  } finally {
    await rm(fixture.fixtureRoot, { recursive: true, force: true });
  }
});

test('registration reuses the workspace registry and Run binding validation supports new and legacy fields', async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'kernel-worktree-registration-'));
  const workspaceRoot = path.join(fixtureRoot, 'workspace');
  const runtimeHome = path.join(fixtureRoot, 'kernel-home');
  await mkdir(path.join(workspaceRoot, '.moon-relay'), { recursive: true });
  await writeFile(path.join(workspaceRoot, '.moon-relay', 'project.identity.yaml'), 'projectId: registration-project\n');
  let registeredInput = null;
  const stateStore = {
    registerProjectWorkspace(workspace) {
      registeredInput = workspace;
      return workspace;
    },
  };

  try {
    const worktree = registerKernelWorktreeBinding({
      stateStore,
      cwd: workspaceRoot,
      env: kernelEnv(runtimeHome),
    });

    assert.equal(registeredInput.workspaceId, worktree.workspaceId);
    assert.equal(registeredInput.identity.projectId, worktree.projectId);
    assert.deepEqual(assertRunWorktreeBinding({
      run: {
        runId: 'run-new',
        projectId: worktree.projectId,
        worktreeId: worktree.worktreeId,
        workspaceId: worktree.workspaceId,
      },
      worktree,
    }), {
      valid: true,
      runId: 'run-new',
      projectId: worktree.projectId,
      worktreeId: worktree.worktreeId,
      workspaceId: worktree.workspaceId,
      bindingAuthority: 'worktreeId',
    });
    assert.equal(assertRunWorktreeBinding({
      run: { runId: 'run-legacy', projectId: worktree.projectId, workspaceId: worktree.workspaceId },
      projectId: worktree.projectId,
      worktreeId: worktree.worktreeId,
      workspaceId: worktree.workspaceId,
    }).bindingAuthority, 'workspaceId');

    assert.equal(validateRunWorktreeBinding({
      run: { runId: 'wrong-project', projectId: 'another-project', worktreeId: worktree.worktreeId },
      worktree,
    }).errorCode, 'run_project_mismatch');
    assert.equal(validateRunWorktreeBinding({
      run: { runId: 'wrong-worktree', projectId: worktree.projectId, worktreeId: 'worktree-other' },
      worktree,
    }).errorCode, 'run_worktree_mismatch');
    assert.equal(validateRunWorktreeBinding({
      run: { runId: 'wrong-workspace', projectId: worktree.projectId, workspaceId: 'workspace-other' },
      worktree,
    }).errorCode, 'run_workspace_mismatch');
    assert.equal(validateRunWorktreeBinding({
      run: { runId: 'unbound', projectId: worktree.projectId },
      worktree,
    }).errorCode, 'run_worktree_unbound');
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

const createBoundRun = (store, runId, worktree, taskContract = null) => store.createRun({
  runId,
  objective: taskContract?.objective || runId,
  sourceIdentity: `source-${runId}`,
  projectId: worktree.projectId,
  workspaceId: worktree.workspaceId,
  worktreeId: worktree.worktreeId,
  taskContract,
});

test('a worktree mutation lease survives reopen, rejects a second mutable Run atomically, and releases only at terminal state', async () => {
  const fixture = await createRepository();
  let store = await openKernelStateStore({ runtimeHome: fixture.runtimeHome });
  try {
    const worktree = registerKernelWorktreeBinding({
      stateStore: store,
      cwd: fixture.repository,
      env: kernelEnv(fixture.runtimeHome),
    });
    createBoundRun(store, 'run-lease-a', worktree);
    assert.equal(store.getWorktreeMutationLease(worktree.worktreeId).holderRunId, 'run-lease-a');
    store.close();

    store = await openKernelStateStore({ runtimeHome: fixture.runtimeHome });
    assert.throws(
      () => resolveBoundInvocation({
        stateStore: store,
        projectId: worktree.projectId,
        provider: 'codex',
        sessionId: 'codex:new-task-session',
        workspaceId: worktree.workspaceId,
        worktreeId: worktree.worktreeId,
        taskContract: {
          objective: 'independent active task',
          acceptance: ['independent active task completes'],
          invocationIntent: 'new-task',
        },
      }),
      (error) => {
        assert.equal(error.code, 'worktree_run_conflict');
        assert.equal(error.details.reason, 'new-task-cannot-revise-mutable-run');
        assert.equal(error.details.holderRunId, 'run-lease-a');
        assert.equal(error.details.holder.status, 'active');
        return true;
      },
    );
    assert.throws(
      () => createBoundRun(store, 'run-lease-b', worktree),
      (error) => error.code === 'worktree_run_conflict',
    );
    assert.equal(store.getRun('run-lease-b'), null);

    store.markRunBlocked('run-lease-a', 'question');
    assert.equal(store.getWorktreeMutationLease(worktree.worktreeId).holderRunId, 'run-lease-a');
    assert.throws(
      () => createBoundRun(store, 'run-lease-b', worktree),
      (error) => error.code === 'worktree_run_conflict',
    );
    const blockedResume = resolveBoundInvocation({
      stateStore: store,
      projectId: worktree.projectId,
      provider: 'claude',
      sessionId: 'claude:replacement-session',
      workspaceId: worktree.workspaceId,
      worktreeId: worktree.worktreeId,
    });
    assert.equal(blockedResume.mode, 'resume');
    assert.equal(blockedResume.runId, 'run-lease-a');

    // A new-task invocation against a blocked run automatically supersedes and archives it
    const newTask = resolveBoundInvocation({
      stateStore: store,
      projectId: worktree.projectId,
      provider: 'codex',
      sessionId: 'codex:new-task-session',
      workspaceId: worktree.workspaceId,
      worktreeId: worktree.worktreeId,
      taskContract: {
        objective: 'independent blocked task',
        acceptance: ['independent blocked task completes'],
        invocationIntent: 'new-task',
      },
    });
    assert.equal(newTask.mode, 'create');
    assert.equal(newTask.reason, 'new-run-after-abandon');
    assert.equal(store.getRun('run-lease-a').status, 'abandoned');
    assert.equal(store.getWorktreeMutationLease(worktree.worktreeId), null);

    createBoundRun(store, 'run-lease-b', worktree);
    assert.equal(store.getWorktreeMutationLease(worktree.worktreeId).holderRunId, 'run-lease-b');
  } finally {
    store?.close();
    await rm(fixture.fixtureRoot, { recursive: true, force: true });
  }
});

test('unleased historical blocked Runs do not conflict with the current active worktree Run', async () => {
  const fixture = await createRepository();
  const store = await openKernelStateStore({ runtimeHome: fixture.runtimeHome });
  try {
    const worktree = registerKernelWorktreeBinding({ stateStore: store, cwd: fixture.repository, env: kernelEnv(fixture.runtimeHome) });
    createBoundRun(store, 'run-historical-blocked', worktree);
    store.markRunBlocked('run-historical-blocked', 'question');

    const raw = await openSqliteDb(kernelDbPath(fixture.runtimeHome));
    raw.prepare('DELETE FROM worktree_mutation_leases WHERE worktree_id=?').run(worktree.worktreeId);
    raw.close();

    const newTask = resolveBoundInvocation({
      stateStore: store,
      projectId: worktree.projectId,
      provider: 'codex',
      sessionId: 'codex:new-task-session',
      workspaceId: worktree.workspaceId,
      worktreeId: worktree.worktreeId,
      taskContract: {
        objective: 'new task after historical blocker',
        acceptance: ['new task starts independently'],
        invocationIntent: 'new-task',
      },
    });
    assert.equal(newTask.mode, 'create');

    createBoundRun(store, 'run-current-active', worktree);
    assert.equal(store.getWorktreeMutationLease(worktree.worktreeId).holderRunId, 'run-current-active');
    const resolved = resolveBoundInvocation({
      stateStore: store,
      projectId: worktree.projectId,
      provider: 'codex',
      sessionId: 'codex:replacement-session',
      workspaceId: worktree.workspaceId,
      worktreeId: worktree.worktreeId,
    });
    assert.equal(resolved.mode, 'resume');
    assert.equal(resolved.runId, 'run-current-active');
  } finally {
    store.close();
    await rm(fixture.fixtureRoot, { recursive: true, force: true });
  }
});

test('linked worktrees hold independent mutable Runs and invocation resumes by worktree instead of actor session', async () => {
  const fixture = await createRepository();
  const store = await openKernelStateStore({ runtimeHome: fixture.runtimeHome });
  try {
    const primary = registerKernelWorktreeBinding({ stateStore: store, cwd: fixture.repository, env: kernelEnv(fixture.runtimeHome) });
    const linked = registerKernelWorktreeBinding({ stateStore: store, cwd: fixture.linkedWorktree, env: kernelEnv(fixture.runtimeHome) });
    const contract = normalizeTaskContract({ objective: 'bound work', acceptance: ['bound work completes'] });
    createBoundRun(store, 'run-primary', primary, contract);

    const resumed = resolveBoundInvocation({
      stateStore: store,
      projectId: primary.projectId,
      provider: 'claude',
      sessionId: 'claude:replacement-session',
      workspaceId: primary.workspaceId,
      worktreeId: primary.worktreeId,
      taskContract: contract,
    });
    assert.equal(resumed.mode, 'resume');
    assert.equal(resumed.runId, 'run-primary');
    assert.throws(
      () => resolveBoundInvocation({
        stateStore: store,
        projectId: primary.projectId,
        provider: 'codex',
        sessionId: 'codex:another-session',
        workspaceId: primary.workspaceId,
        worktreeId: primary.worktreeId,
        explicitRunId: 'run-second-primary',
        taskContract: contract,
      }),
      (error) => error.code === 'worktree_run_conflict',
    );

    const independent = resolveBoundInvocation({
      stateStore: store,
      projectId: linked.projectId,
      provider: 'codex',
      sessionId: 'codex:another-session',
      workspaceId: linked.workspaceId,
      worktreeId: linked.worktreeId,
      taskContract: contract,
    });
    assert.equal(independent.mode, 'create');
    createBoundRun(store, independent.runId, linked, contract);
    assert.equal(store.getWorktreeMutationLease(primary.worktreeId).holderRunId, 'run-primary');
    assert.equal(store.getWorktreeMutationLease(linked.worktreeId).holderRunId, independent.runId);
  } finally {
    store.close();
    await rm(fixture.fixtureRoot, { recursive: true, force: true });
  }
});

test('legacy workspaceId-only Runs migrate to authoritative worktreeId and acquire an unambiguous lease', async () => {
  const fixture = await createRepository();
  let store = await openKernelStateStore({ runtimeHome: fixture.runtimeHome });
  try {
    const worktree = registerKernelWorktreeBinding({ stateStore: store, cwd: fixture.repository, env: kernelEnv(fixture.runtimeHome) });
    createBoundRun(store, 'run-legacy-workspace', worktree);
    store.close();

    const raw = await openSqliteDb(kernelDbPath(fixture.runtimeHome));
    raw.prepare(`UPDATE runs SET worktree_id=NULL WHERE run_id=?`).run('run-legacy-workspace');
    raw.prepare(`DELETE FROM worktree_mutation_leases WHERE holder_run_id=?`).run('run-legacy-workspace');
    raw.close();

    store = await openKernelStateStore({ runtimeHome: fixture.runtimeHome });
    const migrated = store.getRun('run-legacy-workspace');
    assert.equal(migrated.workspaceId, worktree.workspaceId);
    assert.equal(migrated.worktreeId, worktree.worktreeId);
    assert.equal(store.getWorktreeMutationLease(worktree.worktreeId).holderRunId, migrated.runId);
  } finally {
    store?.close();
    await rm(fixture.fixtureRoot, { recursive: true, force: true });
  }
});

test('legacy duplicate active Runs preserve history and fail closed without a worktree lease', async () => {
  const fixture = await createRepository();
  let store = await openKernelStateStore({ runtimeHome: fixture.runtimeHome });
  try {
    const worktree = registerKernelWorktreeBinding({ stateStore: store, cwd: fixture.repository, env: kernelEnv(fixture.runtimeHome) });
    createBoundRun(store, 'run-legacy-older', worktree);
    const older = store.getRun('run-legacy-older');
    store.persistCompletionDecision('run-legacy-older', {
      decision: 'accepted',
      digest: `sha256:${'b'.repeat(64)}`,
      run: older,
      decisionPayload: { decision: 'accepted' },
    });
    createBoundRun(store, 'run-legacy-newer', worktree);
    store.close();

    const raw = await openSqliteDb(kernelDbPath(fixture.runtimeHome));
    raw.prepare(`UPDATE runs SET status='active', updated_at=? WHERE run_id=?`)
      .run('2026-01-01T00:00:00.000Z', 'run-legacy-older');
    raw.prepare(`UPDATE runs SET updated_at=? WHERE run_id=?`)
      .run('2026-01-02T00:00:00.000Z', 'run-legacy-newer');
    raw.prepare(`DELETE FROM worktree_mutation_leases WHERE worktree_id=?`).run(worktree.worktreeId);
    raw.close();

    store = await openKernelStateStore({ runtimeHome: fixture.runtimeHome });
    assert.equal(store.listActiveRuns({ projectId: worktree.projectId, worktreeId: worktree.worktreeId }).length, 2);
    assert.equal(store.getWorktreeMutationLease(worktree.worktreeId), null);
    assert.throws(
      () => resolveBoundInvocation({
        stateStore: store,
        projectId: worktree.projectId,
        provider: 'codex',
        sessionId: 'codex:replacement',
        workspaceId: worktree.workspaceId,
        worktreeId: worktree.worktreeId,
      }),
      (error) => error.code === 'worktree_run_conflict',
    );
  } finally {
    store?.close();
    await rm(fixture.fixtureRoot, { recursive: true, force: true });
  }
});
