import { sha256Hex } from '../../shared/candidate-identity.js';

type UnknownRecord = Record<string, unknown>;

export interface ImprovementPairMemberInput {
  candidateId?: unknown;
  projectId?: unknown;
  sourceRevision?: unknown;
  scope?: unknown;
  evidenceRefs?: unknown;
  obligationIds?: unknown;
}

export interface ImprovementPairMember {
  candidateId: string;
  projectId: string;
  sourceRevision: string | null;
  scope: string[];
  evidenceRefs: string[];
  obligationIds: string[];
}

export interface ImprovementPairScopeOwnerInput {
  owner?: unknown;
  sourceRevision?: unknown;
  scope?: unknown;
}

export interface ImprovementPairScopeOwner {
  owner: string;
  sourceRevision: string | null;
  scope: string[];
}

export interface ImprovementPairRollbackInput {
  strategy?: unknown;
  targetIds?: unknown;
  evidenceRefs?: unknown;
}

export interface ImprovementPairRollback {
  strategy: string;
  targetIds: string[];
  evidenceRefs: string[];
}

export interface BuildImprovementPairInput {
  correctionId: string;
  projectId: string;
  sourceIdentity?: string | null;
  sourceRevision?: string | number | null;
  scope?: string[];
  sourceEvidenceRefs?: string[];
  mutationCandidate?: ImprovementPairMemberInput | null;
  replayCandidate?: ImprovementPairMemberInput | null;
  scopeOwner?: ImprovementPairScopeOwnerInput | null;
  rollback?: ImprovementPairRollbackInput | null;
}

export interface ImprovementPair {
  schemaVersion: 1;
  pairId: string;
  correctionId: string;
  projectId: string;
  sourceIdentity: string | null;
  sourceRevision: string | null;
  scope: string[];
  sourceEvidenceRefs: string[];
  mutationCandidate: ImprovementPairMember | null;
  replayCandidate: ImprovementPairMember | null;
  scopeOwner: ImprovementPairScopeOwner | null;
  rollback: ImprovementPairRollback | null;
  status: 'ready' | 'incomplete' | 'invalid';
  recovery: {
    state:
      | 'complete'
      | 'awaiting_mutation'
      | 'awaiting_replay'
      | 'awaiting_both'
      | 'identity_mismatch';
    missing: string[];
    conflicts: string[];
  };
}

export interface ImprovementPairPromotionVerification {
  id?: unknown;
  status?: unknown;
  exitCode?: unknown;
  evidenceDigest?: unknown;
  evidenceRef?: unknown;
  obligationId?: unknown;
  sourceIdentity?: unknown;
  verifiedMutationRevision?: unknown;
}

export interface ImprovementPairPromotionApproval {
  candidateId?: unknown;
  approvedBy?: unknown;
  approvalReceipt?: unknown;
}

export interface ImprovementPairPromotionRun {
  sourceIdentity?: unknown;
  mutationRevision?: unknown;
}

export interface EvaluateImprovementPairPromotionInput {
  pair: unknown;
  candidateId: string;
  projectId: string;
  scope?: string[];
  supersedes?: string[];
  run?: ImprovementPairPromotionRun | null;
  verifications?: ImprovementPairPromotionVerification[];
  approval?: ImprovementPairPromotionApproval | null;
}

export interface ImprovementPairReplayBinding {
  verificationId: unknown;
  obligationId: string;
  evidenceDigest: string;
  sourceIdentity: string;
  mutationRevision: number;
}

export interface ImprovementPairPromotionAssessment {
  eligible: boolean;
  status: 'eligible' | 'pending_replay' | 'needs_approval' | 'rejected';
  reasons: string[];
  pairId: string | null;
  replayBindings: ImprovementPairReplayBinding[];
  approvalRef: string | null;
  scopeOwner: string | null;
  rollbackStrategy: string | null;
}

const asRecord = (value: unknown): UnknownRecord => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : {}
);

