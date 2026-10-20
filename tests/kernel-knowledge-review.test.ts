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

test('W3: explicit lesson binds to current persisted verification by evidence and obligation identity', async () => {
  const digest = 'sha256:' + 'c'.repeat(64);
  const result = await reviewKnowledgeCandidates({
    projectId: 'test-proj',
    runId: 'run-1',
    stateStore: reviewStore([{
      id: 7,
      obligationId: 'prompt-eval',
      status: 'passed',
      exitCode: 0,
      evidenceDigest: digest,
      evidenceRef: 'evidence://proof/prompt-eval',
      sourceIdentity: 'source-1',
      verifiedMutationRevision: 0,
      acceptanceCoverage: ['AC-prompt-quality'],
    }]),
    candidates: [{
      candidateId: 'cand-useful-lesson',
      runId: 'run-1',
      projectId: 'test-proj',
      proposedType: 'semantic_fact',
      statement: 'Prompt changes must preserve quality and scope compliance.',
      scope: ['src/host/**'],
      evidenceRefs: [],
      acceptanceIds: ['AC-prompt-quality'],
      obligationIds: ['prompt-eval'],
      status: 'observed',
      sourceKind: 'explicit',
    }],
  });

  assert.equal(result.status, 'passed');
  assert.equal(result.verifiedCandidates.length, 1);
  assert.deepEqual(result.verifiedCandidates[0].evidenceRefs, [digest]);
  assert.equal(result.verifiedCandidates[0].evidenceBinding?.verificationId, 7);
});

test('W3: arbitrary artifact path is not verification authority even when a passed proof exists', async () => {
  const result = await reviewKnowledgeCandidates({
    projectId: 'test-proj',
    runId: 'run-1',
    stateStore: reviewStore([{
      id: 8,
      obligationId: 'prompt-eval',
      status: 'passed',
      exitCode: 0,
      evidenceDigest: 'sha256:' + 'd'.repeat(64),
      evidenceRef: 'evidence://proof/prompt-eval',
      sourceIdentity: 'source-1',
      verifiedMutationRevision: 0,
      acceptanceCoverage: ['AC-prompt-quality'],
    }]),
    candidates: [{
      candidateId: 'cand-temp-artifact',
      runId: 'run-1',
      projectId: 'test-proj',
      proposedType: 'semantic_fact',
      statement: 'A local comparison report exists.',
      scope: ['src/host/**'],
      evidenceRefs: ['C:/Temp/prompt-eval/comparison.json'],
      acceptanceIds: ['AC-prompt-quality'],
      obligationIds: ['prompt-eval'],
      status: 'observed',
      sourceKind: 'explicit',
    }],
  });

  assert.equal(result.verifiedCandidates.length, 0);
  assert.equal(result.rejectedCandidates.length, 1);
  assert.deepEqual(result.rejectedCandidates[0].rejectionReasons, ['MISSING_VERIFICATION_EVIDENCE']);
});

test('W3: stale verification source or mutation cannot authorize Knowledge review', async () => {
  for (const verification of [
    {
      id: 9,
      obligationId: 'default',
      status: 'passed',
      exitCode: 0,
      evidenceDigest: 'sha256:' + 'e'.repeat(64),
      evidenceRef: 'proof://run-1/default',
      sourceIdentity: 'stale-source',
      verifiedMutationRevision: 0,
      acceptanceCoverage: [],
    },
    {
      id: 10,
      obligationId: 'default',
      status: 'passed',
      exitCode: 0,
      evidenceDigest: 'sha256:' + 'f'.repeat(64),
      evidenceRef: 'proof://run-1/default',
      sourceIdentity: 'source-1',
      verifiedMutationRevision: 1,
      acceptanceCoverage: [],
    },
  ]) {
    const result = await reviewKnowledgeCandidates({
      projectId: 'test-proj',
      runId: 'run-1',
      stateStore: reviewStore([verification]),
      candidates: [{
        candidateId: `cand-stale-${verification.id}`,
        runId: 'run-1',
        projectId: 'test-proj',
        proposedType: 'semantic_fact',
        statement: 'Stale proof must not verify this lesson.',
        scope: ['scripts/test.mjs'],
        status: 'observed',
      }],
    });

    assert.equal(result.verifiedCandidates.length, 0);
    assert.deepEqual(result.rejectedCandidates[0].rejectionReasons, ['MISSING_VERIFICATION_EVIDENCE']);
  }
});

test('W3: evidenceBinding evidenceRefs participate in the same exact verification matcher', async () => {
  const digest = 'sha256:' + '1'.repeat(64);
  const result = await reviewKnowledgeCandidates({
    projectId: 'test-proj',
    runId: 'run-1',
    stateStore: reviewStore([{
      id: 11,
      obligationId: 'default',
      status: 'passed',
      exitCode: 0,
      evidenceDigest: digest,
      evidenceRef: 'proof://run-1/bound',
      sourceIdentity: 'source-1',
      verifiedMutationRevision: 0,
      acceptanceCoverage: [],
    }]),
    candidates: [{
      candidateId: 'cand-bound-ref',
      runId: 'run-1',
      projectId: 'test-proj',
      proposedType: 'semantic_fact',
      statement: 'Bound evidence ref is authoritative only through persisted verification.',
      scope: ['scripts/test.mjs'],
      evidenceBinding: { evidenceRefs: ['proof://run-1/bound'] },
      status: 'observed',
    }],
  });

  assert.equal(result.verifiedCandidates.length, 1);
  assert.deepEqual(result.verifiedCandidates[0].evidenceRefs, [digest]);
});

test('W3: source digest alone cannot replace persisted verification authority', async () => {
  const result = await reviewKnowledgeCandidates({
    projectId: 'test-proj',
    runId: 'run-1',
    stateStore: reviewStore([]),
    candidates: [{
      candidateId: 'cand-source-digest-only',
      runId: 'run-1',
      projectId: 'test-proj',
      proposedType: 'semantic_fact',
      statement: 'An arbitrary source digest must not become verification evidence.',
      scope: ['scripts/test.mjs'],
      sourceDigest: 'sha256:' + '2'.repeat(64),
      status: 'observed',
      sourceKind: 'explicit',
    }],
  });

  assert.equal(result.verifiedCandidates.length, 0);
  assert.equal(result.rejectedCandidates.length, 1);
  assert.deepEqual(result.rejectedCandidates[0].rejectionReasons, ['MISSING_VERIFICATION_EVIDENCE']);
});
