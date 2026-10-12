import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFeedbackCorrectionPlan,
  classifyFeedbackRootCause,
  type FeedbackRootCause,
  type FeedbackSignal,
} from '../src/kernel/knowledge/candidate-extract.js';
import {
  reviewKnowledgeCandidates,
} from '../src/kernel/knowledge/candidate-review.js';
import { improvementPairApprovalRef } from '../src/kernel/knowledge/improvement-pair.js';

const classification = (
  signal: FeedbackSignal,
  {
    feedbackId = `feedback-${signal}`,
    sourceIdentity = 'feedback://source-1',
    sourceRevision = 'revision-1',
  }: {
    feedbackId?: string;
    sourceIdentity?: string;
    sourceRevision?: string;
  } = {},
) => classifyFeedbackRootCause({
  feedbackId,
  sourceIdentity,
  sourceRevision,
  evidence: [{
    signal,
    origin: 'user_instruction',
    role: 'primary',
    evidenceRefs: [`evidence://${signal}`],
  }],
});

test('C20: gap and one-off classifications map only to bounded existing candidate types', () => {
  const cases: Array<{
    signal: FeedbackSignal;
    cause: FeedbackRootCause;
    type: string;
  }> = [
    {
      signal: 'missing_knowledge',
      cause: 'knowledge_gap',
      type: 'semantic_fact',
    },
    {
      signal: 'missing_procedure',
      cause: 'procedure_gap',
      type: 'episodic_observation',
    },
    {
      signal: 'missing_verification',
      cause: 'verification_gap',
      type: 'required_verification',
    },
    {
      signal: 'isolated_occurrence',
      cause: 'one_off',
      type: 'episodic_observation',
    },
  ];

  for (const item of cases) {
    const plan = buildFeedbackCorrectionPlan({
      projectId: 'project-a',
      statement: `Correction for ${item.cause}`,
      scope: ['src/auth/service.ts'],
      classification: classification(item.signal),
    });

    assert.equal(plan.action, 'candidate');
    assert.equal(plan.candidates.length, 1);
    assert.equal(plan.candidates[0]?.proposedType, item.type);
    assert.equal(plan.candidates[0]?.status, 'observed');
    assert.equal(plan.candidates[0]?.trustTier, 'derived');
    assert.equal(plan.candidates[0]?.correctionIntent, item.cause);
  }
});

test('C20: ambiguity requires confirmation and known failure reuses only one in-scope same-project record', () => {
  const ambiguous = buildFeedbackCorrectionPlan({
    projectId: 'project-a',
    statement: 'Unclear correction.',
    scope: ['src/auth/service.ts'],
    classification: classifyFeedbackRootCause({
      feedbackId: 'ambiguous',
      sourceIdentity: 'feedback://source-2',
      sourceRevision: 1,
      evidence: [],
    }),
  });
  assert.equal(ambiguous.action, 'needs_confirmation');
  assert.deepEqual(ambiguous.candidates, []);

  const knownFailure = buildFeedbackCorrectionPlan({
    projectId: 'project-a',
    statement: 'This failure was seen again.',
    scope: ['src/auth/service.ts'],
    classification: classification('known_failure_match'),
    relatedRecordIds: ['failure-local', 'failure-foreign'],
    existingRecords: [
      {
        id: 'failure-local',
        projectId: 'project-a',
        type: 'known_failure_pattern',
        status: 'committed',
        scope: ['src/auth/**'],
      },
      {
        id: 'failure-foreign',
        projectId: 'project-b',
        type: 'known_failure_pattern',
        status: 'committed',
        scope: ['src/auth/**'],
      },
    ],
  });

  assert.equal(knownFailure.action, 'reuse_existing');
  assert.deepEqual(knownFailure.reuseRecordIds, ['failure-local']);
  assert.deepEqual(knownFailure.candidates, []);

  const outOfScope = buildFeedbackCorrectionPlan({
    projectId: 'project-a',
    statement: 'Known failure mention outside its scope.',
    scope: ['src/billing/service.ts'],
    classification: classification('known_failure_match'),
    relatedRecordIds: ['failure-local'],
    existingRecords: [{
      id: 'failure-local',
      projectId: 'project-a',
      type: 'known_failure_pattern',
      status: 'committed',
      scope: ['src/auth/**'],
    }],
  });
  assert.equal(outOfScope.action, 'needs_confirmation');
});

