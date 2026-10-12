import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import {
  buildCrossRunEvidenceGroups,
  extractStructuredKnowledgeCandidates,
} from '../src/kernel/knowledge/capture.js';
import {
  buildImprovementPair,
  improvementPairApprovalRef,
} from '../src/kernel/knowledge/improvement-pair.js';
import {
  reviewKnowledgeCandidates,
  type KnowledgeCandidateLike as ReviewKnowledgeCandidate,
} from '../src/kernel/knowledge/candidate-review.js';
import {
  commitProjectKnowledge,
  KernelKnowledgeCommitError,
  type CommitProjectKnowledgeInput,
} from '../src/kernel/knowledge/commit.js';

const projectId = 'project-c24';
const scope = ['src/auth/refresh.ts'];
const correctionId = 'correction-auth-refresh';
const currentRunId = 'run-c24-current';
const proofDigest = `sha256:${'e'.repeat(64)}`;
const runAuthority = {
  sourceIdentity: 'run-source-c24',
  mutationRevision: 7,
};

const promotionBasisPair = ({
  pairScope = scope,
}: {
  pairScope?: string[];
} = {}) => buildImprovementPair({
  correctionId,
  projectId,
  sourceIdentity: 'feedback://c24',
  sourceRevision: 'feedback-revision-c24',
  scope: pairScope,
  sourceEvidenceRefs: ['feedback://c24/evidence'],
  mutationCandidate: {
    candidateId: correctionId,
    projectId,
    sourceRevision: 'feedback-revision-c24',
    scope: pairScope,
    evidenceRefs: ['feedback://c24/evidence'],
  },
  replayCandidate: {
    candidateId: 'feedback-replay-c24',
    projectId,
    sourceRevision: 'feedback-revision-c24',
    scope: pairScope,
    evidenceRefs: ['receipt://feedback-replay-c24'],
    obligationIds: ['feedback-regression'],
  },
  scopeOwner: {
    owner: 'owner://auth',
    sourceRevision: 'feedback-revision-c24',
    scope: pairScope,
  },
  rollback: {
    strategy: 'restore prior auth knowledge',
    targetIds: ['fact-auth-old'],
    evidenceRefs: ['rollback://auth'],
  },
});

const priorFailure = ({
  stale = false,
  contradiction = false,
  pair = promotionBasisPair(),
  signalScope = scope,
}: {
  stale?: boolean;
  contradiction?: boolean;
  pair?: ReturnType<typeof promotionBasisPair> | null;
  signalScope?: string[];
} = {}) => ({
  runId: 'run-c24-prior',
  failures: [{
    obligationId: 'feedback-regression',
    statement: 'Auth refresh fails after token expiry.',
    scope: signalScope,
    evidenceRefs: ['failure://run-c24-prior/auth'],
    ...(stale ? { freshnessStatus: 'stale' } : {}),
    ...(contradiction ? { contradiction: true } : {}),
    ...(pair ? { improvementPair: pair } : {}),
  }],
});

const currentSuccess = ({
  pair = promotionBasisPair(),
  signalScope = scope,
  contradiction = false,
}: {
  pair?: ReturnType<typeof promotionBasisPair> | null;
  signalScope?: string[];
  contradiction?: boolean;
} = {}) => ({
  runId: currentRunId,
  regressionVerifications: [{
    obligationId: 'feedback-regression',
    status: 'passed',
    exitCode: 0,
    statement: 'Auth refresh regression passes after correction.',
    scope: signalScope,
    evidenceRefs: [proofDigest],
    ...(contradiction ? { contradiction: true } : {}),
    ...(pair ? { improvementPair: pair } : {}),
  }],
});

const crossRunCandidate = ({
  prior = priorFailure(),
  current = currentSuccess(),
}: {
  prior?: ReturnType<typeof priorFailure>;
  current?: ReturnType<typeof currentSuccess>;
} = {}) => {
  const candidates = extractStructuredKnowledgeCandidates({
    run: { runId: currentRunId, projectId },
    priorRunSignals: [prior],
    signals: current,
  });
  return candidates.find(
    (candidate) => candidate.signalKind === 'cross-run-promotion',
  ) || candidates.find(
    (candidate) => candidate.signalKind === 'cross-run-evidence',
  );
};

