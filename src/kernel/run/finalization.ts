// Run finalization (§18, P0-7).
//
// Finalization is deliberately separate from the completion decision:
// completion says "the evidence is accepted", delivery says "the requested
// Git closeout actually finished". Knowledge commit and projection are
// non-authoritative side effects that do not make finalization partial.

import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { reviewKnowledgeCandidates } from '../knowledge/candidate-review.js';
import { commitProjectKnowledge } from '../knowledge/commit.js';
import { executeKernelGitCloseout } from '../git/closeout.js';
import { normalizeChangedContract } from '../change-contract.js';
import { resolveRecordType } from '../knowledge/records.js';
import { projectRunState } from '../state-projector.js';
import { authoritativeVerificationScope } from '../../contracts/verification-settlement.js';
import { assertCompletionProvenance } from '../proof/completion-provenance.js';
import { evaluateTrustCompletion, type EvaluateTrustCompletionInput } from '../proof/trust-authority.js';
import { resolveRunArtifactPaths } from '../artifact-paths.js';
import { deduplicateKnowledgeCandidates, deriveKnowledgeStatus, extractStructuredKnowledgeCandidates } from '../knowledge/capture.js';
import { mkdir } from 'node:fs/promises';
import { atomicWriteText } from '../durable-write.js';
import path from 'node:path';
import type { KnowledgeCandidateLike as ReviewKnowledgeCandidate } from '../knowledge/candidate-review.js';
import type { KnowledgeCandidateLike as CaptureKnowledgeCandidate } from '../knowledge/capture.js';
import type { OntologyConstraint } from '../knowledge/ontology-evaluate.js';
import type { VerificationObligationLike } from '../../contracts/verification-settlement.js';

type UnknownRecord = Record<string, unknown>;
type GitCloseoutInput = Parameters<typeof executeKernelGitCloseout>[0];
type GitCloseoutRequest = NonNullable<GitCloseoutInput['gitCloseoutRequest']>;
type GitCloseoutHost = NonNullable<GitCloseoutInput['gitCloseoutHost']>;

interface RunLike extends UnknownRecord {
  runId: string;
  projectId: string;
  state?: string | null;
  status?: string | null;
  currentWorkspaceIdentity?: string | null;
  knowledgeRevisionStart?: string | number | null;
  mutationRevision?: number | null;
  taskContract?: {
    flags?: {
      knowledgeRequired?: boolean;
    };
    [key: string]: unknown;
  } | null;
}

interface VerificationLike extends UnknownRecord {
  id?: unknown;
  status?: unknown;
  exitCode?: unknown;
  evidenceDigest?: string | null;
  evidenceRef?: string | null;
  acceptanceCoverage?: unknown;
  obligationId?: unknown;
  sourceIdentity?: unknown;
  verifiedMutationRevision?: unknown;
}

interface StoredCandidateLike extends UnknownRecord {
  status?: string;
  candidateJson?: unknown;
}

interface GitReceiptLike extends UnknownRecord {
  projectId?: string | null;
  mode?: string | null;
  commitSha?: string | null;
  branch?: string | null;
  status?: string;
  receiptJson?: UnknownRecord | null;
}

interface CompletionDecisionLike extends UnknownRecord {
  runId?: unknown;
  decision?: string;
  sourceIdentity?: unknown;
  mutationRevision?: unknown;
  evidenceDigest?: unknown;
  decisionJson?: (UnknownRecord & {
    runId?: unknown;
    decision?: unknown;
    sourceIdentity?: unknown;
    mutationRevision?: unknown;
    currentWorkspaceIdentity?: unknown;
  }) | null;
}

interface CompletionEvaluationLike extends UnknownRecord {
  readyExceptClose: boolean;
  gates: Record<string, unknown>;
  decision?: string;
}

interface ReviewOutcome {
  status: string;
  verifiedCandidates: ReviewKnowledgeCandidate[];
  rejectedCandidates: ReviewKnowledgeCandidate[];
  needsApprovalCandidates: ReviewKnowledgeCandidate[];
  pendingVerificationCandidates: ReviewKnowledgeCandidate[];
  error?: string;
}

interface PersistableCandidate extends ReviewKnowledgeCandidate {
  candidateId: string;
  proposedType?: unknown;
  status?: (string) | undefined;
}

