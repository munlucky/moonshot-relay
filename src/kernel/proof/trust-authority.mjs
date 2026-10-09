import { computeCompletionView } from '../run/completion-view.mjs';
import { digestOfEvidence, evaluateReviewReceipt } from './review-receipt.mjs';
import { isProtectedObligation } from './protected-obligations.mjs';
import { admissionAllowsDispatch } from '../routing/route-admission.mjs';

export const TRUST_AUTHORITY_SCHEMA_VERSION = 1;

// Trust Authority is the provider-free answer to one question: can the
// current result be accepted as complete? Provider, model, session, and cache
// lineage remains Host evidence; it must not become a second Kernel authority
// or leak into the model-visible authority graph.
const FORBIDDEN_TRUST_FIELDS = new Set([
  'provider', 'providerModel', 'model', 'modelClass', 'resolvedModel',
  'requestedModel', 'effort', 'resolvedEffort', 'requestedEffort',
  'sessionId', 'nativeSessionId', 'actorSessionId', 'usageReceiptId',
  'hostSurface', 'surface', 'adapter', 'adapterVersion', 'worktreeRoot',
  'gitState', 'cacheKey', 'promptCache', 'providerState', 'optimizationState',
]);

const list = (value) => (Array.isArray(value) ? value : []).map(String);

const requiredObligationsFor = ({ run = null, obligations = [] } = {}) => {
  const declared = Array.isArray(obligations) ? obligations : [];
  const byId = new Map(declared.map((item) => [String(item.obligationId), item]));
  const ids = Array.isArray(run?.requiredObligations) ? run.requiredObligations.map(String) : [];
  const fallback = ids
    .filter((id) => !byId.has(id))
    .map((obligationId) => ({ obligationId, status: 'required', evidenceClass: 'hard' }));
  return [...declared, ...fallback].filter((item) => item.status === 'required' || ids.includes(String(item.obligationId)));
};

const latestByObligation = (items = []) => {
  const latest = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    if (item?.obligationId) latest.set(String(item.obligationId), item);
  }
  return latest;
};

const scopeIdentityFor = (value) => {
  if (typeof value === 'string') return value;
  return value?.identity || value?.digest || null;
};

const freshnessForVerification = ({ verification = null, run = null, verificationScopeIdentities = {} } = {}) => {
  if (!verification) return { status: 'missing', reasons: ['verification-missing'] };
  if (verification.status !== 'passed') {
    return { status: verification.status === 'failed' ? 'failed' : 'stale', reasons: [`verification-${verification.status || 'not-passed'}`] };
  }

  const reasons = [];
  if (!verification.command) reasons.push('verification-command-missing');
  if (!verification.evidenceRef) reasons.push('evidence-reference-missing');
  if (Number(verification.exitCode) !== 0) reasons.push('verification-exit-nonzero');
  if (!/^sha256:[a-f0-9]{64}$/u.test(String(verification.evidenceDigest || ''))) reasons.push('evidence-digest-invalid');
  if (!run?.sourceIdentity || !verification.sourceIdentity) reasons.push('source-identity-unbound');
  else if (verification.sourceIdentity !== run.sourceIdentity) reasons.push('source-identity-mismatch');
  if (run?.contractRevision && Number(verification.contractRevision || 1) !== Number(run.contractRevision)) reasons.push('contract-revision-stale');

  const scopeDigest = verification.evidenceIdentity?.values?.verificationScopeDigest || null;
  if (scopeDigest) {
    const currentScopeDigest = scopeIdentityFor(verificationScopeIdentities?.[verification.obligationId]);
    if (!currentScopeDigest) reasons.push('verification-scope-unobserved');
    else if (scopeDigest !== currentScopeDigest) reasons.push('verification-scope-stale');
  } else {
    const verifiedMutation = verification.verifiedMutationRevision ?? verification.verifiedRuntimeRevision;
    if (verifiedMutation !== (run?.mutationRevision ?? null)) reasons.push('mutation-revision-stale');
    if (verification.verifiedSourceIdentity && run?.currentWorkspaceIdentity
      && verification.verifiedSourceIdentity !== run.currentWorkspaceIdentity) {
      reasons.push('workspace-identity-stale');
    }
  }

  if (run?.mutationRevision > 0 && verification.executor !== 'kernel-runtime') {
    reasons.push('kernel-runtime-evidence-required');
  }

  return {
    status: reasons.length === 0 ? 'fresh' : 'stale',
    reasons,
    basis: scopeDigest ? 'verification-scope' : 'mutation-revision',
    ...(scopeDigest ? { scopeDigest } : {}),
  };
};

