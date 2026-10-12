// Two-stage review. Contract review checks public-contract compatibility
// and acceptance semantics; engineering review checks implementation standards
// and complexity. Reviewers are defined by a fixed I/O contract, not personas.

import type { FuturesAssessment } from '../../contracts/futures-evidence.js';
import { isReviewAction } from '../../contracts/review.js';
import {
  evaluateReviewReceipt,
  reviewReceiptDigest,
  type ReviewReceipt,
} from './review-receipt.js';

type UnknownRecord = Record<string, unknown>;
type RiskTier = 'T0' | 'T1' | 'T2' | 'T3';
export type ReviewStage = 'contract' | 'engineering';
export type ReviewSeverity = 'critical' | 'important' | 'minor';
export type ReviewCategory =
  | 'contract'
  | 'architecture'
  | 'implementation'
  | 'security'
  | 'verification';
export type ReviewRequiredAction = 'fix' | 'replan' | 'block';

export interface ReviewVerdictInput extends UnknownRecord {
  stage?: unknown;
  verdict?: unknown;
  reviewerId?: unknown;
  findings?: unknown[];
  risks?: unknown[];
}

export interface NormalizedReviewVerdict {
  stage: ReviewStage;
  verdict: 'pass' | 'fail' | 'changes-requested';
  reviewerId: string | null;
  findings: unknown[];
  risks: unknown[];
}

export interface ReviewFindingInput extends UnknownRecord {
  severity?: unknown;
  category?: unknown;
  path?: unknown;
  summary?: unknown;
  requiredAction?: unknown;
}

export interface NormalizedReviewFinding {
  severity: ReviewSeverity;
  category: ReviewCategory;
  path: string | null;
  summary: string;
  requiredAction: ReviewRequiredAction;
}

export interface ReviewDecisionLike extends UnknownRecord {
  modelClass?: unknown;
  role?: unknown;
  actionKind?: unknown;
}

export interface ReviewReceiptLike extends UnknownRecord {
  enforcementStatus?: unknown;
  actorSessionId?: unknown;
}

export interface ImplementationSessionLike extends UnknownRecord {
  actorSessionId?: unknown;
}

const RANK: Readonly<Record<RiskTier, number>> = {
  T0: 0,
  T1: 1,
  T2: 2,
  T3: 3,
};

export const REVIEW_STAGES = [
  'contract',
  'engineering',
] as const satisfies readonly ReviewStage[];

const REVIEW_VERDICTS = [
  'pass',
  'fail',
  'changes-requested',
] as const;

const isReviewStage = (value: unknown): value is ReviewStage => (
  REVIEW_STAGES.includes(value as ReviewStage)
);

const isReviewVerdict = (
  value: unknown,
): value is NormalizedReviewVerdict['verdict'] => (
  REVIEW_VERDICTS.includes(
    value as NormalizedReviewVerdict['verdict'],
  )
);

const normalizeRiskTier = (value: unknown): RiskTier => (
  Object.hasOwn(RANK, String(value))
    ? String(value) as RiskTier
    : 'T0'
);

export const normalizeReviewVerdict = (
  verdict: ReviewVerdictInput | null = {},
): NormalizedReviewVerdict => {
  if (!verdict || typeof verdict !== 'object' || Array.isArray(verdict)) {
    throw new Error('review verdict must be an object');
  }
  if (!isReviewVerdict(verdict.verdict)) {
    throw new Error('review verdict must be pass | fail | changes-requested');
  }
  if (!isReviewStage(verdict.stage)) {
    throw new Error(
      `review stage must be one of: ${REVIEW_STAGES.join(', ')}`,
    );
  }

  return {
    stage: verdict.stage,
    verdict: verdict.verdict,
    reviewerId: verdict.reviewerId
      ? String(verdict.reviewerId)
      : null,
    findings: Array.isArray(verdict.findings) ? verdict.findings : [],
    risks: Array.isArray(verdict.risks) ? verdict.risks : [],
  };
};

export const resolveReviewPlan = ({
  riskTier = 'T0',
  publicContract = false,
  acceptanceAmbiguity = false,
  behaviorChanging = false,
}: {
  riskTier?: unknown;
  publicContract?: boolean;
  acceptanceAmbiguity?: boolean;
  behaviorChanging?: boolean;
} = {}) => {
  const normalizedRisk = normalizeRiskTier(riskTier);
  const stages: Array<{
    stage: ReviewStage;
    permissions: 'read_only';
    objective: string;
  }> = [];

  if (
    publicContract
    || acceptanceAmbiguity
    || RANK[normalizedRisk] >= RANK.T2
  ) {
    stages.push({
      stage: 'contract',
      permissions: 'read_only',
      objective:
        'Assess public-contract compatibility and acceptance semantics.',
    });
  }
  if (behaviorChanging || RANK[normalizedRisk] >= RANK.T1) {
    stages.push({
      stage: 'engineering',
      permissions: 'read_only',
      objective:
        'Assess implementation standards and complexity.',
    });
  }

  return {
    stages,
    independentReviewerRequired: RANK[normalizedRisk] >= RANK.T3,
  };
};

