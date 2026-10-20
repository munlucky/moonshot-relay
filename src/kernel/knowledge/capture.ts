import { createHash } from 'node:crypto';
import {
  buildCrossRunEvidenceCandidate,
  buildCrossRunEvidenceGroups,
} from './cross-run-evidence.js';
import {
  canonicalKnowledgeIdentity,
  canonicalKnowledgeType,
} from './identity.js';
export { buildCrossRunEvidenceGroups } from './cross-run-evidence.js';
export { canonicalKnowledgeIdentity, canonicalKnowledgeType } from './identity.js';

type UnknownRecord = Record<string, unknown>;

export interface KnowledgeCandidateLike extends UnknownRecord {
  candidateId?: unknown;
  runId?: unknown;
  projectId?: unknown;
  proposedType?: unknown;
  type?: unknown;
  recordType?: unknown;
  record_type?: unknown;
  statement?: unknown;
  scope?: unknown;
  sourceRefs?: unknown;
  relatedFiles?: unknown;
  sourceKind?: unknown;
  evidenceRefs?: unknown;
  acceptanceIds?: unknown;
  obligationIds?: unknown;
  supersedes?: unknown;
  signalKind?: unknown;
  improvementPair?: unknown;
  crossRunEvidenceGroup?: unknown;
}

interface RunLike extends UnknownRecord {
  runId: string;
  projectId: string;
}

interface CaptureSignals extends UnknownRecord {
  runId?: unknown;
  projectId?: unknown;
  history?: unknown;
}

interface NormalizedSignal extends UnknownRecord {
  kind: string;
  fingerprint: string;
  statement: string;
  scope: string[];
  sourceRefs: string[];
  relatedFiles: string[];
  evidenceRefs: string[];
  acceptanceIds: string[];
  obligationIds: string[];
  count: number;
}

interface AutoCandidateInput {
  run: RunLike;
  kind: string;
  signal: UnknownRecord;
  proposedType: string;
  statement: string;
  confidence?: number;
}

interface ExtractStructuredKnowledgeCandidatesInput {
  run?: RunLike | null;
  signals?: CaptureSignals;
  priorRunSignals?: CaptureSignals[];
}

interface BuildStructuredRunSignalsInput {
  runId?: string;
  failures?: UnknownRecord[];
  blocker?: UnknownRecord | null;
  judgments?: UnknownRecord[];
  executed?: UnknownRecord[];
  changedPaths?: string[];
  verifications?: UnknownRecord[];
}

interface KnowledgeStatusInput {
  explicitCount?: number;
  autoCount?: number;
  rejectedCount?: number;
  pendingVerificationCount?: number;
  pendingApprovalCount?: number;
  committedCount?: number;
  committedStatus?: string | null;
}

interface EmptyKnowledgeDoctorInput {
  completedRuns?: number;
  mutationRuns?: number;
  knowledgeRevision?: number | string;
  candidateCount?: number;
  committedCount?: number;
}

export const KNOWLEDGE_CAPTURE_STATUSES = Object.freeze([
  'no_candidates_submitted',
  'auto_candidates_generated',
  'explicit_candidates_submitted',
  'candidates_rejected',
  'candidates_pending_verification',
  'candidates_pending_approval',
  'no_new_knowledge',
  'knowledge_committed',
] as const);

const AUTO_SIGNAL_TYPES = new Set([
  'failure',
  'blocker',
  'regression-verification',
  'architecture-judgment',
  'invariant',
  'supersession',
]);

const isRecord = (value: unknown): value is UnknownRecord => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
);

const text = (value: unknown): string => (
  value === null || value === undefined ? '' : String(value).trim()
);

const list = (value: unknown): string[] => (
  Array.isArray(value) ? value : value ? [value] : []
).map(text).filter(Boolean);

const stable = (value: unknown): string => {
  if (!isRecord(value)) return JSON.stringify(value);
  return JSON.stringify(value, Object.keys(value).sort());
};

const digest = (value: unknown): string => `sha256:${createHash('sha256')
  .update(typeof value === 'string' ? value : stable(value))
  .digest('hex')}`;

