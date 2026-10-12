import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import {
  buildImprovementPair,
  evaluateImprovementPairPromotion,
  improvementPairApprovalRef,
} from '../src/kernel/knowledge/improvement-pair.js';
import { reviewKnowledgeCandidates } from '../src/kernel/knowledge/candidate-review.js';
import {
  commitProjectKnowledge,
  KernelKnowledgeCommitError,
  type CommitProjectKnowledgeInput,
} from '../src/kernel/knowledge/commit.js';

const proofDigest = `sha256:${'c'.repeat(64)}`;
const candidateId = 'cand-improvement-c22';
const projectId = 'project-c22';
const scope = ['src/auth/service.ts'];
const sourceRevision = 'feedback-revision-22';
const run = { sourceIdentity: 'run-source-22', mutationRevision: 4 };

const pair = ({
  replayEvidenceRefs = [proofDigest],
  ownerRevision = sourceRevision,
  ownerScope = scope,
  rollback = true,
}: {
  replayEvidenceRefs?: string[];
  ownerRevision?: string;
  ownerScope?: string[];
  rollback?: boolean;
} = {}) => buildImprovementPair({
  correctionId: candidateId,
  projectId,
  sourceIdentity: 'feedback://c22',
  sourceRevision,
  scope,
  sourceEvidenceRefs: ['feedback://evidence-22'],
  mutationCandidate: {
    candidateId,
    projectId,
    sourceRevision,
    scope,
    evidenceRefs: ['feedback://evidence-22'],
  },
  replayCandidate: {
    candidateId: 'replay-c22',
    projectId,
    sourceRevision,
    scope,
    evidenceRefs: replayEvidenceRefs,
    obligationIds: ['feedback-regression'],
  },
  scopeOwner: {
    owner: 'owner://auth',
    sourceRevision: ownerRevision,
    scope: ownerScope,
  },
  rollback: rollback
    ? {
        strategy: 'supersede correction and restore the prior record',
        targetIds: ['fact-old'],
        evidenceRefs: ['rollback://auth'],
      }
    : null,
});

const approvalFor = (
  pairValue = pair(),
) => ({
  candidateId,
  approvedBy: 'owner://auth',
  approvalReceipt: improvementPairApprovalRef(pairValue),
});

const approval = approvalFor();

const verification = ({
  status = 'passed',
  exitCode = 0,
  sourceIdentity = run.sourceIdentity,
  verifiedMutationRevision = run.mutationRevision,
  evidenceDigest = proofDigest,
}: {
  status?: string;
  exitCode?: number;
  sourceIdentity?: string;
  verifiedMutationRevision?: number;
  evidenceDigest?: string;
} = {}) => ({
  id: 22,
  obligationId: 'feedback-regression',
  status,
  exitCode,
  evidenceDigest,
  evidenceRef: evidenceDigest,
  sourceIdentity,
  verifiedMutationRevision,
  acceptanceCoverage: [],
});

test('C22: only a fresh replay, current approval, scope owner, and rollback make the pair eligible', () => {
  const result = evaluateImprovementPairPromotion({
    pair: pair(),
    candidateId,
    projectId,
    scope,
    supersedes: ['fact-old'],
    run,
    verifications: [verification()],
    approval,
  });

  assert.equal(result.eligible, true);
  assert.equal(result.status, 'eligible');
  assert.deepEqual(result.reasons, []);
  assert.equal(result.replayBindings.length, 1);
  assert.equal(result.approvalRef, approval.approvalReceipt);
  assert.equal(result.scopeOwner, 'owner://auth');
});

test('C22: replay missing failed stale and evidence mismatch never authorize promotion', () => {
  const scenarios = [
    {
      verifications: [],
      expected: 'REPLAY_MISSING',
    },
    {
      verifications: [verification({ status: 'failed', exitCode: 1 })],
      expected: 'REPLAY_FAILED',
    },
    {
      verifications: [verification({ verifiedMutationRevision: 3 })],
      expected: 'REPLAY_STALE',
    },
    {
      verifications: [verification({ sourceIdentity: 'old-run-source' })],
      expected: 'REPLAY_STALE',
    },
    {
      verifications: [verification({ evidenceDigest: `sha256:${'d'.repeat(64)}` })],
      expected: 'REPLAY_EVIDENCE_MISMATCH',
    },
  ];

  for (const scenario of scenarios) {
    const result = evaluateImprovementPairPromotion({
      pair: pair(),
      candidateId,
      projectId,
      scope,
      supersedes: ['fact-old'],
      run,
      verifications: scenario.verifications,
      approval,
    });
    assert.equal(result.eligible, false);
    assert.equal(result.status, 'pending_replay');
    assert.ok(result.reasons.includes(scenario.expected));
  }
});

