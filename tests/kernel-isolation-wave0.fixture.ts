import assert from 'node:assert/strict';
import { test } from 'node:test';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createKernelControlPlane } from '../src/host/kernel/control-plane-runtime.js';
import { hydrateKernelProject } from '../src/kernel/project-hydrate.js';
import { openKernelStateStore } from '../src/kernel/state-store.js';
import { resolveKernelProjectIdentity } from '../src/kernel/project-identity.js';

const sourceRoot = path.resolve(process.cwd());

const exists = async (target: string) => {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
};

// Wave 0 deliberately captures assertions that are red on the current
// implementation. Keeping the red assertion inside this helper lets the
// repository test suite record the known defect without making every unrelated
// Kernel verification unusable before Wave 1 changes the authority boundary.
const captureRedAssertion = async (assertion: () => Promise<unknown> | unknown, { label }: { label: string }) => {
  let failure = null;
  try {
    await assertion();
  } catch (error) {
    failure = error;
  }
  assert.ok(failure, `${label}: the isolation assertion unexpectedly passed on the vulnerable baseline`);
  assert.ok(failure && typeof failure === 'object' && 'code' in failure);
  assert.equal(failure.code, 'ERR_ASSERTION');
  return failure;
};

const makeProject = async (prefix: string, name: string) => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), prefix));
  spawnSync('git', ['init'], { cwd: projectRoot, encoding: 'utf8' });
  await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({
    name,
    version: '0.0.1',
    scripts: { 'test:ok': 'node -e "process.exit(0)"' },
  }, null, 2));
  return projectRoot;
};

const makeBoundControlPlane = async ({ runtimeHome, projectRoot, runId, sessionId }: { runtimeHome: string; projectRoot: string; runId: string; sessionId: string }) => {
  const projectId = resolveKernelProjectIdentity({ cwd: projectRoot }).projectId;
  const env = {
    MOON_RELAY_KERNEL_RUN_ID: runId,
    MOON_RELAY_KERNEL_PROJECT_ID: projectId,
    MOON_RELAY_KERNEL_SESSION_ID: sessionId,
  };
  const cp = await createKernelControlPlane({ runtimeHome, projectRoot, holder: sessionId, env, requireHostBinding: true });
  return { cp, env, projectId };
};

test('binding preflight rejects cross-project next without exposing contract data', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-isolation-next-state-'));
  const projectA = await makeProject('kernel-isolation-next-a-', 'private-project-a');
  const projectB = await makeProject('kernel-isolation-next-b-', 'unrelated-project-b');
  const { cp: cpA } = await makeBoundControlPlane({ runtimeHome, projectRoot: projectA, runId: 'project-a-run', sessionId: 'session-a' });
  const { cp: cpB } = await makeBoundControlPlane({ runtimeHome, projectRoot: projectB, runId: 'project-a-run', sessionId: 'session-a' });
  try {
    await cpA.ensureRun({
      runId: 'project-a-run',
      objective: 'PROJECT_A_SECRET_OBJECTIVE',
      taskContract: {
        acceptance: ['PROJECT_A_SECRET_ACCEPTANCE'],
        constraints: ['PROJECT_A_SECRET_CONSTRAINT'],
      },
    });

    const response = await cpB.next('project-a-run');
    assert.deepEqual(response, {
      schemaVersion: 1,
      status: 'error',
      errorCode: 'run_project_mismatch',
    });
    assert.ok(!JSON.stringify(response).includes('PROJECT_A_SECRET'));
  } finally {
    await cpA.close();
    await cpB.close();
    await rm(runtimeHome, { recursive: true, force: true });
    await rm(projectA, { recursive: true, force: true });
    await rm(projectB, { recursive: true, force: true });
  }
});

test('binding preflight rejects cross-project blocker before mutating the foreign run', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-isolation-blocker-state-'));
  const projectA = await makeProject('kernel-isolation-blocker-a-', 'blocker-project-a');
  const projectB = await makeProject('kernel-isolation-blocker-b-', 'blocker-project-b');
  const { cp: cpA } = await makeBoundControlPlane({ runtimeHome, projectRoot: projectA, runId: 'blocker-run-a', sessionId: 'owner-a' });
  const { cp: cpB } = await makeBoundControlPlane({ runtimeHome, projectRoot: projectB, runId: 'blocker-run-a', sessionId: 'owner-a' });
  try {
    await cpA.ensureRun({ runId: 'blocker-run-a', objective: 'private blocker target', taskContract: { acceptance: ['unchanged'] } });
    const before = await cpA.getRun('blocker-run-a');

    const response = await cpB.report('blocker-run-a', {
      blocker: { reason: 'question', detail: 'foreign session must not mutate this run' },
    });
    const after = await cpA.getRun('blocker-run-a');

    assert.ok(after && typeof after === 'object' && 'status' in after);
    assert.ok(after && typeof after === 'object' && 'blockedReason' in after);
    assert.ok(after && typeof after === 'object' && 'revision' in after);
    assert.ok(before && typeof before === 'object' && 'status' in before);
    assert.ok(before && typeof before === 'object' && 'blockedReason' in before);
    assert.ok(before && typeof before === 'object' && 'revision' in before);
    assert.deepEqual(
      { status: after.status, blockedReason: after.blockedReason, revision: after.revision },
      { status: before.status, blockedReason: before.blockedReason, revision: before.revision },
    );
    assert.ok(response && typeof response === 'object' && 'errorCode' in response);
    assert.equal(response.errorCode, 'run_project_mismatch');
  } finally {
    await cpA.close();
    await cpB.close();
    await rm(runtimeHome, { recursive: true, force: true });
    await rm(projectA, { recursive: true, force: true });
    await rm(projectB, { recursive: true, force: true });
  }
});