export const assertIndependentReview = ({
  verdict,
  implementerId,
}: {
  verdict: Pick<NormalizedReviewVerdict, 'reviewerId'>;
  implementerId?: (string | null) | undefined;
}): true => {
  if (!verdict.reviewerId) {
    throw new Error(
      'INDEPENDENT_REVIEW_REQUIRED: reviewerId is required for an independent review',
    );
  }
  if (implementerId && verdict.reviewerId === implementerId) {
    throw new Error(
      'INDEPENDENT_REVIEW_REQUIRED: reviewer must be independent of the implementer',
    );
  }
  return true;
};

export const REVIEW_SEVERITIES = Object.freeze([
  'critical',
  'important',
  'minor',
] as const satisfies readonly ReviewSeverity[]);

export const REVIEW_CATEGORIES = Object.freeze([
  'contract',
  'architecture',
  'implementation',
  'security',
  'verification',
] as const satisfies readonly ReviewCategory[]);

export const REVIEW_REQUIRED_ACTIONS = Object.freeze([
  'fix',
  'replan',
  'block',
] as const satisfies readonly ReviewRequiredAction[]);

const ACTION_FOR_CATEGORY: Readonly<
  Record<ReviewCategory, ReviewRequiredAction>
> = {
  contract: 'replan',
  architecture: 'replan',
  implementation: 'fix',
  verification: 'fix',
  security: 'block',
};

const isSeverity = (value: unknown): value is ReviewSeverity => (
  REVIEW_SEVERITIES.includes(value as ReviewSeverity)
);
const isCategory = (value: unknown): value is ReviewCategory => (
  REVIEW_CATEGORIES.includes(value as ReviewCategory)
);
const isRequiredAction = (
  value: unknown,
): value is ReviewRequiredAction => (
  REVIEW_REQUIRED_ACTIONS.includes(value as ReviewRequiredAction)
);

export const normalizeReviewFinding = (
  finding: string | ReviewFindingInput,
): NormalizedReviewFinding => {
  if (typeof finding === 'string') {
    return {
      severity: 'minor',
      category: 'implementation',
      path: null,
      summary: finding,
      requiredAction: 'fix',
    };
  }
  if (!finding || typeof finding !== 'object' || Array.isArray(finding)) {
    throw new Error('a review finding must be a string or an object');
  }

  const category = isCategory(finding.category)
    ? finding.category
    : 'implementation';
  const severity = isSeverity(finding.severity)
    ? finding.severity
    : 'minor';
  const inferred: ReviewRequiredAction = (
    severity === 'critical' && category === 'security'
      ? 'block'
      : ACTION_FOR_CATEGORY[category]
  );

  return {
    severity,
    category,
    path: finding.path ? String(finding.path) : null,
    summary: String(finding.summary || ''),
    requiredAction: isRequiredAction(finding.requiredAction)
      ? finding.requiredAction
      : inferred,
  };
};

export const classifyReviewFindings = (
  findings: Array<string | ReviewFindingInput> = [],
) => {
  const normalized = findings.map(normalizeReviewFinding);
  const requiredAction = normalized.some(
    (finding) => finding.requiredAction === 'block',
  )
    ? 'block'
    : normalized.some((finding) => finding.requiredAction === 'replan')
      ? 'replan'
      : normalized.some((finding) => finding.requiredAction === 'fix')
        ? 'fix'
        : 'none';

  return {
    findings: normalized,
    requiredAction,
    blocking: requiredAction === 'block',
    actionKind: requiredAction === 'fix'
      ? 'debug'
      : requiredAction === 'none'
        ? null
        : 'replan',
    modelClass: requiredAction === 'fix'
      ? 'value_coding'
      : requiredAction === 'none'
        ? null
        : 'frontier_reasoning',
  };
};

export const assertIndependentReviewSession = ({
  reviewDecision,
  reviewReceipt,
  implementationSession,
}: {
  reviewDecision?: ReviewDecisionLike | null;
  reviewReceipt?: ReviewReceiptLike | null;
  implementationSession?: ImplementationSessionLike | null;
} = {}): true => {
  if (!reviewReceipt) {
    throw new Error(
      'INDEPENDENT_REVIEW_REQUIRED: a routed T3 review requires the Host usage receipt for the reviewing session',
    );
  }
  if (
    !reviewDecision
    || reviewDecision.modelClass !== 'frontier_reasoning'
  ) {
    throw new Error(
      'INDEPENDENT_REVIEW_REQUIRED: a T3 review must run on the frontier reasoning class',
    );
  }
  if (
    reviewDecision.role !== 'reviewer'
    || !isReviewAction(reviewDecision.actionKind)
  ) {
    throw new Error(
      `INDEPENDENT_REVIEW_REQUIRED: a T3 review must come from a routed reviewer turn, not a ${String(reviewDecision.role || 'unknown')} ${String(reviewDecision.actionKind || 'turn')}`,
    );
  }
  if (
    reviewReceipt.enforcementStatus !== 'enforced'
    && reviewReceipt.enforcementStatus !== 'fallback'
  ) {
    throw new Error(
      `INDEPENDENT_REVIEW_REQUIRED: a T3 review cannot rest on ${String(reviewReceipt.enforcementStatus)} model routing`,
    );
  }
  if (
    implementationSession
    && reviewReceipt.actorSessionId
      === implementationSession.actorSessionId
  ) {
    throw new Error(
      'INDEPENDENT_REVIEW_REQUIRED: the reviewing session is the implementing session',
    );
  }
  return true;
};

