import path from 'node:path';
import crypto from 'node:crypto';
import {
  projectKnowledgeDirectory,
  writeAtomicJson,
} from './store.js';
import {
  buildKnowledgeCommitReceipt,
  type KnowledgeCommitReceipt,
} from './receipt.js';
import {
  validateKnowledgeRecord,
  resolveRecordType,
  type KnowledgeRecord,
} from './records.js';
import {
  rebuildKnowledgeProjection,
  type KnowledgeProjectionStore,
} from './projection.js';
import { evaluateImprovementPairPromotion } from './improvement-pair.js';

export { rebuildKnowledgeProjection } from './projection.js';

type UnknownRecord = Record<string, unknown>;

interface RunLike extends UnknownRecord {
  projectId?: unknown;
  sourceIdentity?: unknown;
  mutationRevision?: unknown;
}

interface CompletionDecisionLike extends UnknownRecord {
  decision?: unknown;
  sourceIdentity?: unknown;
  mutationRevision?: unknown;
  evidenceDigest?: unknown;
}

interface CandidateLike extends UnknownRecord {
  status?: unknown;
  proposedType?: unknown;
  type?: unknown;
  candidateId?: unknown;
  id?: unknown;
  statement?: unknown;
  scope?: unknown;
  evidenceRefs?: unknown;
  supersedes?: unknown;
  improvementPair?: unknown;
}

interface StoredCandidateLike extends UnknownRecord {
  status?: unknown;
  candidateJson?: unknown;
}

interface SupersessionProposalLike extends UnknownRecord {
  targetId?: unknown;
}

interface KnowledgeTransactionResult extends UnknownRecord {
  revisionBefore: string | number;
  revisionAfter: string | number;
  status?: unknown;
}

interface KnowledgeCommitStore extends KnowledgeProjectionStore {
  getRun(runId: string): RunLike | null;
  getCompletionDecision?(runId: string): CompletionDecisionLike | null;
  getKnowledgeCandidates(runId: string): StoredCandidateLike[];
  getKnowledgeApproval?(
    runId: string,
    candidateId: string,
  ): UnknownRecord | null;
  getVerifications?(runId: string): UnknownRecord[];
  commitKnowledgeTransaction(input: UnknownRecord): KnowledgeTransactionResult;
}

export interface CommitProjectKnowledgeInput {
  runId: string;
  projectId: string;
  stateStore?: KnowledgeCommitStore | null;
  expectedKnowledgeRevision?: unknown;
  completionDecisionRef?: unknown;
  candidates?: CandidateLike[] | null;
  supersessionProposals?: Array<SupersessionProposalLike | string>;
  sourceIdentity?: string;
  faultInjection?: unknown;
  env?: NodeJS.ProcessEnv;
}

export class KernelKnowledgeCommitError extends Error {
  readonly code: string;
  readonly details: UnknownRecord;

  constructor(
    code: string,
    message: string,
    details: UnknownRecord = {},
  ) {
    super(message);
    this.name = 'KernelKnowledgeCommitError';
    this.code = code;
    this.details = details;
  }
}

const asRecord = (value: unknown): UnknownRecord => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : {}
);

const asCandidate = (value: unknown): CandidateLike => asRecord(value);

const strings = (value: unknown): string[] => (
  Array.isArray(value)
    ? value.map(String).filter(Boolean)
    : []
);

const errorMessage = (error: unknown): string => (
  error instanceof Error ? error.message : String(error)
);

