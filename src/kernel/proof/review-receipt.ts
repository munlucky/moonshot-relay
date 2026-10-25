import type { KernelReviewReceipt } from '../../contracts/generated/kernel.review-receipt.js';
import { parseKernelContract } from '../../contracts/schema-codec.js';
import { matchCapture } from '../../shared/match-capture.js';
// Review Receipt (K0). A judgment obligation used to be satisfiable with two
// different reviewer STRINGS, which is not evidence of anything: anyone could
// invent them. A Review Receipt binds a review verdict to the lineage that
// actually produced it —
//
//   model route decision -> host dispatch -> model usage receipt ->
//   structured verdict -> review receipt -> judgment verification
//
// and to the subject it reviewed (workspace identity + mutation revision), so a
// review of an older workspace goes stale instead of silently completing a run.

import { createHash } from 'node:crypto';
import { canonicalJson } from '../../shared/canonical-digest.js';

type UnknownRecord = Record<string, unknown>;

interface VerificationLike extends UnknownRecord {
  obligationId?: unknown;
  evidenceClass?: unknown;
  status?: unknown;
  evidenceDigest?: unknown;
}

interface ReviewerLike extends UnknownRecord {
  actorSessionId?: unknown;
  usageReceiptId?: unknown;
  routeDecisionId?: unknown;
  modelClass?: unknown;
  resolvedModel?: unknown;
  enforcementStatus?: unknown;
  approvalRefDigest?: unknown;
}

interface ImplementerLike extends UnknownRecord {
  actorSessionId?: unknown;
  usageReceiptId?: unknown;
}

interface SubjectLike extends UnknownRecord {
  workspaceIdentity?: unknown;
  mutationRevision?: unknown;
  changedPathsDigest?: unknown;
  evidenceDigest?: unknown;
}

export interface ReviewReceiptInput extends UnknownRecord {
  runId?: unknown;
  obligationId?: unknown;
  stepId?: unknown;
  reviewerBindingId?: unknown;
  implementerAttemptId?: unknown;
  reviewStage?: unknown;
  verdict?: unknown;
  findingClass?: unknown;
  planRevision?: unknown;
  reviewer?: ReviewerLike;
  implementer?: ImplementerLike;
  subject?: SubjectLike;
  acceptanceCoverage?: unknown;
  findings?: unknown;
  rationale?: unknown;
  createdByVersion?: unknown;
  migrationOrigin?: unknown;
  createdAt?: unknown;
  receiptId?: unknown;
}

export type ReviewReceipt = KernelReviewReceipt;

interface ReviewRunLike extends UnknownRecord {
  runId?: unknown;
  mutationRevision?: unknown;
  currentWorkspaceIdentity?: unknown;
  verifications?: VerificationLike[];
}

export interface EvaluateReviewReceiptInput {
  receipt?: {
    runId: string;
    obligationId?: string;
    verdict: string;
    subject: ReviewReceipt['subject'];
    reviewer: { modelClass: string; enforcementStatus: string; actorSessionId: string | null; approvalRefDigest?: string | null };
    implementer: Pick<ReviewReceipt['implementer'], 'actorSessionId'>;
  } | null;
  run?: ReviewRunLike | null;
  requireIndependentSession?: boolean;
  requireFrontierClass?: boolean;
  requireTrustedEnforcement?: boolean;
  currentEvidenceDigest?: string | null;
}

export interface ReviewReceiptEvaluation {
  usable: boolean;
  reasons: string[];
}

export const REVIEW_RECEIPT_SCHEMA_VERSION = 1;
export const REVIEW_RECEIPT_VERDICTS = Object.freeze(['pass', 'fail', 'changes-requested'] as const);
export const REVIEW_RECEIPT_STAGES = Object.freeze(['contract', 'engineering', 'complexity'] as const);
export const REVIEW_FINDING_CLASSES = Object.freeze(['none', 'minor', 'important', 'critical'] as const);

// `unrouted` is the honest status for a review the Host never routed through a
// model usage receipt. It is recorded rather than rejected so the lineage is
// visible, but it can never satisfy a protected or T3 judgment.
export const REVIEW_ENFORCEMENT_STATUSES = Object.freeze([
  'enforced',
  'fallback',
  'operator_approved',
  'advisory',
  'unsupported',
  'failed',
  'unrouted',
] as const);

// These prove the requested model class or authorized operator approval was actually applied.
export const TRUSTED_ENFORCEMENT_STATUSES = Object.freeze([
  'enforced',
  'fallback',
  'operator_approved',
] as const);

