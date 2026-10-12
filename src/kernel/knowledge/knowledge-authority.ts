export const KNOWLEDGE_AUTHORITY_SCHEMA_VERSION = 1;

type UnknownRecord = Record<string, unknown>;

interface RunLike extends UnknownRecord {
  runId?: unknown;
  projectId?: unknown;
  state?: unknown;
  knowledgeRevisionClose?: unknown;
  knowledgeRevisionStart?: unknown;
  knowledgeStatus?: unknown;
}

interface ContextLike extends UnknownRecord {
  stage?: unknown;
  status?: unknown;
  knowledgeRevision?: unknown;
  digest?: unknown;
  degradedContext?: unknown;
  receiptJson?: unknown;
  quality?: unknown;
  selectionMeta?: unknown;
}

interface CandidateLike extends UnknownRecord {
  status?: unknown;
  proposedType?: unknown;
  type?: unknown;
  candidateJson?: unknown;
}

interface ReceiptLike extends UnknownRecord {
  status?: unknown;
  candidateCount?: unknown;
  verifiedCount?: unknown;
  rejectedCount?: unknown;
  waitingApprovalCount?: unknown;
  waitingVerificationCount?: unknown;
  reviewDigest?: unknown;
  revisionBefore?: unknown;
  revisionAfter?: unknown;
  receiptJson?: unknown;
}

interface RecordLike extends UnknownRecord {
  status?: unknown;
  type?: unknown;
  recordType?: unknown;
}

interface ContextView {
  stage: string | null;
  status: string;
  knowledgeRevision: unknown;
  digest: string | null;
  degraded: boolean;
  usableRecordCount: number;
  selectedCounts: Record<string, number>;
  omittedCount: number;
  selectionMeta: unknown;
}

export interface BuildKnowledgeAuthorityInput {
  projectId?: string | null;
  run?: RunLike | null;
  knowledgeRevision?: unknown;
  context?: ContextLike | null;
  contextReceipts?: ContextLike[];
  stage?: string | null;
  candidates?: CandidateLike[];
  reviewReceipt?: ReceiptLike | null;
  commitReceipt?: ReceiptLike | null;
  records?: RecordLike[];
  imports?: unknown[];
}

export interface KnowledgeAuthorityView extends UnknownRecord {
  schemaVersion: 1;
  project: {
    projectId: string;
    runId: string | null;
    knowledgeRevision: string | null;
  };
  authority: {
    source: 'sqlite';
    durable: true;
    lifecycleStatus: string;
  };
  lifecycle: Record<string, UnknownRecord>;
  records: {
    total: number;
    byStatus: Record<string, number>;
    byType: Record<string, number>;
  };
  projection: {
    authoritative: false;
    status: 'derived';
    knowledgeRevision: string | null;
    committedCount: number;
    supersededCount: number;
  };
}

// Knowledge Authority is a compact read model over the SQLite lifecycle. It
// deliberately contains counts, revisions, digests, and bounded statuses, not
// candidate bodies or projection files. SQLite remains authoritative; files
// under the project knowledge namespace are derived outputs only.
const FORBIDDEN_KNOWLEDGE_FIELDS = new Set<string>([
  'provider', 'model', 'modelClass', 'resolvedModel', 'effort', 'sessionId',
  'nativeSessionId', 'actorSessionId', 'usageReceiptId', 'prompt', 'transcript',
  'recordJson', 'candidateJson', 'rawPayload', 'rawRecords', 'rawCandidates',
]);

const LIFECYCLE_STAGES = Object.freeze([
  'retrieve',
  'select',
  'use',
  'capture',
  'normalize',
  'verify',
  'commit',
  'supersede',
] as const);

const asRecord = (value: unknown): UnknownRecord => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : {}
);

const countBy = <T>(
  items: readonly T[] = [],
  keyOf: (item: T) => unknown = (item) => (
    asRecord(item).status || 'unknown'
  ),
): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const key = String(keyOf(item) || 'unknown');
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
};

const contextView = (context: ContextLike | null = null): ContextView | null => {
  if (!context) return null;

  const receipt = asRecord(context.receiptJson);
  const payload = Object.keys(receipt).length > 0 ? receipt : context;
  const quality = asRecord(payload.quality);
  const selectedCountsRaw = asRecord(quality.selectedCounts);
  const selectedCounts = Object.fromEntries(
    Object.entries(selectedCountsRaw)
      .map(([key, value]) => [key, Number(value || 0)]),
  ) as Record<string, number>;
  const omittedCounts = asRecord(quality.omittedCounts);

  return {
    stage: payload.stage || context.stage
      ? String(payload.stage || context.stage)
      : null,
    status: String(payload.status || 'unknown'),
    knowledgeRevision: payload.knowledgeRevision ?? context.knowledgeRevision ?? null,
    digest: payload.digest || context.digest
      ? String(payload.digest || context.digest)
      : null,
    degraded: payload.degradedContext === true,
    usableRecordCount: Number(quality.usableRecordCount || 0),
    selectedCounts,
    omittedCount: Number(omittedCounts.total || 0),
    selectionMeta: payload.selectionMeta ?? null,
  };
};