const text = (value: unknown): string => (
  value === null || value === undefined ? '' : String(value).trim()
);

const uniqueStrings = (value: unknown): string[] => (
  Array.isArray(value)
    ? [...new Set(value.map(text).filter(Boolean))]
    : []
);

const revision = (value: unknown): string | null => {
  const normalized = text(value);
  return normalized || null;
};

const normalizedScope = (value: unknown): string[] => (
  uniqueStrings(value).sort()
);

const sameScope = (
  left: readonly string[],
  right: readonly string[],
): boolean => (
  left.length === right.length
  && left.every((value, index) => value === right[index])
);

const normalizeMember = (
  value: ImprovementPairMemberInput | null | undefined,
): ImprovementPairMember | null => {
  if (!value) return null;
  const candidateId = text(value.candidateId);
  if (!candidateId) return null;
  return {
    candidateId,
    projectId: text(value.projectId),
    sourceRevision: revision(value.sourceRevision),
    scope: normalizedScope(value.scope),
    evidenceRefs: uniqueStrings(value.evidenceRefs),
    obligationIds: uniqueStrings(value.obligationIds),
  };
};

const normalizeScopeOwner = (
  value: ImprovementPairScopeOwnerInput | null | undefined,
): ImprovementPairScopeOwner | null => {
  if (!value) return null;
  const owner = text(value.owner);
  if (!owner) return null;
  return {
    owner,
    sourceRevision: revision(value.sourceRevision),
    scope: normalizedScope(value.scope),
  };
};

const normalizeRollback = (
  value: ImprovementPairRollbackInput | null | undefined,
): ImprovementPairRollback | null => {
  if (!value) return null;
  const strategy = text(value.strategy);
  if (!strategy) return null;
  return {
    strategy,
    targetIds: uniqueStrings(value.targetIds),
    evidenceRefs: uniqueStrings(value.evidenceRefs),
  };
};

export function improvementPairId({
  correctionId,
  projectId,
  sourceIdentity = null,
  sourceRevision = null,
  scope = [],
}: Pick<
  BuildImprovementPairInput,
  'correctionId'
  | 'projectId'
  | 'sourceIdentity'
  | 'sourceRevision'
  | 'scope'
>): string {
  return 'pair-' + sha256Hex({
    correctionId: text(correctionId),
    projectId: text(projectId),
    sourceIdentity: revision(sourceIdentity),
    sourceRevision: revision(sourceRevision),
    scope: normalizedScope(scope),
  }).slice(0, 24);
}

