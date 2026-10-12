import test from 'node:test';
import assert from 'node:assert/strict';
import type {
  FuturesAssessmentInput,
  FuturesEvidenceInput,
} from '../src/contracts/futures-evidence.js';
import { assessFuturesEvidence } from '../src/kernel/proof/futures-assessment.js';
import { collectFuturesEvidence } from '../src/kernel/proof/futures-evidence.js';
import {
  normalizeReviewReceipt,
  type ReviewReceipt,
} from '../src/kernel/proof/review-receipt.js';
import { resolveFuturesAssessmentReviewGate } from '../src/kernel/proof/review-pipeline.js';

const sha = (char: string): string => `sha256:${char.repeat(64)}`;
const REVIEWER = sha('1');
const IMPLEMENTER = sha('2');

const evidenceInput = (): FuturesEvidenceInput => ({
  revision: 12,
  contentDigest: sha('a'),
  changeSet: {
    status: 'observed',
    reason: null,
    actualChangedPaths: ['src/a.ts', 'src/b.ts'],
  },
  dependencyBoundaries: [
    { fromPath: 'src/a.ts', toPath: 'src/contracts/a.ts' },
  ],
  regressionScope: ['test:focused'],
  unknowns: [],
});

const assessmentInput = (
  overrides: Partial<FuturesAssessmentInput> = {},
): FuturesAssessmentInput => ({
  evidence: collectFuturesEvidence(evidenceInput()),
  currentRevision: 12,
  currentContentDigest: sha('a'),
  existingObligations: ['verify-regression'],
  signals: {
    behavior: 'preserved',
    scope: 'within',
    architecture: 'not-required',
  },
  ...overrides,
});

const assessment = (
  overrides: Partial<FuturesAssessmentInput> = {},
) => assessFuturesEvidence(assessmentInput(overrides));

const run = () => ({
  runId: 'run-futures-review',
  mutationRevision: 12,
  currentWorkspaceIdentity: sha('a'),
});

const receiptFor = (
  reviewed: ReturnType<typeof assessment>,
  overrides: {
    workspaceIdentity?: string;
    mutationRevision?: number;
    changedPathsDigest?: string;
    evidenceDigest?: string;
    enforcementStatus?: 'enforced' | 'fallback' | 'operator_approved' | 'advisory' | 'unsupported' | 'failed' | 'unrouted';
    reviewerSessionId?: string;
    implementerSessionId?: string;
    verdict?: 'pass' | 'fail' | 'changes-requested';
  } = {},
): ReviewReceipt => normalizeReviewReceipt({
  runId: 'run-futures-review',
  obligationId: 'futures-review',
  reviewStage: 'engineering',
  verdict: overrides.verdict ?? 'pass',
  findingClass: 'none',
  reviewer: {
    actorSessionId: overrides.reviewerSessionId ?? REVIEWER,
    usageReceiptId: 'usage-review-1',
    routeDecisionId: 'route-review-1',
    modelClass: 'frontier_reasoning',
    resolvedModel: 'configured-model',
    enforcementStatus: overrides.enforcementStatus ?? 'enforced',
  },
  implementer: {
    actorSessionId: overrides.implementerSessionId ?? IMPLEMENTER,
    usageReceiptId: 'usage-implement-1',
  },
  subject: {
    workspaceIdentity: overrides.workspaceIdentity ?? reviewed.subject.contentDigest,
    mutationRevision: overrides.mutationRevision ?? Number(reviewed.subject.revision),
    changedPathsDigest: overrides.changedPathsDigest ?? reviewed.subject.changedPathsDigest,
    evidenceDigest: overrides.evidenceDigest ?? reviewed.digest,
  },
  rationale: 'reviewed the current Futures assessment',
  createdAt: '2026-10-12T00:00:00.000Z',
});

test('fresh independent review exposes the Green existing-obligation candidate to Work', () => {
  const reviewed = assessment();
  const result = resolveFuturesAssessmentReviewGate({
    assessment: reviewed,
    reviewReceipt: receiptFor(reviewed),
    run: run(),
    existingObligationIds: ['verify-regression'],
  });

  assert.equal(result.status, 'ready');
  if (result.status !== 'ready') assert.fail('fresh review must be ready');
  assert.deepEqual(result.candidate, {
    kind: 'existing-obligations',
    obligationIds: ['verify-regression'],
  });
  assert.equal('execute' in result, false);
  assert.equal('mutation' in result, false);
  assert.equal('completion' in result, false);
});

test('stale assessment identity is blocked before a review can authorize anything', () => {
  const reviewed = assessment();
  const staleRun = { ...run(), mutationRevision: 13 };
  const result = resolveFuturesAssessmentReviewGate({
    assessment: reviewed,
    reviewReceipt: receiptFor(reviewed),
    run: staleRun,
    existingObligationIds: ['verify-regression'],
  });

  assert.equal(result.status, 'blocked');
  if (result.status !== 'blocked') assert.fail('stale assessment must block');
  assert.equal(result.blocker.code, 'assessment-stale');
  assert.ok(result.blocker.reasons.includes('assessment-stale-mutation-revision'));
});

