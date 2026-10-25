import { parseKernelContract } from '../../contracts/schema-codec.js';
import type { KernelKnowledgeReviewResult } from '../../contracts/generated/kernel.knowledge-review-result.js';
import {
  evaluateOntologyConstraints,
  type OntologyConstraint,
} from './ontology-evaluate.js';
import { matchPathScope } from './path-scope.js';
import { evaluateImprovementPairPromotion } from './improvement-pair.js';
import { evaluateCrossRunPromotionCandidate } from './cross-run-evidence.js';
import { isProtectedObligation } from '../proof/protected-obligations.js';

type UnknownRecord = Record<string, unknown>;

interface EvidenceBindingLike extends UnknownRecord {
  acceptanceIds?: string[];
  obligationIds?: string[];
  evidenceRefs?: string[];
}

export interface KnowledgeCandidateLike extends UnknownRecord {
  candidateId?: string;
  projectId?: (string) | undefined;
  statement?: string;
  scope?: string[];
  status?: (string) | undefined;
  rejectionReasons?: string[];
  evidenceRefs?: string[];
  acceptanceIds?: string[];
  obligationIds?: string[];
  evidenceBinding?: EvidenceBindingLike;
  sourceKind?: (string) | undefined;
  obligationId?: string;
  supersedes?: string[];
  feedbackClassification?: unknown;
  improvementPair?: unknown;
  signalKind?: unknown;
  crossRunEvidenceGroup?: unknown;
}

interface KnowledgeApprovalLike {
  candidateId?: unknown;
  approvalReceipt?: unknown;
  approvedBy?: unknown;
}

interface RunObligationLike {
  obligationId?: unknown;
  status?: unknown;
}

