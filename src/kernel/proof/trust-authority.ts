import { computeCompletionView } from './completion-view.js';
import {
  digestOfEvidence,
  evaluateReviewReceipt,
  type ReviewReceipt,
} from './review-receipt.js';
import { isProtectedObligation } from './protected-obligations.js';
import { admissionAllowsDispatch } from '../routing/route-admission.js';

type UnknownRecord = Record<string, unknown>;

interface CompletionPredicateLike {
  requiredOutcomes?: string[];
  [key: string]: unknown;
}

interface TaskContractLike {
  completionPredicate?: CompletionPredicateLike | null;
  [key: string]: unknown;
}

interface RunLike extends UnknownRecord {
  runId: string;
  requiredObligations?: unknown;
  sourceIdentity?: unknown;
  contractRevision?: number | null;
  mutationRevision?: number | null;
  currentWorkspaceIdentity?: unknown;
  proofTier?: string | null;
  status?: string | null;
  finalizationStatus?: string | null;
  taskContract?: TaskContractLike | null;
}

interface StepLike extends UnknownRecord {
  state?: string | null;
}

interface ObligationMetadataLike extends UnknownRecord {
  outcomes?: unknown[];
  outcome?: unknown;
}

interface ObligationLike extends UnknownRecord {
  obligationId: string;
  status?: string | null;
  evidenceClass?: string | null;
  protected?: unknown;
  acceptanceIds?: unknown;
  allowedCommandRefs?: unknown;
  metadata?: ObligationMetadataLike | null;
}

interface EvidenceIdentityValuesLike extends UnknownRecord {
  verificationScopeDigest?: unknown;
}

interface EvidenceIdentityLike extends UnknownRecord {
  values?: EvidenceIdentityValuesLike | null;
}

interface VerificationLike extends UnknownRecord {
  obligationId: string;
  status?: string | null;
  evidenceClass?: string | null;
  evidenceDigest?: unknown;
  evidenceRef?: unknown;
  command?: unknown;
  commandRef?: unknown;
  exitCode?: unknown;
  sourceIdentity?: unknown;
  contractRevision?: unknown;
  evidenceIdentity?: EvidenceIdentityLike | null;
  verifiedMutationRevision?: unknown;
  verifiedRuntimeRevision?: unknown;
  verifiedSourceIdentity?: unknown;
  executor?: unknown;
  acceptanceCoverage?: unknown;
}

interface CompletionObligationStatusLike extends UnknownRecord {
  obligationId: string;
  satisfied?: unknown;
}

interface CompletionLike extends UnknownRecord {
  decision?: string | null;
  obligationStatuses?: CompletionObligationStatusLike[];
  gates?: Record<string, unknown> | null;
  decisionPayload?: {
    evidenceDigest?: unknown;
    [key: string]: unknown;
  } | null;
}

interface CompletionDecisionLike extends UnknownRecord {
  decision?: string | null;
  evidenceDigest?: unknown;
}

interface ScopeIdentityLike extends UnknownRecord {
  identity?: unknown;
  digest?: unknown;
}

interface RouteAdmissionRecord extends UnknownRecord {
  admissionId?: unknown;
  decisionId?: unknown;
  role?: unknown;
  riskTier?: unknown;
  decision?: string | null;
  rejectionCode?: unknown;
}

interface VerificationFreshness {
  status: 'missing' | 'failed' | 'stale' | 'fresh';
  reasons: string[];
  basis?: 'verification-scope' | 'mutation-revision';
  scopeDigest?: unknown;
}

interface ReviewFreshness {
  required: boolean;
  usable: boolean;
  status: 'missing' | 'failed' | 'stale' | 'fresh';
  reasons: string[];
  currentEvidenceDigest: string;
}

interface EvidenceFreshnessView {
  status: string;
  reasons: string[];
  evidenceDigest?: string;
}

interface EvidenceView extends UnknownRecord {
  obligationId: string;
  freshness: EvidenceFreshnessView;
}

interface VerificationEvidenceView extends EvidenceView {
  status: string;
  evidenceClass: unknown;
  evidenceDigest: unknown;
  commandRef: unknown;
  executor: unknown;
  mutationRevision: unknown;
  acceptanceCoverage: string[];
}