test('C20: stale knowledge creates one in-scope same-project supersession candidate and rejects unsafe targets', () => {
  const stale = classification('stale_knowledge');
  const valid = buildFeedbackCorrectionPlan({
    projectId: 'project-a',
    statement: 'Auth timeout is now 10 seconds.',
    scope: ['src/auth/config.ts'],
    classification: stale,
    relatedRecordIds: ['fact-old'],
    existingRecords: [{
      id: 'fact-old',
      projectId: 'project-a',
      type: 'semantic_fact',
      status: 'committed',
      scope: ['src/auth/**'],
    }],
  });

  assert.equal(valid.action, 'candidate');
  assert.equal(valid.candidates.length, 1);
  assert.deepEqual(valid.candidates[0]?.supersedes, ['fact-old']);
  assert.equal(valid.candidates[0]?.proposedType, 'semantic_fact');

  for (const existingRecords of [
    [{
      id: 'fact-old',
      projectId: 'project-b',
      type: 'semantic_fact',
      status: 'committed',
      scope: ['src/auth/**'],
    }],
    [{
      id: 'fact-old',
      projectId: 'project-a',
      type: 'semantic_fact',
      status: 'committed',
      scope: ['src/billing/**'],
    }],
  ]) {
    const unsafe = buildFeedbackCorrectionPlan({
      projectId: 'project-a',
      statement: 'Auth timeout is now 10 seconds.',
      scope: ['src/auth/config.ts'],
      classification: stale,
      relatedRecordIds: ['fact-old'],
      existingRecords,
    });
    assert.equal(unsafe.action, 'needs_confirmation');
    assert.deepEqual(unsafe.candidates, []);
  }
});

test('C20: same feedback source and revision yields the same candidate identity without duplicate semantics', () => {
  const firstClassification = classification('missing_knowledge', {
    feedbackId: 'message-a',
    sourceIdentity: 'feedback://same-source',
    sourceRevision: 'revision-7',
  });
  const secondClassification = classification('missing_knowledge', {
    feedbackId: 'message-b',
    sourceIdentity: 'feedback://same-source',
    sourceRevision: 'revision-7',
  });

  const input = {
    projectId: 'project-a',
    statement: 'The API timeout is 10 seconds.',
    scope: ['src/api/client.ts'],
  };
  const first = buildFeedbackCorrectionPlan({
    ...input,
    classification: firstClassification,
  });
  const second = buildFeedbackCorrectionPlan({
    ...input,
    classification: secondClassification,
  });

  assert.notEqual(
    firstClassification.feedbackIdentity,
    secondClassification.feedbackIdentity,
  );
  assert.equal(
    first.candidates[0]?.candidateId,
    second.candidates[0]?.candidateId,
  );
});

type ReviewStore = NonNullable<
  NonNullable<Parameters<typeof reviewKnowledgeCandidates>[0]>['stateStore']
>;

const staleReviewStore = ({
  records,
  verifications,
  approvalCandidateId = null,
  approvalReceipt = null,
}: {
  records: ReturnType<ReviewStore['listKnowledgeRecords']>;
  verifications: ReturnType<ReviewStore['getVerifications']>;
  approvalCandidateId?: string | null;
  approvalReceipt?: string | null;
}): ReviewStore => ({
  listKnowledgeRecords: () => records,
  getKnowledgeApproval: () => approvalCandidateId && approvalReceipt
    ? {
        candidateId: approvalCandidateId,
        approvedBy: 'owner://auth',
        approvalReceipt,
      }
    : null,
  ensureRunObligation: () => { throw new Error('unexpected obligation write'); },
  getRunObligations: () => [],
  getVerifications: () => verifications,
  recordCandidateEvidenceBinding: () => {},
  getRun: () => ({ sourceIdentity: 'source-run', mutationRevision: 0 }),
});