interface VerificationLike {
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

interface RunLike {
  sourceIdentity?: unknown;
  mutationRevision?: unknown;
}

interface KnowledgeReviewStore {
  listKnowledgeRecords(input?: {
    projectId?: string | null;
    statuses?: string[];
  }): OntologyConstraint[];
  getKnowledgeApproval(
    runId: string,
    candidateId?: string,
  ): KnowledgeApprovalLike | null;
  ensureRunObligation(
    runId: string,
    input: UnknownRecord,
  ): unknown;
  getRunObligations(runId: string): RunObligationLike[];
  getVerifications(runId: string): VerificationLike[];
  recordCandidateEvidenceBinding(input: UnknownRecord): unknown;
  getRun(runId: string): RunLike | null;
}

interface EvidencePackLike extends UnknownRecord {
  digest?: unknown;
}

export interface ReviewKnowledgeCandidatesInput {
  candidates?: KnowledgeCandidateLike[];
  projectId?: string | null;
  runId?: string | null;
  stateStore?: KnowledgeReviewStore | null;
  evidencePack?: EvidencePackLike | null;
}

export interface CandidateReviewRecord extends UnknownRecord {
  candidateId?: (string) | undefined;
  decision: string;
  reason?: string;
  evidenceRef?: string;
}

export type ReviewKnowledgeCandidatesResult = KernelKnowledgeReviewResult;

const strings = (value: unknown): string[] => (
  Array.isArray(value)
    ? value.map(String).filter(Boolean)
    : []
);

const evidenceBinding = (
  candidate: KnowledgeCandidateLike,
): EvidenceBindingLike => (
  candidate.evidenceBinding && typeof candidate.evidenceBinding === 'object'
    ? candidate.evidenceBinding
    : {}
);

const rejectedCandidate = (
  candidate: KnowledgeCandidateLike,
  status: string,
  reason: string,
): KnowledgeCandidateLike => ({
  ...candidate,
  status,
  rejectionReasons: [reason],
});

export async function reviewKnowledgeCandidates({
  candidates = [],
  projectId = null,
  runId = null,
  stateStore = null,
  evidencePack = null,
}: ReviewKnowledgeCandidatesInput = {}): Promise<ReviewKnowledgeCandidatesResult> {
  if (candidates.length === 0) {
    return parseKernelContract('kernel.knowledge-review-result', {
      status: 'no_candidates',
      verifiedCandidates: [],
      rejectedCandidates: [],
      needsApprovalCandidates: [],
      pendingVerificationCandidates: [],
      candidateReviews: [],
      supersessionProposals: [],
      ontologyViolations: [],
      approvalRequired: [],
      verificationsRequired: [],
      evidenceCoverage: [],
    });
  }

  if (!stateStore || !runId) {
    throw Object.assign(
      new Error(
        'Persisted Run and SQLite Knowledge authority are required to review Knowledge candidates',
      ),
      { code: 'KNOWLEDGE_REVIEW_AUTHORITY_REQUIRED' },
    );
  }

  const currentRun = stateStore.getRun(runId);
  if (!currentRun) {
    throw Object.assign(
      new Error(`Run ${runId} not found for Knowledge review`),
      { code: 'KNOWLEDGE_REVIEW_RUN_NOT_FOUND' },
    );
  }

  const verifiedCandidates: KnowledgeCandidateLike[] = [];
  const rejectedCandidates: KnowledgeCandidateLike[] = [];
  const needsApprovalCandidates: KnowledgeCandidateLike[] = [];
  const pendingVerificationCandidates: KnowledgeCandidateLike[] = [];
  const ontologyViolations: OntologyConstraint[] = [];
  const approvalRequired: OntologyConstraint[] = [];
  const verificationsRequired: OntologyConstraint[] = [];
  const candidateReviews: CandidateReviewRecord[] = [];
  const supersessionProposals: UnknownRecord[] = [];

  for (const candidate of candidates) {
    if (candidate.projectId && candidate.projectId !== projectId) {
      rejectedCandidates.push(
        rejectedCandidate(candidate, 'rejected', 'PROJECT_ID_MISMATCH'),
      );
      candidateReviews.push({
        candidateId: candidate.candidateId,
        decision: 'rejected',
        reason: 'PROJECT_ID_MISMATCH',
      });
      continue;
    }

    const statement = String(candidate.statement || '');
    if (
      /sk-[a-zA-Z0-9]{20,}/.test(statement)
      || statement.includes('raw_transcript_body')
    ) {
      rejectedCandidates.push(
        rejectedCandidate(candidate, 'rejected', 'FORBIDDEN_SAFETY_LEAK'),
      );
      candidateReviews.push({
        candidateId: candidate.candidateId,
        decision: 'rejected',
        reason: 'FORBIDDEN_SAFETY_LEAK',
      });
      continue;
    }

    const crossRunPromotion = evaluateCrossRunPromotionCandidate({
      candidate,
      runId,
      projectId: String(projectId || candidate.projectId || ''),
    });
    if (crossRunPromotion.applies && !crossRunPromotion.eligible) {
      candidateReviews.push({
        candidateId: candidate.candidateId,
        decision: 'episodic',
        reason: crossRunPromotion.reasons[0]
          || 'CROSS_RUN_GROUP_EPISODIC_ONLY',
      });
      continue;
    }

    const feedbackClassification = (
      candidate.feedbackClassification
      && typeof candidate.feedbackClassification === 'object'
      && !Array.isArray(candidate.feedbackClassification)
    )
      ? candidate.feedbackClassification as UnknownRecord
      : {};
    const candidateSupersedes = (
      (
        candidate.sourceKind === 'feedback'
        && feedbackClassification.primary === 'stale_knowledge'
      )
      || (
        crossRunPromotion.applies
        && crossRunPromotion.eligible
        && candidate.signalKind === 'cross-run-promotion'
      )
    )
      ? strings(candidate.supersedes)
      : [];

    if (candidateSupersedes.length > 0) {
      const currentRecords = stateStore.listKnowledgeRecords({
        projectId,
        statuses: ['committed', 'verified'],
      }) as Array<OntologyConstraint & {
        projectId?: string | null;
        scope?: string[];
      }>;
      const candidateScope = strings(candidate.scope);
      let supersessionError: string | null = null;
      for (const targetId of candidateSupersedes) {
        const target = currentRecords.find((record) => record.id === targetId);
        if (!target) {
          supersessionError = 'SUPERSESSION_TARGET_NOT_FOUND';
          break;
        }
        if (target.projectId !== projectId) {
          supersessionError = 'SUPERSESSION_PROJECT_MISMATCH';
          break;
        }
        const targetScope = strings(target.scope);
        if (
          targetScope.length > 0
          && (
            candidateScope.length === 0
            || !candidateScope.every((candidatePath) => (
              matchPathScope(candidatePath, targetScope)
            ))
          )
        ) {
          supersessionError = 'SUPERSESSION_SCOPE_MISMATCH';
          break;
        }
      }
      if (supersessionError) {
        rejectedCandidates.push(
          rejectedCandidate(candidate, 'rejected', supersessionError),
        );
        candidateReviews.push({
          candidateId: candidate.candidateId,
          decision: 'rejected',
          reason: supersessionError,
        });
        continue;
      }
    }

    const ontologyEval = await evaluateOntologyConstraints({
      projectId,
      paths: strings(candidate.scope),
      statements: [statement],
      stateStore,
    });

    if (ontologyEval.violations.length > 0) {
      ontologyViolations.push(...ontologyEval.violations);
      rejectedCandidates.push(
        rejectedCandidate(candidate, 'rejected', 'ONTOLOGY_NEVER_VIOLATION'),
      );
      candidateReviews.push({
        candidateId: candidate.candidateId,
        decision: 'rejected',
        reason: 'ONTOLOGY_NEVER_VIOLATION',
      });
      continue;
    }

    if (ontologyEval.approvalRequired.length > 0) {
      approvalRequired.push(...ontologyEval.approvalRequired);
      const dbApproval = stateStore.getKnowledgeApproval(
        runId,
        candidate.candidateId,
      );
      const hasApproval = Boolean(
        dbApproval?.approvalReceipt && dbApproval.approvedBy,
      );
      if (!hasApproval) {
        needsApprovalCandidates.push(
          rejectedCandidate(candidate, 'needs_approval', 'ASK_FIRST_REQUIRED'),
        );
        candidateReviews.push({
          candidateId: candidate.candidateId,
          decision: 'needs_approval',
          reason: 'ASK_FIRST_REQUIRED',
        });
        continue;
      }
    }

    if (ontologyEval.verificationsRequired.length > 0) {
      verificationsRequired.push(...ontologyEval.verificationsRequired);
      let allPassed = true;
      for (const requirement of ontologyEval.verificationsRequired) {
        const obligationId = String(
          requirement.obligationId
          || requirement.id
          || 'verify-invariant',
        );
        stateStore.ensureRunObligation(runId, {
          obligationId,
          sourceType: 'ontology_constraint',
          sourceRef: requirement.id,
          protected: isProtectedObligation(obligationId),
        });
        const currentObligation = stateStore
          .getRunObligations(runId)
          .find((obligation) => (
            String(obligation.obligationId || '') === obligationId
          ));
        if (
          !currentObligation
          || (
            currentObligation.status !== 'passed'
            && currentObligation.status !== 'waived'
          )
        ) {
          allPassed = false;
        }
      }

      if (!allPassed) {
        pendingVerificationCandidates.push(
          rejectedCandidate(
            candidate,
            'pending_verification',
            'INVARIANT_VERIFICATION_REQUIRED',
          ),
        );
        candidateReviews.push({
          candidateId: candidate.candidateId,
          decision: 'pending_verification',
          reason: 'INVARIANT_VERIFICATION_REQUIRED',
        });
        continue;
      }
    }

    const verifications = stateStore.getVerifications(runId);
    const currentSourceIdentity = String(currentRun.sourceIdentity || '');
    const currentMutationRevision = Number(currentRun.mutationRevision);
    const authoritativeVerifications = verifications.filter((verification) => (
      verification.status === 'passed'
      && Number(verification.exitCode) === 0
      && Boolean(verification.evidenceDigest)
      && currentSourceIdentity.length > 0
      && String(verification.sourceIdentity || '') === currentSourceIdentity
      && Number.isInteger(currentMutationRevision)
      && Number(verification.verifiedMutationRevision) === currentMutationRevision
    ));
    let candidateEvidenceDigest: string | null = null;
    let improvementReplayVerificationId: unknown = null;
    let improvementReplayObligationId: string | null = null;

    if (candidate.improvementPair) {
      const promotion = evaluateImprovementPairPromotion({
        pair: candidate.improvementPair,
        candidateId: String(candidate.candidateId || ''),
        projectId: String(projectId || ''),
        scope: strings(candidate.scope),
        supersedes: strings(candidate.supersedes),
        run: currentRun,
        verifications,
        approval: stateStore.getKnowledgeApproval(
          runId,
          candidate.candidateId,
        ),
      });
      const reason = promotion.reasons[0]
        || 'IMPROVEMENT_PAIR_PROMOTION_BLOCKED';

      if (promotion.status === 'needs_approval') {
        needsApprovalCandidates.push(
          rejectedCandidate(candidate, 'needs_approval', reason),
        );
        candidateReviews.push({
          candidateId: candidate.candidateId,
          decision: 'needs_approval',
          reason,
        });
        continue;
      }
      if (promotion.status === 'pending_replay') {
        pendingVerificationCandidates.push(
          rejectedCandidate(candidate, 'pending_verification', reason),
        );
        candidateReviews.push({
          candidateId: candidate.candidateId,
          decision: 'pending_verification',
          reason,
        });
        continue;
      }
      if (!promotion.eligible) {
        rejectedCandidates.push(
          rejectedCandidate(candidate, 'rejected', reason),
        );
        candidateReviews.push({
          candidateId: candidate.candidateId,
          decision: 'rejected',
          reason,
        });
        continue;
      }

      for (const replayBinding of promotion.replayBindings) {
        stateStore.recordCandidateEvidenceBinding({
          candidateId: candidate.candidateId,
          runId,
          evidenceDigest: replayBinding.evidenceDigest,
          obligationId: replayBinding.obligationId,
          sourceIdentity: replayBinding.sourceIdentity,
          mutationRevision: replayBinding.mutationRevision,
          bindingType: 'improvement-replay',
        });
      }
      const firstReplayBinding = promotion.replayBindings[0];
      if (firstReplayBinding) {
        candidateEvidenceDigest = firstReplayBinding.evidenceDigest;
        improvementReplayVerificationId = firstReplayBinding.verificationId;
        improvementReplayObligationId = firstReplayBinding.obligationId;
      }
    }

    const binding = evidenceBinding(candidate);
    const candidateRefs = [...new Set([
      ...strings(candidate.evidenceRefs),
      ...strings(binding.evidenceRefs),
    ])];
    const acceptanceIds = new Set([
      ...strings(candidate.acceptanceIds),
      ...strings(binding.acceptanceIds),
    ]);
    const obligationIds = new Set([
      ...strings(candidate.obligationIds),
      ...strings(binding.obligationIds),
    ]);

    const matchingVerification = authoritativeVerifications.filter((verification) => {
      if (
        candidateRefs.length > 0
        && !candidateRefs.some((reference) => (
          reference === verification.evidenceDigest
          || reference === verification.evidenceRef
        ))
      ) {
        return false;
      }
      if (
        acceptanceIds.size > 0
        && !strings(verification.acceptanceCoverage)
          .some((id) => acceptanceIds.has(id))
      ) {
        return false;
      }
      if (
        obligationIds.size > 0
        && !obligationIds.has(String(verification.obligationId))
      ) {
        return false;
      }
      return true;
    });

    // A single current authoritative verification is a compatibility bridge
    // for legacy explicit observations. It is deliberately not the "last
    // verification" fallback: when several current receipts exist, the
    // observation must name its acceptance, obligation, or evidence ref.
    const selectedVerification = matchingVerification.length > 0
      ? matchingVerification[0]
      : (
          candidateRefs.length === 0
          && acceptanceIds.size === 0
          && obligationIds.size === 0
          && authoritativeVerifications.length === 1
        )
        ? authoritativeVerifications[0]
        : null;

    const structuredReceipt = candidate.sourceKind === 'auto'
      ? candidateRefs.find((reference) => (
          /^(?:failure|blocker|review|source|receipt):\/\//i.test(reference)
        ))
      : null;

    if (!candidateEvidenceDigest && selectedVerification?.evidenceDigest) {
      candidateEvidenceDigest = selectedVerification.evidenceDigest;
      stateStore.recordCandidateEvidenceBinding({
        candidateId: candidate.candidateId,
        runId,
        evidenceDigest: selectedVerification.evidenceDigest,
        obligationId: selectedVerification.obligationId || 'default',
        sourceIdentity: selectedVerification.sourceIdentity,
        mutationRevision: selectedVerification.verifiedMutationRevision,
        bindingType: candidate.sourceKind === 'auto'
          ? 'structured-signal'
          : 'verification',
      });
    } else if (!candidateEvidenceDigest && structuredReceipt) {
      candidateEvidenceDigest = structuredReceipt;
      stateStore.recordCandidateEvidenceBinding({
        candidateId: candidate.candidateId,
        runId,
        evidenceDigest: structuredReceipt,
        obligationId: candidate.obligationIds?.[0] || 'structured-signal',
        sourceIdentity: currentRun?.sourceIdentity || 'structured-signal',
        mutationRevision: currentRun?.mutationRevision || 0,
        bindingType: 'structured-signal',
      });
    }

    if (!candidateEvidenceDigest) {
      rejectedCandidates.push(
        rejectedCandidate(candidate, 'rejected', 'MISSING_VERIFICATION_EVIDENCE'),
      );
      candidateReviews.push({
        candidateId: candidate.candidateId,
        decision: 'rejected',
        reason: 'MISSING_VERIFICATION_EVIDENCE',
      });
      continue;
    }

    verifiedCandidates.push({
      ...candidate,
      status: 'verified',
      evidenceRefs: [candidateEvidenceDigest],
      evidenceBinding: {
        ...binding,
        evidenceRefs: [candidateEvidenceDigest],
        obligationId: selectedVerification?.obligationId
          ? String(selectedVerification.obligationId)
          : improvementReplayObligationId || candidate.obligationId || null,
        verificationId: selectedVerification?.id
          ?? improvementReplayVerificationId
          ?? null,
      },
    });
    if (candidate.candidateId) {
      for (const targetId of candidateSupersedes) {
        supersessionProposals.push({
          targetId,
          supersedingId: candidate.candidateId,
          reason: candidate.signalKind === 'cross-run-promotion'
            ? 'verified_cross_run_supersession'
            : 'verified_feedback_stale_knowledge',
        });
      }
    }
    candidateReviews.push({
      candidateId: candidate.candidateId,
      decision: 'verified',
      evidenceRef: candidateEvidenceDigest,
    });
  }

  let status: ReviewKnowledgeCandidatesResult['status'] = 'passed';
  if (
    ontologyViolations.length > 0
    || (
      rejectedCandidates.length === candidates.length
      && candidates.length > 0
    )
  ) {
    status = 'failed';
  } else if (needsApprovalCandidates.length > 0) {
    status = 'needs_approval';
  } else if (pendingVerificationCandidates.length > 0) {
    status = 'pending_verification';
  }

  return parseKernelContract('kernel.knowledge-review-result', {
    status,
    verifiedCandidates,
    rejectedCandidates,
    needsApprovalCandidates,
    pendingVerificationCandidates,
    candidateReviews,
    supersessionProposals,
    ontologyViolations,
    approvalRequired,
    verificationsRequired,
    evidenceCoverage: evidencePack
      ? [String(evidencePack.digest || 'evidence-pack')]
      : [],
  });
}