test('C24: repeat count alone never creates a durable candidate', () => {
  const candidates = extractStructuredKnowledgeCandidates({
    run: { runId: currentRunId, projectId },
    signals: {
      runId: currentRunId,
      failures: [{
        obligationId: 'feedback-regression',
        statement: 'Auth refresh fails after token expiry.',
        scope,
        evidenceRefs: ['failure://same-run/auth'],
        count: 20,
        improvementPair: promotionBasisPair(),
      }],
    },
  });

  assert.equal(
    candidates.some((candidate) => candidate.signalKind === 'cross-run-promotion'),
    false,
  );
});

test('C24: stale contradictory scope-mismatched and non-current replay groups stay episodic', () => {
  const stale = crossRunCandidate({
    prior: priorFailure({ stale: true }),
  });
  assert.ok(stale);
  assert.equal(stale.signalKind, 'cross-run-evidence');
  assert.equal(stale.proposedType, 'episodic_observation');
  assert.equal(stale.improvementPair, undefined);

  const contradictory = crossRunCandidate({
    current: currentSuccess({ contradiction: true }),
  });
  assert.ok(contradictory);
  assert.equal(contradictory.signalKind, 'cross-run-evidence');

  const wrongScope = crossRunCandidate({
    prior: priorFailure({
      pair: promotionBasisPair({ pairScope: ['src/billing/charge.ts'] }),
    }),
    current: currentSuccess({
      pair: promotionBasisPair({ pairScope: ['src/billing/charge.ts'] }),
    }),
  });
  assert.ok(wrongScope);
  assert.equal(wrongScope.signalKind, 'cross-run-evidence');

  const groups = buildCrossRunEvidenceGroups({
    projectId,
    currentRunId: 'run-c24-later',
    priorRunSignals: [
      priorFailure(),
      currentSuccess(),
    ],
    signals: {
      runId: 'run-c24-later',
      failures: [{
        obligationId: 'feedback-regression',
        statement: 'Auth refresh fails again.',
        scope,
        evidenceRefs: ['failure://run-c24-later/auth'],
        improvementPair: promotionBasisPair(),
      }],
    },
  });
  assert.equal(groups.length, 1);
  const laterCandidate = extractStructuredKnowledgeCandidates({
    run: { runId: 'run-c24-later', projectId },
    priorRunSignals: [priorFailure(), currentSuccess()],
    signals: {
      runId: 'run-c24-later',
      failures: [{
        obligationId: 'feedback-regression',
        statement: 'Auth refresh fails again.',
        scope,
        evidenceRefs: ['failure://run-c24-later/auth'],
        improvementPair: promotionBasisPair(),
      }],
    },
  }).find((candidate) => candidate.signalKind === 'cross-run-evidence');
  assert.ok(laterCandidate);
  assert.equal(laterCandidate.proposedType, 'episodic_observation');
});

test('C24: eligible current-run resolution becomes known_failure_pattern with a fresh Improvement Pair', () => {
  const candidate = crossRunCandidate();
  assert.ok(candidate);
  assert.equal(candidate.signalKind, 'cross-run-promotion');
  assert.equal(candidate.proposedType, 'known_failure_pattern');
  assert.deepEqual(candidate.supersedes, ['fact-auth-old']);

  const pair = candidate.improvementPair as {
    status?: string;
    correctionId?: string;
    projectId?: string;
    scope?: string[];
    replayCandidate?: {
      evidenceRefs?: string[];
      obligationIds?: string[];
    };
    scopeOwner?: { owner?: string };
  };
  assert.equal(pair.status, 'ready');
  assert.equal(pair.correctionId, candidate.candidateId);
  assert.equal(pair.projectId, projectId);
  assert.deepEqual(pair.scope, scope);
  assert.deepEqual(pair.replayCandidate?.evidenceRefs, [proofDigest]);
  assert.deepEqual(
    pair.replayCandidate?.obligationIds,
    ['feedback-regression'],
  );
  assert.equal(pair.scopeOwner?.owner, 'owner://auth');

  const group = candidate.crossRunEvidenceGroup as {
    authority?: string;
    runCount?: number;
    failureRunIds?: string[];
    successRunIds?: string[];
  };
  assert.equal(group.authority, 'episodic_only');
  assert.equal(group.runCount, 2);
  assert.deepEqual(group.failureRunIds, ['run-c24-prior']);
  assert.deepEqual(group.successRunIds, [currentRunId]);
});

