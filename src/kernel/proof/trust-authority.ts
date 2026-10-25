import { createHash } from 'node:crypto';
import { computeCompletionView } from './completion-view.js';
import {
  digestOfEvidence,
  evaluateReviewReceipt,
  parseReviewEvidenceRef,
  type ReviewReceipt,
} from './review-receipt.js';
import { isProtectedObligation } from './protected-obligations.js';
import { admissionAllowsDispatch } from '../routing/route-admission.js';
import { deriveEvidenceLevel } from '../../contracts/verification-settlement.js';
import { assertCommandBinding } from '../run/obligation-compiler.js';
import { normalizeAcceptanceCoverage } from '../task/task-contract.js';
import { assessMutationProvenance, type MutationProvenanceAuthority } from './completion-provenance.js';
import type { KernelRun as PersistedKernelRun } from '../persistence/state-store-contracts.js';
import type {
  PersistedEvidencePack,
  PersistedRunObligation,
  PersistedVerification,
  PersistedWaiver,
} from '../persistence/trust-store.js';

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

export interface EvaluateTrustCompletionInput {
  run: PersistedKernelRun;
  verifications?: PersistedVerification[];
  obligations?: PersistedRunObligation[];
  waivers?: PersistedWaiver[];
  reviewReceipts?: ReviewReceipt[];
  releaseEvidence?: PersistedEvidencePack | null;
  mutationProvenance?: MutationProvenanceAuthority | null;
  expectedSourceIdentity?: string | null;
  verificationScopeIdentities?: Record<string, string | { status?: string; identity?: string | null; reason?: string | null } | null | undefined> | null;
}