export const reviewSubjectKey = (receipt: ReviewReceiptInput = {}) => `review-subject-${createHash('sha256').update(JSON.stringify({
  runId: receipt.runId || null,
  obligationId: receipt.obligationId || null,
  stepId: receipt.stepId || null,
  planRevision: Number(receipt.planRevision || 1),
  mutationRevision: Number(receipt.subject?.mutationRevision || 0),
  workspaceIdentity: receipt.subject?.workspaceIdentity || null,
  changedPathsDigest: receipt.subject?.changedPathsDigest || null,
  evidenceDigest: receipt.subject?.evidenceDigest || null,
})).digest('hex')}`;

export const reviewSubjectAdoptionEligible = (receipt: ReviewReceiptInput = {}) => {
  const enforcement = receipt.reviewer?.enforcementStatus || null;
  if (!(TRUSTED_ENFORCEMENT_STATUSES as readonly unknown[]).includes(enforcement)) return false;
  if (enforcement === 'operator_approved') return true;
  if (receipt.reviewer?.modelClass !== 'frontier_reasoning') return false;
  const reviewerSession = receipt.reviewer?.actorSessionId || null;
  const implementerSession = receipt.implementer?.actorSessionId || null;
  return Boolean(reviewerSession && implementerSession && reviewerSession !== implementerSession);
};

const SESSION_ID = /^sha256:[a-f0-9]{64}$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const RECEIPT_ID = /^review-receipt-[a-f0-9]{8,64}$/;

const stringIn = (values: readonly string[], value: unknown): boolean => values.includes(String(value));

export class ReviewReceiptError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ReviewReceiptError';
    this.code = code;
  }
}

const fail = (code: string, message: string): never => {
  throw new ReviewReceiptError(code, message);
};

export const canonicalReviewReceiptJson = (receipt: UnknownRecord | null | undefined): string => {
  const { digest: _digest, ...rest } = receipt || {};
  return canonicalJson(rest);
};

export const reviewReceiptDigest = (receipt: UnknownRecord): string => (
  `sha256:${createHash('sha256').update(canonicalReviewReceiptJson(receipt)).digest('hex')}`
);

export const buildReviewReceiptId = ({
  runId = 'run',
  obligationId = 'review',
  reviewStage = 'contract',
  reviewerSessionId = '',
  mutationRevision = 0,
  createdAt = '',
}: {
  runId?: unknown;
  obligationId?: unknown;
  reviewStage?: unknown;
  reviewerSessionId?: unknown;
  mutationRevision?: unknown;
  createdAt?: unknown;
} = {}): string => (
  `review-receipt-${createHash('sha256')
    .update(`${runId}|${obligationId}|${reviewStage}|${reviewerSessionId}|${mutationRevision}|${createdAt}`)
    .digest('hex')
    .slice(0, 24)}`
);

export const reviewEvidenceRef = (runId: unknown, receiptId: unknown): string => (
  `review://${String(runId)}/${String(receiptId)}`
);

export const parseReviewEvidenceRef = (
  evidenceRef: unknown,
): { runId: string; receiptId: string } | null => {
  const match = /^review:\/\/([^/]+)\/(review-receipt-[a-f0-9]{8,64})$/.exec(String(evidenceRef || ''));
  if (!match) return null;
  return { runId: matchCapture(match, 1), receiptId: matchCapture(match, 2) };
};

// The executable evidence state a review was formed against. Judgment rows are
// excluded because recording one independent verdict must not invalidate every
// other verdict in the same review wave. Including them creates an impossible
// cycle for runs with multiple judgment obligations: the last receipt always
// makes the earlier receipts stale. Hard evidence remains in the digest, so a
// build or test rerun still invalidates every review that did not observe it.
export const digestOfEvidence = (
  verifications: VerificationLike[] = [],
  { excludeObligationId = null }: { excludeObligationId?: unknown } = {},
): string => `sha256:${createHash('sha256').update(canonicalJson(
  verifications
    .filter((verification) => verification.obligationId !== excludeObligationId)
    .filter((verification) => verification.evidenceClass !== 'judgment')
    .map((verification) => ({
      obligationId: String(verification.obligationId || ''),
      status: verification.status,
      evidenceDigest: verification.evidenceDigest || null,
    }))
    .sort((a, b) => a.obligationId.localeCompare(b.obligationId)),
)).digest('hex')}`;

export const digestOfPaths = (paths: unknown[] = []): string => (
  `sha256:${createHash('sha256')
    .update(canonicalJson([...new Set((paths || []).map(String))].sort()))
    .digest('hex')}`
);

const requireSession = (value: unknown, field: string): string => {
  if (!SESSION_ID.test(String(value || ''))) {
    fail(
      'kernel_review_receipt_session_invalid',
      `${field} must be a sha256:<hex> digest so raw session identifiers never persist`,
    );
  }
  return String(value);
};