type FinalizationStore = Pick<Awaited<ReturnType<typeof import('../state-store.js').openKernelStateStore>>, "getRun" | "listKnowledgeRecords" | "getKnowledgeApproval" | "ensureRunObligation" | "getRunObligations" | "getVerifications" | "recordCandidateEvidenceBinding" | "getProjectKnowledgeRevision" | "commitKnowledgeTransaction" | "getCompletionDecision" | "getMutationProvenance" | "observeWorkspaceIdentity" | "recordGitCloseoutReceipt" | "getGitCloseoutReceipt" | "recordKnowledgeReviewReceipt" | "recordKnowledgeCandidate" | "setKnowledgeStatus" | "recordFinalizationReceipt" | "setFinalizationStatus" | "getFinalizationReceipt" | "getWaivers" | "listReviewReceipts" | "getLatestEvidencePack" | "recordKnowledgeApproval" | "transition" | "persistCompletionDecision" | "getProjectRunSignals" | "getKnowledgeCandidates" | "recordKnowledgeCommitReceipt" | "getKnowledgeCommitReceipt" | "getDeferredKnowledgeRuns">;

type ObserveWorkspaceIdentity = (input: { projectRoot: string }) => { identity: string };
type ObserveScopedWorkspaceIdentity = (input: {
  projectRoot: string;
  scopes: readonly string[];
}) => { status?: string; identity?: string | null; reason?: string | null };

interface RecordKnowledgeObservationsInput {
  store: FinalizationStore;
  runtimeHome: string;
  runId: string;
  observations?: unknown[];
}

interface FinalizeRunInput {
  store: FinalizationStore;
  runtimeHome: string;
  projectRoot: string;
  runId: string;
  gitCloseoutRequest?: GitCloseoutRequest | null;
  changedPaths?: string[];
  changedFileCount?: number | null;
  knowledgeObservations?: unknown[];
  structuredSignals?: UnknownRecord;
  approvals?: unknown[];
  verificationScopeIdentities?: EvaluateTrustCompletionInput['verificationScopeIdentities'];
  observeWorkspaceIdentity?: ObserveWorkspaceIdentity | null;
  observeScopedWorkspaceIdentity?: ObserveScopedWorkspaceIdentity | null;
  gitCloseoutHost?: GitCloseoutHost | null;
}

interface RecoverDeferredKnowledgeInput {
  store?: FinalizationStore | null;
  runtimeHome?: string;
  projectId?: string | null;
  currentRunId?: string | null;
  maxDeferredRuns?: number;
}

const asRecord = (value: unknown): UnknownRecord => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : {}
);

const strings = (value: unknown): string[] => (
  Array.isArray(value) ? value.map(String).filter(Boolean) : []
);

const errorMessage = (error: unknown): string => (
  error instanceof Error ? error.message : String(error)
);

const errorCode = (error: unknown): string => (
  typeof asRecord(error).code === 'string' ? String(asRecord(error).code) : ''
);

const normalizeCandidate = (
  value: CaptureKnowledgeCandidate | ReviewKnowledgeCandidate | UnknownRecord,
  fallbackId: string,
): PersistableCandidate => {
  const candidate = asRecord(value);
  return {
    ...candidate,
    candidateId: candidate.candidateId ? String(candidate.candidateId) : fallbackId,
    projectId: candidate.projectId ? String(candidate.projectId) : undefined,
    statement: candidate.statement ? String(candidate.statement) : '',
    scope: strings(candidate.scope),
    status: candidate.status ? String(candidate.status) : undefined,
    evidenceRefs: strings(candidate.evidenceRefs),
    acceptanceIds: strings(candidate.acceptanceIds),
    obligationIds: strings(candidate.obligationIds),
    sourceKind: candidate.sourceKind ? String(candidate.sourceKind) : undefined,
  };
};

const requireRun = (store: FinalizationStore, runId: string): NonNullable<ReturnType<FinalizationStore['getRun']>> & { projectId: string } => {
  const run = store.getRun(runId);
  if (!run) throw new Error(`Run ${runId} not found`);
  if (!run.projectId) throw new Error(`Run ${runId} has no projectId`);
  return { ...run, projectId: run.projectId };
};

const normalizeGitCloseoutRequest = (value: unknown): GitCloseoutRequest | null => {
  const request = asRecord(value);
  if (Object.keys(request).length === 0) return null;
  return {
    ...request,
    requested: request.requested === true,
    approvalReceipt: request.approvalReceipt,
    mode: typeof request.mode === 'string' ? request.mode : null,
    existingCommitSha: typeof request.existingCommitSha === 'string' ? request.existingCommitSha : null,
    message: request.message,
    reportKey: request.reportKey,
    verifiedWorkspaceIdentity: request.verifiedWorkspaceIdentity,
  };
};