type ReviewStore = NonNullable<
  NonNullable<Parameters<typeof reviewKnowledgeCandidates>[0]>['stateStore']
>;

const forReview = (
  candidate: NonNullable<ReturnType<typeof crossRunCandidate>>,
): ReviewKnowledgeCandidate => {
  const acceptanceIds = Array.isArray(candidate.acceptanceIds)
    ? candidate.acceptanceIds.map(String)
    : [];
  const obligationIds = Array.isArray(candidate.obligationIds)
    ? candidate.obligationIds.map(String)
    : [];
  const evidenceRefs = Array.isArray(candidate.evidenceRefs)
    ? candidate.evidenceRefs.map(String)
    : [];
  return {
    candidateId: String(candidate.candidateId || ''),
    projectId: String(candidate.projectId || ''),
    statement: String(candidate.statement || ''),
    scope: Array.isArray(candidate.scope) ? candidate.scope.map(String) : [],
    status: String(candidate.status || 'observed'),
    evidenceRefs,
    acceptanceIds,
    obligationIds,
    evidenceBinding: {
      evidenceRefs,
      acceptanceIds,
      obligationIds,
    },
    sourceKind: String(candidate.sourceKind || ''),
    supersedes: Array.isArray(candidate.supersedes)
      ? candidate.supersedes.map(String)
      : [],
    proposedType: candidate.proposedType,
    signalKind: candidate.signalKind,
    improvementPair: candidate.improvementPair,
    crossRunEvidenceGroup: candidate.crossRunEvidenceGroup,
  };
};

const reviewStoreFor = (
  candidate: NonNullable<ReturnType<typeof crossRunCandidate>>,
  {
    approval = true,
    mutationRevision = runAuthority.mutationRevision,
  }: {
    approval?: boolean;
    mutationRevision?: number;
  } = {},
): ReviewStore => ({
  listKnowledgeRecords: () => [{
    id: 'fact-auth-old',
    projectId,
    type: 'semantic_fact',
    status: 'committed',
    scope: ['src/auth/**'],
  }],
  getKnowledgeApproval: () => approval
    ? {
        candidateId: String(candidate.candidateId),
        approvedBy: 'owner://auth',
        approvalReceipt: improvementPairApprovalRef(candidate.improvementPair),
      }
    : null,
  ensureRunObligation: () => {},
  getRunObligations: () => [],
  getVerifications: () => [{
    id: 24,
    obligationId: 'feedback-regression',
    status: 'passed',
    exitCode: 0,
    evidenceDigest: proofDigest,
    evidenceRef: proofDigest,
    sourceIdentity: runAuthority.sourceIdentity,
    verifiedMutationRevision: mutationRevision,
    acceptanceCoverage: [],
  }],
  recordCandidateEvidenceBinding: () => {},
  getRun: () => runAuthority,
});

test('C24: episodic-only group is non-blocking and never reaches verified candidates', async () => {
  const episodic = crossRunCandidate({
    prior: priorFailure({ stale: true }),
  });
  assert.ok(episodic);

  const result = await reviewKnowledgeCandidates({
    projectId,
    runId: currentRunId,
    stateStore: reviewStoreFor(episodic),
    candidates: [forReview(episodic)],
  });

  assert.equal(result.status, 'passed');
  assert.equal(result.verifiedCandidates.length, 0);
  assert.equal(result.rejectedCandidates.length, 0);
  assert.equal(result.needsApprovalCandidates.length, 0);
  assert.equal(result.pendingVerificationCandidates.length, 0);
  assert.equal(result.candidateReviews[0]?.decision, 'episodic');
});