export function buildImprovementPair({
  correctionId,
  projectId,
  sourceIdentity = null,
  sourceRevision = null,
  scope = [],
  sourceEvidenceRefs = [],
  mutationCandidate = null,
  replayCandidate = null,
  scopeOwner = null,
  rollback = null,
}: BuildImprovementPairInput): ImprovementPair {
  const normalizedProjectId = text(projectId);
  const normalizedCorrectionId = text(correctionId);
  const normalizedSourceIdentity = revision(sourceIdentity);
  const normalizedSourceRevision = revision(sourceRevision);
  const pairScope = normalizedScope(scope);
  const normalizedEvidenceRefs = uniqueStrings(sourceEvidenceRefs);
  const mutation = normalizeMember(mutationCandidate);
  const replay = normalizeMember(replayCandidate);
  const normalizedOwner = normalizeScopeOwner(scopeOwner);
  const normalizedRollback = normalizeRollback(rollback);

  const conflicts: string[] = [];
  if (!normalizedCorrectionId) conflicts.push('correction_id_missing');
  if (!normalizedProjectId) conflicts.push('project_id_missing');
  if (!normalizedSourceIdentity) conflicts.push('source_identity_missing');
  if (!normalizedSourceRevision) conflicts.push('source_revision_missing');
  if (normalizedEvidenceRefs.length === 0) {
    conflicts.push('source_evidence_missing');
  }

  for (const [role, member] of [
    ['mutation', mutation],
    ['replay', replay],
  ] as const) {
    if (!member) continue;
    if (member.projectId !== normalizedProjectId) {
      conflicts.push(`${role}_project_mismatch`);
    }
    if (member.sourceRevision !== normalizedSourceRevision) {
      conflicts.push(`${role}_revision_mismatch`);
    }
    if (!sameScope(member.scope, pairScope)) {
      conflicts.push(`${role}_scope_mismatch`);
    }
  }

  const missing: string[] = [];
  if (!mutation) missing.push('mutation_candidate');
  if (!replay) missing.push('replay_candidate');

  const status: ImprovementPair['status'] = conflicts.length > 0
    ? 'invalid'
    : missing.length > 0
      ? 'incomplete'
      : 'ready';

  let recoveryState: ImprovementPair['recovery']['state'] = 'complete';
  if (status === 'invalid') {
    recoveryState = 'identity_mismatch';
  } else if (missing.length === 2) {
    recoveryState = 'awaiting_both';
  } else if (missing.includes('mutation_candidate')) {
    recoveryState = 'awaiting_mutation';
  } else if (missing.includes('replay_candidate')) {
    recoveryState = 'awaiting_replay';
  }

  return {
    schemaVersion: 1,
    pairId: improvementPairId({
      correctionId: normalizedCorrectionId,
      projectId: normalizedProjectId,
      sourceIdentity: normalizedSourceIdentity,
      sourceRevision: normalizedSourceRevision,
      scope: pairScope,
    }),
    correctionId: normalizedCorrectionId,
    projectId: normalizedProjectId,
    sourceIdentity: normalizedSourceIdentity,
    sourceRevision: normalizedSourceRevision,
    scope: pairScope,
    sourceEvidenceRefs: normalizedEvidenceRefs,
    mutationCandidate: mutation,
    replayCandidate: replay,
    scopeOwner: normalizedOwner,
    rollback: normalizedRollback,
    status,
    recovery: {
      state: recoveryState,
      missing,
      conflicts,
    },
  };
}

const assessment = (
  status: ImprovementPairPromotionAssessment['status'],
  reasons: string[],
  {
    pairId = null,
    replayBindings = [],
    approvalRef = null,
    scopeOwner = null,
    rollbackStrategy = null,
  }: Partial<ImprovementPairPromotionAssessment> = {},
): ImprovementPairPromotionAssessment => ({
  eligible: status === 'eligible',
  status,
  reasons,
  pairId,
  replayBindings,
  approvalRef,
  scopeOwner,
  rollbackStrategy,
});

export function improvementPairApprovalRef(pair: unknown): string {
  const pairRecord = asRecord(pair);
  return 'improvement-pair-approval:' + sha256Hex({
    pairId: text(pairRecord.pairId),
    correctionId: text(pairRecord.correctionId),
    projectId: text(pairRecord.projectId),
    sourceIdentity: revision(pairRecord.sourceIdentity),
    sourceRevision: revision(pairRecord.sourceRevision),
    scope: normalizedScope(pairRecord.scope),
    sourceEvidenceRefs: uniqueStrings(pairRecord.sourceEvidenceRefs).sort(),
    mutationCandidate: normalizeMember(
      asRecord(pairRecord.mutationCandidate),
    ),
    replayCandidate: normalizeMember(
      asRecord(pairRecord.replayCandidate),
    ),
    scopeOwner: normalizeScopeOwner(
      asRecord(pairRecord.scopeOwner),
    ),
    rollback: normalizeRollback(
      asRecord(pairRecord.rollback),
    ),
  });
}