const normalizeCommittedRecord = (
  candidate: CandidateLike,
  projectId: string,
): KnowledgeRecord => {
  const record: UnknownRecord = {
    id: candidate.candidateId
      ? String(candidate.candidateId)
      : candidate.id
        ? String(candidate.id)
        : `rec-${crypto.randomUUID()}`,
    candidateId: candidate.candidateId
      ? String(candidate.candidateId)
      : candidate.id
        ? String(candidate.id)
        : null,
    projectId,
    type: resolveRecordType(candidate.proposedType || candidate.type),
    statement: candidate.statement ? String(candidate.statement) : '',
    scope: strings(candidate.scope),
    status: 'committed',
    trustTier: 'verified',
    createdAt: new Date().toISOString(),
    evidence: { refs: strings(candidate.evidenceRefs) },
    ...(strings(candidate.supersedes).length > 0
      ? { supersedes: strings(candidate.supersedes) }
      : {}),
    ...(candidate.improvementPair
      ? { improvementPair: asRecord(candidate.improvementPair) }
      : {}),
  };

  if (!validateKnowledgeRecord(record)) {
    throw new KernelKnowledgeCommitError(
      'INVALID_RECORD',
      'Candidate could not be normalized into a valid Knowledge record',
    );
  }
  return record;
};

const normalizeStoredCandidate = (value: unknown): CandidateLike => {
  const record = asRecord(value);
  return asCandidate(record.candidateJson);
};

