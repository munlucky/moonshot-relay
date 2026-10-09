import { createHash } from 'node:crypto';

export const KNOWLEDGE_CAPTURE_STATUSES = Object.freeze([
  'no_candidates_submitted',
  'auto_candidates_generated',
  'explicit_candidates_submitted',
  'candidates_rejected',
  'candidates_pending_verification',
  'candidates_pending_approval',
  'no_new_knowledge',
  'knowledge_committed',
]);

const AUTO_SIGNAL_TYPES = new Set([
  'failure',
  'blocker',
  'regression-verification',
  'architecture-judgment',
  'invariant',
  'supersession',
]);

const text = (value) => (value === null || value === undefined ? '' : String(value).trim());
const list = (value) => (Array.isArray(value) ? value : value ? [value] : []).map(text).filter(Boolean);
const stable = (value) => JSON.stringify(value, Object.keys(value || {}).sort());
const digest = (value) => `sha256:${createHash('sha256').update(typeof value === 'string' ? value : stable(value)).digest('hex')}`;

// Failure signals often contain measurements, PIDs, line numbers, and other
// run-specific noise. Keep the stable semantic class while removing values
// that otherwise split one recurring problem into many fingerprints.
export const normalizeFailureSignalText = (value) => text(value)
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

export const canonicalKnowledgeType = (type) => {
  const t = text(type).toLowerCase().replace(/[- ]/g, '_');
  if (t === 'policy' || t === 'policy_anchor') return 'policy_anchor';
  if (t === 'semantic' || t === 'semantic_fact') return 'semantic_fact';
  if (t === 'architecture' || t === 'architecture_record') return 'architecture_record';
  if (t === 'decision' || t === 'architecture_decision') return 'architecture_decision';
  if (t === 'observation' || t === 'episodic_observation') return 'episodic_observation';
  if (t === 'kg_relation' || t === 'relation') return 'kg_relation';
  if (t === 'constraint' || t === 'ontology_constraint') return 'ontology_constraint';
  return t || 'semantic_fact';
};

export const canonicalKnowledgeIdentity = ({ recordType, proposedType, type, statement, scope = [] } = {}) => {
  const normType = canonicalKnowledgeType(recordType || proposedType || type);
  const normStatement = text(statement).toLowerCase().replace(/\s+/g, ' ');
  const normScope = [...list(scope)].map((s) => s.toLowerCase()).sort();
  return digest({
    type: normType,
    statement: normStatement,
    scope: normScope,
  });
};

export const candidateKey = (candidate) => canonicalKnowledgeIdentity({
  type: candidate?.proposedType || candidate?.type || candidate?.recordType || candidate?.record_type,
  statement: candidate?.statement,
  scope: candidate?.scope,
});

const evidenceRefsFor = (signal = {}) => [...new Set([
  ...list(signal.evidenceRefs),
  ...list(signal.evidenceRef),
  ...list(signal.evidenceDigest),
  ...list(signal.verificationReceipt),
  ...list(signal.reviewReceipt),
  ...list(signal.blockerReceipt),
  ...list(signal.sourceDigest),
].filter(Boolean))];

const normalizeSignal = (signal, kind) => ({
  ...signal,
  kind,
  fingerprint: text(signal.fingerprint || signal.failureFingerprint || signal.blockerFingerprint),
  statement: text(signal.statement || signal.summary || signal.reason || signal.message),
  scope: list(signal.scope || signal.changedPaths || signal.changedFiles),
  evidenceRefs: evidenceRefsFor(signal),
  acceptanceIds: list(signal.acceptanceIds || signal.acceptanceId),
  obligationIds: list(signal.obligationIds || signal.obligationId),
  count: Number(signal.count || 1),
});