const ALLOWED_CANDIDATE_TYPES = new Set([
  'semantic_fact',
  'architecture_decision',
  'domain_term',
  'component_boundary',
  'api_contract',
  'kg_relation',
  'ontology_constraint',
  'tacit_observation',
  'episodic_observation',
  'tacit_practice',
  'known_failure_pattern',
  'required_verification',
]);

const latestEvidencePack = (store: FinalizationStore, runId: string) => {
  const verifications = store.getVerifications(runId);
  const last = verifications[verifications.length - 1];
  return last ? { status: last.status, digest: last.evidenceDigest } : null;
};

const persistReviewReceipt = (store: FinalizationStore, runId: string, projectId: string, candidateCount: number, reviewResult: ReviewOutcome) => {
  store.recordKnowledgeReviewReceipt(runId, {
    projectId,
    status: reviewResult.status,
    candidateCount,
    verifiedCount: (reviewResult.verifiedCandidates || []).length,
    rejectedCount: (reviewResult.rejectedCandidates || []).length,
    waitingApprovalCount: (reviewResult.needsApprovalCandidates || []).length,
    waitingVerificationCount: (reviewResult.pendingVerificationCandidates || []).length,
    reviewDigest: createHash('sha256').update(JSON.stringify(reviewResult)).digest('hex'),
    receiptJson: reviewResult,
  });
};

