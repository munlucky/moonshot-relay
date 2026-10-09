export const KNOWLEDGE_AUTHORITY_SCHEMA_VERSION = 1;

// Knowledge Authority is a compact read model over the SQLite lifecycle. It
// deliberately contains counts, revisions, digests, and bounded statuses, not
// candidate bodies or projection files. SQLite remains authoritative; files
// under the project knowledge namespace are derived outputs only.
const FORBIDDEN_KNOWLEDGE_FIELDS = new Set([
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
]);

const list = (value) => (Array.isArray(value) ? value : []).map(String);

const countBy = (items = [], keyOf = (item) => item?.status || 'unknown') => {
  const counts = {};
  for (const item of Array.isArray(items) ? items : []) {
    const key = String(keyOf(item) || 'unknown');
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
};

const contextView = (context = null) => {
  if (!context) return null;
  const payload = context.receiptJson && typeof context.receiptJson === 'object'
    ? context.receiptJson
    : context;
  const quality = payload.quality || {};
  const selectedCounts = quality.selectedCounts && typeof quality.selectedCounts === 'object'
    ? Object.fromEntries(Object.entries(quality.selectedCounts).map(([key, value]) => [key, Number(value || 0)]))
    : {};
  return {
    stage: payload.stage || context.stage || null,
    status: payload.status || 'unknown',
    knowledgeRevision: payload.knowledgeRevision ?? context.knowledgeRevision ?? null,
    digest: payload.digest || context.digest || null,
    degraded: payload.degradedContext === true,
    usableRecordCount: Number(quality.usableRecordCount || 0),
    selectedCounts,
    omittedCount: Number(quality.omittedCounts?.total || 0),
    selectionMeta: payload.selectionMeta || null,
  };
};

const latestContext = ({ context = null, contextReceipts = [], stage = null } = {}) => {
  const entries = [
    ...(Array.isArray(contextReceipts) ? contextReceipts : []),
    ...(context ? [context] : []),
  ].map(contextView).filter(Boolean);
  const matching = stage ? entries.filter((entry) => entry.stage === stage) : entries;
  return matching.at(-1) || entries.at(-1) || null;
};

const recordCounts = (records = []) => ({
  total: Array.isArray(records) ? records.length : 0,
  byStatus: countBy(records),
  byType: countBy(records, (record) => record?.type || record?.recordType || 'unknown'),
});

const candidateCounts = (candidates = []) => ({
  total: Array.isArray(candidates) ? candidates.length : 0,
  byStatus: countBy(candidates),
  verified: (Array.isArray(candidates) ? candidates : []).filter((candidate) => candidate.status === 'verified').length,
  rejected: (Array.isArray(candidates) ? candidates : []).filter((candidate) => candidate.status === 'rejected').length,
});

const projectionCounts = (records = []) => ({
  committed: (Array.isArray(records) ? records : []).filter((record) => record.status === 'committed').length,
  superseded: (Array.isArray(records) ? records : []).filter((record) => record.status === 'superseded').length,
});

const lifecycleStatus = ({ context, candidates, reviewReceipt, commitReceipt, records } = {}) => {
  if (commitReceipt?.status === 'committed' || commitReceipt?.status === 'no_change') return 'committed';
  if (reviewReceipt?.status === 'passed' || reviewReceipt?.status === 'no_candidates') return 'verified';
  if (Array.isArray(candidates) && candidates.length > 0) return 'captured';
  if (context) return context.degraded ? 'degraded' : 'retrieved';
  if (Array.isArray(records) && records.length > 0) return 'available';
  return 'empty';
};

const assertDerivedShape = (value, path = '$') => {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertDerivedShape(entry, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KNOWLEDGE_FIELDS.has(key)) throw new Error(`knowledge_authority_forbidden_field: ${path}.${key}`);
    assertDerivedShape(child, `${path}.${key}`);
  }
};

