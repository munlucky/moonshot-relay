// Run finalization (§18, P0-7).
//
// Finalization is deliberately separate from the completion decision:
// completion says "the evidence is accepted", delivery says "the requested
// Git closeout actually finished". Knowledge commit and projection are
// non-authoritative side effects that do not make finalization partial.

import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { reviewKnowledgeCandidates } from '../knowledge/candidate-review.mjs';
import { commitProjectKnowledge } from '../knowledge/commit.mjs';
import { executeKernelGitCloseout, isAuthorizedKernelGitCloseoutWorkspace } from '../git/closeout.mjs';
import { normalizeChangedContract } from '../change-contract.mjs';
import { resolveRecordType } from '../knowledge/records.mjs';
import { projectRunState } from '../state-projector.mjs';
import { observeWorkspaceIdentity, observeScopedWorkspaceIdentity } from './workspace-identity.mjs';
import { authoritativeVerificationScope } from './obligation-compiler.mjs';
import { resolveRunArtifactPaths } from '../artifact-paths.mjs';
import { deduplicateKnowledgeCandidates, deriveKnowledgeStatus, extractStructuredKnowledgeCandidates } from '../knowledge/capture.mjs';
import { mkdir } from 'node:fs/promises';
import { atomicWriteText } from '../durable-write.mjs';
import path from 'node:path';

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

const latestEvidencePack = (store, runId) => {
  const verifications = store.getVerifications(runId);
  const last = verifications[verifications.length - 1];
  return last ? { status: last.status, digest: last.evidenceDigest } : null;
};