test('C20: stale supersession proposal appears only after existing review verification passes', async () => {
  const proofDigest = `sha256:${'a'.repeat(64)}`;
  const plan = buildFeedbackCorrectionPlan({
    projectId: 'project-a',
    statement: 'Auth timeout is now 10 seconds.',
    scope: ['src/auth/config.ts'],
    classification: classification('stale_knowledge'),
    relatedRecordIds: ['fact-old'],
    existingRecords: [{
      id: 'fact-old',
      projectId: 'project-a',
      type: 'semantic_fact',
      status: 'committed',
      scope: ['src/auth/**'],
    }],
    replayCandidate: {
      candidateId: 'replay-auth-timeout',
      projectId: 'project-a',
      sourceRevision: 'revision-1',
      scope: ['src/auth/config.ts'],
      evidenceRefs: [proofDigest],
      obligationIds: ['feedback-regression'],
    },
    scopeOwner: {
      owner: 'owner://auth',
      sourceRevision: 'revision-1',
      scope: ['src/auth/config.ts'],
    },
    rollback: {
      strategy: 'restore prior auth timeout knowledge',
      targetIds: ['fact-old'],
      evidenceRefs: ['rollback://auth-timeout'],
    },
  });
  const candidate = plan.candidates[0];
  assert.ok(candidate);

  const currentRecords = [{
    id: 'fact-old',
    projectId: 'project-a',
    type: 'semantic_fact',
    status: 'committed',
    scope: ['src/auth/**'],
  }];

  const withoutProof = await reviewKnowledgeCandidates({
    projectId: 'project-a',
    runId: 'run-no-proof',
    stateStore: staleReviewStore({
      records: currentRecords,
      verifications: [],
      approvalCandidateId: candidate.candidateId,
      approvalReceipt: improvementPairApprovalRef(
        candidate.improvementPair,
      ),
    }),
    candidates: [candidate],
  });
  assert.equal(withoutProof.verifiedCandidates.length, 0);
  assert.equal(withoutProof.pendingVerificationCandidates.length, 1);
  assert.deepEqual(withoutProof.supersessionProposals, []);

  const withProof = await reviewKnowledgeCandidates({
    projectId: 'project-a',
    runId: 'run-with-proof',
    stateStore: staleReviewStore({
      records: currentRecords,
      verifications: [{
        id: 1,
        obligationId: 'feedback-regression',
        status: 'passed',
        exitCode: 0,
        evidenceDigest: proofDigest,
        evidenceRef: 'evidence://stale_knowledge',
        sourceIdentity: 'source-run',
        verifiedMutationRevision: 0,
        acceptanceCoverage: [],
      }],
      approvalCandidateId: candidate.candidateId,
      approvalReceipt: improvementPairApprovalRef(
        candidate.improvementPair,
      ),
    }),
    candidates: [candidate],
  });

  assert.equal(withProof.status, 'passed');
  assert.equal(withProof.verifiedCandidates.length, 1);
  assert.deepEqual(withProof.supersessionProposals, [{
    targetId: 'fact-old',
    supersedingId: candidate.candidateId,
    reason: 'verified_feedback_stale_knowledge',
  }]);
});

test('C20: forged stale supersession cannot cross project or scope boundaries', async () => {
  const proofDigest = `sha256:${'b'.repeat(64)}`;
  const base = {
    candidateId: 'cand-forged-stale',
    projectId: 'project-a',
    proposedType: 'semantic_fact',
    statement: 'Forged stale correction.',
    scope: ['src/auth/config.ts'],
    status: 'observed',
    sourceKind: 'feedback',
    sourceDigest: proofDigest,
    supersedes: ['fact-old'],
    feedbackClassification: {
      primary: 'stale_knowledge',
    },
  };

  for (const {
    target,
    reason,
  } of [
    {
      target: {
        id: 'fact-old',
        projectId: 'project-b',
        type: 'semantic_fact',
        status: 'committed',
        scope: ['src/auth/**'],
      },
      reason: 'SUPERSESSION_PROJECT_MISMATCH',
    },
    {
      target: {
        id: 'fact-old',
        projectId: 'project-a',
        type: 'semantic_fact',
        status: 'committed',
        scope: ['src/billing/**'],
      },
      reason: 'SUPERSESSION_SCOPE_MISMATCH',
    },
  ]) {
    const result = await reviewKnowledgeCandidates({
      projectId: 'project-a',
      runId: `run-${reason}`,
      stateStore: staleReviewStore({
        records: [target],
        verifications: [{
          id: 1,
          status: 'passed',
          exitCode: 0,
          evidenceDigest: proofDigest,
          evidenceRef: proofDigest,
          sourceIdentity: 'source-run',
          verifiedMutationRevision: 0,
          acceptanceCoverage: [],
        }],
      }),
      candidates: [base],
    });

    assert.equal(result.verifiedCandidates.length, 0);
    assert.equal(result.rejectedCandidates.length, 1);
    assert.equal(result.rejectedCandidates[0]?.rejectionReasons?.[0], reason);
    assert.deepEqual(result.supersessionProposals, []);
  }
});