export const validateKnowledgeAuthority = (view) => {
  if (!view || typeof view !== 'object' || Array.isArray(view)) throw new TypeError('knowledge authority view must be an object');
  if (view.schemaVersion !== KNOWLEDGE_AUTHORITY_SCHEMA_VERSION) throw new Error('knowledge_authority_schema_invalid');
  if (!view.project?.projectId) throw new Error('knowledge_authority_project_missing');
  if (view.authority?.source !== 'sqlite' || view.projection?.authoritative !== false) {
    throw new Error('knowledge_authority_source_invalid');
  }
  for (const stage of LIFECYCLE_STAGES) {
    if (!view.lifecycle?.[stage]) throw new Error(`knowledge_authority_lifecycle_missing:${stage}`);
  }
  assertDerivedShape(view);
  return view;
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
} = {}) => {
  const resolvedProjectId = projectId || run?.projectId;
  if (!resolvedProjectId) return null;
  const currentContext = latestContext({ context, contextReceipts, stage: stage || run?.state });
  const resolvedRevision = knowledgeRevision ?? run?.knowledgeRevisionClose ?? run?.knowledgeRevisionStart ?? null;
  const candidateSummary = candidateCounts(candidates);
  const recordSummary = recordCounts(records);
  const projection = projectionCounts(records);
  const reviewStatus = reviewReceipt?.status || (candidateSummary.total === 0 ? 'no_candidates' : 'pending');
  const commitStatus = commitReceipt?.status || run?.knowledgeStatus || 'pending';
  const commitPayload = commitReceipt?.receiptJson && typeof commitReceipt.receiptJson === 'object'
    ? commitReceipt.receiptJson
    : {};
  const supersededCount = Number(commitPayload.supersededCount ?? projection.superseded ?? 0);
  const importedCount = Array.isArray(imports) ? imports.length : 0;
  const retrieved = Boolean(currentContext);
  const normalizedCount = (Array.isArray(candidates) ? candidates : []).filter((candidate) => (
    Boolean(candidate.proposedType || candidate.type || candidate.candidateJson?.proposedType || candidate.candidateJson?.type)
  )).length;
  const lifecycle = {
    retrieve: {
      status: retrieved ? 'retrieved' : 'missing',
      stage: currentContext?.stage || stage || run?.state || null,
      knowledgeRevision: currentContext?.knowledgeRevision ?? resolvedRevision,
      digest: currentContext?.digest || null,
    },
    select: {
      status: currentContext?.selectionMeta || currentContext?.usableRecordCount > 0 ? 'selected' : retrieved ? 'empty' : 'pending',
      selectedRecordCount: currentContext?.usableRecordCount || 0,
      selectedCounts: currentContext?.selectedCounts || {},
      omittedCount: currentContext?.omittedCount || 0,
    },
    use: {
      status: currentContext?.status === 'ready-populated' ? 'available' : currentContext ? currentContext.status : 'pending',
      degraded: currentContext?.degraded === true,
    },
    capture: {
      status: candidateSummary.total > 0 ? 'captured' : 'empty',
      candidateCount: candidateSummary.total,
      statusCounts: candidateSummary.byStatus,
      importedCount,
    },
    normalize: {
      status: candidateSummary.total === 0 ? 'not-required' : normalizedCount === candidateSummary.total ? 'normalized' : 'pending',
      candidateCount: candidateSummary.total,
      normalizedCount,
    },
    verify: {
      status: reviewStatus,
      candidateCount: Number(reviewReceipt?.candidateCount ?? candidateSummary.total),
      verifiedCount: Number(reviewReceipt?.verifiedCount ?? candidateSummary.verified),
      rejectedCount: Number(reviewReceipt?.rejectedCount ?? candidateSummary.rejected),
      waitingApprovalCount: Number(reviewReceipt?.waitingApprovalCount || 0),
      waitingVerificationCount: Number(reviewReceipt?.waitingVerificationCount || 0),
      reviewDigest: reviewReceipt?.reviewDigest || null,
    },
    commit: {
      status: commitStatus,
      revisionBefore: commitReceipt?.revisionBefore ?? commitPayload.revisionBefore ?? null,
      revisionAfter: commitReceipt?.revisionAfter ?? commitPayload.revisionAfter ?? resolvedRevision,
      committedCount: Number(commitPayload.committedCount ?? projection.committed ?? 0),
      receiptPresent: Boolean(commitReceipt),
    },
    supersede: {
      status: supersededCount > 0 ? 'applied' : 'none',
      count: supersededCount,
    },
  };

  const view = {
    schemaVersion: KNOWLEDGE_AUTHORITY_SCHEMA_VERSION,
    project: {
      projectId: String(resolvedProjectId),
      runId: run?.runId ? String(run.runId) : null,
      knowledgeRevision: resolvedRevision === null ? null : String(resolvedRevision),
    },
    authority: {
      source: 'sqlite',
      durable: true,
      lifecycleStatus: lifecycleStatus({ context: currentContext, candidates, reviewReceipt, commitReceipt, records }),
    },
    lifecycle,
    records: recordSummary,
    projection: {
      authoritative: false,
      status: 'derived',
      knowledgeRevision: resolvedRevision === null ? null : String(resolvedRevision),
      committedCount: projection.committed,
      supersededCount: projection.superseded,
    },
  };
  return validateKnowledgeAuthority(view);
};