interface ReviewEvidenceView extends EvidenceView {
  receiptId: string | null;
  verdict: string;
  evidenceDigest: string | null;
  mutationRevision: number | null;
  acceptanceCoverage: string[];
  required: boolean;
  usable: boolean;
}

interface RequirementView extends UnknownRecord {
  obligationId: string;
  evidenceClass: string;
  status: string;
  protected: boolean;
  acceptanceIds: string[];
  allowedCommandRefs: string[];
  reviewRequired: boolean;
  satisfied: boolean;
  persistedSatisfied: boolean;
  evidenceStatus: string;
}

interface RouteAdmissionView extends UnknownRecord {
  admissionId: string | null;
  decisionId: string | null;
  role: string | null;
  riskTier: string | null;
  decision: string | null;
  rejectionCode: string | null;
  dispatchable: boolean;
}

export interface BuildTrustAuthorityViewInput {
  run?: RunLike | null;
  obligations?: ObligationLike[];
  verifications?: VerificationLike[];
  reviews?: ReviewReceipt[];
  completion?: CompletionLike | null;
  completionDecision?: CompletionDecisionLike | null;
  verificationScopeIdentities?: Record<string, string | ScopeIdentityLike | null | undefined>;
  routeAdmissions?: RouteAdmissionRecord[];
  step?: StepLike | null;
}

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

const isRecord = (value: unknown): value is UnknownRecord => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
);

const list = (value: unknown): string[] => (
  Array.isArray(value) ? value : []
).map(String);

const requiredObligationsFor = ({
  run = null,
  obligations = [],
}: {
  run?: RunLike | null;
  obligations?: ObligationLike[];
} = {}): ObligationLike[] => {
  const declared = Array.isArray(obligations) ? obligations : [];
  const byId = new Map(declared.map((item) => [String(item.obligationId), item]));
  const ids = Array.isArray(run?.requiredObligations)
    ? run.requiredObligations.map(String)
    : [];
  const fallback: ObligationLike[] = ids
    .filter((id) => !byId.has(id))
    .map((obligationId) => ({
      obligationId,
      status: 'required',
      evidenceClass: 'hard',
    }));
  return [...declared, ...fallback].filter(
    (item) => item.status === 'required' || ids.includes(String(item.obligationId)),
  );
};

const latestByObligation = <T extends { obligationId?: unknown }>(
  items: T[] = [],
): Map<string, T> => {
  const latest = new Map<string, T>();
  for (const item of Array.isArray(items) ? items : []) {
    if (item?.obligationId) latest.set(String(item.obligationId), item);
  }
  return latest;
};

const scopeIdentityFor = (value: unknown): unknown => {
  if (typeof value === 'string') return value;
  if (!isRecord(value)) return null;
  return value.identity || value.digest || null;
};