// A receipt is only usable once it is closed and complete: no partially filled
// reviewer lineage, no free-text subject.
export const normalizeReviewReceipt = (input: ReviewReceiptInput = {}): Readonly<ReviewReceipt> => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail('kernel_review_receipt_invalid', 'review receipt must be an object');
  }
  if (!input.runId) fail('kernel_review_receipt_invalid', 'review receipt requires a runId');
  if (!input.obligationId) {
    fail('kernel_review_receipt_invalid', 'review receipt requires the obligationId it answers');
  }
  if (!stringIn(REVIEW_RECEIPT_STAGES, input.reviewStage)) {
    fail(
      'kernel_review_receipt_invalid',
      `reviewStage must be one of: ${REVIEW_RECEIPT_STAGES.join(', ')}`,
    );
  }
  if (!stringIn(REVIEW_RECEIPT_VERDICTS, input.verdict)) {
    fail(
      'kernel_review_receipt_invalid',
      `verdict must be one of: ${REVIEW_RECEIPT_VERDICTS.join(', ')}`,
    );
  }
  if (!input.rationale || String(input.rationale).trim() === '') {
    fail('kernel_review_receipt_invalid', 'review receipt requires a rationale');
  }

  const reviewer = input.reviewer || {};
  if (!stringIn(REVIEW_ENFORCEMENT_STATUSES, reviewer.enforcementStatus)) {
    fail(
      'kernel_review_receipt_invalid',
      `reviewer.enforcementStatus must be one of: ${REVIEW_ENFORCEMENT_STATUSES.join(', ')}`,
    );
  }
  if (!reviewer.modelClass) {
    fail('kernel_review_receipt_invalid', 'reviewer.modelClass is required');
  }
  if (
    reviewer.enforcementStatus === 'operator_approved'
    && !SHA256.test(String(reviewer.approvalRefDigest || ''))
  ) {
    fail(
      'kernel_review_receipt_invalid',
      'operator_approved review receipt requires a scoped approvalRefDigest',
    );
  }
  if (
    !['unrouted', 'operator_approved'].includes(String(reviewer.enforcementStatus))
    && !reviewer.usageReceiptId
  ) {
    fail(
      'kernel_review_receipt_invalid',
      'a routed review receipt requires the reviewer usageReceiptId',
    );
  }

  const subject = input.subject || {};
  if (!SHA256.test(String(subject.workspaceIdentity || ''))) {
    fail(
      'kernel_review_receipt_invalid',
      'subject.workspaceIdentity must be a sha256:<hex> workspace identity',
    );
  }

  const mutationRevision = Number(subject.mutationRevision);
  if (!Number.isInteger(mutationRevision) || mutationRevision < 0) {
    fail(
      'kernel_review_receipt_invalid',
      'subject.mutationRevision must be a non-negative integer',
    );
  }
  if (!SHA256.test(String(subject.changedPathsDigest || ''))) {
    fail(
      'kernel_review_receipt_invalid',
      'subject.changedPathsDigest must be a sha256:<hex> digest',
    );
  }
  if (!SHA256.test(String(subject.evidenceDigest || ''))) {
    fail(
      'kernel_review_receipt_invalid',
      'subject.evidenceDigest must be a sha256:<hex> digest',
    );
  }

  const createdAt = input.createdAt ? String(input.createdAt) : new Date().toISOString();
  const receiptId = String(input.receiptId || buildReviewReceiptId({
    runId: input.runId,
    obligationId: input.obligationId,
    reviewStage: input.reviewStage,
    reviewerSessionId: reviewer.actorSessionId,
    mutationRevision,
    createdAt,
  }));

  if (!RECEIPT_ID.test(receiptId)) {
    fail('kernel_review_receipt_invalid', 'receiptId must match review-receipt-<hex>');
  }

  const findingClass = stringIn(REVIEW_FINDING_CLASSES, input.findingClass)
    ? String(input.findingClass)
    : 'none';
  const planRevision = Number(input.planRevision);

  const base = {
    schemaVersion: REVIEW_RECEIPT_SCHEMA_VERSION,
    receiptId,
    runId: String(input.runId),
    obligationId: String(input.obligationId),
    stepId: input.stepId ? String(input.stepId) : null,
    reviewerBindingId: input.reviewerBindingId ? String(input.reviewerBindingId) : null,
    implementerAttemptId: input.implementerAttemptId ? String(input.implementerAttemptId) : null,
    reviewStage: String(input.reviewStage),
    verdict: String(input.verdict),
    findingClass,
    planRevision: Number.isInteger(planRevision) && planRevision > 0 ? planRevision : 1,
    reviewer: {
      actorSessionId: requireSession(reviewer.actorSessionId, 'reviewer.actorSessionId'),
      usageReceiptId: reviewer.usageReceiptId ? String(reviewer.usageReceiptId) : null,
      routeDecisionId: reviewer.routeDecisionId ? String(reviewer.routeDecisionId) : null,
      modelClass: String(reviewer.modelClass),
      resolvedModel: reviewer.resolvedModel ? String(reviewer.resolvedModel) : null,
      enforcementStatus: String(reviewer.enforcementStatus),
      approvalRefDigest: reviewer.approvalRefDigest ? String(reviewer.approvalRefDigest) : null,
    },
    implementer: {
      actorSessionId: input.implementer?.actorSessionId
        ? requireSession(input.implementer.actorSessionId, 'implementer.actorSessionId')
        : null,
      usageReceiptId: input.implementer?.usageReceiptId
        ? String(input.implementer.usageReceiptId)
        : null,
    },
    subject: {
      workspaceIdentity: String(subject.workspaceIdentity),
      mutationRevision,
      changedPathsDigest: String(subject.changedPathsDigest),
      evidenceDigest: String(subject.evidenceDigest),
    },
    acceptanceCoverage: [
      ...new Set(
        (Array.isArray(input.acceptanceCoverage) ? input.acceptanceCoverage : []).map(String),
      ),
    ],
    findings: Array.isArray(input.findings) ? input.findings : [],
    rationale: String(input.rationale),
    createdByVersion: input.createdByVersion
      ? String(input.createdByVersion)
      : 'kernel.review-receipt.v1',
    migrationOrigin: input.migrationOrigin ? String(input.migrationOrigin) : null,
    createdAt,
  };

  return Object.freeze(parseKernelContract('kernel.review-receipt', {
    ...base,
    digest: reviewReceiptDigest(base),
  }));
};