export const evaluateTrustCompletion = ({
  run,
  verifications = [],
  obligations = [],
  waivers = [],
  reviewReceipts = [],
  releaseEvidence = null,
  mutationProvenance = null,
  expectedSourceIdentity = null,
  verificationScopeIdentities = null,
}: EvaluateTrustCompletionInput) => {
  const runId = run.runId;

  const isClosed = Boolean(run.state === 'CLOSE');
  const mutationProvenanceAssessment = assessMutationProvenance({
    run,
    mutationProvenance,
  });

  const declaredById = new Map(obligations.map((obligation) => [obligation.obligationId, obligation]));

  const normalizedCoverageFor = (v: PersistedVerification | null | undefined) => {
    try {
      return normalizeAcceptanceCoverage({
        contract: run.taskContract || {},
        acceptanceCriteria: run.acceptanceCriteria || [],
        obligation: v?.obligationId ? (declaredById.get(v.obligationId) || null) : null,
        coverage: v?.acceptanceCoverage || [],
      });
    } catch {
      return null;
    }
  };

  const isVerificationValid = (v: PersistedVerification | null | undefined) => {
    if (!v) return false;
    if (v.status !== 'passed') return false;
    if (Number(v.exitCode) !== 0) return false;
    if (!v.command) return false;
    if (!v.evidenceRef) return false;
    // Historical builds briefly allowed operator approval to mint synthetic
    // executable proof. Preserve those rows for audit, but never let them
    // satisfy a hard-evidence gate during inspection or reevaluation.
    if (v.command === 'operator-override' || String(v.evidenceRef).startsWith('operator-override://')) return false;
    if (!v.evidenceDigest || !sha256Regex.test(v.evidenceDigest)) return false;

    if (!v.sourceIdentity || v.sourceIdentity !== run.sourceIdentity) return false;
    if (expectedSourceIdentity && v.sourceIdentity !== expectedSourceIdentity) return false;

    // A scoped proof is fresh only when the authoritative verification
    // scope still hashes to the same file contents. The full workspace
    // identity may change for an unrelated Step, so it is deliberately not
    // used for this case. Missing scope observations fail closed.
    const scopedDigest = asRecord(v.evidenceIdentity?.values).verificationScopeDigest || null;
    if (scopedDigest) {
      const currentScope = verificationScopeIdentities?.[v.obligationId];
      const currentScopeDigest = typeof currentScope === 'string' ? currentScope : currentScope?.identity;
      if (!currentScopeDigest || currentScopeDigest !== scopedDigest) return false;
    } else {
      const verifiedMutation = v.verifiedMutationRevision ?? v.verifiedRuntimeRevision;
      if (verifiedMutation !== run.mutationRevision) return false;
    }
    if (!scopedDigest && v.verifiedSourceIdentity && run.currentWorkspaceIdentity && v.verifiedSourceIdentity !== run.currentWorkspaceIdentity) {
      // Evidence proven against a different full workspace state is stale.
      return false;
    }

    // A contract revision changes the evidence authority. Proof recorded
    // before a plan/binding revision must be rerun, even when its other
    // receipt fields still look fresh.
    if (Number(v.contractRevision || 1) !== Number(run.contractRevision || 1)) return false;

    // Revalidate the persisted command against the CURRENT obligation. A
    // plan may have narrowed or changed its command after an older proof
    // was written; that older row cannot be reused at finalization. Legacy
    // rows without commandRef are accepted only for broad, non-explicit
    // obligations where the old contract did not specify a command.
    const declared = declaredById.get(v.obligationId);
    const explicitCommandBinding = declared?.metadata?.evidencePlanCommandBinding === true;
    if (declared && declared.evidenceClass !== 'judgment') {
      if (explicitCommandBinding && !v.commandRef) return false;
      if (v.commandRef) {
        try {
          assertCommandBinding(declared, v.commandRef);
        } catch {
          return false;
        }
      }
    }

    // Re-derive coverage at completion as well as at write time. This keeps
    // legacy or directly-mutated rows from turning an unrelated passing
    // command into proof for a different acceptance criterion.
    if (normalizedCoverageFor(v) === null) return false;

    return true;
  };

  const requiredObligations = run.requiredObligations.length > 0 ? run.requiredObligations : ['default'];
  const dynamicObligationRows = obligations.filter((obligation) => obligation.status === 'required' && obligation.sourceType !== 'ad-hoc');

  const waivedObligations = new Set(waivers.filter((w) => w.approvalReceipt).map((w) => w.obligationId));
  const latestByObligation = new Map(verifications.map((v) => [v.obligationId, v]));

  // Evidence class is not substitutable (P0-3): a `hard` obligation needs
  // executable evidence, a `judgment` obligation needs a structured
  // verdict, and neither can stand in for the other. A run that actually
  // mutated the workspace tightens `hard` further — only the Kernel
  // executing the bound command counts. A protected obligation can never
  // be waived.
  const runMutatedWorkspace = run.mutationRevision > 0;

  // K0: a judgment that stands in for a protected obligation, or any
  // judgment in a T3 run, must be backed by a Review Receipt whose reviewer
  // lineage and reviewed subject still hold. Two different reviewer strings
  // are not evidence that an independent review happened.
  const reviewLineageFor = (obligationId: string, verification: PersistedVerification, declared: PersistedRunObligation | null | undefined) => {
    const protectedObligation = Boolean(declared?.protected || isProtectedObligation(obligationId));
    const independenceRequired = run.proofTier === 'T3';
    if (!protectedObligation && !independenceRequired) {
      return { required: false, usable: true, receiptId: null, reasons: [] };
    }
    const parsed = parseReviewEvidenceRef(verification?.evidenceRef);
    if (!parsed || parsed.runId !== runId) {
      return { required: true, usable: false, receiptId: null, reasons: ['review-receipt-not-referenced'] };
    }
    const receipt = reviewReceipts.find((candidate) => candidate.receiptId === parsed.receiptId && candidate.runId === runId) || null;
    const reasons = [];
    if (receipt) {
      if (receipt.obligationId !== obligationId) reasons.push('review-receipt-obligation-mismatch');
      if (verification.evidenceDigest !== receipt.digest) reasons.push('review-receipt-digest-mismatch');
    }
    const evaluation = evaluateReviewReceipt({
      receipt,
      run,
      requireIndependentSession: independenceRequired,
      requireFrontierClass: independenceRequired,
      requireTrustedEnforcement: true,
      // The verdict must describe the evidence set the run has NOW; a check
      // rerun after the review changes nothing about the workspace.
      currentEvidenceDigest: digestOfEvidence(verifications, { excludeObligationId: obligationId }),
    });
    const allReasons = [...reasons, ...evaluation.reasons];
    return { required: true, usable: allReasons.length === 0, receiptId: parsed.receiptId, reasons: allReasons };
  };

  const obligationSatisfied = (obligationId: string) => {
    const declared = declaredById.get(obligationId);
    const expectedClass = declared?.evidenceClass || 'hard';
    const verification = latestByObligation.get(obligationId);
    if (verification && isVerificationValid(verification)) {
      if (expectedClass === 'judgment') {
        if (verification.evidenceClass === 'judgment') return reviewLineageFor(obligationId, verification, declared).usable;
      } else if (verification.executor === 'kernel-runtime' && verification.evidenceClass === 'hard') {
        return true;
      } else if (!runMutatedWorkspace && verification.evidenceClass !== 'judgment') {
        // Nothing changed, so attested evidence is still an honest record;
        // a judgment verdict is never accepted for an executable obligation.
        return true;
      }
    }
    if (waivedObligations.has(obligationId) && !(declared?.protected || isProtectedObligation(obligationId))) return true;
    return false;
  };

  const obligationStatuses = [...new Set([...requiredObligations, ...dynamicObligationRows.map((row) => row.obligationId)])]
    .map((obligationId) => {
      const declared = declaredById.get(obligationId);
      const verification = latestByObligation.get(obligationId);
      const requiredEvidenceClass = declared?.evidenceClass || 'hard';
      const reviewLineage = requiredEvidenceClass === 'judgment' && verification
        ? reviewLineageFor(obligationId, verification, declared)
        : null;
      return {
        obligationId,
        evidenceLevel: deriveEvidenceLevel(declared),
        requiredEvidenceClass,
        observedEvidenceClass: verification?.evidenceClass || null,
        executor: verification?.executor || null,
        reviewLineage,
        satisfied: obligationSatisfied(obligationId),
        waived: waivedObligations.has(obligationId),
      };
    });

  const staticPassed = requiredObligations.every((ob) => obligationSatisfied(ob));
  const dynamicPassed = dynamicObligationRows.every((row) => row.status === 'passed' || row.status === 'waived' || obligationSatisfied(row.obligationId));

  // Work-level proof may settle one bounded Work Unit, but it cannot by
  // itself close the Goal. Goal completion requires at least one current,
  // non-waived Goal-level verification. Integration-level obligations stay
  // mandatory when declared, but do not substitute for root Goal proof.
  const integrationEvidenceObligations = obligationStatuses.filter((entry) => entry.evidenceLevel === 'integration');
  const requiredIntegrationEvidence = integrationEvidenceObligations.filter((entry) => !entry.waived);
  const integrationEvidenceCount = requiredIntegrationEvidence.filter((entry) => {
    if (!entry.satisfied) return false;
    const verification = latestByObligation.get(entry.obligationId);
    return Boolean(verification && isVerificationValid(verification));
  }).length;
  const integrationEvidenceSatisfied = requiredIntegrationEvidence.length === 0
    || integrationEvidenceCount === requiredIntegrationEvidence.length;
  const goalEvidenceObligations = obligationStatuses.filter((entry) => entry.evidenceLevel === 'goal');
  const requiredGoalEvidence = goalEvidenceObligations.filter((entry) => !entry.waived);
  const goalEvidenceCount = requiredGoalEvidence.filter((entry) => {
    if (!entry.satisfied) return false;
    const verification = latestByObligation.get(entry.obligationId);
    return Boolean(verification && isVerificationValid(verification));
  }).length;
  const goalEvidenceSatisfied = goalEvidenceObligations.length > 0
    && (requiredGoalEvidence.length === 0 || goalEvidenceCount > 0);

  const coveredAcceptance = new Set([
    ...verifications.filter(isVerificationValid).flatMap((v) => normalizedCoverageFor(v) || []),
    ...waivers.flatMap((w) => w.acceptanceCoverage || []),
  ]);
  // Coverage may be declared by acceptance id (AC-1) or by statement.
  const contractAcceptance = Array.isArray(run.taskContract?.acceptance) ? run.taskContract.acceptance : [];
  // Completion must not trust a legacy verification row merely because it
  // contains coverage. The persisted acceptance statement still has to
  // match the current contract, while an explicit evidence plan remains
  // optional and unplanned criteria use the compiled policy obligation.
  const persistedAcceptance = Array.isArray(run.acceptanceCriteria) ? run.acceptanceCriteria : [];
  const evidencePlansComplete = persistedAcceptance.length === 0
    ? true
    : Boolean(run.taskContract)
      && contractAcceptance.length === persistedAcceptance.length
      && contractAcceptance.every((criterion, index) => (
        Boolean(criterion?.statement)
        && criterion.statement === persistedAcceptance[index]
      ));
  const acceptanceCovered = evidencePlansComplete && persistedAcceptance.every((criterion, index) => {
    const declared = contractAcceptance[index];
    return coveredAcceptance.has(criterion) || (declared?.id && coveredAcceptance.has(declared.id));
  });
  const releaseEvidencePresent = !run.releaseEvidenceRequired || (releaseEvidence?.tier === 'E2' && releaseEvidence.mutationRevision === run.mutationRevision && sha256Regex.test(releaseEvidence.digest));

  // A run that actually mutated the workspace cannot complete on
  // caller-attested proofs alone; at least one verification must have been
  // executed by the Kernel runtime itself.
  const hardEvidenceRequired = run.mutationRevision > 0;
  const hardEvidenceCount = verifications.filter((v) => isVerificationValid(v) && v.executor === 'kernel-runtime').length;
  const hardEvidenceSatisfied = !hardEvidenceRequired || hardEvidenceCount > 0;

  const requiredLifecycleOutcomes = new Set(run.taskContract?.completionPredicate?.requiredOutcomes || []);
  const outcomesFor = (obligation: PersistedRunObligation | null | undefined) => new Set([
    ...(Array.isArray(obligation?.metadata?.outcomes) ? obligation.metadata.outcomes : []),
    ...(obligation?.metadata?.outcome ? [obligation.metadata.outcome] : []),
  ]);
  const lifecycleOutcomes = [...requiredLifecycleOutcomes].map((outcome) => {
    if (outcome === 'implemented') {
      return { outcome, satisfied: run.mutationRevision > 0, obligationIds: [] };
    }
    const matching = dynamicObligationRows.filter((obligation) => outcomesFor(obligation).has(outcome));
    return {
      outcome,
      satisfied: matching.length > 0 && matching.every((obligation) => obligationSatisfied(obligation.obligationId)),
      obligationIds: matching.map((obligation) => obligation.obligationId),
    };
  });
  const lifecycleOutcomesSatisfied = lifecycleOutcomes.every((outcome) => outcome.satisfied);

  // All completion gates except the CLOSE-state requirement. Callers use
  // this to decide whether it is SAFE to transition to CLOSE, so a run is
  // never closed into an unrecoverable blocked state.
  const mutationProvenanceCurrent = mutationProvenanceAssessment.current;
  const readyExceptClose = staticPassed && dynamicPassed && integrationEvidenceSatisfied && goalEvidenceSatisfied && evidencePlansComplete && acceptanceCovered && releaseEvidencePresent && hardEvidenceSatisfied && lifecycleOutcomesSatisfied && mutationProvenanceCurrent;
  const gates = { isClosed, staticPassed, dynamicPassed, integrationEvidenceSatisfied, goalEvidenceSatisfied, evidencePlansComplete, acceptanceCovered, releaseEvidencePresent, hardEvidenceSatisfied, lifecycleOutcomesSatisfied, mutationProvenanceCurrent };
  const unsatisfiedObligations = obligationStatuses.filter((entry) => !entry.satisfied);

  const accepted = isClosed && readyExceptClose;

  const decision = accepted ? 'accepted' : 'blocked';
  // A run that leaned on any waiver to pass is completed but degraded
  // (§17.5), never silently clean.
  const completionQuality = accepted && waivers.length > 0 ? 'degraded' : (accepted ? 'clean' : 'none');
  const decisionPayload = {
    runId,
    decision,
    completionQuality,
    sourceIdentity: run.sourceIdentity,
    currentWorkspaceIdentity: run.currentWorkspaceIdentity,
    mutationRevision: run.mutationRevision,
    hardEvidence: { required: hardEvidenceRequired, count: hardEvidenceCount },
    integrationEvidence: { required: integrationEvidenceObligations.length > 0, count: integrationEvidenceCount },
    goalEvidence: { required: goalEvidenceObligations.length > 0, count: goalEvidenceCount },
    lifecycleOutcomes,
    evidenceDigest: releaseEvidence?.digest || verifications[0]?.evidenceDigest || `sha256:${'0'.repeat(64)}`,
    verifications,
  };
  const decisionDigest = `sha256:${createHash('sha256').update(JSON.stringify(decisionPayload)).digest('hex')}`;

  return {
    decision,
    completionQuality,
    digest: decisionDigest,
    run,
    verifications,
    waivers,
    releaseEvidence: releaseEvidence || null,
    evidencePlansComplete,
    acceptanceCovered: [...coveredAcceptance],
    hardEvidence: { required: hardEvidenceRequired, count: hardEvidenceCount },
    integrationEvidence: { required: integrationEvidenceObligations.length > 0, count: integrationEvidenceCount },
    goalEvidence: { required: goalEvidenceObligations.length > 0, count: goalEvidenceCount },
    lifecycleOutcomes,
    obligationStatuses,
    unsatisfiedObligations,
    gates,
    readyExceptClose,
    decisionPayload,
  };};

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

const asRecord = (value: unknown): UnknownRecord => isRecord(value) ? value : {};
const sha256Regex = /^sha256:[a-f0-9]{64}$/i;

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
