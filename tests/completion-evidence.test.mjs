import test from 'node:test';
import assert from 'node:assert/strict';
import { openKernelStateStore } from '../scripts/kernel/state-store.js';
import { evaluateTrustCompletion } from '../scripts/kernel/proof/trust-authority.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('Completion Evidence - requires fresh verification evidence', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'mr-test-comp-ev-'));
  const store = await openKernelStateStore({ runtimeHome: tmp });
  try {
    store.createRun({
      runId: 'run-comp-ev-1',
      objective: 'Test evidence evaluation',
      sourceIdentity: 'cand-12345678901234567890123456789012',
      projectId: 'proj-1',
    });

    store.transition('run-comp-ev-1', 'EXECUTE');
    store.transition('run-comp-ev-1', 'PROVE');

    // Without verification, evaluation should reject completion
    const runSnapshot = store.getRun('run-comp-ev-1');
    assert.ok(runSnapshot);
    const evalRes = evaluateTrustCompletion({
      run: runSnapshot,
      verifications: store.getVerifications('run-comp-ev-1'),
      obligations: store.getRunObligations('run-comp-ev-1'),
      waivers: store.getWaivers('run-comp-ev-1'),
      reviewReceipts: store.listReviewReceipts('run-comp-ev-1'),
      mutationProvenance: store.getMutationProvenance('run-comp-ev-1'),
    });
    assert.notEqual(evalRes.decision, 'accepted');
  } finally {
    store.close();
    await rm(tmp, { recursive: true, force: true });
  }
});
