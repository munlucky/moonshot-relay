import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp } from 'node:fs/promises';
import { createKernelControlPlane } from '../src/host/kernel/control-plane-runtime.js';

test('recordProof does not store proof command line as semantic fact knowledge candidate', async () => {
  const tmpHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-proof-cmd-test-'));
  const cp = await createKernelControlPlane({ runtimeHome: tmpHome, projectRoot: process.cwd() });

  const runId = 'proof-cmd-run-1';
  await cp.startRun({
    runId,
    objective: 'Test proof command boundary',
    taskContract: { riskTier: 'T0' },
  });

  await cp.transition(runId, 'EXECUTE');
  await cp.transition(runId, 'PROVE');
  await cp.recordProof(runId, {
    obligationId: 'default',
    status: 'passed',
    evidenceRef: 'ev-1',
    command: 'npm run test:kernel',
    exitCode: 0,
    evidenceDigest: `sha256:${'b'.repeat(64)}`,
  });

  const status = await cp.status(runId);
  assert.ok(status && 'run' in status);
  assert.equal(status.run.state, 'PROVE');

  await cp.close();
});
