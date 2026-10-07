import { prepareTestHostTurn } from './helpers/kernel-host-test-api.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createKernelControlPlane } from '../scripts/kernel/control-plane.mjs';

const makeTmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-fencing-test-'));

test('assertMutationAllowed enforces strict fail-closed fencing logic', async () => {
  const tmpDir = makeTmpDir();
  const runtimeHome = path.join(tmpDir, 'runtime');
  const projectRoot = path.join(tmpDir, 'project');
  fs.mkdirSync(projectRoot, { recursive: true });

  const cp = await createKernelControlPlane({ runtimeHome, projectRoot });

  const run = await cp.startRun({
    runId: 'run-fencing-1',
    objective: 'Fencing guard test',
  });

  const step = cp.getCurrentStep('run-fencing-1');
  const capsule = await cp.buildCapsule('run-fencing-1', { role: 'implementer' });

  // 1. Lock missing
  assert.throws(
    () => cp.assertMutationAllowed({
      runId: 'run-fencing-1',
      stepId: step.stepId,
      capsuleId: capsule.capsuleId,
      operation: 'file_write',
      targetPaths: ['test.js'],
      fencingToken: 1,
      sessionToken: 'sess-1',
    }),
    (err) => err.code === 'workspace_mutation_lock_missing',
  );

  // Acquire lock with valid hostCapabilities
  const hostRes = await prepareTestHostTurn(cp, 'run-fencing-1', {
    hostCapabilities: { surface: 'cli' },
    actionContext: { actionKind: 'implement' },
  });
  const lock = hostRes.hostDirective.mutationLock;
  assert.ok(lock);

  // 2. FencingToken missing
  assert.throws(
    () => cp.assertMutationAllowed({
      runId: 'run-fencing-1',
      stepId: step.stepId,
      capsuleId: capsule.capsuleId,
      operation: 'file_write',
      targetPaths: ['test.js'],
      fencingToken: null,
      sessionToken: lock.sessionToken,
    }),
    (err) => err.code === 'mutation_fence_credentials_missing',
  );

  // 3. SessionToken missing
  assert.throws(
    () => cp.assertMutationAllowed({
      runId: 'run-fencing-1',
      stepId: step.stepId,
      capsuleId: capsule.capsuleId,
      operation: 'file_write',
      targetPaths: ['test.js'],
      fencingToken: lock.fencingToken,
      sessionToken: null,
    }),
    (err) => err.code === 'mutation_fence_credentials_missing',
  );

  // 4. Same run, wrong session token
  assert.throws(
    () => cp.assertMutationAllowed({
      runId: 'run-fencing-1',
      stepId: step.stepId,
      capsuleId: capsule.capsuleId,
      operation: 'file_write',
      targetPaths: ['test.js'],
      fencingToken: lock.fencingToken,
      sessionToken: 'wrong-session',
    }),
    (err) => err.code === 'workspace_mutation_fence_mismatch',
  );

  // 5. Wrong fencing token
  assert.throws(
    () => cp.assertMutationAllowed({
      runId: 'run-fencing-1',
      stepId: step.stepId,
      capsuleId: capsule.capsuleId,
      operation: 'file_write',
      targetPaths: ['test.js'],
      fencingToken: 9999,
      sessionToken: lock.sessionToken,
    }),
    (err) => err.code === 'workspace_mutation_fence_mismatch',
  );

  // 6. Valid credentials pass
  const allowed = cp.assertMutationAllowed({
    runId: 'run-fencing-1',
    stepId: step.stepId,
    capsuleId: capsule.capsuleId,
    operation: 'file_write',
    targetPaths: ['test.js'],
    fencingToken: lock.fencingToken,
    sessionToken: lock.sessionToken,
  });
  assert.equal(allowed.allowed, true);

  await cp.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