export async function commitProjectKnowledge({
  runId,
  projectId,
  stateStore = null,
  expectedKnowledgeRevision = null,
  completionDecisionRef = null,
  candidates = null,
  supersessionProposals = [],
  sourceIdentity = 'kernel-source',
  faultInjection = null,
  env = process.env,
}: CommitProjectKnowledgeInput): Promise<KnowledgeCommitReceipt> {
  if (!stateStore || typeof stateStore.getRun !== 'function') {
    throw new KernelKnowledgeCommitError(
      'COMPLETION_AUTHORITY_REQUIRED',
      'Kernel stateStore is required for completion authority',
    );
  }

  const run = stateStore.getRun(runId);
  const completion = stateStore.getCompletionDecision
    ? stateStore.getCompletionDecision(runId)
    : null;

  if (!run) {
    throw new KernelKnowledgeCommitError(
      'RUN_NOT_FOUND',
      `Run ${runId} not found`,
    );
  }
  if (!completion) {
    throw new KernelKnowledgeCommitError(
      'COMPLETION_DECISION_REQUIRED',
      `Run ${runId} has no authoritative completion decision`,
    );
  }
  if (completion.decision !== 'accepted') {
    throw new KernelKnowledgeCommitError(
      'COMPLETION_NOT_ACCEPTED',
      `Run ${runId} completion decision is ${String(completion.decision)}`,
    );
  }
  if (run.projectId !== projectId) {
    throw new KernelKnowledgeCommitError(
      'PROJECT_ID_MISMATCH',
      `Run project mismatch: expected ${projectId} but found ${String(run.projectId)}`,
    );
  }
  if (completion.sourceIdentity !== run.sourceIdentity) {
    throw new KernelKnowledgeCommitError(
      'SOURCE_IDENTITY_MISMATCH',
      `Completion decision source identity mismatch for run ${runId}`,
    );
  }
  if (completion.mutationRevision !== run.mutationRevision) {
    throw new KernelKnowledgeCommitError(
      'STALE_COMPLETION_DECISION',
      `Completion decision mutation revision mismatch for run ${runId}`,
    );
  }

  let recordsToCommit: KnowledgeRecord[] | null = null;
  let acceptedCandidates: CandidateLike[] = [];
  let rejectedCandidates: CandidateLike[] = [];

  if (Array.isArray(candidates)) {
    acceptedCandidates = candidates.filter(
      (candidate) => (
        candidate.status === 'verified'
        || candidate.status === 'committed'
      ),
    );
    rejectedCandidates = candidates.filter(
      (candidate) => candidate.status === 'rejected',
    );
    recordsToCommit = acceptedCandidates.map(
      (candidate) => normalizeCommittedRecord(candidate, projectId),
    );
  } else {
    const dbCandidates = stateStore.getKnowledgeCandidates(runId);
    acceptedCandidates = dbCandidates
      .filter((candidate) => candidate.status === 'verified')
      .map(normalizeStoredCandidate);
    rejectedCandidates = dbCandidates
      .filter((candidate) => candidate.status === 'rejected')
      .map(normalizeStoredCandidate);
  }

  const improvementPairIds: string[] = [];
  for (const candidate of acceptedCandidates) {
    if (!candidate.improvementPair) continue;
    if (
      typeof stateStore.getKnowledgeApproval !== 'function'
      || typeof stateStore.getVerifications !== 'function'
    ) {
      throw new KernelKnowledgeCommitError(
        'IMPROVEMENT_PAIR_PROMOTION_AUTHORITY_REQUIRED',
        'Improvement Pair promotion requires persisted approval and verification authority',
      );
    }

    const candidateId = String(candidate.candidateId || candidate.id || '');
    const promotion = evaluateImprovementPairPromotion({
      pair: candidate.improvementPair,
      candidateId,
      projectId,
      scope: strings(candidate.scope),
      supersedes: strings(candidate.supersedes),
      run,
      verifications: stateStore.getVerifications(runId),
      approval: stateStore.getKnowledgeApproval(runId, candidateId),
    });
    if (!promotion.eligible) {
      throw new KernelKnowledgeCommitError(
        'IMPROVEMENT_PAIR_PROMOTION_BLOCKED',
        `Improvement Pair promotion blocked: ${promotion.reasons.join(', ') || promotion.status}`,
        { candidateId, promotion },
      );
    }
    if (promotion.pairId) improvementPairIds.push(promotion.pairId);
  }

  const transactionId = `tx-${crypto.randomUUID()}`;
  const supersessions = [...new Set([
    ...supersessionProposals.map((proposal) => (
      typeof proposal === 'string'
        ? proposal
        : String(proposal.targetId || '')
    )),
    ...acceptedCandidates.flatMap((candidate) => strings(candidate.supersedes)),
  ].filter(Boolean))];

  let txResult: KnowledgeTransactionResult;
  try {
    txResult = stateStore.commitKnowledgeTransaction({
      transactionId,
      runId,
      projectId,
      expectedRevision: expectedKnowledgeRevision,
      records: recordsToCommit,
      supersessions,
      provenance: {
        runId,
        sourceIdentity,
        committedCount: acceptedCandidates.length,
        improvementPairIds: [...new Set(improvementPairIds)],
      },
      faultInjection,
      noChange: acceptedCandidates.length === 0
        && supersessions.length === 0,
    });
  } catch (error) {
    const message = errorMessage(error);
    throw new KernelKnowledgeCommitError(
      message.includes('STALE_KNOWLEDGE_REVISION')
        ? 'STALE_KNOWLEDGE_REVISION'
        : 'TRANSACTION_FAILED',
      message,
      { originalError: error },
    );
  }

  const {
    revisionBefore,
    revisionAfter,
    status: txStatus,
  } = txResult;

  let projectionStatus = 'completed';
  const projectionResult = await rebuildKnowledgeProjection(
    projectId,
    {
      env,
      stateStore,
      revisionAfter,
    },
  );
  if (projectionResult.status === 'failed') {
    projectionStatus = 'failed';
  }

  const receipt = buildKnowledgeCommitReceipt({
    runId,
    projectId,
    sourceIdentity: completion.sourceIdentity
      ? String(completion.sourceIdentity)
      : sourceIdentity,
    mutationRevision: Number(completion.mutationRevision || 1),
    completionDecisionRef: completion.evidenceDigest
      ? String(completion.evidenceDigest)
      : completionDecisionRef
        ? String(completionDecisionRef)
        : `accepted-${runId}`,
    revisionBefore,
    revisionAfter,
    acceptedCandidates,
    rejectedCandidates,
    supersededRecords: supersessions,
    evidenceRefs: acceptedCandidates.flatMap(
      (candidate) => strings(candidate.evidenceRefs),
    ),
    projectionStatus,
    status: txStatus ? String(txStatus) : 'committed',
  });

  try {
    const root = projectKnowledgeDirectory(projectId, { env });
    const receiptPath = path.join(
      root,
      'receipts',
      `${runId}-knowledge-closeout.json`,
    );
    await writeAtomicJson(receiptPath, receipt);
  } catch {
    // Receipt projection is non-authoritative. SQLite commit remains durable.
  }

  return receipt;
}