test('binding preflight rejects cross-project report before observing the caller workspace', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-isolation-report-state-'));
  const projectA = await makeProject('kernel-isolation-report-a-', 'report-project-a');
  const projectB = await makeProject('kernel-isolation-report-b-', 'report-project-b');
  const { cp: cpA } = await makeBoundControlPlane({ runtimeHome, projectRoot: projectA, runId: 'report-run-a', sessionId: 'report-owner-a' });
  const { cp: cpB } = await makeBoundControlPlane({ runtimeHome, projectRoot: projectB, runId: 'report-run-a', sessionId: 'report-owner-a' });
  try {
    await cpA.ensureRun({ runId: 'report-run-a', objective: 'private report target', taskContract: { acceptance: ['unchanged'] } });
    const before = await cpA.getRun('report-run-a');

    const response = await cpB.report('report-run-a', { summary: 'foreign workspace observation' });
    const after = await cpA.getRun('report-run-a');

    assert.ok(after && typeof after === 'object' && 'currentWorkspaceIdentity' in after);
    assert.ok(before && typeof before === 'object' && 'currentWorkspaceIdentity' in before);
    assert.equal(after.currentWorkspaceIdentity, before.currentWorkspaceIdentity);
    assert.ok(response && typeof response === 'object' && 'errorCode' in response);
    assert.equal(response.errorCode, 'run_project_mismatch');
  } finally {
    await cpA.close();
    await cpB.close();
    await rm(runtimeHome, { recursive: true, force: true });
    await rm(projectA, { recursive: true, force: true });
    await rm(projectB, { recursive: true, force: true });
  }
});

test('workspace-level lock permits distinct worktrees in the same project', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-isolation-lock-state-'));
  const store = await openKernelStateStore({ runtimeHome });
  try {
    for (const workspaceId of ['worktree-a', 'worktree-b']) {
      store.registerProjectWorkspace({
        workspaceId,
        identity: { projectId: 'shared-project' },
        canonicalRoot: `C:\\fixtures\\${workspaceId}`,
        gitCommonDir: null,
        gitWorktreeDir: null,
      });
    }
    store.createRun({
      runId: 'run-a',
      objective: 'run-a',
      sourceIdentity: `sha256:${'a'.repeat(64)}`,
      projectId: 'shared-project',
      workspaceId: 'worktree-a',
    });
    store.createRun({
      runId: 'run-b',
      objective: 'run-b',
      sourceIdentity: `sha256:${'b'.repeat(64)}`,
      projectId: 'shared-project',
      workspaceId: 'worktree-b',
    });
    const first = store.acquireWorkspaceMutationLockV2({
      projectId: 'shared-project',
      workspaceId: 'worktree-a',
      runId: 'run-a',
      sessionToken: 'session-a',
    });
    assert.equal(first.acquired, true);

    const second = store.acquireWorkspaceMutationLockV2({
      projectId: 'shared-project',
      workspaceId: 'worktree-b',
      runId: 'run-b',
      sessionToken: 'session-b',
    });
    assert.equal(second.acquired, true);
  } finally {
    store.close();
    await rm(runtimeHome, { recursive: true, force: true });
  }
});

test('legacy project hydration remains an explicit migration fixture, not a launch side effect', async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'kernel-isolation-hydration-'));
  try {
    await hydrateKernelProject({ projectRoot, sourceRoot });
    const forbiddenArtifacts = [
      '.moon-relay',
      '.agents',
      '.codex',
      'AGENTS.override.md',
    ];
    const written: string[] = [];
    for (const relativePath of forbiddenArtifacts) {
      if (await exists(path.join(projectRoot, relativePath))) written.push(relativePath);
    }

    await captureRedAssertion(
      () => assert.deepEqual(written, []),
      { label: 'Kernel launch preparation must leave the project tree unchanged' },
    );
    assert.deepEqual(written, forbiddenArtifacts);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

type KernelControlPlane = Awaited<ReturnType<typeof createKernelControlPlane>>;