test('C24: durable cross-run candidate still requires current approval and fresh replay', async () => {
  const candidate = crossRunCandidate();
  assert.ok(candidate);
  assert.equal(candidate.signalKind, 'cross-run-promotion');

  const missingApproval = await reviewKnowledgeCandidates({
    projectId,
    runId: currentRunId,
    stateStore: reviewStoreFor(candidate, { approval: false }),
    candidates: [forReview(candidate)],
  });
  assert.equal(missingApproval.status, 'needs_approval');
  assert.equal(missingApproval.verifiedCandidates.length, 0);

  const staleReplay = await reviewKnowledgeCandidates({
    projectId,
    runId: currentRunId,
    stateStore: reviewStoreFor(candidate, { mutationRevision: 6 }),
    candidates: [forReview(candidate)],
  });
  assert.equal(staleReplay.status, 'pending_verification');
  assert.equal(staleReplay.verifiedCandidates.length, 0);

  const passed = await reviewKnowledgeCandidates({
    projectId,
    runId: currentRunId,
    stateStore: reviewStoreFor(candidate),
    candidates: [forReview(candidate)],
  });
  assert.equal(passed.status, 'passed');
  assert.equal(passed.verifiedCandidates.length, 1);
  assert.equal(
    passed.verifiedCandidates[0]?.proposedType,
    'known_failure_pattern',
  );
  assert.deepEqual(passed.supersessionProposals, [{
    targetId: 'fact-auth-old',
    supersedingId: candidate.candidateId,
    reason: 'verified_cross_run_supersession',
  }]);
});

const commitStoreFor = (
  candidate: NonNullable<ReturnType<typeof crossRunCandidate>>,
) => {
  let transactionCalls = 0;
  let transactionInput: Record<string, unknown> | null = null;
  const store: NonNullable<CommitProjectKnowledgeInput['stateStore']> = {
    getKnowledgeCandidates: () => [],
    getRun: () => ({
      runId: currentRunId,
      projectId,
      sourceIdentity: runAuthority.sourceIdentity,
      mutationRevision: runAuthority.mutationRevision,
    }),
    getCompletionDecision: () => ({
      decision: 'accepted',
      sourceIdentity: runAuthority.sourceIdentity,
      mutationRevision: runAuthority.mutationRevision,
      evidenceDigest: proofDigest,
    }),
    getKnowledgeApproval: () => ({
      candidateId: String(candidate.candidateId),
      approvedBy: 'owner://auth',
      approvalReceipt: improvementPairApprovalRef(candidate.improvementPair),
    }),
    getVerifications: () => [{
      id: 24,
      obligationId: 'feedback-regression',
      status: 'passed',
      exitCode: 0,
      evidenceDigest: proofDigest,
      evidenceRef: proofDigest,
      sourceIdentity: runAuthority.sourceIdentity,
      verifiedMutationRevision: runAuthority.mutationRevision,
      acceptanceCoverage: [],
    }],
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

test('C24: direct commit cannot forge durable promotion from an episodic-only group', async () => {
  const episodic = crossRunCandidate({
    prior: priorFailure({ stale: true }),
  });
  assert.ok(episodic);
  const store = commitStoreFor(episodic);
  await assert.rejects(
    () => commitProjectKnowledge({
      runId: currentRunId,
      projectId,
      stateStore: store.store,
      candidates: [{
        ...episodic,
        status: 'verified',
      }],
    }),
    (error) => (
      error instanceof KernelKnowledgeCommitError
      && error.code === 'CROSS_RUN_PROMOTION_BLOCKED'
    ),
  );
  assert.equal(store.calls(), 0);
});

test('C24: eligible durable candidate commits through the existing transaction and preserves group provenance', async () => {
  const candidate = crossRunCandidate();
  assert.ok(candidate);
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'kernel-c24-'));
  const store = commitStoreFor(candidate);
  try {
    const receipt = await commitProjectKnowledge({
      runId: currentRunId,
      projectId,
      stateStore: store.store,
      candidates: [{
        ...candidate,
        status: 'verified',
        evidenceRefs: [proofDigest],
      }],
      env: { MOON_RELAY_KERNEL_HOME: tmp },
    });

    assert.equal(receipt.status, 'committed');
    assert.equal(store.calls(), 1);
    const input = store.input();
    assert.ok(input);
    assert.deepEqual(input.supersessions, ['fact-auth-old']);
    const records = input.records as Array<{
      type?: string;
      crossRunEvidenceGroup?: { groupId?: string };
    }>;
    assert.equal(records[0]?.type, 'known_failure_pattern');
    assert.equal(
      records[0]?.crossRunEvidenceGroup?.groupId,
      (candidate.crossRunEvidenceGroup as { groupId?: string }).groupId,
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