const freshnessForVerification = ({
  verification = null,
  run = null,
  verificationScopeIdentities = {},
}: {
  verification?: VerificationLike | null;
  run?: RunLike | null;
  verificationScopeIdentities?: Record<string, string | ScopeIdentityLike | null | undefined>;
} = {}): VerificationFreshness => {
  if (!verification) {
    return { status: 'missing', reasons: ['verification-missing'] };
  }
  if (verification.status !== 'passed') {
    return {
      status: verification.status === 'failed' ? 'failed' : 'stale',
      reasons: [`verification-${verification.status || 'not-passed'}`],
    };
  }

  const reasons: string[] = [];
  if (!verification.command) reasons.push('verification-command-missing');
  if (!verification.evidenceRef) reasons.push('evidence-reference-missing');
  if (Number(verification.exitCode) !== 0) reasons.push('verification-exit-nonzero');
  if (!/^sha256:[a-f0-9]{64}$/u.test(String(verification.evidenceDigest || ''))) {
    reasons.push('evidence-digest-invalid');
  }
  if (!run?.sourceIdentity || !verification.sourceIdentity) {
    reasons.push('source-identity-unbound');
  } else if (verification.sourceIdentity !== run.sourceIdentity) {
    reasons.push('source-identity-mismatch');
  }
  if (
    run?.contractRevision
    && Number(verification.contractRevision || 1) !== Number(run.contractRevision)
  ) {
    reasons.push('contract-revision-stale');
  }

  const scopeDigest = verification.evidenceIdentity?.values?.verificationScopeDigest || null;
  if (scopeDigest) {
    const currentScopeDigest = scopeIdentityFor(
      verificationScopeIdentities[String(verification.obligationId)],
    );
    if (!currentScopeDigest) {
      reasons.push('verification-scope-unobserved');
    } else if (scopeDigest !== currentScopeDigest) {
      reasons.push('verification-scope-stale');
    }
  } else {
    const verifiedMutation = verification.verifiedMutationRevision
      ?? verification.verifiedRuntimeRevision;
    if (verifiedMutation !== (run?.mutationRevision ?? null)) {
      reasons.push('mutation-revision-stale');
    }
    if (
      verification.verifiedSourceIdentity
      && run?.currentWorkspaceIdentity
      && verification.verifiedSourceIdentity !== run.currentWorkspaceIdentity
    ) {
      reasons.push('workspace-identity-stale');
    }
  }

  if (
    Number(run?.mutationRevision || 0) > 0
    && verification.executor !== 'kernel-runtime'
  ) {
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
}: {
  receipt?: ReviewReceipt | null;
  obligation?: ObligationLike | null;
  run?: RunLike | null;
  verifications?: VerificationLike[];
} = {}): ReviewFreshness => {
  const protectedObligation = Boolean(obligation?.protected)
    || isProtectedObligation(obligation?.obligationId);
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

  if (!receipt) {
    return {
      required,
      usable: false,
      status: 'missing',
      reasons,
      currentEvidenceDigest,
    };
  }
  if (receipt.verdict !== 'pass') {
    return {
      required,
      usable: false,
      status: 'failed',
      reasons,
      currentEvidenceDigest,
    };
  }
  return {
    required,
    usable: evaluation.usable,
    status: evaluation.usable ? 'fresh' : 'stale',
    reasons,
    currentEvidenceDigest,
  };
};

const requirementEvidence = ({
  obligation,
  verification,
  review,
  run,
}: {
  obligation: ObligationLike;
  verification: VerificationEvidenceView;
  review: ReviewFreshness | null;
  run: RunLike;
}): boolean => {
  const evidenceClass = obligation.evidenceClass || 'hard';
  if (evidenceClass === 'judgment') {
    return review?.required
      ? review.usable
      : Boolean(
        verification.status === 'passed'
        && verification.freshness.status === 'fresh',
      );
  }
  return Boolean(
    verification.status === 'passed'
    && verification.freshness.status === 'fresh'
    && (
      Number(run.mutationRevision || 0) <= 0
      || verification.executor === 'kernel-runtime'
    ),
  );
};

const routeAdmissionView = (
  routeAdmissions: RouteAdmissionRecord[] = [],
): RouteAdmissionView | null => {
  const latest = Array.isArray(routeAdmissions) ? routeAdmissions.at(-1) : null;
  if (!latest) return null;
  return {
    admissionId: latest.admissionId ? String(latest.admissionId) : null,
    decisionId: latest.decisionId ? String(latest.decisionId) : null,
    role: latest.role ? String(latest.role) : null,
    riskTier: latest.riskTier ? String(latest.riskTier) : null,
    decision: latest.decision || null,
    rejectionCode: latest.rejectionCode ? String(latest.rejectionCode) : null,
    dispatchable: admissionAllowsDispatch(latest),
  };
};

const assertProviderFree = (value: unknown, path = '$'): void => {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertProviderFree(entry, `${path}[${index}]`));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_TRUST_FIELDS.has(key)) {
      throw new Error(`trust_authority_forbidden_field: ${path}.${key}`);
    }
    assertProviderFree(child, `${path}.${key}`);
  }
};