const latestContext = ({
  context = null,
  contextReceipts = [],
  stage = null,
}: Pick<
  BuildKnowledgeAuthorityInput,
  'context' | 'contextReceipts' | 'stage'
> = {}): ContextView | null => {
  const entries = [
    ...contextReceipts,
    ...(context ? [context] : []),
  ]
    .map(contextView)
    .filter((entry): entry is ContextView => Boolean(entry));

  const matching = stage
    ? entries.filter((entry) => entry.stage === stage)
    : entries;
  return matching.at(-1) || entries.at(-1) || null;
};

const recordCounts = (records: RecordLike[] = []) => ({
  total: records.length,
  byStatus: countBy(records),
  byType: countBy(
    records,
    (record) => record.type || record.recordType || 'unknown',
  ),
});

const candidateCounts = (candidates: CandidateLike[] = []) => ({
  total: candidates.length,
  byStatus: countBy(candidates),
  verified: candidates.filter(
    (candidate) => candidate.status === 'verified',
  ).length,
  rejected: candidates.filter(
    (candidate) => candidate.status === 'rejected',
  ).length,
});

const projectionCounts = (records: RecordLike[] = []) => ({
  committed: records.filter((record) => record.status === 'committed').length,
  superseded: records.filter((record) => record.status === 'superseded').length,
});

const lifecycleStatus = ({
  context,
  candidates = [],
  reviewReceipt,
  commitReceipt,
  records = [],
}: {
  context: ContextView | null;
  candidates?: CandidateLike[];
  reviewReceipt?: ReceiptLike | null;
  commitReceipt?: ReceiptLike | null;
  records?: RecordLike[];
}): string => {
  if (
    commitReceipt?.status === 'committed'
    || commitReceipt?.status === 'no_change'
  ) {
    return 'committed';
  }
  if (
    reviewReceipt?.status === 'passed'
    || reviewReceipt?.status === 'no_candidates'
  ) {
    return 'verified';
  }
  if (candidates.length > 0) return 'captured';
  if (context) return context.degraded ? 'degraded' : 'retrieved';
  if (records.length > 0) return 'available';
  return 'empty';
};

const assertDerivedShape = (value: unknown, path = '$'): void => {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => (
      assertDerivedShape(entry, `${path}[${index}]`)
    ));
    return;
  }
  if (!value || typeof value !== 'object') return;

  for (const [key, child] of Object.entries(value as UnknownRecord)) {
    if (FORBIDDEN_KNOWLEDGE_FIELDS.has(key)) {
      throw new Error(
        `knowledge_authority_forbidden_field: ${path}.${key}`,
      );
    }
    assertDerivedShape(child, `${path}.${key}`);
  }
};

export const validateKnowledgeAuthority = (
  view: unknown,
): KnowledgeAuthorityView => {
  if (!view || typeof view !== 'object' || Array.isArray(view)) {
    throw new TypeError('knowledge authority view must be an object');
  }

  const record = view as UnknownRecord;
  const project = asRecord(record.project);
  const authority = asRecord(record.authority);
  const projection = asRecord(record.projection);
  const lifecycle = asRecord(record.lifecycle);

  if (record.schemaVersion !== KNOWLEDGE_AUTHORITY_SCHEMA_VERSION) {
    throw new Error('knowledge_authority_schema_invalid');
  }
  if (!project.projectId) {
    throw new Error('knowledge_authority_project_missing');
  }
  if (
    authority.source !== 'sqlite'
    || projection.authoritative !== false
  ) {
    throw new Error('knowledge_authority_source_invalid');
  }
  for (const stage of LIFECYCLE_STAGES) {
    if (!lifecycle[stage]) {
      throw new Error(`knowledge_authority_lifecycle_missing:${stage}`);
    }
  }

  assertDerivedShape(view);
  return view as KnowledgeAuthorityView;
};

