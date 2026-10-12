import test from 'node:test';
import assert from 'node:assert/strict';
import { createKernelControlPlane } from '../scripts/host/kernel/control-plane-runtime.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('Completion Runtime - assesses kernel runtime completion decision', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'mr-test-comp-rt-'));
  const plane = await createKernelControlPlane({ runtimeHome: tmp });
  try {
    const run = await plane.startRun({
      runId: 'run-comp-rt-1',
      objective: 'Runtime completion test',
    });

    await plane.transition('run-comp-rt-1', 'EXECUTE');
    await plane.transition('run-comp-rt-1', 'PROVE');

    await plane.recordProof('run-comp-rt-1', {
      obligationId: 'default',
      status: 'passed',
      evidenceRef: 'ev-1',
      command: 'npm test',
      exitCode: 0,
      evidenceDigest: 'sha256:' + 'b'.repeat(64),
    });

    await plane.transition('run-comp-rt-1', 'CLOSE');

    const completion = await plane.assessCompletion('run-comp-rt-1');
    assert.equal(completion.decision, 'accepted');
  } finally {
    await plane.close();
    await rm(tmp, { recursive: true, force: true });
  }
});