const autoCandidate = ({ run, kind, signal, proposedType, statement, confidence = 0.75 }) => {
  const normalized = normalizeSignal(signal, kind);
  const sourceRefs = normalized.scope;
  const refs = normalized.evidenceRefs;
  if (!statement || refs.length === 0) return null;
  return {
    candidateId: `cand-auto-${digest({ runId: run.runId, proposedType, statement, scope: sourceRefs }).slice(-24)}`,
    runId: run.runId,
    projectId: run.projectId,
    proposedType,
    statement,
    scope: sourceRefs,
    relatedFiles: sourceRefs,
    sourceRefs,
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
} = {}) => {
  if (!run?.runId || !run?.projectId) return [];
  const candidates = [];
  const allRuns = [...priorRunSignals, ...(Array.isArray(signals.history) ? signals.history : []), signals];

  const repeated = (kind, keyOf) => {
    const grouped = new Map();
    for (const entry of allRuns) {
      for (const signal of (Array.isArray(entry?.[kind]) ? entry[kind] : [])) {
        const normalized = normalizeSignal(signal, kind);
        const key = keyOf(normalized) || normalized.statement || normalized.fingerprint;
        if (!key) continue;
        const prior = grouped.get(key) || { ...normalized, count: 0, evidenceRefs: [] };
        prior.count += Math.max(1, normalized.count);
        prior.evidenceRefs = [...new Set([...prior.evidenceRefs, ...normalized.evidenceRefs])];
        prior.acceptanceIds = [...new Set([...prior.acceptanceIds, ...normalized.acceptanceIds])];
        prior.obligationIds = [...new Set([...prior.obligationIds, ...normalized.obligationIds])];
        grouped.set(key, prior);
      }
    }
    return [...grouped.values()].filter((entry) => entry.count >= 2);
  };

  for (const signal of repeated('failures', (entry) => entry.fingerprint || entry.statement)) {
    const candidate = autoCandidate({
      run,
      kind: 'failure',
      signal,
      proposedType: 'known_failure_pattern',
      statement: signal.statement || `Repeated failure fingerprint: ${signal.fingerprint}`,
      confidence: 0.85,
    });
    if (candidate) candidates.push(candidate);
  }
  for (const signal of repeated('blockers', (entry) => entry.fingerprint || entry.reason || entry.statement)) {
    const candidate = autoCandidate({
      run,
      kind: 'blocker',
      signal,
      proposedType: 'known_failure_pattern',
      statement: signal.statement || `Repeated blocker: ${signal.reason || signal.fingerprint}`,
      confidence: 0.8,
    });
    if (candidate) candidates.push(candidate);
  }

  const oneShot = (kind, proposedType, confidence, fallback) => {
    for (const raw of Array.isArray(signals[kind]) ? signals[kind] : []) {
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

  oneShot('regressionVerifications', 'required_verification', 0.9, (signal) => `Regression verification executed: ${signal.command || signal.obligationIds[0] || 'bound verification'}`);
  oneShot('architectureJudgments', 'architecture_decision', 0.9, (signal) => signal.decision || 'Structured architecture decision established.');
  oneShot('invariantObservations', 'ontology_constraint', 0.85, (signal) => 'Project invariant established.');
  oneShot('supersessionEvidence', 'semantic_fact', 0.8, (signal) => `Knowledge supersession established for ${signal.supersedes || 'an existing record'}.`);

  return deduplicateKnowledgeCandidates(candidates);
};

export const deduplicateKnowledgeCandidates = (candidates = []) => {
  const merged = new Map();
  for (const candidate of candidates) {
    if (!candidate || !text(candidate.statement)) continue;
    const key = candidateKey(candidate);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { ...candidate, evidenceRefs: [...new Set(list(candidate.evidenceRefs))] });
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
} = {}) => {
  if (committedStatus === 'committed' && committedCount > 0) return 'knowledge_committed';
  if (pendingApprovalCount > 0) return 'candidates_pending_approval';
  if (pendingVerificationCount > 0) return 'candidates_pending_verification';
  if (rejectedCount > 0 && explicitCount + autoCount > 0) return 'candidates_rejected';
  if (explicitCount === 0 && autoCount === 0) return committedStatus === 'no_change' ? 'no_new_knowledge' : 'no_candidates_submitted';
  return explicitCount > 0 ? 'explicit_candidates_submitted' : 'auto_candidates_generated';
};

export const failureFingerprint = (failure = {}) => digest({
  obligationId: text(failure.obligationId),
  commandRef: text(failure.commandRef || failure.command),
  errorCode: text(failure.errorCode || failure.code || failure.errorKind),
  errorSummary: normalizeFailureSignalText(failure.errorSummary || failure.message || failure.reason),
});

export const blockerFingerprint = (blocker = {}) => digest({
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
  verifications = [],
} = {}) => ({
  failures: failures.filter(Boolean).map((failure) => ({
    ...failure,
    fingerprint: failure.fingerprint || failureFingerprint(failure),
    evidenceRefs: list(failure.evidenceRefs || failure.evidenceRef || failure.evidenceDigest || `failure://${runId}/${failure.fingerprint || failureFingerprint(failure)}`),
    scope: list(failure.scope || changedPaths),
  })),
  blockers: blocker ? [{
    ...blocker,
    fingerprint: blocker.fingerprint || blockerFingerprint(blocker),
    evidenceRefs: list(blocker.evidenceRefs || blocker.blockerReceipt || `blocker://${runId}/${blocker.reason || 'unknown'}`),
    scope: list(blocker.scope || changedPaths),
  }] : [],
  architectureJudgments: judgments.filter((judgment) => judgment?.verdict === 'pass' && (judgment.architectureDecision || judgment.proposedType === 'architecture_decision' || judgment.type === 'architecture_decision')).map((judgment) => ({
    ...judgment,
    statement: judgment.statement || judgment.architectureDecision || judgment.rationale,
    evidenceRefs: list(judgment.evidenceRefs || judgment.reviewReceiptId || judgment.evidenceDigest),
    scope: list(judgment.scope || changedPaths),
  })),
  regressionVerifications: executed.filter((entry) => entry?.status === 'passed' && (entry.newRegression === true || /regression/i.test(`${entry.commandRef || ''} ${entry.obligationId || ''}`))).map((entry) => ({
    ...entry,
    statement: entry.statement || `Regression verification executed: ${entry.commandRef || entry.obligationId}`,
    evidenceRefs: list(entry.evidenceRefs || entry.evidenceDigest),
    obligationIds: list(entry.obligationIds || entry.obligationId),
    scope: list(entry.scope || changedPaths),
  })),
  invariantObservations: [],
  supersessionEvidence: [],
});

export const emptyKnowledgeDoctorFinding = ({
  completedRuns = 0,
  mutationRuns = 0,
  knowledgeRevision = 1,
  candidateCount = 0,
  committedCount = 0,
} = {}) => {
  if (completedRuns < 3 || mutationRuns < 1 || Number(knowledgeRevision) !== 1 || candidateCount !== 0 || committedCount !== 0) return null;
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

export const isStructuredKnowledgeSignal = (value) => Boolean(value && typeof value === 'object' && AUTO_SIGNAL_TYPES.has(value.kind));