const reviewFreshnessFor = ({
  receipt = null,
  obligation = null,
  run = null,
  verifications = [],
} = {}) => {
  const protectedObligation = Boolean(obligation?.protected) || isProtectedObligation(obligation?.obligationId);
  const independenceRequired = run?.proofTier === 'T3';
  const required = protectedObligation || independenceRequired;
  const currentEvidenceDigest = digestOfEvidence(verifications, {
    excludeObligationId: obligation?.obligationId || null,
  });
  const evaluation = evaluateReviewReceipt({
    receipt,
    run,
    requireIndependentSession: required,
    requireFrontierClass: required,
    requireTrustedEnforcement: required,
    currentEvidenceDigest,
  });
  const reasons = [...evaluation.reasons];
  if (!receipt) return {
    required,
    usable: false,
    status: 'missing',
    reasons,
    currentEvidenceDigest,
  };
  if (receipt.verdict !== 'pass') return {
    required,
    usable: false,
    status: 'failed',
    reasons,
    currentEvidenceDigest,
  };
  return {
    required,
    usable: evaluation.usable,
    status: evaluation.usable ? 'fresh' : 'stale',
    reasons,
    currentEvidenceDigest,
  };
};

const requirementEvidence = ({ obligation, verification, review, run } = {}) => {
  const evidenceClass = obligation.evidenceClass || 'hard';
  if (evidenceClass === 'judgment') {
    return review?.required
      ? review.usable
      : Boolean(verification?.status === 'passed' && verification.freshness?.status === 'fresh');
  }
  return Boolean(verification?.status === 'passed' && verification.freshness?.status === 'fresh'
    && (run?.mutationRevision <= 0 || verification.executor === 'kernel-runtime'));
};

const routeAdmissionView = (routeAdmissions = []) => {
  const latest = Array.isArray(routeAdmissions) ? routeAdmissions.at(-1) : null;
  if (!latest) return null;
  return {
    admissionId: latest.admissionId || null,
    decisionId: latest.decisionId || null,
    role: latest.role || null,
    riskTier: latest.riskTier || null,
    decision: latest.decision || null,
    rejectionCode: latest.rejectionCode || null,
    dispatchable: admissionAllowsDispatch(latest),
  };
};

const assertProviderFree = (value, path = '$') => {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertProviderFree(entry, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_TRUST_FIELDS.has(key)) throw new Error(`trust_authority_forbidden_field: ${path}.${key}`);
    assertProviderFree(child, `${path}.${key}`);
  }
};

export const validateTrustAuthority = (view) => {
  if (!view || typeof view !== 'object' || Array.isArray(view)) throw new TypeError('trust authority view must be an object');
  if (view.schemaVersion !== TRUST_AUTHORITY_SCHEMA_VERSION) throw new Error('trust_authority_schema_invalid');
  if (!view.run?.runId) throw new Error('trust_authority_identity_missing');
  if (!view.requirements || !view.evidence || !view.decision) throw new Error('trust_authority_graph_incomplete');
  assertProviderFree(view);
  return view;
};