export const buildReviewContract = ({
  stage,
  objective,
  acceptance = [],
  changedPaths = [],
}: {
  stage?: unknown;
  objective?: unknown;
  acceptance?: unknown[];
  changedPaths?: string[];
} = {}) => ({
  role: 'reviewer' as const,
  stage: stage ? String(stage) : null,
  permissions: 'read_only' as const,
  objective: String(objective || ''),
  input: { acceptance, changedPaths },
  output: {
    verdict: '',
    findings: [] as unknown[],
    risks: [] as unknown[],
  },
});


export type FuturesReviewCapability = 'available' | 'unavailable';

export type FuturesAssessmentReviewGateResult =
  | Readonly<{
    status: 'ready';
    blocker: null;
    reviewReceiptId: string;
    candidate: FuturesAssessment['actionCandidate'];
  }>
  | Readonly<{
    status: 'blocked';
    blocker: Readonly<{
      code: string;
      reasons: readonly string[];
    }>;
    reviewReceiptId: string | null;
    candidate: null;
  }>;

interface FuturesReviewRun extends UnknownRecord {
  runId: string;
  mutationRevision: number;
  currentWorkspaceIdentity: string;
}

const blockedFuturesReview = (
  code: string,
  reasons: readonly string[],
  reviewReceiptId: string | null = null,
): FuturesAssessmentReviewGateResult => Object.freeze({
  status: 'blocked' as const,
  blocker: Object.freeze({
    code,
    reasons: Object.freeze([...reasons]),
  }),
  reviewReceiptId,
  candidate: null,
});

export const resolveFuturesAssessmentReviewGate = ({
  assessment,
  reviewReceipt = null,
  reviewCapability = 'available',
  run,
  existingObligationIds = [],
}: {
  assessment: FuturesAssessment;
  reviewReceipt?: ReviewReceipt | null;
  reviewCapability?: FuturesReviewCapability;
  run: FuturesReviewRun;
  existingObligationIds?: readonly string[];
}): FuturesAssessmentReviewGateResult => {
  if (
    !assessment
    || assessment.status !== 'assessed'
    || assessment.color === null
  ) {
    return blockedFuturesReview('assessment-incomplete', ['assessment-not-actionable']);
  }

  if (
    String(run.mutationRevision) !== assessment.subject.revision
    || run.currentWorkspaceIdentity !== assessment.subject.contentDigest
  ) {
    return blockedFuturesReview('assessment-stale', [
      ...(String(run.mutationRevision) !== assessment.subject.revision
        ? ['assessment-stale-mutation-revision']
        : []),
      ...(run.currentWorkspaceIdentity !== assessment.subject.contentDigest
        ? ['assessment-stale-workspace-identity']
        : []),
    ]);
  }

  if (reviewCapability === 'unavailable') {
    return blockedFuturesReview(
      'no-independent-review-capability',
      ['review-capability-unavailable'],
    );
  }

  if (!reviewReceipt) {
    return blockedFuturesReview('review-receipt-missing', ['review-receipt-missing']);
  }

  if (
    !reviewReceipt.digest
    || reviewReceiptDigest(reviewReceipt as unknown as UnknownRecord) !== reviewReceipt.digest
  ) {
    return blockedFuturesReview(
      'review-receipt-invalid',
      ['review-receipt-digest-mismatch'],
      reviewReceipt.receiptId || null,
    );
  }

  if (reviewReceipt.subject.changedPathsDigest !== assessment.subject.changedPathsDigest) {
    return blockedFuturesReview(
      'review-stale-changed-paths',
      ['review-stale-changed-paths'],
      reviewReceipt.receiptId,
    );
  }

  const review = evaluateReviewReceipt({
    receipt: reviewReceipt,
    run,
    requireIndependentSession: true,
    requireFrontierClass: true,
    requireTrustedEnforcement: true,
    currentEvidenceDigest: assessment.digest,
  });
  if (!review.usable) {
    return blockedFuturesReview(
      'review-receipt-unusable',
      review.reasons,
      reviewReceipt.receiptId,
    );
  }

  if (assessment.actionCandidate.kind === 'existing-obligations') {
    const current = new Set(existingObligationIds.map(String));
    const missing = assessment.actionCandidate.obligationIds
      .filter((obligationId) => !current.has(obligationId));
    if (missing.length > 0) {
      return blockedFuturesReview(
        'assessment-obligation-stale',
        missing.map((obligationId) => `obligation-missing:${obligationId}`),
        reviewReceipt.receiptId,
      );
    }
  }

  return Object.freeze({
    status: 'ready' as const,
    blocker: null,
    reviewReceiptId: reviewReceipt.receiptId,
    candidate: assessment.actionCandidate,
  });
};
