import crypto from 'node:crypto';
import { matchPathScope } from '../../shared/path-scope.js';
import { analyzeChangeDiff } from './change-diff.js';
import {
  buildImprovementPair,
  type ImprovementPair,
  type ImprovementPairMemberInput,
  type ImprovementPairRollbackInput,
  type ImprovementPairScopeOwnerInput,
} from './improvement-pair.js';

interface EvidencePackLike {
  digest: string;
  status?: string;
}

export const FEEDBACK_ROOT_CAUSES = [
  'knowledge_gap',
  'procedure_gap',
  'verification_gap',
  'stale_knowledge',
  'known_failure',
  'ambiguity',
  'one_off',
] as const;

export type FeedbackRootCause = (typeof FEEDBACK_ROOT_CAUSES)[number];

export const FEEDBACK_SIGNAL_TO_CAUSE = {
  missing_knowledge: 'knowledge_gap',
  missing_procedure: 'procedure_gap',
  missing_verification: 'verification_gap',
  stale_knowledge: 'stale_knowledge',
  known_failure_match: 'known_failure',
  insufficient_evidence: 'ambiguity',
  isolated_occurrence: 'one_off',
} as const satisfies Record<string, FeedbackRootCause>;

export type FeedbackSignal = keyof typeof FEEDBACK_SIGNAL_TO_CAUSE;
export type FeedbackEvidenceOrigin = 'user_instruction' | 'analysis_inference';
export type FeedbackCauseRole = 'primary' | 'secondary';

export interface FeedbackCauseEvidence {
  signal: FeedbackSignal;
  origin: FeedbackEvidenceOrigin;
  role?: FeedbackCauseRole;
  evidenceRefs?: string[];
}

export interface ClassifyFeedbackRootCauseInput {
  feedbackId?: string | null;
  sourceIdentity?: string | null;
  sourceRevision?: string | number | null;
  evidence?: FeedbackCauseEvidence[];
}

export interface FeedbackCauseEvidenceRecord {
  signal: FeedbackSignal;
  cause: FeedbackRootCause;
  origin: FeedbackEvidenceOrigin;
  role: FeedbackCauseRole | null;
  evidenceRefs: string[];
}

export interface FeedbackRootCauseClassification {
  schemaVersion: 1;
  feedbackIdentity: string;
  sourceIdentity: string | null;
  sourceRevision: string | null;
  status: 'classified' | 'ambiguous';
  primary: FeedbackRootCause;
  secondary: FeedbackRootCause[];
  evidence: FeedbackCauseEvidenceRecord[];
  provenance: {
    userInstructionRefs: string[];
    analysisInferenceRefs: string[];
  };
}

const uniqueStrings = (value: unknown): string[] => (
  Array.isArray(value)
    ? [...new Set(value.map(String).map((item) => item.trim()).filter(Boolean))]
    : []
);

const isFeedbackSignal = (value: unknown): value is FeedbackSignal => (
  typeof value === 'string'
  && Object.hasOwn(FEEDBACK_SIGNAL_TO_CAUSE, value)
);

const isFeedbackEvidenceOrigin = (
  value: unknown,
): value is FeedbackEvidenceOrigin => (
  value === 'user_instruction' || value === 'analysis_inference'
);

const isFeedbackCauseRole = (value: unknown): value is FeedbackCauseRole => (
  value === 'primary' || value === 'secondary'
);

const feedbackIdentity = ({
  feedbackId,
  sourceIdentity,
  sourceRevision,
}: ClassifyFeedbackRootCauseInput): string => (
  'feedback-' + crypto
    .createHash('sha256')
    .update(JSON.stringify({
      feedbackId: feedbackId ? String(feedbackId) : null,
      sourceIdentity: sourceIdentity ? String(sourceIdentity) : null,
      sourceRevision: sourceRevision === null || sourceRevision === undefined
        ? null
        : String(sourceRevision),
    }))
    .digest('hex')
    .slice(0, 24)
);

