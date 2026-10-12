import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createKernelFixture, cleanupKernelFixture } from './fixtures/kernel-execution-fixture.js';
import { createKernelControlPlane } from '../src/host/kernel/control-plane-runtime.js';
import { resolveKernelProjectIdentity } from '../src/kernel/project-identity.js';
import { resolveKernelWorktreeIdentity } from '../src/host/kernel/workspace/worktree-resolution.js';

test('Baseline 1: Project identity authority and isolation', async () => {
  const fixtureA = await createKernelFixture('krn-b1-a-');
  const fixtureB = await createKernelFixture('krn-b1-b-');
  try {
    const idA = resolveKernelProjectIdentity({ cwd: fixtureA.projectRoot, env: { MOON_RELAY_KERNEL_HOME: fixtureA.runtimeHome } });
    const idB = resolveKernelProjectIdentity({ cwd: fixtureB.projectRoot, env: { MOON_RELAY_KERNEL_HOME: fixtureB.runtimeHome } });
    assert.notEqual(idA.projectId, idB.projectId, 'Distinct project directories must have distinct project IDs');
  } finally {
    await cleanupKernelFixture(fixtureA);
    await cleanupKernelFixture(fixtureB);
  }
});

test('Baseline 2: Worktree identity binds to canonical git path', async () => {
  const fixture = await createKernelFixture('krn-b2-');
  try {
    const wt = resolveKernelWorktreeIdentity({ cwd: fixture.projectRoot, workspaceRoot: fixture.projectRoot });
    assert.ok(wt.worktreeId, 'Worktree identity must be present');
    assert.equal(typeof wt.worktreeId, 'string');
  } finally {
    await cleanupKernelFixture(fixture);
  }
});

test('Baseline 3: Ordinary implementation does not require external reviewer capability', async () => {
  const fixture = await createKernelFixture('krn-b3-');
  const cp = await createKernelControlPlane(fixture);
  try {
    const runId = 'run-base-ordinary';
    await cp.startRun({
      runId,
      objective: 'ordinary feature without special review',
      taskContract: {
        acceptance: [{
          acceptance: 'basic feature works',
          evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test'] },
        }],
        allowedPaths: ['index.mjs'],
      },
    });
    const nextTurn = await cp.next(runId);
    assert.ok('action' in nextTurn && nextTurn.action);
    assert.equal(nextTurn.action.type, 'implement');
    assert.equal(('review' in nextTurn && nextTurn.review && typeof nextTurn.review === 'object' && 'required' in nextTurn.review && nextTurn.review.required) || false, false);
  } finally {
    await cp.close();
    await cleanupKernelFixture(fixture);
  }
});
