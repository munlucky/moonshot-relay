import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createKernelControlPlane } from '../src/host/kernel/control-plane-runtime.js';

const makeTmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-stage-k-test-'));

test('transition materializes target stage knowledge fail-closed and updates next() context', async () => {
  const tmpDir = makeTmpDir();
  const runtimeHome = path.join(tmpDir, 'runtime');
  const projectRoot = path.join(tmpDir, 'project');
  fs.mkdirSync(projectRoot, { recursive: true });

  const cp = await createKernelControlPlane({ runtimeHome, projectRoot });

  const run = await cp.startRun({
    runId: 'run-stage-1',
    objective: 'Stage knowledge transition test',
  });

  // Initial stage is FRAME
  assert.equal(run.state, 'FRAME');
  const frameNext = await cp.next('run-stage-1');
  assert.ok(frameNext);

  // Transition to EXECUTE
  await cp.transition('run-stage-1', 'EXECUTE');
  const executeRun = await cp.getRun('run-stage-1');
  assert.ok(executeRun);
  assert.equal(executeRun.state, 'EXECUTE');

  // next() after transition must reflect EXECUTE stage context receipt
  const executeNext = await cp.next('run-stage-1');
  assert.ok(executeNext);

  // Transition to PROVE
  await cp.transition('run-stage-1', 'PROVE');
  const proveRun = await cp.getRun('run-stage-1');
  assert.ok(proveRun);
  assert.equal(proveRun.state, 'PROVE');

  const proveNext = await cp.next('run-stage-1');
  assert.ok(proveNext);

  await cp.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('transition fails closed when stage knowledge materialization fails', async () => {
  const tmpDir = makeTmpDir();
  const runtimeHome = path.join(tmpDir, 'runtime');
  const projectRoot = path.join(tmpDir, 'project');
  fs.mkdirSync(projectRoot, { recursive: true });

  const cp = await createKernelControlPlane({ runtimeHome, projectRoot });

  await cp.startRun({
    runId: 'run-stage-fail',
    objective: 'Stage knowledge failure test',
  });

  // Inject invalid stage to force materialization failure
  await assert.rejects(
    async () => {
      await Reflect.apply(cp.transition, cp, ['run-stage-fail', 'INVALID_STAGE_NAME']);
    },
  );

  // State should remain unchanged (FRAME)
  const run = await cp.getRun('run-stage-fail');
  assert.ok(run);
  assert.equal(run.state, 'FRAME');

  await cp.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