export function classifyFeedbackRootCause(
  input: ClassifyFeedbackRootCauseInput = {},
): FeedbackRootCauseClassification {
  const evidence: FeedbackCauseEvidenceRecord[] = [];
  for (const item of input.evidence || []) {
    if (
      !item
      || !isFeedbackSignal(item.signal)
      || !isFeedbackEvidenceOrigin(item.origin)
    ) {
      continue;
    }
    const evidenceRefs = uniqueStrings(item.evidenceRefs);
    if (evidenceRefs.length === 0) continue;
    evidence.push({
      signal: item.signal,
      cause: FEEDBACK_SIGNAL_TO_CAUSE[item.signal],
      origin: item.origin,
      role: isFeedbackCauseRole(item.role) ? item.role : null,
      evidenceRefs,
    });
  }

  const supportedCauses = [
    ...new Set(
      evidence
        .map((item) => item.cause)
        .filter((cause) => cause !== 'ambiguity'),
    ),
  ];
  const explicitPrimary = [
    ...new Set(
      evidence
        .filter((item) => item.role === 'primary' && item.cause !== 'ambiguity')
        .map((item) => item.cause),
    ),
  ];
  const hasAmbiguityEvidence = evidence.some((item) => (
    item.cause === 'ambiguity'
  ));

  let primary: FeedbackRootCause = 'ambiguity';
  const explicitPrimaryCause = explicitPrimary[0];
  const soleSupportedCause = supportedCauses[0];
  if (
    !hasAmbiguityEvidence
    && explicitPrimary.length === 1
    && explicitPrimaryCause
  ) {
    primary = explicitPrimaryCause;
  } else if (
    !hasAmbiguityEvidence
    && explicitPrimary.length === 0
    && supportedCauses.length === 1
    && soleSupportedCause
  ) {
    primary = soleSupportedCause;
  }

  const secondary = supportedCauses.filter((cause) => cause !== primary);
  const userInstructionRefs = uniqueStrings(
    evidence
      .filter((item) => item.origin === 'user_instruction')
      .flatMap((item) => item.evidenceRefs),
  );
  const analysisInferenceRefs = uniqueStrings(
    evidence
      .filter((item) => item.origin === 'analysis_inference')
      .flatMap((item) => item.evidenceRefs),
  );

  return {
    schemaVersion: 1,
    feedbackIdentity: feedbackIdentity(input),
    sourceIdentity: input.sourceIdentity ? String(input.sourceIdentity) : null,
    sourceRevision: input.sourceRevision === null || input.sourceRevision === undefined
      ? null
      : String(input.sourceRevision),
    status: primary === 'ambiguity' ? 'ambiguous' : 'classified',
    primary,
    secondary,
    evidence,
    provenance: {
      userInstructionRefs,
      analysisInferenceRefs,
    },
  };
}

export interface FeedbackExistingRecord {
  id: string;
  projectId: string;
  type: string;
  status?: string | null;
  scope?: string[];
  statement?: string | null;
}

export interface BuildFeedbackCorrectionPlanInput {
  projectId: string;
  statement: string;
  scope?: string[];
  classification: FeedbackRootCauseClassification;
  relatedRecordIds?: string[];
  existingRecords?: FeedbackExistingRecord[];
  replayCandidate?: ImprovementPairMemberInput | null;
  scopeOwner?: ImprovementPairScopeOwnerInput | null;
  rollback?: ImprovementPairRollbackInput | null;
}

export interface FeedbackCorrectionCandidate extends Record<string, unknown> {
  candidateId: string;
  projectId: string;
  proposedType: string;
  statement: string;
  scope: string[];
  sourceKind: 'feedback';
  status: 'observed';
  trustTier: 'derived';
  evidenceRefs: string[];
  supersedes: string[];
  feedbackClassification: FeedbackRootCauseClassification;
  correctionIntent: FeedbackRootCause;
  improvementPair: ImprovementPair;
}

export interface FeedbackCorrectionPlan {
  schemaVersion: 1;
  feedbackIdentity: string;
  action: 'candidate' | 'reuse_existing' | 'needs_confirmation';
  reason: string;
  candidates: FeedbackCorrectionCandidate[];
  reuseRecordIds: string[];
}

const activeExistingRecord = (record: FeedbackExistingRecord): boolean => (
  !['superseded', 'rejected', 'archived'].includes(String(record.status || ''))
);

const scopeIsWithinRecord = (
  scope: readonly string[],
  recordScope: readonly string[] = [],
): boolean => {
  if (recordScope.length === 0) return true;
  if (scope.length === 0) return false;
  return scope.every((targetPath) => matchPathScope(targetPath, recordScope));
};

const correctionEvidenceRefs = (
  classification: FeedbackRootCauseClassification,
): string[] => uniqueStrings(
  classification.evidence.flatMap((item) => item.evidenceRefs),
);

const correctionCandidateId = ({
  projectId,
  statement,
  scope,
  classification,
  supersedes,
}: {
  projectId: string;
  statement: string;
  scope: string[];
  classification: FeedbackRootCauseClassification;
  supersedes: string[];
}): string => (
  'cand-feedback-' + crypto
    .createHash('sha256')
    .update(JSON.stringify({
      projectId,
      sourceIdentity: classification.sourceIdentity,
      sourceRevision: classification.sourceRevision,
      cause: classification.primary,
      statement: statement.trim(),
      scope: [...scope].sort(),
      supersedes: [...supersedes].sort(),
    }))
    .digest('hex')
    .slice(0, 24)
);

const candidateTypeForCause = (
  cause: FeedbackRootCause,
): string | null => {
  if (cause === 'knowledge_gap') return 'semantic_fact';
  if (cause === 'procedure_gap' || cause === 'one_off') {
    return 'episodic_observation';
  }
  if (cause === 'verification_gap') return 'required_verification';
  return null;
};

