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
import { canonicalJson } from '../canonical-digest.mjs';

export const REVIEW_RECEIPT_SCHEMA_VERSION = 1;
export const REVIEW_RECEIPT_VERDICTS = Object.freeze(['pass', 'fail', 'changes-requested']);
export const REVIEW_RECEIPT_STAGES = Object.freeze(['contract', 'engineering', 'complexity']);
export const REVIEW_FINDING_CLASSES = Object.freeze(['none', 'minor', 'important', 'critical']);

// `unrouted` is the honest status for a review the Host never routed through a
// model usage receipt. It is recorded rather than rejected so the lineage is
// visible, but it can never satisfy a protected or T3 judgment.
export const REVIEW_ENFORCEMENT_STATUSES = Object.freeze(['enforced', 'fallback', 'operator_approved', 'advisory', 'unsupported', 'failed', 'unrouted']);
// These prove the requested model class or authorized operator approval was actually applied.
export const TRUSTED_ENFORCEMENT_STATUSES = Object.freeze(['enforced', 'fallback', 'operator_approved']);

const SESSION_ID = /^sha256:[a-f0-9]{64}$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const RECEIPT_ID = /^review-receipt-[a-f0-9]{8,64}$/;

export class ReviewReceiptError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ReviewReceiptError';
    this.code = code;
  }
}

const fail = (code, message) => { throw new ReviewReceiptError(code, message); };

export const canonicalReviewReceiptJson = (receipt) => {
  const { digest, ...rest } = receipt || {};
  return canonicalJson(rest);
};

export const reviewReceiptDigest = (receipt) => `sha256:${createHash('sha256').update(canonicalReviewReceiptJson(receipt)).digest('hex')}`;

export const buildReviewReceiptId = ({ runId = 'run', obligationId = 'review', reviewStage = 'contract', reviewerSessionId = '', mutationRevision = 0, createdAt = '' } = {}) =>
  `review-receipt-${createHash('sha256').update(`${runId}|${obligationId}|${reviewStage}|${reviewerSessionId}|${mutationRevision}|${createdAt}`).digest('hex').slice(0, 24)}`;

export const reviewEvidenceRef = (runId, receiptId) => `review://${runId}/${receiptId}`;

export const parseReviewEvidenceRef = (evidenceRef) => {
  const match = /^review:\/\/([^/]+)\/(review-receipt-[a-f0-9]{8,64})$/.exec(String(evidenceRef || ''));
  if (!match) return null;
  return { runId: match[1], receiptId: match[2] };
};

// The executable evidence state a review was formed against. Judgment rows are
// excluded because recording one independent verdict must not invalidate every
// other verdict in the same review wave. Including them creates an impossible
// cycle for runs with multiple judgment obligations: the last receipt always
// makes the earlier receipts stale. Hard evidence remains in the digest, so a
// build or test rerun still invalidates every review that did not observe it.
export const digestOfEvidence = (verifications = [], { excludeObligationId = null } = {}) => `sha256:${createHash('sha256').update(canonicalJson(
  verifications
    .filter((verification) => verification.obligationId !== excludeObligationId)
    .filter((verification) => verification.evidenceClass !== 'judgment')
    .map((verification) => ({
      obligationId: verification.obligationId,
      status: verification.status,
      evidenceDigest: verification.evidenceDigest || null,
    }))
    .sort((a, b) => a.obligationId.localeCompare(b.obligationId)),
)).digest('hex')}`;

export const digestOfPaths = (paths = []) =>
  `sha256:${createHash('sha256').update(canonicalJson([...new Set((paths || []).map(String))].sort())).digest('hex')}`;

const requireSession = (value, field) => {
  if (!SESSION_ID.test(String(value || ''))) {
    fail('kernel_review_receipt_session_invalid', `${field} must be a sha256:<hex> digest so raw session identifiers never persist`);
  }
  return String(value);
};