test('C22: stale approval scope-owner mismatch and missing rollback fail closed', () => {
  const staleApproval = evaluateImprovementPairPromotion({
    pair: pair(),
    candidateId,
    projectId,
    scope,
    supersedes: ['fact-old'],
    run,
    verifications: [verification()],
    approval: {
      ...approval,
      candidateId: 'cand-old-correction',
    },
  });
  assert.equal(staleApproval.status, 'needs_approval');
  assert.deepEqual(staleApproval.reasons, ['STALE_KNOWLEDGE_APPROVAL']);

  const staleReceipt = evaluateImprovementPairPromotion({
    pair: pair(),
    candidateId,
    projectId,
    scope,
    supersedes: ['fact-old'],
    run,
    verifications: [verification()],
    approval: {
      ...approval,
      approvalReceipt: 'improvement-pair-approval:stale',
    },
  });
  assert.equal(staleReceipt.status, 'needs_approval');
  assert.deepEqual(staleReceipt.reasons, ['STALE_KNOWLEDGE_APPROVAL']);

  const wrongApprover = evaluateImprovementPairPromotion({
    pair: pair(),
    candidateId,
    projectId,
    scope,
    supersedes: ['fact-old'],
    run,
    verifications: [verification()],
    approval: {
      ...approval,
      approvedBy: 'owner://billing',
    },
  });
  assert.equal(wrongApprover.status, 'needs_approval');
  assert.deepEqual(
    wrongApprover.reasons,
    ['SCOPE_OWNER_APPROVAL_MISMATCH'],
  );

  const staleOwner = evaluateImprovementPairPromotion({
    pair: pair({ ownerRevision: 'feedback-revision-21' }),
    candidateId,
    projectId,
    scope,
    supersedes: ['fact-old'],
    run,
    verifications: [verification()],
    approval,
  });
  assert.equal(staleOwner.status, 'rejected');
  assert.deepEqual(staleOwner.reasons, ['SCOPE_OWNER_STALE']);

  const wrongOwnerScope = evaluateImprovementPairPromotion({
    pair: pair({ ownerScope: ['src/billing/service.ts'] }),
    candidateId,
    projectId,
    scope,
    supersedes: ['fact-old'],
    run,
    verifications: [verification()],
    approval,
  });
  assert.equal(wrongOwnerScope.status, 'rejected');
  assert.deepEqual(wrongOwnerScope.reasons, ['SCOPE_OWNER_SCOPE_MISMATCH']);

  const missingRollback = evaluateImprovementPairPromotion({
    pair: pair({ rollback: false }),
    candidateId,
    projectId,
    scope,
    supersedes: ['fact-old'],
    run,
    verifications: [verification()],
    approval,
  });
  assert.equal(missingRollback.status, 'rejected');
  assert.deepEqual(missingRollback.reasons, ['ROLLBACK_PLAN_MISSING']);
});

type ReviewStore = NonNullable<
  NonNullable<Parameters<typeof reviewKnowledgeCandidates>[0]>['stateStore']
>;

const reviewStore = ({
  proof = verification(),
  approvalValue = approval,
}: {
  proof?: ReturnType<typeof verification> | null;
  approvalValue?: typeof approval | null;
} = {}): ReviewStore => ({
  listKnowledgeRecords: () => [{
    id: 'fact-old',
    projectId,
    type: 'semantic_fact',
    status: 'committed',
    scope: ['src/auth/**'],
  }],
  getKnowledgeApproval: () => approvalValue,
  ensureRunObligation: () => {},
  getRunObligations: () => [],
  getVerifications: () => proof ? [proof] : [],
  recordCandidateEvidenceBinding: () => {},
  getRun: () => run,
});

const verifiedCandidateInput = () => ({
  candidateId,
  projectId,
  proposedType: 'semantic_fact',
  statement: 'Auth retries must use bounded exponential backoff.',
  scope,
  status: 'observed',
  sourceKind: 'feedback',
  evidenceRefs: ['feedback://evidence-22'],
  supersedes: ['fact-old'],
  feedbackClassification: { primary: 'stale_knowledge' },
  improvementPair: pair(),
});

test('C22: Knowledge review routes pair failures and only verified fresh replay emits supersession', async () => {
  const missingReplay = await reviewKnowledgeCandidates({
    projectId,
    runId: 'run-c22-missing',
    stateStore: reviewStore({ proof: null }),
    candidates: [verifiedCandidateInput()],
  });
  assert.equal(missingReplay.status, 'pending_verification');
  assert.equal(missingReplay.verifiedCandidates.length, 0);
  assert.deepEqual(missingReplay.supersessionProposals, []);

  const passed = await reviewKnowledgeCandidates({
    projectId,
    runId: 'run-c22-pass',
    stateStore: reviewStore(),
    candidates: [verifiedCandidateInput()],
  });
  assert.equal(passed.status, 'passed');
  assert.equal(passed.verifiedCandidates.length, 1);
  assert.deepEqual(passed.supersessionProposals, [{
    targetId: 'fact-old',
    supersedingId: candidateId,
    reason: 'verified_feedback_stale_knowledge',
  }]);
  assert.equal(passed.verifiedCandidates[0]?.evidenceRefs?.[0], proofDigest);
});