test('missing or unavailable independent review remains an explicit capability blocker', () => {
  const reviewed = assessment();
  const missing = resolveFuturesAssessmentReviewGate({
    assessment: reviewed,
    reviewReceipt: null,
    run: run(),
    existingObligationIds: ['verify-regression'],
  });
  const unavailable = resolveFuturesAssessmentReviewGate({
    assessment: reviewed,
    reviewReceipt: null,
    reviewCapability: 'unavailable',
    run: run(),
    existingObligationIds: ['verify-regression'],
  });

  assert.equal(missing.status, 'blocked');
  if (missing.status === 'blocked') assert.equal(missing.blocker.code, 'review-receipt-missing');
  assert.equal(unavailable.status, 'blocked');
  if (unavailable.status === 'blocked') {
    assert.equal(unavailable.blocker.code, 'no-independent-review-capability');
  }
});

test('a model self-check shaped like a review cannot substitute for a closed ReviewReceipt', () => {
  const reviewed = assessment();
  const selfCheck = {
    runId: 'run-futures-review',
    obligationId: 'futures-review',
    verdict: 'pass',
    reviewer: {
      actorSessionId: REVIEWER,
      modelClass: 'frontier_reasoning',
      enforcementStatus: 'enforced',
    },
    implementer: { actorSessionId: IMPLEMENTER },
    subject: {
      workspaceIdentity: reviewed.subject.contentDigest,
      mutationRevision: 12,
      changedPathsDigest: reviewed.subject.changedPathsDigest,
      evidenceDigest: reviewed.digest,
    },
  } as unknown as ReviewReceipt;

  const result = resolveFuturesAssessmentReviewGate({
    assessment: reviewed,
    reviewReceipt: selfCheck,
    run: run(),
    existingObligationIds: ['verify-regression'],
  });

  assert.equal(result.status, 'blocked');
  if (result.status === 'blocked') assert.equal(result.blocker.code, 'review-receipt-invalid');
});

test('review freshness covers workspace, changed paths, evidence set, routing, and independence', () => {
  const reviewed = assessment();
  const cases: Array<[ReviewReceipt, string]> = [
    [receiptFor(reviewed, { workspaceIdentity: sha('b') }), 'review-stale-workspace-identity'],
    [receiptFor(reviewed, { changedPathsDigest: sha('c') }), 'review-stale-changed-paths'],
    [receiptFor(reviewed, { evidenceDigest: sha('d') }), 'review-stale-evidence-set'],
    [receiptFor(reviewed, { enforcementStatus: 'unsupported' }), 'review-routing-unsupported'],
    [receiptFor(reviewed, { reviewerSessionId: IMPLEMENTER }), 'review-session-not-independent'],
  ];

  for (const [receipt, reason] of cases) {
    const result = resolveFuturesAssessmentReviewGate({
      assessment: reviewed,
      reviewReceipt: receipt,
      run: run(),
      existingObligationIds: ['verify-regression'],
    });
    assert.equal(result.status, 'blocked', reason);
    if (result.status === 'blocked') assert.ok(result.blocker.reasons.includes(reason), JSON.stringify(result));
  }
});

test('Green cannot revive an obligation that is no longer present in current Work', () => {
  const reviewed = assessment();
  const result = resolveFuturesAssessmentReviewGate({
    assessment: reviewed,
    reviewReceipt: receiptFor(reviewed),
    run: run(),
    existingObligationIds: [],
  });

  assert.equal(result.status, 'blocked');
  if (result.status === 'blocked') {
    assert.equal(result.blocker.code, 'assessment-obligation-stale');
    assert.deepEqual(result.blocker.reasons, ['obligation-missing:verify-regression']);
  }
});

test('reviewed Yellow and Red candidates stay proposals for the existing next-work path', () => {
  const yellow = assessment({
    signals: {
      behavior: 'regressed',
      scope: 'within',
      architecture: 'not-required',
    },
  });
  const red = assessment({
    signals: {
      behavior: 'preserved',
      scope: 'outside',
      architecture: 'not-required',
    },
  });

  for (const reviewed of [yellow, red]) {
    const result = resolveFuturesAssessmentReviewGate({
      assessment: reviewed,
      reviewReceipt: receiptFor(reviewed),
      run: run(),
    });
    assert.equal(result.status, 'ready');
    if (result.status !== 'ready') assert.fail('reviewed candidate must be ready');
    assert.ok(['bounded-restore', 'architecture-planning'].includes(result.candidate.kind));
    assert.equal('execute' in result.candidate, false);
  }
});