// A receipt is only usable once it is closed and complete: no partially filled
// reviewer lineage, no free-text subject.
export const normalizeReviewReceipt = (input = {}) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('kernel_review_receipt_invalid', 'review receipt must be an object');
  if (!input.runId) fail('kernel_review_receipt_invalid', 'review receipt requires a runId');
  if (!input.obligationId) fail('kernel_review_receipt_invalid', 'review receipt requires the obligationId it answers');
  if (!REVIEW_RECEIPT_STAGES.includes(input.reviewStage)) fail('kernel_review_receipt_invalid', `reviewStage must be one of: ${REVIEW_RECEIPT_STAGES.join(', ')}`);
  if (!REVIEW_RECEIPT_VERDICTS.includes(input.verdict)) fail('kernel_review_receipt_invalid', `verdict must be one of: ${REVIEW_RECEIPT_VERDICTS.join(', ')}`);
  if (!input.rationale || String(input.rationale).trim() === '') fail('kernel_review_receipt_invalid', 'review receipt requires a rationale');

  const reviewer = input.reviewer || {};
  if (!REVIEW_ENFORCEMENT_STATUSES.includes(reviewer.enforcementStatus)) {
    fail('kernel_review_receipt_invalid', `reviewer.enforcementStatus must be one of: ${REVIEW_ENFORCEMENT_STATUSES.join(', ')}`);
  }
  if (!reviewer.modelClass) fail('kernel_review_receipt_invalid', 'reviewer.modelClass is required');
  if (reviewer.enforcementStatus === 'operator_approved' && !SHA256.test(String(reviewer.approvalRefDigest || ''))) {
    fail('kernel_review_receipt_invalid', 'operator_approved review receipt requires a scoped approvalRefDigest');
  }
  if (!['unrouted', 'operator_approved'].includes(reviewer.enforcementStatus) && !reviewer.usageReceiptId) {
    fail('kernel_review_receipt_invalid', 'a routed review receipt requires the reviewer usageReceiptId');
  }

  const subject = input.subject || {};
  if (!SHA256.test(String(subject.workspaceIdentity || ''))) fail('kernel_review_receipt_invalid', 'subject.workspaceIdentity must be a sha256:<hex> workspace identity');
  if (!Number.isInteger(subject.mutationRevision) || subject.mutationRevision < 0) fail('kernel_review_receipt_invalid', 'subject.mutationRevision must be a non-negative integer');
  if (!SHA256.test(String(subject.changedPathsDigest || ''))) fail('kernel_review_receipt_invalid', 'subject.changedPathsDigest must be a sha256:<hex> digest');
  if (!SHA256.test(String(subject.evidenceDigest || ''))) fail('kernel_review_receipt_invalid', 'subject.evidenceDigest must be a sha256:<hex> digest');

  const createdAt = input.createdAt ? String(input.createdAt) : new Date().toISOString();
  const receiptId = String(input.receiptId || buildReviewReceiptId({
    runId: input.runId,
    obligationId: input.obligationId,
    reviewStage: input.reviewStage,
    reviewerSessionId: reviewer.actorSessionId,
    mutationRevision: subject.mutationRevision,
    createdAt,
  }));
  if (!RECEIPT_ID.test(receiptId)) fail('kernel_review_receipt_invalid', 'receiptId must match review-receipt-<hex>');

  const base = {
    schemaVersion: REVIEW_RECEIPT_SCHEMA_VERSION,
    receiptId,
    runId: String(input.runId),
    obligationId: String(input.obligationId),
    stepId: input.stepId ? String(input.stepId) : null,
    reviewerBindingId: input.reviewerBindingId ? String(input.reviewerBindingId) : null,
    implementerAttemptId: input.implementerAttemptId ? String(input.implementerAttemptId) : null,
    reviewStage: input.reviewStage,
    verdict: input.verdict,
    findingClass: REVIEW_FINDING_CLASSES.includes(input.findingClass) ? input.findingClass : 'none',
    planRevision: Number.isInteger(input.planRevision) && input.planRevision > 0 ? input.planRevision : 1,
    reviewer: {
      actorSessionId: requireSession(reviewer.actorSessionId, 'reviewer.actorSessionId'),
      usageReceiptId: reviewer.usageReceiptId ? String(reviewer.usageReceiptId) : null,
      routeDecisionId: reviewer.routeDecisionId ? String(reviewer.routeDecisionId) : null,
      modelClass: String(reviewer.modelClass),
      resolvedModel: reviewer.resolvedModel ? String(reviewer.resolvedModel) : null,
      enforcementStatus: reviewer.enforcementStatus,
      approvalRefDigest: reviewer.approvalRefDigest ? String(reviewer.approvalRefDigest) : null,
    },
    implementer: {
      actorSessionId: input.implementer?.actorSessionId ? requireSession(input.implementer.actorSessionId, 'implementer.actorSessionId') : null,
      usageReceiptId: input.implementer?.usageReceiptId ? String(input.implementer.usageReceiptId) : null,
    },
    subject: {
      workspaceIdentity: String(subject.workspaceIdentity),
      mutationRevision: subject.mutationRevision,
      changedPathsDigest: String(subject.changedPathsDigest),
      evidenceDigest: String(subject.evidenceDigest),
    },
    acceptanceCoverage: [...new Set((Array.isArray(input.acceptanceCoverage) ? input.acceptanceCoverage : []).map(String))],
    findings: Array.isArray(input.findings) ? input.findings : [],
    rationale: String(input.rationale),
    createdByVersion: input.createdByVersion ? String(input.createdByVersion) : 'kernel.review-receipt.v1',
    migrationOrigin: input.migrationOrigin ? String(input.migrationOrigin) : null,
    createdAt,
  };
  return Object.freeze({ ...base, digest: reviewReceiptDigest(base) });
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
} = {}) => {
  const reasons = [];
  if (!receipt) return { usable: false, reasons: ['review-receipt-missing'] };
  if (receipt.verdict !== 'pass') reasons.push(`review-verdict-${receipt.verdict}`);
  // Evidence can change without the workspace changing — a failing check rerun
  // until it passes leaves the mutation revision untouched. A verdict formed
  // against a different evidence set is not a verdict about this one.
  const effectiveEvidenceDigest = currentEvidenceDigest
    || (run && Array.isArray(run.verifications) ? digestOfEvidence(run.verifications, { excludeObligationId: receipt.obligationId }) : null);
  if (effectiveEvidenceDigest && receipt.subject.evidenceDigest !== effectiveEvidenceDigest) {
    reasons.push('review-stale-evidence-set');
  }
  if (run) {
    if (run.runId && receipt.runId !== run.runId) reasons.push('review-receipt-run-mismatch');
    if (receipt.subject.mutationRevision !== run.mutationRevision) reasons.push('review-stale-mutation-revision');
    if (run.currentWorkspaceIdentity && receipt.subject.workspaceIdentity !== run.currentWorkspaceIdentity) {
      reasons.push('review-stale-workspace-identity');
    }
  }
  const isOperatorApproved = receipt.reviewer?.enforcementStatus === 'operator_approved';
  if (isOperatorApproved && !SHA256.test(String(receipt.reviewer?.approvalRefDigest || ''))) {
    reasons.push('operator-approval-ref-missing');
  }
  if (requireTrustedEnforcement && !TRUSTED_ENFORCEMENT_STATUSES.includes(receipt.reviewer.enforcementStatus)) {
    reasons.push(`review-routing-${receipt.reviewer.enforcementStatus}`);
  }
  if (!isOperatorApproved && requireFrontierClass && receipt.reviewer.modelClass !== 'frontier_reasoning') {
    reasons.push(`review-model-class-${receipt.reviewer.modelClass}`);
  }
  if (!isOperatorApproved && requireIndependentSession) {
    if (!receipt.implementer.actorSessionId) reasons.push('review-implementer-session-unknown');
    else if (receipt.implementer.actorSessionId === receipt.reviewer.actorSessionId) reasons.push('review-session-not-independent');
  }
  return { usable: reasons.length === 0, reasons };
};

export const assertReviewReceiptUsable = (options) => {
  const result = evaluateReviewReceipt(options);
  if (!result.usable) {
    fail('kernel_review_receipt_unusable', `REVIEW_RECEIPT_UNUSABLE: ${result.reasons.join(', ')}`);
  }
  return true;
};