const commitStore = ({
  proof = verification(),
  approvalValue = approval,
}: {
  proof?: ReturnType<typeof verification> | null;
  approvalValue?: typeof approval | null;
} = {}) => {
  let transactionCalls = 0;
  let transactionInput: Record<string, unknown> | null = null;
  const store: NonNullable<CommitProjectKnowledgeInput['stateStore']> = {
    getKnowledgeCandidates: () => [],
    getRun: () => ({
      runId: 'run-c22',
      projectId,
      sourceIdentity: run.sourceIdentity,
      mutationRevision: run.mutationRevision,
    }),
    getCompletionDecision: () => ({
      decision: 'accepted',
      sourceIdentity: run.sourceIdentity,
      mutationRevision: run.mutationRevision,
      evidenceDigest: proofDigest,
    }),
    getKnowledgeApproval: () => approvalValue,
    getVerifications: () => proof ? [proof] : [],
    getProjectKnowledgeRevision: () => 1,
    listKnowledgeRecords: () => [],
    commitKnowledgeTransaction: (input) => {
      transactionCalls += 1;
      transactionInput = input;
      return {
        revisionBefore: '1',
        revisionAfter: '2',
        status: 'committed',
      };
    },
  };
  return {
    store,
    calls: () => transactionCalls,
    input: () => transactionInput,
  };
};

test('C22: direct commit cannot bypass pair promotion gate', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'kernel-c22-block-'));
  const blockedStore = commitStore({ proof: null });
  try {
    await assert.rejects(
      () => commitProjectKnowledge({
        runId: 'run-c22',
        projectId,
        stateStore: blockedStore.store,
        candidates: [{
          ...verifiedCandidateInput(),
          status: 'verified',
          evidenceRefs: [proofDigest],
        }],
        env: { MOON_RELAY_KERNEL_HOME: tmp },
      }),
      (error) => (
        error instanceof KernelKnowledgeCommitError
        && error.code === 'IMPROVEMENT_PAIR_PROMOTION_BLOCKED'
      ),
    );
    assert.equal(blockedStore.calls(), 0);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('C22: eligible pair commits through existing transaction with pair provenance and supersession', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'kernel-c22-pass-'));
  const acceptedStore = commitStore();
  try {
    const receipt = await commitProjectKnowledge({
      runId: 'run-c22',
      projectId,
      stateStore: acceptedStore.store,
      candidates: [{
        ...verifiedCandidateInput(),
        status: 'verified',
        evidenceRefs: [proofDigest],
      }],
      env: { MOON_RELAY_KERNEL_HOME: tmp },
    });

    assert.equal(receipt.status, 'committed');
    assert.equal(acceptedStore.calls(), 1);
    const input = acceptedStore.input();
    assert.ok(input);
    assert.deepEqual(input.supersessions, ['fact-old']);
    assert.deepEqual(
      (input.provenance as { improvementPairIds?: string[] }).improvementPairIds,
      [pair().pairId],
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('C22: evaluation success is not promotion authority and missing approval remains blocked', () => {
  const pairWithEvaluation = {
    ...pair(),
    evaluation: {
      status: 'passed',
      score: 1,
    },
  };
  const result = evaluateImprovementPairPromotion({
    pair: pairWithEvaluation,
    candidateId,
    projectId,
    scope,
    supersedes: ['fact-old'],
    run,
    verifications: [verification()],
    approval: null,
  });

  assert.equal(result.eligible, false);
  assert.equal(result.status, 'needs_approval');
  assert.deepEqual(result.reasons, ['KNOWLEDGE_APPROVAL_REQUIRED']);
});

test('C22: candidate scope and rollback supersession targets must remain exact', () => {
  const wrongCandidateScope = evaluateImprovementPairPromotion({
    pair: pair(),
    candidateId,
    projectId,
    scope: ['src/auth/other.ts'],
    supersedes: ['fact-old'],
    run,
    verifications: [verification()],
    approval,
  });
  assert.equal(wrongCandidateScope.status, 'rejected');
  assert.deepEqual(
    wrongCandidateScope.reasons,
    ['IMPROVEMENT_PAIR_SCOPE_MISMATCH'],
  );

  const rollbackTargetMismatch = evaluateImprovementPairPromotion({
    pair: buildImprovementPair({
      correctionId: candidateId,
      projectId,
      sourceIdentity: 'feedback://c22',
      sourceRevision,
      scope,
      sourceEvidenceRefs: ['feedback://evidence-22'],
      mutationCandidate: {
        candidateId,
        projectId,
        sourceRevision,
        scope,
      },
      replayCandidate: {
        candidateId: 'replay-c22',
        projectId,
        sourceRevision,
        scope,
        evidenceRefs: [proofDigest],
        obligationIds: ['feedback-regression'],
      },
      scopeOwner: {
        owner: 'owner://auth',
        sourceRevision,
        scope,
      },
      rollback: {
        strategy: 'restore prior record',
        targetIds: ['different-record'],
      },
    }),
    candidateId,
    projectId,
    scope,
    supersedes: ['fact-old'],
    run,
    verifications: [verification()],
    approval,
  });
  assert.equal(rollbackTargetMismatch.status, 'rejected');
  assert.deepEqual(
    rollbackTargetMismatch.reasons,
    ['ROLLBACK_SUPERSESSION_MISMATCH'],
  );
});