export function buildFeedbackCorrectionPlan({
  projectId,
  statement,
  scope = [],
  classification,
  relatedRecordIds = [],
  existingRecords = [],
  replayCandidate = null,
  scopeOwner = null,
  rollback = null,
}: BuildFeedbackCorrectionPlanInput): FeedbackCorrectionPlan {
  const relatedIds = new Set(uniqueStrings(relatedRecordIds));
  const related = existingRecords.filter((record) => (
    relatedIds.has(record.id)
    && record.projectId === projectId
    && activeExistingRecord(record)
    && scopeIsWithinRecord(scope, record.scope || [])
  ));

  if (
    classification.status === 'ambiguous'
    || classification.primary === 'ambiguity'
  ) {
    return {
      schemaVersion: 1,
      feedbackIdentity: classification.feedbackIdentity,
      action: 'needs_confirmation',
      reason: 'feedback_root_cause_ambiguous',
      candidates: [],
      reuseRecordIds: [],
    };
  }

  if (classification.primary === 'known_failure') {
    const matches = related.filter((record) => (
      record.type === 'known_failure_pattern'
    ));
    if (matches.length !== 1) {
      return {
        schemaVersion: 1,
        feedbackIdentity: classification.feedbackIdentity,
        action: 'needs_confirmation',
        reason: 'known_failure_match_not_unique',
        candidates: [],
        reuseRecordIds: [],
      };
    }
    const match = matches[0];
    if (!match) {
      throw new Error('known failure match disappeared during correction planning');
    }
    return {
      schemaVersion: 1,
      feedbackIdentity: classification.feedbackIdentity,
      action: 'reuse_existing',
      reason: 'known_failure_reused',
      candidates: [],
      reuseRecordIds: [match.id],
    };
  }

  let supersedes: string[] = [];
  let proposedType = candidateTypeForCause(classification.primary);
  if (classification.primary === 'stale_knowledge') {
    if (related.length !== 1) {
      return {
        schemaVersion: 1,
        feedbackIdentity: classification.feedbackIdentity,
        action: 'needs_confirmation',
        reason: 'stale_target_not_unique_or_out_of_scope',
        candidates: [],
        reuseRecordIds: [],
      };
    }
    const target = related[0];
    if (!target) {
      throw new Error('stale knowledge target disappeared during correction planning');
    }
    proposedType = target.type;
    supersedes = [target.id];
  }

  if (!proposedType) {
    return {
      schemaVersion: 1,
      feedbackIdentity: classification.feedbackIdentity,
      action: 'needs_confirmation',
      reason: 'feedback_cause_has_no_candidate_mapping',
      candidates: [],
      reuseRecordIds: [],
    };
  }

  const normalizedScope = uniqueStrings(scope);
  const candidateId = correctionCandidateId({
    projectId,
    statement,
    scope: normalizedScope,
    classification,
    supersedes,
  });
  const evidenceRefs = correctionEvidenceRefs(classification);
  const improvementPair = buildImprovementPair({
    correctionId: candidateId,
    projectId,
    sourceIdentity: classification.sourceIdentity,
    sourceRevision: classification.sourceRevision,
    scope: normalizedScope,
    sourceEvidenceRefs: evidenceRefs,
    mutationCandidate: {
      candidateId,
      projectId,
      sourceRevision: classification.sourceRevision,
      scope: normalizedScope,
      evidenceRefs,
    },
    replayCandidate,
    scopeOwner,
    rollback,
  });
  const candidate: FeedbackCorrectionCandidate = {
    candidateId,
    projectId,
    proposedType,
    statement: statement.trim(),
    scope: normalizedScope,
    sourceKind: 'feedback',
    status: 'observed',
    trustTier: 'derived',
    evidenceRefs,
    supersedes,
    feedbackClassification: classification,
    correctionIntent: classification.primary,
    improvementPair,
  };

  return {
    schemaVersion: 1,
    feedbackIdentity: classification.feedbackIdentity,
    action: 'candidate',
    reason: classification.primary === 'stale_knowledge'
      ? 'stale_knowledge_correction_candidate'
      : 'feedback_gap_candidate',
    candidates: [candidate],
    reuseRecordIds: [],
  };
}

export interface ExtractKnowledgeCandidatesInput {
  runId: string;
  projectId: string;
  objective?: string;
  changedFiles?: string[];
  evidencePack?: EvidencePackLike | null;
  observedStatements?: string[];
}

export function extractKnowledgeCandidates({
  runId,
  projectId,
  objective: _objective,
  changedFiles = [],
  evidencePack = null,
  observedStatements = [],
}: ExtractKnowledgeCandidatesInput) {
  const diffInfo = analyzeChangeDiff({ changedFiles });
  void diffInfo;

  const candidates = [];
  for (const statement of observedStatements) {
    if (
      /sk-[a-zA-Z0-9]{20,}/.test(statement)
      || statement.toLowerCase().includes('raw_transcript_body')
    ) {
      continue;
    }

    const candidateId = 'cand-' + crypto
      .createHash('sha256')
      .update(`${runId}:${statement}`)
      .digest('hex')
      .slice(0, 12);

    candidates.push({
      candidateId,
      runId,
      projectId,
      proposedType: 'semantic_fact',
      statement,
      scope: changedFiles,
      relatedFiles: changedFiles,
      sourceRefs: [],
      evidenceRefs: evidencePack ? [evidencePack.digest] : [],
      confidence: evidencePack?.status === 'pass' ? 0.9 : 0.4,
      status: 'observed',
      supersedes: [],
      rejectionReasons: [],
    });
  }

  return candidates;
}
