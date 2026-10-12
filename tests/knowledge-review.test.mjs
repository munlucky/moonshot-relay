import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewKnowledgeCandidates } from '../scripts/kernel/knowledge/candidate-review.js';

test('Knowledge Review binds a candidate to the matching persisted verification', async () => {
  const evidenceDigest = 'sha256:' + 'a'.repeat(64);
  const candidates = [{
    candidateId: 'cand-rev-1',
    proposedType: 'semantic_fact',
    statement: 'Project uses SQLite for runtime persistence',
    evidenceRefs: [evidenceDigest],
  }];

  const res = await reviewKnowledgeCandidates({
    projectId: 'proj-rev-1',
    runId: 'run-rev-1',
    stateStore: {
      listKnowledgeRecords: () => [],
      getVerifications: () => [{
        id: 7,
        obligationId: 'default',
        status: 'passed',
        exitCode: 0,
        evidenceDigest,
        evidenceRef: 'proof://run-rev-1/default',
        sourceIdentity: 'source-review',
        verifiedMutationRevision: 0,
        acceptanceCoverage: [],
      }],
      recordCandidateEvidenceBinding: () => {},
      getKnowledgeApproval: () => null,
    },
    candidates,
  });

  assert.equal(res.status, 'passed');
  assert.equal(res.verifiedCandidates.length, 1);
  assert.equal(res.verifiedCandidates[0].evidenceRefs[0], evidenceDigest);
});
