import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolveKernelProjectIdentity } from '../src/kernel/project-identity.js';
import { ensureKnowledgeStoreDirectories } from '../src/kernel/knowledge/store.js';
import { buildProjectKnowledgeContext } from '../src/kernel/knowledge/context-load.js';
import { extractKnowledgeCandidates } from '../src/kernel/knowledge/candidate-extract.js';
import { reviewKnowledgeCandidates } from '../src/kernel/knowledge/candidate-review.js';
import { commitProjectKnowledge } from '../src/kernel/knowledge/commit.js';
import { openKernelStateStore } from '../src/kernel/state-store.js';

test('Full Kernel Project Knowledge Lifecycle E2E Scenario A (load -> prove -> accepted -> commit)', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'kernel-e2e-test-'));
  const env = { MOON_RELAY_KERNEL_HOME: tmp };
  const store = await openKernelStateStore({ runtimeHome: tmp });

  try {
    const identity = resolveKernelProjectIdentity({ cwd: tmp, env });
    const projectId = identity.projectId;
    const runId = 'e2e-run-1';
    const sourceIdentity = 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const proofDigest = 'sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';
    const proofRef = 'proof://e2e-run-1/default';

    await ensureKnowledgeStoreDirectories(projectId, { env });

    const ctx = await buildProjectKnowledgeContext({
      projectId,
      stage: 'FRAME',
      runId,
      stateStore: store,
      env,
    });
    assert.equal(ctx.status, 'ready-empty');
    assert.ok(ctx.digest);

    store.createRun({
      runId,
      objective: 'Implement project knowledge lifecycle',
      sourceIdentity,
      projectId,
      knowledgeRevisionStart: '1',
    });
    store.transition(runId, 'EXECUTE');
    store.transition(runId, 'PROVE');
    store.recordVerification(runId, {
      obligationId: 'default',
      status: 'passed',
      evidenceRef: proofRef,
      sourceIdentity,
      command: 'node --test knowledge-lifecycle',
      exitCode: 0,
      evidenceDigest: proofDigest,
      acceptanceCoverage: [],
    });

    const rawCandidates = extractKnowledgeCandidates({
      runId,
      projectId,
      objective: 'Implement project knowledge lifecycle',
      changedFiles: ['scripts/kernel/knowledge/store.js'],
      evidencePack: { status: 'pass', digest: proofRef },
      observedStatements: ['Verified E2E knowledge lifecycle flow.'],
    });

    for (const candidate of rawCandidates) {
      store.recordKnowledgeCandidate(candidate.candidateId, runId, {
        projectId,
        proposedType: candidate.proposedType || 'semantic_fact',
        status: 'pending',
        candidateJson: candidate,
      });
    }

    const reviewResult = await reviewKnowledgeCandidates({
      runId,
      projectId,
      stateStore: store,
      candidates: rawCandidates,
      evidencePack: { status: 'pass', digest: 'metadata-only' },
    });

    assert.equal(reviewResult.status, 'passed');
    assert.equal(reviewResult.verifiedCandidates.length, 1);
    assert.ok(reviewResult.verifiedCandidates[0].evidenceRefs);
    assert.equal(reviewResult.verifiedCandidates[0].evidenceRefs[0], proofDigest);

    store.recordCompletionDecision(runId, {
      decision: 'accepted',
      sourceIdentity,
      mutationRevision: 0,
      evidenceDigest: proofDigest,
      decisionJson: { decision: 'accepted', sourceIdentity, mutationRevision: 0 },
    });

    const revisionBefore = store.getProjectKnowledgeRevision(projectId);
    const receipt = await commitProjectKnowledge({
      runId,
      projectId,
      stateStore: store,
      expectedKnowledgeRevision: revisionBefore,
      candidates: reviewResult.verifiedCandidates,
      env,
    });

    assert.equal(receipt.status, 'committed');
    assert.equal(receipt.revisionBefore, String(revisionBefore));
    assert.equal(receipt.revisionAfter, String(revisionBefore + 1));
    assert.equal(store.getProjectKnowledgeRevision(projectId), revisionBefore + 1);

    const records = store.listKnowledgeRecords({ projectId, statuses: ['committed'] });
    assert.equal(records.length, 1);
    assert.equal(records[0].statement, 'Verified E2E knowledge lifecycle flow.');
  } finally {
    store.close();
    await rm(tmp, { recursive: true, force: true });
  }
});
