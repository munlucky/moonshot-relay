import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewKnowledgeCandidates } from '../src/kernel/knowledge/candidate-review.js';

type ReviewStore = NonNullable<NonNullable<Parameters<typeof reviewKnowledgeCandidates>[0]>['stateStore']>;
const reviewStore = (verifications: ReturnType<ReviewStore['getVerifications']> = []): ReviewStore => ({
  ensureRunObligation: () => { throw new Error('unexpected obligation write'); },
  getRunObligations: () => [],
  getRun: () => ({ sourceIdentity: 'source-1', mutationRevision: 0 }),
  listKnowledgeRecords: () => [],
  getVerifications: () => verifications,
  recordCandidateEvidenceBinding: () => {},
  getKnowledgeApproval: () => null,
});

test('reviewKnowledgeCandidates verifies candidates only from persisted verification authority', async () => {
  const result = await reviewKnowledgeCandidates({
    projectId: 'test-proj',
    runId: 'run-1',
    stateStore: reviewStore([{
      id: 1,
      obligationId: 'default',
      status: 'passed',
      exitCode: 0,
      evidenceDigest: 'sha256:' + 'a'.repeat(64),
      evidenceRef: 'proof://run-1/default',
      sourceIdentity: 'source-1',
      verifiedMutationRevision: 0,
      acceptanceCoverage: [],
    }]),
    candidates: [{
      candidateId: 'cand-1',
      runId: 'run-1',
      projectId: 'test-proj',
      proposedType: 'semantic_fact',
      statement: 'Valid verified statement',
      scope: ['scripts/test.mjs'],
      status: 'observed',
    }],
    evidencePack: { status: 'pass', digest: 'legacy-pack-metadata-only' },
  });

  assert.equal(result.status, 'passed');
  assert.equal(result.verifiedCandidates.length, 1);
  assert.equal(result.rejectedCandidates.length, 0);
  assert.ok(result.verifiedCandidates[0].evidenceRefs);
  assert.equal(result.verifiedCandidates[0].evidenceRefs[0], 'sha256:' + 'a'.repeat(64));
});

test('reviewKnowledgeCandidates rejects candidates when persisted verification evidence is missing', async () => {
  const result = await reviewKnowledgeCandidates({
    projectId: 'test-proj',
    runId: 'run-1',
    stateStore: reviewStore([]),
    candidates: [{
      candidateId: 'cand-1',
      runId: 'run-1',
      projectId: 'test-proj',
      proposedType: 'semantic_fact',
      statement: 'Statement without evidence',
      status: 'observed',
    }],
  });

  assert.equal(result.verifiedCandidates.length, 0);
  assert.equal(result.rejectedCandidates.length, 1);
  assert.ok(result.rejectedCandidates[0].rejectionReasons);
  assert.equal(result.rejectedCandidates[0].rejectionReasons[0], 'MISSING_VERIFICATION_EVIDENCE');
});

test('reviewKnowledgeCandidates does not accept evidencePack as authority without a persisted Run', async () => {
  await assert.rejects(
    () => reviewKnowledgeCandidates({
      projectId: 'test-proj',
      runId: 'run-1',
      candidates: [{
        candidateId: 'cand-legacy-pack',
        projectId: 'test-proj',
        proposedType: 'semantic_fact',
        statement: 'Legacy pack must not auto-promote this candidate',
      }],
      evidencePack: { status: 'pass', digest: 'sha256:' + 'b'.repeat(64) },
    }),
    (error) => error instanceof Error && 'code' in error && error.code === 'KNOWLEDGE_REVIEW_AUTHORITY_REQUIRED',
  );
});