const persistReviewReceipt = (store, runId, projectId, candidateCount, reviewResult) => {
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

export const recordKnowledgeObservations = async ({ store, runtimeHome, runId, observations = [] }) => {
  const run = store.getRun(runId);
  if (!run) throw new Error(`Run ${runId} not found`);
  if (!run.projectId) throw new Error(`Run ${runId} has no projectId`);

  const candidates = [];
  for (const observation of observations) {
    if (!observation || typeof observation !== 'object') continue;
    const proposedType = resolveRecordType(observation.proposedType || observation.type || 'semantic_fact');
    if (!ALLOWED_CANDIDATE_TYPES.has(proposedType)) {
      throw new Error(`INVALID_CANDIDATE_TYPE: ${proposedType} is not an allowed candidate type`);
    }
    const candidateId = observation.candidateId || observation.id || `cand-${runId}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    candidates.push({
      candidateId,
      runId,
      projectId: run.projectId,
      proposedType,
      statement: observation.statement || '',
      scope: observation.scope || [],
      sourceRefs: observation.sourceRefs || [],
      evidenceRefs: observation.evidenceRefs || [],
      status: 'pending',
      sourceKind: 'explicit',
      ...observation,
      candidateId,
    });
  }

  const uniqueCandidates = deduplicateKnowledgeCandidates(candidates);
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
    env: { MOON_RELAY_KERNEL_HOME: runtimeHome },
  });

  const allReviewed = [
    ...(reviewResult.verifiedCandidates || []),
    ...(reviewResult.rejectedCandidates || []),
    ...(reviewResult.needsApprovalCandidates || []),
    ...(reviewResult.pendingVerificationCandidates || []),
  ];
  for (const candidate of allReviewed) {
    store.recordKnowledgeCandidate(candidate.candidateId, runId, {
      projectId: run.projectId,
      proposedType: candidate.proposedType || 'semantic_fact',
      status: candidate.status,
      candidateJson: candidate,
    });
  }

  persistReviewReceipt(store, runId, run.projectId, uniqueCandidates.length, reviewResult);
  return { ...reviewResult, submittedCount: uniqueCandidates.length, explicitCount: uniqueCandidates.length };
};

const blockedReceipt = (store, runId, receipt) => {
  if (receipt.knowledgeStatus && typeof store.setKnowledgeStatus === 'function') store.setKnowledgeStatus(runId, receipt.knowledgeStatus);
  store.recordFinalizationReceipt(runId, receipt);
  store.setFinalizationStatus(runId, 'blocked');
  return receipt;
};

const refreshFinalizationWorkspaceIdentity = ({ store, runId, projectRoot, priorGitReceipt }) => {
  if (!projectRoot || typeof store.getRun !== 'function' || typeof store.observeWorkspaceIdentity !== 'function') {
    return store.getRun(runId);
  }

  const run = store.getRun(runId);
  const observation = observeWorkspaceIdentity({ projectRoot });
  const authorizedCloseoutRetry = ['commit_created', 'push_failed', 'parity_failed', 'completed'].includes(priorGitReceipt?.status)
    && isAuthorizedKernelGitCloseoutWorkspace({ repoRoot: projectRoot, commitSha: priorGitReceipt?.commitSha || null });

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
  return store.getRun(runId);
};

const buildVerificationScopeIdentities = ({ store, runId, projectRoot }) => {
  const identities = {};
  for (const obligation of store.getRunObligations(runId)) {
    const authority = authoritativeVerificationScope(obligation);
    if (!authority) continue;
    identities[obligation.obligationId] = observeScopedWorkspaceIdentity({
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
}) => {
  let run = store.getRun(runId);
  if (!run) throw new Error(`Run ${runId} not found`);

  // A Git closeout that was requested once stays requested across finalization
  // retries; otherwise omitting it on the next report would silently turn a
  // failed closeout into a clean completion (P0-7).
  //
  // Restoring the request alone is not enough: without the selected paths the
  // retry stages nothing and the closeout reports `skipped`, and without the
  // SHA of a commit that was already created a failed push is never retried.
  // Both are recovered here so a retry resumes where the failure happened.
  const priorReceipt = store.getFinalizationReceipt(runId)?.receiptJson;
  const priorGitReceipt = store.getGitCloseoutReceipt(runId);
  const evaluateCompletion = () => store.evaluateCompletion(runId, {
    verificationScopeIdentities: verificationScopeIdentities || buildVerificationScopeIdentities({ store, runId, projectRoot }),
  });
  run = refreshFinalizationWorkspaceIdentity({ store, runId, projectRoot, priorGitReceipt });
  const normalizedChangeSet = normalizeChangedContract({
    changedPaths: changedPaths.length > 0 ? changedPaths : (priorReceipt?.changedPaths || []),
    changedFileCount,
  });

  const requestedCloseout = gitCloseoutRequest || priorReceipt?.gitCloseoutRequest || null;
  const unfinishedCommitSha = priorGitReceipt && priorGitReceipt.status !== 'completed' ? priorGitReceipt.commitSha : null;
  const effectiveCloseoutRequest = requestedCloseout && unfinishedCommitSha
    ? { ...requestedCloseout, existingCommitSha: requestedCloseout.existingCommitSha || unfinishedCommitSha }
    : requestedCloseout;

  for (const approval of Array.isArray(approvals) ? approvals : []) {
    if (approval?.candidateId && approval.approvedBy && approval.approvalReceipt) {
      store.recordKnowledgeApproval(`app-${randomUUID()}`, {
        runId,
        candidateId: approval.candidateId,
        approvedBy: approval.approvedBy,
        approvalReceipt: approval.approvalReceipt,
      });
    }
  }

  // Step 1: Pre-flight completion gates BEFORE closing and on every retry (Execution-First).
  run = refreshFinalizationWorkspaceIdentity({ store, runId, projectRoot, priorGitReceipt });
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
      unmetGates: Object.entries(preflight.gates).filter(([key, value]) => key !== 'isClosed' && !value).map(([key]) => key),
    });
  }
  if (run.state !== 'CLOSE' && run.status !== 'completed') {
    store.transition(runId, 'CLOSE');
  }

  // Step 2: Assess & persist completion authority.
  const existingDecision = store.getCompletionDecision(runId);
  const isFinalizationRetry = existingDecision?.decision === 'accepted' && run.status === 'completed';
  const completionEval = isFinalizationRetry
    ? { ...evaluateCompletion(), decision: 'accepted', digest: existingDecision.evidenceDigest, decisionPayload: existingDecision.decisionJson }
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
  let gitReceipt = null;
  let gitCloseoutError = null;
  if (effectiveCloseoutRequest?.requested) {
    try {
      const completedGitRecovery = priorGitReceipt?.status === 'completed'
        && priorGitReceipt.receiptJson?.reportKey === effectiveCloseoutRequest.reportKey
        && priorGitReceipt.receiptJson?.verifiedWorkspaceIdentity === effectiveCloseoutRequest.verifiedWorkspaceIdentity
        && effectiveCloseoutRequest.reportKey
        && isAuthorizedKernelGitCloseoutWorkspace({ repoRoot: projectRoot, commitSha: priorGitReceipt.commitSha });
      gitReceipt = completedGitRecovery ? priorGitReceipt.receiptJson : await executeKernelGitCloseout({
        runId,
        projectId: run.projectId,
        stateStore: store,
        repoRoot: projectRoot,
        gitCloseoutRequest: effectiveCloseoutRequest,
        knowledgeCommitReceipt: null, // Non-blocking: Git closeout does not require knowledge commit receipt
        changedFiles: normalizedChangeSet.changedPaths,
      });
      gitCloseoutStatus = gitReceipt.status || 'completed';
    } catch (error) {
      gitCloseoutStatus = 'failed';
      gitCloseoutError = error.message;
    }
  }

  // Step 4: Knowledge candidate review & transactional commit.
  let reviewResult = { status: 'no_candidates', verifiedCandidates: [], rejectedCandidates: [], needsApprovalCandidates: [], pendingVerificationCandidates: [] };
  const explicitCandidates = Array.isArray(knowledgeObservations) && knowledgeObservations.length > 0
    ? knowledgeObservations.map((observation) => ({ ...observation, sourceKind: 'explicit' }))
    : [];
  const autoCandidates = extractStructuredKnowledgeCandidates({
    run,
    signals: structuredSignals,
    priorRunSignals: typeof store.getProjectRunSignals === 'function'
      ? store.getProjectRunSignals(run.projectId, { excludeRunId: runId })
      : [],
  });
  const submittedCandidates = deduplicateKnowledgeCandidates([
    ...explicitCandidates.map((candidate, index) => ({
      ...candidate,
      candidateId: candidate.candidateId || candidate.id || `cand-explicit-${runId}-${index + 1}`,
      runId,
      projectId: run.projectId,
    })),
    ...autoCandidates,
  ]);
  const dbCandidates = store.getKnowledgeCandidates(runId).map((candidate) => candidate.candidateJson);
  const candidatesForReview = submittedCandidates.length > 0 ? submittedCandidates : dbCandidates;
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
        env: { MOON_RELAY_KERNEL_HOME: runtimeHome },
      });
      persistReviewReceipt(store, runId, run.projectId, candidatesForReview.length, reviewResult);
      const allReviewed = [
        ...(reviewResult.verifiedCandidates || []),
        ...(reviewResult.rejectedCandidates || []),
        ...(reviewResult.needsApprovalCandidates || []),
        ...(reviewResult.pendingVerificationCandidates || []),
      ];
      for (const candidate of allReviewed) {
        store.recordKnowledgeCandidate(candidate.candidateId, runId, {
          projectId: run.projectId,
          proposedType: candidate.proposedType || 'semantic_fact',
          status: candidate.status,
          candidateJson: candidate,
        });
      }
    } catch (reviewError) {
      reviewResult = {
        status: 'error',
        error: reviewError?.message || String(reviewError),
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
  let commitReceipt = null;
  let knowledgeCommitError = null;
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
    if (priorCommit && ['committed', 'no_change'].includes(priorCommit.status)) {
      commitReceipt = priorCommit.receiptJson;
      knowledgeStatus = priorCommit.status;
      knowledgeCaptureStatus = priorCommit.status === 'committed' ? 'knowledge_committed' : 'no_new_knowledge';
    } else {
      const MAX_CAS_RETRIES = 3;
      let currentExpectedRevision = run.knowledgeRevisionStart;
      for (let attempt = 1; attempt <= MAX_CAS_RETRIES; attempt++) {
        knowledgeCommitAttempts = attempt;
        try {
          commitReceipt = await commitProjectKnowledge({
            runId,
            projectId: run.projectId,
            stateStore: store,
            expectedKnowledgeRevision: currentExpectedRevision,
            env: { MOON_RELAY_KERNEL_HOME: runtimeHome },
          });
          knowledgeStatus = commitReceipt.status || 'committed';
          knowledgeCaptureStatus = knowledgeStatus === 'committed' ? 'knowledge_committed' : 'no_new_knowledge';
          break;
        } catch (error) {
          if (error.code === 'STALE_KNOWLEDGE_REVISION' && attempt < MAX_CAS_RETRIES) {
            const latestRev = store.getProjectKnowledgeRevision
              ? String(store.getProjectKnowledgeRevision(run.projectId))
              : null;
            if (latestRev && latestRev !== currentExpectedRevision) {
              currentExpectedRevision = latestRev;
              continue;
            }
          }
          knowledgeStatus = error.code === 'STALE_KNOWLEDGE_REVISION' ? 'deferred' : 'failed';
          knowledgeCommitError = error.message;
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
  const knowledgeRequired = run.taskContract?.flags?.knowledgeRequired === true;
  const requiredKnowledgeUnfinished = knowledgeRequired && !['committed', 'no_change'].includes(knowledgeStatus);
  const finalizationStatus = (gitCloseoutStatus === 'failed' || requestedCloseoutUnfinished || requiredKnowledgeUnfinished)
    ? 'partial'
    : 'completed';

  const knowledgeWarning = run.mutationRevision > 0 && candidateCount === 0
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
  await projectRunState(store.getRun(runId), { runtimeHome });

  // Post-finalization bounded recovery: drains at most 1 previous deferred run independently
  try {
    await recoverBoundedDeferredKnowledge({ store, runtimeHome, projectId: run.projectId, currentRunId: runId });
  } catch {
    // Non-fatal for current run
  }

  return finalizationReceipt;
};

export const recoverBoundedDeferredKnowledge = async ({ store, runtimeHome, projectId, currentRunId = null, maxDeferredRuns = 1 } = {}) => {
  if (!store || !projectId) return [];
  const deferredRuns = typeof store.getDeferredKnowledgeRuns === 'function'
    ? store.getDeferredKnowledgeRuns(projectId, { limit: maxDeferredRuns, excludeRunId: currentRunId, retryableOnly: true })
    : [];

  const recovered = [];
  for (const deferred of deferredRuns) {
    try {
      const priorCandidates = store.getKnowledgeCandidates(deferred.runId);
      const verifiedCandidates = priorCandidates.filter((c) => c.status === 'verified').map((c) => c.candidateJson || c);
      if (verifiedCandidates.length === 0) continue;

      const commitReceipt = await commitProjectKnowledge({
        runId: deferred.runId,
        projectId,
        stateStore: store,
        env: { MOON_RELAY_KERNEL_HOME: runtimeHome },
      });
      if (commitReceipt && ['committed', 'no_change'].includes(commitReceipt.status)) {
        if (typeof store.recordKnowledgeCommitReceipt === 'function') {
          store.recordKnowledgeCommitReceipt(deferred.runId, {
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
