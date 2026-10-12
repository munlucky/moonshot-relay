import test from 'node:test';
import assert from 'node:assert/strict';
import { commitProjectKnowledge } from '../scripts/kernel/knowledge/commit.js';
import { openKernelStateStore } from '../scripts/kernel/state-store.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('Knowledge Commit - performs transactional knowledge commit upon accepted completion', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'mr-test-kn-commit-'));
  const store = await openKernelStateStore({ runtimeHome: tmp });
  try {
    const run = store.createRun({
      runId: 'run-kn-c1',
      objective: 'Knowledge commit test',
      sourceIdentity: 'cand-12345678901234567890123456789012',
      projectId: 'proj-kn-c1',
    });

    store.transition('run-kn-c1', 'EXECUTE');
    store.transition('run-kn-c1', 'PROVE');

    store.recordVerification('run-kn-c1', {
      obligationId: 'default',
      status: 'passed',
      evidenceRef: 'ev-1',
      sourceIdentity: 'cand-12345678901234567890123456789012',
      command: 'npm test',
      exitCode: 0,
      evidenceDigest: 'sha256:' + 'c'.repeat(64),
    });

    store.transition('run-kn-c1', 'CLOSE');

    const completion = store.evaluateCompletion('run-kn-c1');
    store.persistCompletionDecision('run-kn-c1', completion);

    const candidates = [
      {
        candidateId: 'cand-kc-1',
        proposedType: 'semantic_fact',
        statement: 'Verified knowledge item',
        status: 'verified',
        evidenceRefs: ['sha256:' + 'c'.repeat(64)],
      },
    ];

    const receipt = await commitProjectKnowledge({
      runId: 'run-kn-c1',
      projectId: 'proj-kn-c1',
      stateStore: store,
      expectedKnowledgeRevision: run.knowledgeRevisionStart,
      candidates,
      env: { MOON_RELAY_KERNEL_HOME: tmp },
    });

    assert.equal(receipt.status, 'committed');
    assert.equal(receipt.acceptedCandidates.length, 1);
  } finally {
    store.close();
    await rm(tmp, { recursive: true, force: true });
  }
});
