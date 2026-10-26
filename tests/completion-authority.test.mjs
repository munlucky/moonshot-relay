import test from 'node:test';
import assert from 'node:assert/strict';
import { openKernelStateStore } from '../scripts/kernel/state-store.js';
import { evaluateTrustCompletion } from '../scripts/kernel/proof/trust-authority.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('Completion Authority - verifies single completion authority in SQLite', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'mr-test-comp-auth-'));
  const store = await openKernelStateStore({ runtimeHome: tmp });
  try {
    const run = store.createRun({
      runId: 'run-comp-1',
      objective: 'Test completion authority',
      sourceIdentity: 'cand-12345678901234567890123456789012',
      projectId: 'proj-1',
    });

    store.transition('run-comp-1', 'EXECUTE');
    store.transition('run-comp-1', 'PROVE');

    store.recordVerification('run-comp-1', {
      obligationId: 'default',
      status: 'passed',
      evidenceRef: 'ev-1',
      sourceIdentity: 'cand-12345678901234567890123456789012',
      command: 'npm test',
      exitCode: 0,
      evidenceDigest: 'sha256:' + 'a'.repeat(64),
    });

    store.transition('run-comp-1', 'CLOSE');

    const runSnapshot = store.getRun('run-comp-1');
    assert.ok(runSnapshot);
    const evalRes = evaluateTrustCompletion({
      run: runSnapshot,
      verifications: store.getVerifications('run-comp-1'),
      obligations: store.getRunObligations('run-comp-1'),
      waivers: store.getWaivers('run-comp-1'),
      reviewReceipts: store.listReviewReceipts('run-comp-1'),
      mutationProvenance: store.getMutationProvenance('run-comp-1'),
    });
    assert.equal(evalRes.decision, 'accepted');

    const persisted = store.persistCompletionDecision('run-comp-1', evalRes);
    assert.equal(persisted.status, 'completed');
  } finally {
    store.close();
    await rm(tmp, { recursive: true, force: true });
  }
});