export function evaluateImprovementPairPromotion({
  pair,
  candidateId,
  projectId,
  scope = [],
  supersedes = [],
  run = null,
  verifications = [],
  approval = null,
}: EvaluateImprovementPairPromotionInput): ImprovementPairPromotionAssessment {
  const pairRecord = asRecord(pair);
  const pairId = text(pairRecord.pairId) || null;
  const pairCorrectionId = text(pairRecord.correctionId);
  const pairProjectId = text(pairRecord.projectId);
  const pairSourceIdentity = revision(pairRecord.sourceIdentity);
  const pairSourceRevision = revision(pairRecord.sourceRevision);
  const pairScope = normalizedScope(pairRecord.scope);
  const candidateScope = normalizedScope(scope);

  if (pairRecord.status === 'incomplete') {
    return assessment('pending_replay', ['IMPROVEMENT_PAIR_NOT_READY'], {
      pairId,
    });
  }
  if (pairRecord.status !== 'ready') {
    return assessment('rejected', ['IMPROVEMENT_PAIR_INVALID'], { pairId });
  }

  const expectedPairId = improvementPairId({
    correctionId: pairCorrectionId,
    projectId: pairProjectId,
    sourceIdentity: pairSourceIdentity,
    sourceRevision: pairSourceRevision,
    scope: pairScope,
  });
  if (pairId !== expectedPairId || pairCorrectionId !== text(candidateId)) {
    return assessment('rejected', ['IMPROVEMENT_PAIR_ID_MISMATCH'], {
      pairId,
    });
  }
  if (pairProjectId !== text(projectId)) {
    return assessment('rejected', ['IMPROVEMENT_PAIR_PROJECT_MISMATCH'], {
      pairId,
    });
  }
  if (!sameScope(pairScope, candidateScope)) {
    return assessment('rejected', ['IMPROVEMENT_PAIR_SCOPE_MISMATCH'], {
      pairId,
    });
  }

  const scopeOwnerRecord = asRecord(pairRecord.scopeOwner);
  const owner = text(scopeOwnerRecord.owner);
  const ownerRevision = revision(scopeOwnerRecord.sourceRevision);
  const ownerScope = normalizedScope(scopeOwnerRecord.scope);
  if (!owner) {
    return assessment('rejected', ['SCOPE_OWNER_MISSING'], { pairId });
  }
  if (ownerRevision !== pairSourceRevision) {
    return assessment('rejected', ['SCOPE_OWNER_STALE'], {
      pairId,
      scopeOwner: owner,
    });
  }
  if (!sameScope(ownerScope, pairScope)) {
    return assessment('rejected', ['SCOPE_OWNER_SCOPE_MISMATCH'], {
      pairId,
      scopeOwner: owner,
    });
  }

  const rollbackRecord = asRecord(pairRecord.rollback);
  const rollbackStrategy = text(rollbackRecord.strategy);
  const rollbackTargets = new Set(uniqueStrings(rollbackRecord.targetIds));
  if (!rollbackStrategy) {
    return assessment('rejected', ['ROLLBACK_PLAN_MISSING'], {
      pairId,
      scopeOwner: owner,
    });
  }
  const supersededIds = uniqueStrings(supersedes);
  if (
    supersededIds.length > 0
    && supersededIds.some((targetId) => !rollbackTargets.has(targetId))
  ) {
    return assessment('rejected', ['ROLLBACK_SUPERSESSION_MISMATCH'], {
      pairId,
      scopeOwner: owner,
      rollbackStrategy,
    });
  }

  const approvalCandidateId = text(approval?.candidateId);
  const approvedBy = text(approval?.approvedBy);
  const approvalReceipt = text(approval?.approvalReceipt);
  if (!approvedBy || !approvalReceipt) {
    return assessment('needs_approval', ['KNOWLEDGE_APPROVAL_REQUIRED'], {
      pairId,
      scopeOwner: owner,
      rollbackStrategy,
    });
  }
  if (!approvalCandidateId || approvalCandidateId !== text(candidateId)) {
    return assessment('needs_approval', ['STALE_KNOWLEDGE_APPROVAL'], {
      pairId,
      scopeOwner: owner,
      rollbackStrategy,
    });
  }
  if (approvedBy !== owner) {
    return assessment(
      'needs_approval',
      ['SCOPE_OWNER_APPROVAL_MISMATCH'],
      {
        pairId,
        scopeOwner: owner,
        rollbackStrategy,
      },
    );
  }
  if (approvalReceipt !== improvementPairApprovalRef(pairRecord)) {
    return assessment('needs_approval', ['STALE_KNOWLEDGE_APPROVAL'], {
      pairId,
      scopeOwner: owner,
      rollbackStrategy,
    });
  }

  const replayRecord = asRecord(pairRecord.replayCandidate);
  const replayObligations = uniqueStrings(replayRecord.obligationIds);
  const replayEvidenceRefs = new Set(uniqueStrings(replayRecord.evidenceRefs));
  if (replayObligations.length === 0) {
    return assessment('pending_replay', ['REPLAY_OBLIGATION_REQUIRED'], {
      pairId,
      approvalRef: approvalReceipt,
      scopeOwner: owner,
      rollbackStrategy,
    });
  }

  const runSourceIdentity = text(run?.sourceIdentity);
  const runMutationRevision = Number(run?.mutationRevision);
  if (
    !runSourceIdentity
    || !Number.isInteger(runMutationRevision)
    || runMutationRevision < 0
  ) {
    return assessment('pending_replay', ['REPLAY_FRESHNESS_UNAVAILABLE'], {
      pairId,
      approvalRef: approvalReceipt,
      scopeOwner: owner,
      rollbackStrategy,
    });
  }

  const replayBindings: ImprovementPairReplayBinding[] = [];
  const replayReasons = new Set<string>();
  for (const obligationId of replayObligations) {
    const related = verifications.filter((verification) => (
      text(verification.obligationId) === obligationId
    ));
    const fresh = related.find((verification) => {
      if (
        verification.status !== 'passed'
        || Number(verification.exitCode) !== 0
      ) {
        return false;
      }
      const digest = text(verification.evidenceDigest);
      if (!digest) return false;
      if (text(verification.sourceIdentity) !== runSourceIdentity) return false;
      if (
        Number(verification.verifiedMutationRevision)
        !== runMutationRevision
      ) {
        return false;
      }
      if (
        replayEvidenceRefs.size > 0
        && !replayEvidenceRefs.has(digest)
        && !replayEvidenceRefs.has(text(verification.evidenceRef))
      ) {
        return false;
      }
      return true;
    });

    if (!fresh) {
      const failed = related.some((verification) => (
        verification.status === 'failed'
        || Number(verification.exitCode) !== 0
      ));
      const stale = related.some((verification) => (
        verification.status === 'passed'
        && Number(verification.exitCode) === 0
        && (
          text(verification.sourceIdentity) !== runSourceIdentity
          || Number(verification.verifiedMutationRevision)
            !== runMutationRevision
        )
      ));
      const evidenceMismatch = related.some((verification) => (
        verification.status === 'passed'
        && Number(verification.exitCode) === 0
        && text(verification.sourceIdentity) === runSourceIdentity
        && Number(verification.verifiedMutationRevision)
          === runMutationRevision
        && replayEvidenceRefs.size > 0
      ));
      replayReasons.add(
        failed
          ? 'REPLAY_FAILED'
          : stale
            ? 'REPLAY_STALE'
            : evidenceMismatch
              ? 'REPLAY_EVIDENCE_MISMATCH'
              : 'REPLAY_MISSING',
      );
      continue;
    }

    replayBindings.push({
      verificationId: fresh.id ?? null,
      obligationId,
      evidenceDigest: text(fresh.evidenceDigest),
      sourceIdentity: runSourceIdentity,
      mutationRevision: runMutationRevision,
    });
  }

  if (replayReasons.size > 0) {
    return assessment('pending_replay', [...replayReasons], {
      pairId,
      approvalRef: approvalReceipt,
      scopeOwner: owner,
      rollbackStrategy,
    });
  }

  return assessment('eligible', [], {
    pairId,
    replayBindings,
    approvalRef: approvalReceipt,
    scopeOwner: owner,
    rollbackStrategy,
  });
}