export const recordKnowledgeObservations = async ({ store, runtimeHome, runId, observations = [] }: RecordKnowledgeObservationsInput) => {
  const run = store.getRun(runId);
  if (!run) throw new Error(`Run ${runId} not found`);
  if (!run.projectId) throw new Error(`Run ${runId} has no projectId`);

  const candidates: PersistableCandidate[] = [];
  for (const observation of observations) {
    if (!observation || typeof observation !== 'object') continue;
    const observationRecord = asRecord(observation);
    const proposedType = resolveRecordType(observationRecord.proposedType || observationRecord.type || 'semantic_fact');
    if (!ALLOWED_CANDIDATE_TYPES.has(proposedType)) {
      throw new Error(`INVALID_CANDIDATE_TYPE: ${proposedType} is not an allowed candidate type`);
    }
    const candidateId = String(observationRecord.candidateId || observationRecord.id || `cand-${runId}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
    candidates.push({
      runId,
      projectId: run.projectId,
      proposedType,
      statement: observationRecord.statement ? String(observationRecord.statement) : '',
      scope: strings(observationRecord.scope),
      sourceRefs: strings(observationRecord.sourceRefs),
      evidenceRefs: strings(observationRecord.evidenceRefs),
      status: 'pending',
      sourceKind: 'explicit',
      ...observationRecord,
      candidateId,
    });
  }

  const uniqueCandidates = deduplicateKnowledgeCandidates(candidates).map((candidate, index) => normalizeCandidate(candidate, `cand-${runId}-${index + 1}`));
  for (const candidate of uniqueCandidates) {
    store.recordKnowledgeCandidate(candidate.candidateId, runId, {
      projectId: run.projectId,
      proposedType: candidate.proposedType || 'semantic_fact',
      status: 'pending',
      candidateJson: candidate,
    });
  }

  const reviewResult = await reviewKnowledgeCandidates({
    projectId: run.projectId,
    runId,
    stateStore: store,
    candidates: uniqueCandidates,
    evidencePack: latestEvidencePack(store, runId),
  });

  const allReviewed = [
    ...(reviewResult.verifiedCandidates || []),
    ...(reviewResult.rejectedCandidates || []),
    ...(reviewResult.needsApprovalCandidates || []),
    ...(reviewResult.pendingVerificationCandidates || []),
  ];
  for (const [index, candidate] of allReviewed.entries()) {
    const normalizedCandidate = normalizeCandidate(candidate, `cand-reviewed-${runId}-${index + 1}`);
    store.recordKnowledgeCandidate(normalizedCandidate.candidateId, runId, {
      projectId: run.projectId,
      proposedType: normalizedCandidate.proposedType || 'semantic_fact',
      status: normalizedCandidate.status,
      candidateJson: normalizedCandidate,
    });
  }

  persistReviewReceipt(store, runId, run.projectId, uniqueCandidates.length, reviewResult);
  return { ...reviewResult, submittedCount: uniqueCandidates.length, explicitCount: uniqueCandidates.length };
};

const blockedReceipt = (store: FinalizationStore, runId: string, receipt: UnknownRecord & { knowledgeStatus?: string }) => {
  if (receipt.knowledgeStatus && typeof store.setKnowledgeStatus === 'function') store.setKnowledgeStatus(runId, receipt.knowledgeStatus);
  store.recordFinalizationReceipt(runId, receipt);
  store.setFinalizationStatus(runId, 'blocked');
  return receipt;
};

const refreshFinalizationWorkspaceIdentity = ({ store, runId, projectRoot, priorGitReceipt, observeWorkspaceIdentity, gitCloseoutHost }: { store: FinalizationStore; runId: string; projectRoot: string; priorGitReceipt: GitReceiptLike | null; observeWorkspaceIdentity: ObserveWorkspaceIdentity | null; gitCloseoutHost: GitCloseoutHost | null; }): ReturnType<typeof requireRun> => {
  if (!projectRoot || typeof store.observeWorkspaceIdentity !== 'function') {
    return requireRun(store, runId);
  }
  if (typeof observeWorkspaceIdentity !== 'function') {
    throw new Error('workspace_identity_observer_required');
  }

  const run = store.getRun(runId);
  const observation = observeWorkspaceIdentity({ projectRoot });
  const authorizedCloseoutRetry = ['commit_created', 'push_failed', 'parity_failed', 'completed'].includes(String(priorGitReceipt?.status || ''))
    && typeof gitCloseoutHost?.isAuthorizedCloseoutWorkspace === 'function'
    && gitCloseoutHost.isAuthorizedCloseoutWorkspace({
      repoRoot: projectRoot,
      commitSha: priorGitReceipt?.commitSha || null,
    });

  // The HEAD change made by a Kernel commit whose push/parity stage failed is
  // an expected retry boundary.  Preserve the evidence identity for that
  // exact clean HEAD; every other direct Git/index/workspace mutation advances
  // the mutation revision and makes the old proof fail closed.
  if (run?.currentWorkspaceIdentity
    && observation.identity !== run.currentWorkspaceIdentity
    && !authorizedCloseoutRetry) {
    store.observeWorkspaceIdentity(runId, observation.identity);
  } else if (!run?.currentWorkspaceIdentity) {
    store.observeWorkspaceIdentity(runId, observation.identity);
  }
  return requireRun(store, runId);
};

const buildVerificationScopeIdentities = ({ store, runId, projectRoot, observeScopedWorkspaceIdentity }: { store: FinalizationStore; runId: string; projectRoot: string; observeScopedWorkspaceIdentity: ObserveScopedWorkspaceIdentity | null; }): NonNullable<EvaluateTrustCompletionInput['verificationScopeIdentities']> => {
  if (typeof observeScopedWorkspaceIdentity !== 'function') {
    throw new Error('scoped_workspace_identity_observer_required');
  }
  const identities: NonNullable<EvaluateTrustCompletionInput['verificationScopeIdentities']> = {};
  for (const obligation of store.getRunObligations(runId)) {
    const authority = authoritativeVerificationScope(obligation);
    if (!authority) continue;
    const obligationId = String(obligation.obligationId || '').trim();
    if (!obligationId) continue;
    identities[obligationId] = observeScopedWorkspaceIdentity({
      projectRoot,
      scopes: authority.scope,
    });
  }
  return identities;
};

export const finalizeRun = async ({
  store,
  runtimeHome,
  projectRoot,
  runId,
  gitCloseoutRequest = null,
  changedPaths = [],
  changedFileCount = null,
  knowledgeObservations = [],
  structuredSignals = {},
  approvals = [],
  verificationScopeIdentities = null,
  observeWorkspaceIdentity = null,
  observeScopedWorkspaceIdentity = null,
  gitCloseoutHost = null,
}: FinalizeRunInput) => {
  let run = requireRun(store, runId);

  // A Git closeout that was requested once stays requested across finalization
  // retries; otherwise omitting it on the next report would silently turn a
  // failed closeout into a clean completion (P0-7).
  //
  // Restoring the request alone is not enough: without the selected paths the
  // retry stages nothing and the closeout reports `skipped`, and without the
  // SHA of a commit that was already created a failed push is never retried.
  // Both are recovered here so a retry resumes where the failure happened.
  const priorReceipt = asRecord(store.getFinalizationReceipt(runId)?.receiptJson);
  const priorGitReceipt = store.getGitCloseoutReceipt(runId);
  const evaluateCompletion = () => evaluateTrustCompletion({
    run: requireRun(store, runId),
    verifications: store.getVerifications(runId),
    obligations: store.getRunObligations(runId),
    waivers: store.getWaivers(runId),
    reviewReceipts: store.listReviewReceipts(runId),
    releaseEvidence: store.getLatestEvidencePack(runId),
    mutationProvenance: store.getMutationProvenance(runId),
    verificationScopeIdentities: verificationScopeIdentities || buildVerificationScopeIdentities({ store, runId, projectRoot, observeScopedWorkspaceIdentity }),
  });
  run = refreshFinalizationWorkspaceIdentity({ store, runId, projectRoot, priorGitReceipt, observeWorkspaceIdentity, gitCloseoutHost });
  const normalizedChangeSet = normalizeChangedContract({
    changedPaths: changedPaths.length > 0 ? changedPaths : strings(priorReceipt?.changedPaths),
    changedFileCount,
  });

  const requestedCloseout = gitCloseoutRequest || normalizeGitCloseoutRequest(priorReceipt?.gitCloseoutRequest);
  const unfinishedCommitSha = priorGitReceipt && priorGitReceipt.status !== 'completed' ? priorGitReceipt.commitSha : null;
  const effectiveCloseoutRequest = requestedCloseout && unfinishedCommitSha
    ? { ...requestedCloseout, existingCommitSha: requestedCloseout.existingCommitSha || unfinishedCommitSha }
    : requestedCloseout;

  for (const approval of Array.isArray(approvals) ? approvals : []) {
    const approvalRecord = asRecord(approval);
    if (approvalRecord.candidateId && approvalRecord.approvedBy && approvalRecord.approvalReceipt) {
      store.recordKnowledgeApproval(`app-${randomUUID()}`, {
        runId,
        candidateId: approvalRecord.candidateId,
        approvedBy: approvalRecord.approvedBy,
        approvalReceipt: approvalRecord.approvalReceipt,
      });
    }
  }

  // Step 1: Pre-flight completion gates BEFORE closing and on every retry (Execution-First).
  run = refreshFinalizationWorkspaceIdentity({ store, runId, projectRoot, priorGitReceipt, observeWorkspaceIdentity, gitCloseoutHost });
  const preflight = evaluateCompletion();
  if (!preflight.readyExceptClose) {
    return blockedReceipt(store, runId, {
      schemaVersion: 1,
      runId,
      projectId: run.projectId,
      completionStatus: 'blocked',
      knowledgeStatus: 'skipped',
      projectionStatus: 'none',
      gitCloseoutStatus: 'skipped',
      finalizationStatus: 'incomplete_gates',
      completionResult: preflight,
      reviewResult: { status: 'no_candidates' },
      reason: 'completion_gates_unmet',
      unmetGates: Object.entries(preflight.gates || {}).filter(([key, value]) => key !== 'isClosed' && !value).map(([key]) => key),
    });
  }
  if (run.state !== 'CLOSE' && run.status !== 'completed') {
    store.transition(runId, 'CLOSE');
  }

  // Step 2: Assess & persist completion authority.
  const existingDecision = store.getCompletionDecision(runId);
  const isFinalizationRetry = existingDecision?.decision === 'accepted' && run.status === 'completed';
  const completionEval = isFinalizationRetry
    ? { ...evaluateCompletion(), decision: 'accepted', digest: String(existingDecision.evidenceDigest), decisionPayload: asRecord(existingDecision.decisionJson) }
    : evaluateCompletion();
  if (!isFinalizationRetry) store.persistCompletionDecision(runId, completionEval);

  if (completionEval.decision !== 'accepted') {
    return blockedReceipt(store, runId, {
      schemaVersion: 1,
      runId,
      projectId: run.projectId,
      completionStatus: completionEval.decision,
      codeAccepted: false,
      knowledgeStatus: 'blocked',
      projectionStatus: 'none',
      gitCloseoutStatus: 'skipped',
      finalizationStatus: 'blocked_completion',
      completionResult: completionEval,
      reviewResult: { status: 'no_candidates' },
      reason: 'completion_not_accepted',
    });
  }

  // Step 3: Git closeout (Execution-First: deliver accepted code before knowledge commits).
  let gitCloseoutStatus = 'skipped';
  let gitReceipt: UnknownRecord | null = null;
  let gitCloseoutError: string | null = null;
  if (effectiveCloseoutRequest?.requested) {
    try {
      assertCompletionProvenance({
        run: store.getRun(runId),
        completionDecision: store.getCompletionDecision(runId),
        mutationProvenance: store.getMutationProvenance(runId),
      });
      const completedGitRecovery = priorGitReceipt?.status === 'completed'
        && priorGitReceipt.receiptJson?.reportKey === effectiveCloseoutRequest.reportKey
        && priorGitReceipt.receiptJson?.verifiedWorkspaceIdentity === effectiveCloseoutRequest.verifiedWorkspaceIdentity
        && effectiveCloseoutRequest.reportKey
        && typeof gitCloseoutHost?.isAuthorizedCloseoutWorkspace === 'function'
        && gitCloseoutHost.isAuthorizedCloseoutWorkspace({ repoRoot: projectRoot, commitSha: priorGitReceipt.commitSha });
      gitReceipt = completedGitRecovery ? asRecord(priorGitReceipt.receiptJson) : asRecord(await executeKernelGitCloseout({
        runId,
        projectId: run.projectId,
        stateStore: store,
        repoRoot: projectRoot,
        gitCloseoutRequest: effectiveCloseoutRequest,
        knowledgeCommitReceipt: null, // Non-blocking: Git closeout does not require knowledge commit receipt
        changedFiles: normalizedChangeSet.changedPaths,
        observeWorkspaceIdentity,
        gitCloseoutHost,
      }));
      gitCloseoutStatus = String(gitReceipt.status || 'completed');
    } catch (error: unknown) {
      gitCloseoutStatus = 'failed';
      gitCloseoutError = errorMessage(error);
    }
  }

  // Step 4: Knowledge candidate review & transactional commit.
  let reviewResult: ReviewOutcome = { status: 'no_candidates', verifiedCandidates: [], rejectedCandidates: [], needsApprovalCandidates: [], pendingVerificationCandidates: [] };
  const explicitCandidates: PersistableCandidate[] = Array.isArray(knowledgeObservations) && knowledgeObservations.length > 0
    ? knowledgeObservations.map((observation, index) => normalizeCandidate(
      { ...asRecord(observation), sourceKind: 'explicit' },
      `cand-explicit-${runId}-${index + 1}`,
    ))
    : [];
  const autoCandidates = extractStructuredKnowledgeCandidates({
    run,
    signals: structuredSignals,
    priorRunSignals: typeof store.getProjectRunSignals === 'function'
      ? store.getProjectRunSignals(run.projectId, { excludeRunId: runId })
      : [],
  });
  const submittedCandidates = deduplicateKnowledgeCandidates([
    ...explicitCandidates.map((candidate) => ({
      ...candidate,
      runId,
      projectId: run.projectId,
    })),
    ...autoCandidates,
  ]).map((candidate, index) => normalizeCandidate(candidate, `cand-${runId}-${index + 1}`));
  const dbCandidates = store.getKnowledgeCandidates(runId).map((candidate, index) => normalizeCandidate(asRecord(candidate.candidateJson || candidate), `cand-db-${runId}-${index + 1}`));
  const candidatesForReview: PersistableCandidate[] = submittedCandidates.length > 0 ? submittedCandidates : dbCandidates;
  const candidateCount = candidatesForReview.length;
  if (candidatesForReview.length > 0) {
    for (const candidate of submittedCandidates) {
      store.recordKnowledgeCandidate(candidate.candidateId, runId, {
        projectId: run.projectId,
        proposedType: candidate.proposedType || 'semantic_fact',
        status: 'pending',
        candidateJson: candidate,
      });
    }
    try {
      reviewResult = await reviewKnowledgeCandidates({
        projectId: run.projectId,
        runId,
        stateStore: store,
        candidates: candidatesForReview,
        evidencePack: latestEvidencePack(store, runId),
          });
      persistReviewReceipt(store, runId, run.projectId, candidatesForReview.length, reviewResult);
      const allReviewed = [
        ...(reviewResult.verifiedCandidates || []),
        ...(reviewResult.rejectedCandidates || []),
        ...(reviewResult.needsApprovalCandidates || []),
        ...(reviewResult.pendingVerificationCandidates || []),
      ];
      for (const [index, candidate] of allReviewed.entries()) {
        const normalizedCandidate = normalizeCandidate(candidate, `cand-reviewed-${runId}-${index + 1}`);
        store.recordKnowledgeCandidate(normalizedCandidate.candidateId, runId, {
          projectId: run.projectId,
          proposedType: normalizedCandidate.proposedType || 'semantic_fact',
          status: normalizedCandidate.status,
          candidateJson: normalizedCandidate,
        });
      }
    } catch (reviewError: unknown) {
      reviewResult = {
        status: 'error',
        error: errorMessage(reviewError),
        verifiedCandidates: [],
        rejectedCandidates: [],
        needsApprovalCandidates: [],
        pendingVerificationCandidates: [],
      };
      persistReviewReceipt(store, runId, run.projectId, candidatesForReview.length, reviewResult);
    }
  } else {
    persistReviewReceipt(store, runId, run.projectId, 0, reviewResult);
  }

  let knowledgeCaptureStatus = deriveKnowledgeStatus({
    explicitCount: explicitCandidates.length,
    autoCount: autoCandidates.length,
    rejectedCount: reviewResult.rejectedCandidates?.length || 0,
    pendingVerificationCount: reviewResult.pendingVerificationCandidates?.length || 0,
    pendingApprovalCount: reviewResult.needsApprovalCandidates?.length || 0,
  });
  let knowledgeStatus = 'skipped';
  let commitReceipt: UnknownRecord | null = null;
  let knowledgeCommitError: string | null = null;
  let knowledgeCommitAttempts = 1;

  if (!['passed', 'no_candidates'].includes(reviewResult.status)) {
    // Non-blocking: Knowledge review failure defers knowledge but NEVER blocks code completion!
    knowledgeStatus = 'deferred';
    knowledgeCaptureStatus = 'knowledge_deferred';
    commitReceipt = {
      schemaVersion: 1,
      runId,
      projectId: run.projectId,
      status: 'deferred',
      reason: reviewResult.status === 'error' ? 'knowledge_review_error' : `knowledge_review_${reviewResult.status}`,
      reviewResult,
      deferredAt: new Date().toISOString(),
    };
    store.recordKnowledgeCommitReceipt(runId, {
      projectId: run.projectId,
      revisionBefore: String(run.knowledgeRevisionStart || '0'),
      revisionAfter: String(run.knowledgeRevisionStart || '0'),
      status: 'deferred',
      receiptJson: commitReceipt,
    });
  } else {
    const priorCommit = store.getKnowledgeCommitReceipt(runId);
    if (priorCommit && ['committed', 'no_change'].includes(String(priorCommit.status || ''))) {
      commitReceipt = asRecord(priorCommit.receiptJson);
      knowledgeStatus = String(priorCommit.status);
      knowledgeCaptureStatus = priorCommit.status === 'committed' ? 'knowledge_committed' : 'no_new_knowledge';
    } else {
      const MAX_CAS_RETRIES = 3;
      let currentExpectedRevision = String(run.knowledgeRevisionStart || '0');
      for (let attempt = 1; attempt <= MAX_CAS_RETRIES; attempt++) {
        knowledgeCommitAttempts = attempt;
        try {
          commitReceipt = asRecord(await commitProjectKnowledge({
            runId,
            projectId: run.projectId,
            stateStore: store,
            expectedKnowledgeRevision: currentExpectedRevision,
            env: { MOON_RELAY_KERNEL_HOME: runtimeHome },
          }));
          knowledgeStatus = String(commitReceipt.status || 'committed');
          knowledgeCaptureStatus = knowledgeStatus === 'committed' ? 'knowledge_committed' : 'no_new_knowledge';
          break;
        } catch (error: unknown) {
          const code = errorCode(error);
          if (code === 'STALE_KNOWLEDGE_REVISION' && attempt < MAX_CAS_RETRIES) {
            const latestRev = store.getProjectKnowledgeRevision
              ? String(store.getProjectKnowledgeRevision(run.projectId))
              : null;
            if (latestRev && latestRev !== currentExpectedRevision) {
              currentExpectedRevision = latestRev;
              continue;
            }
          }
          knowledgeStatus = code === 'STALE_KNOWLEDGE_REVISION' ? 'deferred' : 'failed';
          knowledgeCommitError = errorMessage(error);
          knowledgeCaptureStatus = knowledgeStatus === 'deferred' ? 'knowledge_deferred' : 'no_new_knowledge';
          if (knowledgeStatus === 'deferred') {
            commitReceipt = {
              schemaVersion: 1,
              runId,
              projectId: run.projectId,
              status: 'deferred',
              reason: 'cas_retry_exhausted',
              attempts: knowledgeCommitAttempts,
              error: knowledgeCommitError,
              deferredAt: new Date().toISOString(),
            };
            store.recordKnowledgeCommitReceipt(runId, {
              projectId: run.projectId,
              revisionBefore: String(run.knowledgeRevisionStart || '0'),
              revisionAfter: String(currentExpectedRevision || run.knowledgeRevisionStart || '0'),
              status: 'deferred',
              receiptJson: commitReceipt,
            });
          }
          break;
        }
      }
    }
  }

  const requestedCloseoutUnfinished = Boolean(effectiveCloseoutRequest?.requested) && gitCloseoutStatus !== 'completed';
  const knowledgeRequired = asRecord(run.taskContract?.flags).knowledgeRequired === true;
  const requiredKnowledgeUnfinished = knowledgeRequired && !['committed', 'no_change'].includes(knowledgeStatus);
  const finalizationStatus = (gitCloseoutStatus === 'failed' || requestedCloseoutUnfinished || requiredKnowledgeUnfinished)
    ? 'partial'
    : 'completed';

  const knowledgeWarning = Number(run.mutationRevision || 0) > 0 && candidateCount === 0
    ? {
      code: 'MUTATION_WITHOUT_KNOWLEDGE_CANDIDATE',
      reason: 'mutation_completed_without_explicit_or_structured_knowledge_candidate',
      mutationRevision: run.mutationRevision,
      candidateCount,
    }
    : null;
  const finalizationReceipt = {
    schemaVersion: 1,
    runId,
    projectId: run.projectId,
    completionStatus: completionEval.decision,
    codeAccepted: completionEval.decision === 'accepted',
    knowledgeRequired,
    knowledgeStatus,
    knowledgeCaptureStatus,
    knowledgeCommitAttempts,
    knowledgeWarning: Boolean(knowledgeWarning),
    knowledgeWarningReason: knowledgeWarning?.reason || null,
    knowledgeWarningDetail: knowledgeWarning,
    knowledgeCapture: {
      candidateCount,
      explicitCount: explicitCandidates.length,
      autoCount: autoCandidates.length,
      status: knowledgeCaptureStatus,
      warning: knowledgeWarning,
    },
    projectionStatus: commitReceipt?.projectionStatus || 'completed',
    gitCloseoutStatus,
    finalizationStatus,
    completionResult: completionEval,
    reviewResult,
    gitCloseoutRequest: effectiveCloseoutRequest,
    changedPaths: normalizedChangeSet.changedPaths,
    knowledgeCommitReceipt: commitReceipt,
    knowledgeCommitError,
    gitCloseoutReceipt: gitReceipt,
    gitCloseoutError,
    reason: requiredKnowledgeUnfinished
      ? 'required_knowledge_incomplete'
      : commitReceipt?.reason || null,
  };

  store.recordFinalizationReceipt(runId, finalizationReceipt);
  if (typeof store.setKnowledgeStatus === 'function') store.setKnowledgeStatus(runId, knowledgeStatus);
  store.setFinalizationStatus(runId, finalizationStatus);
  if (run.projectId) {
    const dir = resolveRunArtifactPaths({ runtimeHome, projectId: run.projectId, runId }).finalization;
    await mkdir(dir, { recursive: true });
    const target = path.join(dir, 'receipt.json');
    await atomicWriteText(target, JSON.stringify(finalizationReceipt, null, 2));
  }
  await projectRunState(requireRun(store, runId), { runtimeHome });

  // Post-finalization bounded recovery: drains at most 1 previous deferred run independently
  try {
    await recoverBoundedDeferredKnowledge({ store, runtimeHome, projectId: run.projectId, currentRunId: runId });
  } catch {
    // Non-fatal for current run
  }

  return finalizationReceipt;
};

export const recoverBoundedDeferredKnowledge = async ({ store = null, runtimeHome = '', projectId = null, currentRunId = null, maxDeferredRuns = 1 }: RecoverDeferredKnowledgeInput = {}): Promise<UnknownRecord[]> => {
  if (!store || !projectId) return [];
  const deferredRuns = typeof store.getDeferredKnowledgeRuns === 'function'
    ? store.getDeferredKnowledgeRuns(projectId, { limit: maxDeferredRuns, excludeRunId: currentRunId, retryableOnly: true })
    : [];

  const recovered: UnknownRecord[] = [];
  for (const deferred of deferredRuns) {
    try {
      const priorCandidates = store.getKnowledgeCandidates(String(deferred.runId));
      const verifiedCandidates = priorCandidates.filter((candidate) => candidate.status === 'verified').map((candidate) => candidate.candidateJson || candidate);
      if (verifiedCandidates.length === 0) continue;

      const commitReceipt = await commitProjectKnowledge({
        runId: String(deferred.runId),
        projectId,
        stateStore: store,
        env: { MOON_RELAY_KERNEL_HOME: runtimeHome },
      });
      if (commitReceipt && ['committed', 'no_change'].includes(commitReceipt.status)) {
        if (typeof store.recordKnowledgeCommitReceipt === 'function') {
          store.recordKnowledgeCommitReceipt(String(deferred.runId), {
            projectId,
            revisionBefore: commitReceipt.revisionBefore,
            revisionAfter: commitReceipt.revisionAfter,
            status: commitReceipt.status,
            receiptJson: commitReceipt,
          });
        }
        recovered.push({ runId: deferred.runId, status: 'recovered', commitReceipt });
      }
    } catch {
      // Bounded post-finalization recovery failure is non-fatal for current run
    }
  }
  return recovered;
};