export const buildTrustAuthorityView = ({
  run = null,
  obligations = [],
  verifications = [],
  reviews = [],
  completion = null,
  completionDecision = null,
  verificationScopeIdentities = {},
  routeAdmissions = [],
  step = null,
} = {}) => {
  if (!run) return null;

  const required = requiredObligationsFor({ run, obligations });
  const latestVerifications = latestByObligation(verifications);
  const latestReviews = latestByObligation(reviews);
  const completionView = computeCompletionView({
    run,
    step,
    verifications,
    obligations: required,
    reviews,
    completionDecision,
  });
  const completionStatus = new Map((completion?.obligationStatuses || []).map((entry) => [entry.obligationId, entry]));

  const hardEvidence = [];
  const reviewEvidence = [];
  const requirementViews = required.map((obligation) => {
    const obligationId = String(obligation.obligationId);
    const protectedObligation = Boolean(obligation.protected) || isProtectedObligation(obligationId);
    const verification = latestVerifications.get(obligationId) || null;
    const freshness = freshnessForVerification({ verification, run, verificationScopeIdentities });
    const verificationView = verification ? {
      obligationId,
      status: verification.status || 'missing',
      evidenceClass: verification.evidenceClass || null,
      evidenceDigest: verification.evidenceDigest || null,
      commandRef: verification.commandRef || null,
      executor: verification.executor || null,
      mutationRevision: verification.verifiedMutationRevision ?? verification.verifiedRuntimeRevision ?? null,
      acceptanceCoverage: list(verification.acceptanceCoverage),
      freshness,
    } : {
      obligationId,
      status: 'missing',
      evidenceClass: null,
      evidenceDigest: null,
      commandRef: null,
      executor: null,
      mutationRevision: null,
      acceptanceCoverage: [],
      freshness,
    };

    const review = obligation.evidenceClass === 'judgment'
      ? reviewFreshnessFor({
        receipt: latestReviews.get(obligationId) || null,
        obligation: { ...obligation, obligationId },
        run,
        verifications,
      })
      : null;
    const reviewView = review ? {
      obligationId,
      receiptId: latestReviews.get(obligationId)?.receiptId || null,
      verdict: latestReviews.get(obligationId)?.verdict || 'missing',
      evidenceDigest: latestReviews.get(obligationId)?.subject?.evidenceDigest || null,
      mutationRevision: latestReviews.get(obligationId)?.subject?.mutationRevision ?? null,
      acceptanceCoverage: list(latestReviews.get(obligationId)?.acceptanceCoverage),
      required: review.required,
      usable: review.usable,
      freshness: {
        status: review.status,
        reasons: review.reasons,
        evidenceDigest: review.currentEvidenceDigest,
      },
    } : null;

    if (obligation.evidenceClass === 'judgment') reviewEvidence.push(reviewView);
    else hardEvidence.push(verificationView);

    const derivedSatisfied = requirementEvidence({
      obligation,
      verification: verificationView,
      review,
      run,
    });
    const persisted = completionStatus.get(obligationId);
    return {
      obligationId,
      evidenceClass: obligation.evidenceClass || 'hard',
      status: obligation.status || 'required',
      protected: protectedObligation,
      acceptanceIds: list(obligation.acceptanceIds),
      allowedCommandRefs: list(obligation.allowedCommandRefs),
      reviewRequired: Boolean(review?.required),
      satisfied: derivedSatisfied,
      persistedSatisfied: persisted?.satisfied === true,
      evidenceStatus: obligation.evidenceClass === 'judgment' ? review?.status || 'missing' : freshness.status,
    };
  });

  const unsatisfied = requirementViews.filter((entry) => !entry.satisfied).map((entry) => entry.obligationId);
  const reasons = unsatisfied.map((obligationId) => `requirement-unsatisfied:${obligationId}`);
  const staleEvidence = [...hardEvidence, ...reviewEvidence]
    .filter((entry) => entry.freshness?.status && !['fresh'].includes(entry.freshness.status));
  for (const evidence of staleEvidence) {
    for (const reason of evidence.freshness.reasons || []) reasons.push(`${evidence.obligationId}:${reason}`);
  }
  if (completion?.decision === 'blocked' && completionDecision?.decision === 'rejected') reasons.push('completion-decision-rejected');
  if (completion?.gates) {
    for (const [gate, satisfied] of Object.entries(completion.gates)) {
      if (satisfied !== true) reasons.push(`completion-gate-unsatisfied:${gate}`);
    }
  }
  const routeView = routeAdmissionView(routeAdmissions);
  if (routeView && !routeView.dispatchable) reasons.push(`route-admission-${routeView.decision || 'blocked'}`);
  const uniqueReasons = [...new Set(reasons)];
  const evidenceSatisfied = unsatisfied.length === 0;
  const completionAccepted = completion?.decision === 'accepted' || completionDecision?.decision === 'accepted';
  const accepted = completionAccepted && evidenceSatisfied && uniqueReasons.length === 0;
  const decisionStatus = accepted
    ? 'accepted'
    : (completion?.decision === 'blocked' || completionDecision?.decision === 'rejected' || uniqueReasons.length > 0 ? 'blocked' : 'pending');

  const view = {
    schemaVersion: TRUST_AUTHORITY_SCHEMA_VERSION,
    run: {
      runId: String(run.runId),
      mutationRevision: Number(run.mutationRevision || 0),
      contractRevision: Number(run.contractRevision || 1),
      proofTier: run.proofTier || null,
    },
    requirements: requirementViews,
    evidence: {
      hard: hardEvidence,
      review: reviewEvidence,
    },
    decision: {
      status: decisionStatus,
      accepted,
      reasons: uniqueReasons,
      completion: completionView,
      gates: completion?.gates || null,
      evidenceDigest: completionDecision?.evidenceDigest || completion?.decisionPayload?.evidenceDigest || null,
      mutationRevision: Number(run.mutationRevision || 0),
    },
    routeAdmission: routeView,
  };
  return validateTrustAuthority(view);
};