// Is this receipt still usable as the proof of a judgment obligation, HERE and
// NOW? Returns every reason it is not, so the completion gate can explain
// itself instead of just refusing.
export const evaluateReviewReceipt = ({
  receipt,
  run,
  requireIndependentSession = false,
  requireFrontierClass = false,
  requireTrustedEnforcement = false,
  currentEvidenceDigest = null,
}: EvaluateReviewReceiptInput = {}): ReviewReceiptEvaluation => {
  const reasons: string[] = [];
  if (!receipt) return { usable: false, reasons: ['review-receipt-missing'] };

  if (receipt.verdict !== 'pass') reasons.push(`review-verdict-${receipt.verdict}`);

  // Evidence can change without the workspace changing — a failing check rerun
  // until it passes leaves the mutation revision untouched. A verdict formed
  // against a different evidence set is not a verdict about this one.
  const effectiveEvidenceDigest = currentEvidenceDigest
    || (
      run && Array.isArray(run.verifications)
        ? digestOfEvidence(run.verifications, { excludeObligationId: receipt.obligationId })
        : null
    );

  if (effectiveEvidenceDigest && receipt.subject.evidenceDigest !== effectiveEvidenceDigest) {
    reasons.push('review-stale-evidence-set');
  }

  if (run) {
    if (run.runId && receipt.runId !== String(run.runId)) {
      reasons.push('review-receipt-run-mismatch');
    }
    if (receipt.subject.mutationRevision !== Number(run.mutationRevision)) {
      reasons.push('review-stale-mutation-revision');
    }
    if (
      run.currentWorkspaceIdentity
      && receipt.subject.workspaceIdentity !== String(run.currentWorkspaceIdentity)
    ) {
      reasons.push('review-stale-workspace-identity');
    }
  }

  const isOperatorApproved = receipt.reviewer.enforcementStatus === 'operator_approved';
  if (isOperatorApproved && !SHA256.test(String(receipt.reviewer.approvalRefDigest || ''))) {
    reasons.push('operator-approval-ref-missing');
  }
  if (
    requireTrustedEnforcement
    && !stringIn(TRUSTED_ENFORCEMENT_STATUSES, receipt.reviewer.enforcementStatus)
  ) {
    reasons.push(`review-routing-${receipt.reviewer.enforcementStatus}`);
  }
  if (
    !isOperatorApproved
    && requireFrontierClass
    && receipt.reviewer.modelClass !== 'frontier_reasoning'
  ) {
    reasons.push(`review-model-class-${receipt.reviewer.modelClass}`);
  }
  if (!isOperatorApproved && requireIndependentSession) {
    if (!receipt.implementer.actorSessionId) {
      reasons.push('review-implementer-session-unknown');
    } else if (receipt.implementer.actorSessionId === receipt.reviewer.actorSessionId) {
      reasons.push('review-session-not-independent');
    }
  }

  return { usable: reasons.length === 0, reasons };
};

export const assertReviewReceiptUsable = (options: EvaluateReviewReceiptInput): true => {
  const result = evaluateReviewReceipt(options);
  if (!result.usable) {
    fail(
      'kernel_review_receipt_unusable',
      `REVIEW_RECEIPT_UNUSABLE: ${result.reasons.join(', ')}`,
    );
  }
  return true;
};