export const validateTrustAuthority = (view: unknown): UnknownRecord => {
  if (!isRecord(view)) {
    throw new TypeError('trust authority view must be an object');
  }
  if (view.schemaVersion !== TRUST_AUTHORITY_SCHEMA_VERSION) {
    throw new Error('trust_authority_schema_invalid');
  }
  if (!isRecord(view.run) || !view.run.runId) {
    throw new Error('trust_authority_identity_missing');
  }
  if (!view.requirements || !view.evidence || !view.decision) {
    throw new Error('trust_authority_graph_incomplete');
  }
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
}: BuildTrustAuthorityViewInput = {}): UnknownRecord | null => {
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
  const completionStatus = new Map<string, CompletionObligationStatusLike>(
    (completion?.obligationStatuses || []).map((entry) => [entry.obligationId, entry]),
  );

  const hardEvidence: VerificationEvidenceView[] = [];
  const reviewEvidence: ReviewEvidenceView[] = [];
  const requirementViews: RequirementView[] = required.map((obligation) => {
    const obligationId = String(obligation.obligationId);
    const protectedObligation = Boolean(obligation.protected)
      || isProtectedObligation(obligationId);
    const verification = latestVerifications.get(obligationId) || null;
    const freshness = freshnessForVerification({
      verification,
      run,
      verificationScopeIdentities,
    });
    const verificationView: VerificationEvidenceView = verification
      ? {
        obligationId,
        status: verification.status || 'missing',
        evidenceClass: verification.evidenceClass || null,
        evidenceDigest: verification.evidenceDigest || null,
        commandRef: verification.commandRef || null,
        executor: verification.executor || null,
        mutationRevision: verification.verifiedMutationRevision
          ?? verification.verifiedRuntimeRevision
          ?? null,
        acceptanceCoverage: list(verification.acceptanceCoverage),
        freshness,
      }
      : {
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

    const receipt = latestReviews.get(obligationId) || null;
    const review = obligation.evidenceClass === 'judgment'
      ? reviewFreshnessFor({
        receipt,
        obligation: { ...obligation, obligationId },
        run,
        verifications,
      })
      : null;
    const reviewView: ReviewEvidenceView | null = review
      ? {
        obligationId,
        receiptId: receipt?.receiptId || null,
        verdict: receipt?.verdict || 'missing',
        evidenceDigest: receipt?.subject?.evidenceDigest || null,
        mutationRevision: receipt?.subject?.mutationRevision ?? null,
        acceptanceCoverage: list(receipt?.acceptanceCoverage),
        required: review.required,
        usable: review.usable,
        freshness: {
          status: review.status,
          reasons: review.reasons,
          evidenceDigest: review.currentEvidenceDigest,
        },
      }
      : null;

    if (obligation.evidenceClass === 'judgment') {
      if (reviewView) reviewEvidence.push(reviewView);
    } else {
      hardEvidence.push(verificationView);
    }

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
      evidenceStatus: obligation.evidenceClass === 'judgment'
        ? review?.status || 'missing'
        : freshness.status,
    };
  });

  const unsatisfied = requirementViews
    .filter((entry) => !entry.satisfied)
    .map((entry) => entry.obligationId);
  const reasons = unsatisfied.map(
    (obligationId) => `requirement-unsatisfied:${obligationId}`,
  );

  const staleEvidence: EvidenceView[] = [...hardEvidence, ...reviewEvidence]
    .filter(
      (entry) => entry.freshness.status && entry.freshness.status !== 'fresh',
    );
  for (const evidence of staleEvidence) {
    for (const reason of evidence.freshness.reasons || []) {
      reasons.push(`${evidence.obligationId}:${reason}`);
    }
  }

  if (
    completion?.decision === 'blocked'
    && completionDecision?.decision === 'rejected'
  ) {
    reasons.push('completion-decision-rejected');
  }
  if (completion?.gates) {
    for (const [gate, satisfied] of Object.entries(completion.gates)) {
      if (satisfied !== true) {
        reasons.push(`completion-gate-unsatisfied:${gate}`);
      }
    }
  }

  const routeView = routeAdmissionView(routeAdmissions);
  if (routeView && !routeView.dispatchable) {
    reasons.push(`route-admission-${routeView.decision || 'blocked'}`);
  }

  const uniqueReasons = [...new Set(reasons)];
  const evidenceSatisfied = unsatisfied.length === 0;
  const completionAccepted = completion?.decision === 'accepted'
    || completionDecision?.decision === 'accepted';
  const accepted = completionAccepted
    && evidenceSatisfied
    && uniqueReasons.length === 0;
  const decisionStatus = accepted
    ? 'accepted'
    : (
      completion?.decision === 'blocked'
      || completionDecision?.decision === 'rejected'
      || uniqueReasons.length > 0
        ? 'blocked'
        : 'pending'
    );

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
      evidenceDigest: completionDecision?.evidenceDigest
        || completion?.decisionPayload?.evidenceDigest
        || null,
      mutationRevision: Number(run.mutationRevision || 0),
    },
    routeAdmission: routeView,
  };

  return validateTrustAuthority(view);
};