// Failure signals often contain measurements, PIDs, line numbers, and other
// run-specific noise. Keep the stable semantic class while removing values
// that otherwise split one recurring problem into many fingerprints.
export const normalizeFailureSignalText = (value: unknown): string => text(value)
  .toLowerCase()
  .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/g, '<uuid>')
  .replace(/\b0x[0-9a-f]+\b/g, '<hex>')
  .replace(/\(\s*node:\d+\s*\)/g, '(node:<pid>)')
  .replace(/\bnode:\d+\b/g, 'node:<pid>')
  .replace(/\b(?:fps|p95)\s*[:=]?\s*\d+(?:\.\d+)?(?:\s*(?:ms|milliseconds?|seconds?|secs?))?\b/g, '<metric>')
  .replace(/\b(line|column|offset|pid|port|attempt|retry|worker|process|exit(?:\s+code)?)\s*[:=#]?\s*\d+\b/g, '$1 <number>')
  .replace(/\b\d+(?:\.\d+)?\s*(?:fps|frames?\/s|ms|milliseconds?|seconds?|secs?|mb|gb|kb|%|percent)\b/g, '<metric>')
  .replace(/\s+/g, ' ')
  .trim();

export const candidateKey = (candidate: KnowledgeCandidateLike): string => canonicalKnowledgeIdentity({
  type: candidate.proposedType || candidate.type || candidate.recordType || candidate.record_type,
  statement: candidate.statement,
  scope: candidate.scope,
});

const evidenceRefsFor = (signal: UnknownRecord = {}): string[] => [...new Set([
  ...list(signal.evidenceRefs),
  ...list(signal.evidenceRef),
  ...list(signal.evidenceDigest),
  ...list(signal.verificationReceipt),
  ...list(signal.reviewReceipt),
  ...list(signal.blockerReceipt),
  ...list(signal.sourceDigest),
].filter(Boolean))];

const normalizeSignal = (signal: UnknownRecord, kind: string): NormalizedSignal => ({
  ...signal,
  kind,
  fingerprint: text(signal.fingerprint || signal.failureFingerprint || signal.blockerFingerprint),
  statement: text(signal.statement || signal.summary || signal.reason || signal.message),
  scope: list(signal.scope || signal.changedPaths || signal.changedFiles),
  sourceRefs: list(signal.sourceRefs || signal.sourceFiles || signal.source),
  relatedFiles: list(signal.relatedFiles || signal.changedPaths || signal.changedFiles),
  evidenceRefs: evidenceRefsFor(signal),
  acceptanceIds: list(signal.acceptanceIds || signal.acceptanceId),
  obligationIds: list(signal.obligationIds || signal.obligationId),
  count: Number(signal.count || 1),
});

const autoCandidate = ({
  run,
  kind,
  signal,
  proposedType,
  statement,
  confidence = 0.75,
}: AutoCandidateInput): KnowledgeCandidateLike | null => {
  const normalized = normalizeSignal(signal, kind);
  const refs = normalized.evidenceRefs;
  if (!statement || refs.length === 0) return null;
  return {
    candidateId: `cand-auto-${digest({
      runId: run.runId,
      proposedType,
      statement,
      scope: normalized.scope,
    }).slice(-24)}`,
    runId: run.runId,
    projectId: run.projectId,
    proposedType,
    statement,
    scope: normalized.scope,
    relatedFiles: normalized.relatedFiles,
    sourceRefs: normalized.sourceRefs,
    evidenceRefs: refs,
    acceptanceIds: normalized.acceptanceIds,
    obligationIds: normalized.obligationIds,
    sourceKind: 'auto',
    signalKind: kind,
    signalFingerprint: normalized.fingerprint || null,
    confidence,
    status: 'observed',
    supersedes: list(signal.supersedes || signal.supersedesId),
    evidenceBinding: {
      evidenceRefs: refs,
      acceptanceIds: normalized.acceptanceIds,
      obligationIds: normalized.obligationIds,
      sourceDigest: normalized.sourceDigest || null,
    },
  };
};

export const extractStructuredKnowledgeCandidates = ({
  run,
  signals = {},
  priorRunSignals = [],
}: ExtractStructuredKnowledgeCandidatesInput = {}): KnowledgeCandidateLike[] => {
  if (!run?.runId || !run?.projectId) return [];

  const candidates: KnowledgeCandidateLike[] = [];
  const history = Array.isArray(signals.history)
    ? signals.history.filter(isRecord) as CaptureSignals[]
    : [];
  const allRuns: CaptureSignals[] = [...priorRunSignals, ...history, signals];

  const repeated = (
    kind: string,
    keyOf: (entry: NormalizedSignal) => string,
  ): NormalizedSignal[] => {
    const grouped = new Map<string, NormalizedSignal>();

    for (const entry of allRuns) {
      const rawSignals = entry[kind];
      for (const rawSignal of Array.isArray(rawSignals) ? rawSignals : []) {
        if (!isRecord(rawSignal)) continue;
        const normalized = normalizeSignal(rawSignal, kind);
        const key = keyOf(normalized) || normalized.statement || normalized.fingerprint;
        if (!key) continue;

        const existing = grouped.get(key);
        const prior: NormalizedSignal = existing
          ? { ...existing }
          : { ...normalized, count: 0, evidenceRefs: [] };

        prior.count += Math.max(1, normalized.count);
        prior.evidenceRefs = [...new Set([...prior.evidenceRefs, ...normalized.evidenceRefs])];
        prior.acceptanceIds = [...new Set([...prior.acceptanceIds, ...normalized.acceptanceIds])];
        prior.obligationIds = [...new Set([...prior.obligationIds, ...normalized.obligationIds])];
        grouped.set(key, prior);
      }
    }

    return [...grouped.values()].filter((entry) => entry.count >= 2);
  };

  const crossRunGroups = buildCrossRunEvidenceGroups({
    projectId: run.projectId,
    currentRunId: run.runId,
    signals,
    priorRunSignals,
  });
  for (const group of crossRunGroups) {
    candidates.push(buildCrossRunEvidenceCandidate(run, group));
  }

  for (const signal of repeated(
    'blockers',
    (entry) => entry.fingerprint || text(entry.reason) || entry.statement,
  )) {
    const candidate = autoCandidate({
      run,
      kind: 'blocker',
      signal,
      proposedType: 'known_failure_pattern',
      statement: signal.statement
        || `Repeated blocker: ${text(signal.reason) || signal.fingerprint}`,
      confidence: 0.8,
    });
    if (candidate) candidates.push(candidate);
  }

  const oneShot = (
    kind: string,
    proposedType: string,
    confidence: number,
    fallback: (signal: NormalizedSignal) => string,
  ): void => {
    const rawSignals = signals[kind];
    for (const raw of Array.isArray(rawSignals) ? rawSignals : []) {
      if (!isRecord(raw)) continue;
      const signal = normalizeSignal(raw, kind);
      const candidate = autoCandidate({
        run,
        kind,
        signal,
        proposedType,
        statement: signal.statement || fallback(signal),
        confidence,
      });
      if (candidate) candidates.push(candidate);
    }
  };

  oneShot(
    'regressionVerifications',
    'required_verification',
    0.9,
    (signal) => `Regression verification executed: ${text(signal.command) || signal.obligationIds[0] || 'bound verification'}`,
  );
  oneShot(
    'architectureJudgments',
    'architecture_decision',
    0.9,
    (signal) => text(signal.decision) || 'Structured architecture decision established.',
  );
  oneShot(
    'invariantObservations',
    'ontology_constraint',
    0.85,
    () => 'Project invariant established.',
  );
  oneShot(
    'supersessionEvidence',
    'semantic_fact',
    0.8,
    (signal) => `Knowledge supersession established for ${text(signal.supersedes) || 'an existing record'}.`,
  );

  return deduplicateKnowledgeCandidates(candidates);
};

export const deduplicateKnowledgeCandidates = (
  candidates: KnowledgeCandidateLike[] = [],
): KnowledgeCandidateLike[] => {
  const merged = new Map<string, KnowledgeCandidateLike>();

  for (const candidate of candidates) {
    if (!candidate || !text(candidate.statement)) continue;
    const key = candidateKey(candidate);
    const existing = merged.get(key);

    if (!existing) {
      merged.set(key, {
        ...candidate,
        evidenceRefs: [...new Set(list(candidate.evidenceRefs))],
      });
      continue;
    }

    const preferExplicit = candidate.sourceKind === 'explicit' && existing.sourceKind !== 'explicit';
    const primary = preferExplicit ? candidate : existing;
    merged.set(key, {
      ...primary,
      sourceKind: preferExplicit ? 'explicit' : existing.sourceKind,
      evidenceRefs: [...new Set([...list(existing.evidenceRefs), ...list(candidate.evidenceRefs)])],
      acceptanceIds: [...new Set([...list(existing.acceptanceIds), ...list(candidate.acceptanceIds)])],
      obligationIds: [...new Set([...list(existing.obligationIds), ...list(candidate.obligationIds)])],
      supersedes: [...new Set([...list(existing.supersedes), ...list(candidate.supersedes)])],
    });
  }

  return [...merged.values()];
};

export const deriveKnowledgeStatus = ({
  explicitCount = 0,
  autoCount = 0,
  rejectedCount = 0,
  pendingVerificationCount = 0,
  pendingApprovalCount = 0,
  committedCount = 0,
  committedStatus = null,
}: KnowledgeStatusInput = {}): string => {
  if (committedStatus === 'committed' && committedCount > 0) return 'knowledge_committed';
  if (pendingApprovalCount > 0) return 'candidates_pending_approval';
  if (pendingVerificationCount > 0) return 'candidates_pending_verification';
  if (rejectedCount > 0 && explicitCount + autoCount > 0) return 'candidates_rejected';
  if (explicitCount === 0 && autoCount === 0) {
    return committedStatus === 'no_change' ? 'no_new_knowledge' : 'no_candidates_submitted';
  }
  return explicitCount > 0 ? 'explicit_candidates_submitted' : 'auto_candidates_generated';
};

export const failureFingerprint = (failure: UnknownRecord = {}): string => digest({
  obligationId: text(failure.obligationId),
  commandRef: text(failure.commandRef || failure.command),
  errorCode: text(failure.errorCode || failure.code || failure.errorKind),
  errorSummary: normalizeFailureSignalText(
    failure.errorSummary || failure.message || failure.reason,
  ),
});

export const blockerFingerprint = (blocker: UnknownRecord = {}): string => digest({
  reason: text(blocker.reason),
  detail: normalizeFailureSignalText(blocker.detail || blocker.message),
});

export const buildStructuredRunSignals = ({
  runId = 'current-run',
  failures = [],
  blocker = null,
  judgments = [],
  executed = [],
  changedPaths = [],
  verifications: _verifications = [],
}: BuildStructuredRunSignalsInput = {}): CaptureSignals => ({
  runId,
  failures: failures.filter(isRecord).map((failure) => ({
    ...failure,
    fingerprint: failure.fingerprint || failureFingerprint(failure),
    evidenceRefs: list(
      failure.evidenceRefs
        || failure.evidenceRef
        || failure.evidenceDigest
        || `failure://${runId}/${text(failure.fingerprint) || failureFingerprint(failure)}`,
    ),
    scope: list(failure.scope || changedPaths),
  })),
  blockers: blocker ? [{
    ...blocker,
    fingerprint: blocker.fingerprint || blockerFingerprint(blocker),
    evidenceRefs: list(
      blocker.evidenceRefs
        || blocker.blockerReceipt
        || `blocker://${runId}/${text(blocker.reason) || 'unknown'}`,
    ),
    scope: list(blocker.scope || changedPaths),
  }] : [],
  architectureJudgments: judgments
    .filter((judgment) => (
      judgment.verdict === 'pass'
      && (
        Boolean(judgment.architectureDecision)
        || judgment.proposedType === 'architecture_decision'
        || judgment.type === 'architecture_decision'
      )
    ))
    .map((judgment) => ({
      ...judgment,
      statement: judgment.statement || judgment.architectureDecision || judgment.rationale,
      evidenceRefs: list(
        judgment.evidenceRefs || judgment.reviewReceiptId || judgment.evidenceDigest,
      ),
      scope: list(judgment.scope || changedPaths),
    })),
  regressionVerifications: executed
    .filter((entry) => (
      entry.status === 'passed'
      && (
        entry.newRegression === true
        || /regression/i.test(`${text(entry.commandRef)} ${text(entry.obligationId)}`)
      )
    ))
    .map((entry) => ({
      ...entry,
      statement: entry.statement
        || `Regression verification executed: ${text(entry.commandRef) || text(entry.obligationId)}`,
      evidenceRefs: list(entry.evidenceRefs || entry.evidenceDigest),
      obligationIds: list(entry.obligationIds || entry.obligationId),
      scope: list(entry.scope || changedPaths),
    })),
  invariantObservations: [],
  supersessionEvidence: [],
  verifications: _verifications,
});

export const emptyKnowledgeDoctorFinding = ({
  completedRuns = 0,
  mutationRuns = 0,
  knowledgeRevision = 1,
  candidateCount = 0,
  committedCount = 0,
}: EmptyKnowledgeDoctorInput = {}): (UnknownRecord & { code: string; severity: string }) | null => {
  if (
    completedRuns < 3
    || mutationRuns < 1
    || Number(knowledgeRevision) !== 1
    || candidateCount !== 0
    || committedCount !== 0
  ) {
    return null;
  }

  return {
    code: 'knowledge_capture_missing',
    severity: 'warning',
    completedRuns,
    mutationRuns,
    knowledgeRevision: Number(knowledgeRevision),
    candidateCount,
    committedCount,
  };
};

export const isStructuredKnowledgeSignal = (value: unknown): boolean => (
  isRecord(value) && AUTO_SIGNAL_TYPES.has(text(value.kind))
);