export const buildKnowledgeAuthorityView = ({
  projectId = null,
  run = null,
  knowledgeRevision = null,
  context = null,
  contextReceipts = [],
  stage = null,
  candidates = [],
  reviewReceipt = null,
  commitReceipt = null,
  records = [],
  imports = [],
}: BuildKnowledgeAuthorityInput = {}): KnowledgeAuthorityView | null => {
  const resolvedProjectId = projectId
    || (run?.projectId ? String(run.projectId) : null);
  if (!resolvedProjectId) return null;

  const runState = run?.state ? String(run.state) : null;
  const currentContext = latestContext({
    context,
    contextReceipts,
    stage: stage || runState,
  });
  const resolvedRevision = knowledgeRevision
    ?? run?.knowledgeRevisionClose
    ?? run?.knowledgeRevisionStart
    ?? null;

  const candidateSummary = candidateCounts(candidates);
  const recordSummary = recordCounts(records);
  const projection = projectionCounts(records);
  const reviewStatus = reviewReceipt?.status
    || (candidateSummary.total === 0 ? 'no_candidates' : 'pending');
  const commitStatus = commitReceipt?.status
    || run?.knowledgeStatus
    || 'pending';
  const commitPayload = asRecord(commitReceipt?.receiptJson);
  const supersededCount = Number(
    commitPayload.supersededCount ?? projection.superseded ?? 0,
  );
  const importedCount = imports.length;
  const retrieved = Boolean(currentContext);

  const normalizedCount = candidates.filter((candidate) => {
    const candidateJson = asRecord(candidate.candidateJson);
    return Boolean(
      candidate.proposedType
      || candidate.type
      || candidateJson.proposedType
      || candidateJson.type,
    );
  }).length;

  const lifecycle: Record<string, UnknownRecord> = {
    retrieve: {
      status: retrieved ? 'retrieved' : 'missing',
      stage: currentContext?.stage || stage || runState || null,
      knowledgeRevision:
        currentContext?.knowledgeRevision ?? resolvedRevision,
      digest: currentContext?.digest || null,
    },
    select: {
      status: currentContext?.selectionMeta
        || (currentContext?.usableRecordCount || 0) > 0
        ? 'selected'
        : retrieved
          ? 'empty'
          : 'pending',
      selectedRecordCount: currentContext?.usableRecordCount || 0,
      selectedCounts: currentContext?.selectedCounts || {},
      omittedCount: currentContext?.omittedCount || 0,
    },
    use: {
      status: currentContext?.status === 'ready-populated'
        ? 'available'
        : currentContext
          ? currentContext.status
          : 'pending',
      degraded: currentContext?.degraded === true,
    },
    capture: {
      status: candidateSummary.total > 0 ? 'captured' : 'empty',
      candidateCount: candidateSummary.total,
      statusCounts: candidateSummary.byStatus,
      importedCount,
    },
    normalize: {
      status: candidateSummary.total === 0
        ? 'not-required'
        : normalizedCount === candidateSummary.total
          ? 'normalized'
          : 'pending',
      candidateCount: candidateSummary.total,
      normalizedCount,
    },
    verify: {
      status: reviewStatus,
      candidateCount: Number(
        reviewReceipt?.candidateCount ?? candidateSummary.total,
      ),
      verifiedCount: Number(
        reviewReceipt?.verifiedCount ?? candidateSummary.verified,
      ),
      rejectedCount: Number(
        reviewReceipt?.rejectedCount ?? candidateSummary.rejected,
      ),
      waitingApprovalCount: Number(
        reviewReceipt?.waitingApprovalCount || 0,
      ),
      waitingVerificationCount: Number(
        reviewReceipt?.waitingVerificationCount || 0,
      ),
      reviewDigest: reviewReceipt?.reviewDigest || null,
    },
    commit: {
      status: commitStatus,
      revisionBefore:
        commitReceipt?.revisionBefore ?? commitPayload.revisionBefore ?? null,
      revisionAfter:
        commitReceipt?.revisionAfter
        ?? commitPayload.revisionAfter
        ?? resolvedRevision,
      committedCount: Number(
        commitPayload.committedCount ?? projection.committed ?? 0,
      ),
      receiptPresent: Boolean(commitReceipt),
    },
    supersede: {
      status: supersededCount > 0 ? 'applied' : 'none',
      count: supersededCount,
    },
  };

  const view: KnowledgeAuthorityView = {
    schemaVersion: KNOWLEDGE_AUTHORITY_SCHEMA_VERSION,
    project: {
      projectId: String(resolvedProjectId),
      runId: run?.runId ? String(run.runId) : null,
      knowledgeRevision: resolvedRevision === null
        ? null
        : String(resolvedRevision),
    },
    authority: {
      source: 'sqlite',
      durable: true,
      lifecycleStatus: lifecycleStatus({
        context: currentContext,
        candidates,
        reviewReceipt,
        commitReceipt,
        records,
      }),
    },
    lifecycle,
    records: recordSummary,
    projection: {
      authoritative: false,
      status: 'derived',
      knowledgeRevision: resolvedRevision === null
        ? null
        : String(resolvedRevision),
      committedCount: projection.committed,
      supersededCount: projection.superseded,
    },
  };

  return validateKnowledgeAuthority(view);
};
