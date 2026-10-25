import { createHash } from 'node:crypto';
import {
  buildImprovementPair,
  improvementPairApprovalRef,
} from './improvement-pair.js';

type UnknownRecord = Record<string, unknown>;

export interface CrossRunSignalCollection extends UnknownRecord {
  runId?: unknown;
  projectId?: unknown;
  history?: unknown;
}

export interface CrossRunRunLike extends UnknownRecord {
  runId: string;
  projectId: string;
}

export interface CrossRunCandidateLike extends UnknownRecord {
  candidateId?: unknown;
  runId?: unknown;
  projectId?: unknown;
  proposedType?: unknown;
  statement?: unknown;
  scope?: unknown;
  sourceKind?: unknown;
  evidenceRefs?: unknown;
  acceptanceIds?: unknown;
  obligationIds?: unknown;
  supersedes?: unknown;
  signalKind?: unknown;
  improvementPair?: unknown;
  crossRunEvidenceGroup?: unknown;
}

export interface CrossRunEvidenceRun {
  runId: string;
  outcomes: Array<'failure' | 'success'>;
  evidenceRefs: string[];
  failureEvidenceRefs: string[];
  successEvidenceRefs: string[];
  successObligationIds: string[];
  staleEvidenceRefs: string[];
  contradictionEvidenceRefs: string[];
}

export interface CrossRunPromotionBasis {
  sourcePairId: string;
  sourceApprovalRef: string;
  scopeOwner: string;
  rollback: {
    strategy: string;
    targetIds: string[];
    evidenceRefs: string[];
  };
}

export interface CrossRunEvidenceGroup {
  schemaVersion: 1;
  groupId: string;
  projectId: string;
  correctionIdentity: string;
  scope: string[];
  statement: string;
  supportingRuns: CrossRunEvidenceRun[];
  runCount: number;
  failureRunIds: string[];
  successRunIds: string[];
  evidenceRefs: string[];
  failureEvidenceRefs: string[];
  successEvidenceRefs: string[];
  staleEvidenceRefs: string[];
  contradictionEvidenceRefs: string[];
  failureFingerprints: string[];
  causes: string[];
  promotionBasis: CrossRunPromotionBasis | null;
  promotionBasisConflict: boolean;
  status: 'repeated_failure' | 'repeated_with_resolution' | 'repeated_success';
  authority: 'episodic_only';
}

export interface BuildCrossRunEvidenceGroupsInput {
  projectId: string;
  currentRunId: string;
  signals?: CrossRunSignalCollection;
  priorRunSignals?: CrossRunSignalCollection[];
}

export interface CrossRunPromotionAssessment {
  applies: boolean;
  eligible: boolean;
  reasons: string[];
}

interface NormalizedCrossRunSignal extends UnknownRecord {
  fingerprint: string;
  cause: string;
  statement: string;
  scope: string[];
  evidenceRefs: string[];
  obligationIds: string[];
}

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

const evidenceRefsFor = (signal: UnknownRecord): string[] => [...new Set([
  ...list(signal.evidenceRefs),
  ...list(signal.evidenceRef),
  ...list(signal.evidenceDigest),
  ...list(signal.verificationReceipt),
  ...list(signal.reviewReceipt),
  ...list(signal.blockerReceipt),
  ...list(signal.sourceDigest),
].filter(Boolean))];

const normalizeSignal = (signal: UnknownRecord): NormalizedCrossRunSignal => ({
  ...signal,
  fingerprint: text(
    signal.fingerprint
      || signal.failureFingerprint
      || signal.blockerFingerprint,
  ),
  cause: text(
    signal.cause
      || signal.rootCause
      || signal.identifiedCause,
  ),
  statement: text(
    signal.statement
      || signal.summary
      || signal.reason
      || signal.message,
  ),
  scope: list(signal.scope || signal.changedPaths || signal.changedFiles),
  evidenceRefs: evidenceRefsFor(signal),
  obligationIds: list(signal.obligationIds || signal.obligationId),
});

const normalizedScope = (value: unknown): string[] => (
  [...new Set(list(value).map((entry) => entry.toLowerCase()))].sort()
);

const sameScope = (
  left: readonly string[],
  right: readonly string[],
): boolean => (
  left.length === right.length
  && left.every((entry, index) => entry === right[index])
);

const promotionBasisForSignal = ({
  signal,
  projectId,
  correctionIdentity,
  scope,
}: {
  signal: UnknownRecord;
  projectId: string;
  correctionIdentity: string;
  scope: string[];
}): CrossRunPromotionBasis | null => {
  const pair = isRecord(signal.improvementPair)
    ? signal.improvementPair
    : null;
  if (!pair || pair.status !== 'ready') return null;
  if (text(pair.projectId) !== projectId) return null;
  if (text(pair.correctionId) !== correctionIdentity) return null;
  if (!sameScope(normalizedScope(pair.scope), scope)) return null;

  const owner = isRecord(pair.scopeOwner) ? pair.scopeOwner : {};
  const rollback = isRecord(pair.rollback) ? pair.rollback : {};
  const scopeOwner = text(owner.owner);
  const pairRevision = text(pair.sourceRevision);
  if (!scopeOwner || !pairRevision) return null;
  if (text(owner.sourceRevision) !== pairRevision) return null;
  if (!sameScope(normalizedScope(owner.scope), scope)) return null;

  const rollbackStrategy = text(rollback.strategy);
  if (!rollbackStrategy) return null;

  return {
    sourcePairId: text(pair.pairId),
    sourceApprovalRef: improvementPairApprovalRef(pair),
    scopeOwner,
    rollback: {
      strategy: rollbackStrategy,
      targetIds: [...new Set(list(rollback.targetIds))].sort(),
      evidenceRefs: [...new Set(list(rollback.evidenceRefs))].sort(),
    },
  };
};

const signalCorrectionIdentity = (
  signal: UnknownRecord,
  normalized: NormalizedCrossRunSignal,
): string => {
  const pair = isRecord(signal.improvementPair) ? signal.improvementPair : {};
  return text(
    signal.correctionId
      || pair.correctionId
      || signal.candidateId
      || signal.linkedCorrectionId
      || signal.obligationId
      || normalized.obligationIds[0]
      || signal.failureFingerprint
      || normalized.fingerprint
      || normalized.statement,
  );
};

const signalIsStale = (signal: UnknownRecord): boolean => {
  const freshness = text(signal.freshnessStatus || signal.freshness)
    .toLowerCase();
  return signal.stale === true
    || freshness === 'stale'
    || freshness === 'needs_deep_verify';
};

const contradictionRefsFor = (
  signal: UnknownRecord,
  evidenceRefs: string[],
): string[] => {
  const explicit = [
    ...list(signal.contradictionEvidenceRefs),
    ...list(signal.contradicts),
  ];
  if (explicit.length > 0) return [...new Set(explicit)];
  return signal.contradiction === true || signal.contradictory === true
    ? [...evidenceRefs]
    : [];
};

const legacyRunIdentity = (
  signals: CrossRunSignalCollection,
): string => (
  `legacy-run-${digest(signals).slice(-24)}`
);

export function buildCrossRunEvidenceGroups({
  projectId,
  currentRunId,
  signals = {},
  priorRunSignals = [],
}: BuildCrossRunEvidenceGroupsInput): CrossRunEvidenceGroup[] {
  if (!projectId || !currentRunId) return [];

  const history = Array.isArray(signals.history)
    ? signals.history.filter(isRecord) as CrossRunSignalCollection[]
    : [];
  const runEntries = [...priorRunSignals, ...history, signals]
    .map((entry, index, all) => {
      if (entry.projectId && text(entry.projectId) !== projectId) {
        return null;
      }
      const runId = text(entry.runId)
        || (
          index === all.length - 1
            ? currentRunId
            : legacyRunIdentity(entry)
        );
      return { runId, entry };
    })
    .filter((entry): entry is {
      runId: string;
      entry: CrossRunSignalCollection;
    } => Boolean(entry?.runId));

  type MutableRunEvidence = {
    outcomes: Set<'failure' | 'success'>;
    evidenceRefs: Set<string>;
    failureEvidenceRefs: Set<string>;
    successEvidenceRefs: Set<string>;
    successObligationIds: Set<string>;
    staleEvidenceRefs: Set<string>;
    contradictionEvidenceRefs: Set<string>;
  };
  type MutableGroup = {
    correctionIdentity: string;
    scope: string[];
    statement: string;
    failureFingerprints: Set<string>;
    causes: Set<string>;
    runs: Map<string, MutableRunEvidence>;
    promotionBases: Map<string, CrossRunPromotionBasis>;
  };

  const groups = new Map<string, MutableGroup>();

  const addSignals = (
    runId: string,
    entry: CrossRunSignalCollection,
    kind: 'failures' | 'regressionVerifications',
    outcome: 'failure' | 'success',
  ): void => {
    const rawSignals = entry[kind];
    for (
      const rawSignal of Array.isArray(rawSignals) ? rawSignals : []
    ) {
      if (!isRecord(rawSignal)) continue;
      if (
        outcome === 'success'
        && rawSignal.status
        && rawSignal.status !== 'passed'
      ) {
        continue;
      }
      if (
        outcome === 'success'
        && rawSignal.exitCode !== undefined
        && Number(rawSignal.exitCode) !== 0
      ) {
        continue;
      }

      const normalized = normalizeSignal(rawSignal);
      const correctionIdentity = signalCorrectionIdentity(
        rawSignal,
        normalized,
      );
      const scope = normalizedScope(normalized.scope);
      if (!correctionIdentity) continue;

      const groupKey = digest({
        projectId,
        correctionIdentity,
        scope,
      });
      const group = groups.get(groupKey) || {
        correctionIdentity,
        scope,
        statement: normalized.statement,
        failureFingerprints: new Set<string>(),
        causes: new Set<string>(),
        runs: new Map<string, MutableRunEvidence>(),
        promotionBases: new Map<string, CrossRunPromotionBasis>(),
      };
      if (!group.statement && normalized.statement) {
        group.statement = normalized.statement;
      }
      if (outcome === 'failure') {
        if (normalized.fingerprint) group.failureFingerprints.add(normalized.fingerprint);
        if (normalized.cause) group.causes.add(normalized.cause);
      }

      const runEvidence = group.runs.get(runId) || {
        outcomes: new Set<'failure' | 'success'>(),
        evidenceRefs: new Set<string>(),
        failureEvidenceRefs: new Set<string>(),
        successEvidenceRefs: new Set<string>(),
        successObligationIds: new Set<string>(),
        staleEvidenceRefs: new Set<string>(),
        contradictionEvidenceRefs: new Set<string>(),
      };
      runEvidence.outcomes.add(outcome);
      for (const evidenceRef of normalized.evidenceRefs) {
        runEvidence.evidenceRefs.add(evidenceRef);
        if (outcome === 'failure') {
          runEvidence.failureEvidenceRefs.add(evidenceRef);
        } else {
          runEvidence.successEvidenceRefs.add(evidenceRef);
        }
        if (signalIsStale(rawSignal)) {
          runEvidence.staleEvidenceRefs.add(evidenceRef);
        }
      }
      if (outcome === 'success') {
        for (const obligationId of normalized.obligationIds) {
          runEvidence.successObligationIds.add(obligationId);
        }
      }
      for (
        const contradictionRef of contradictionRefsFor(
          rawSignal,
          normalized.evidenceRefs,
        )
      ) {
        runEvidence.contradictionEvidenceRefs.add(contradictionRef);
      }

      const promotionBasis = promotionBasisForSignal({
        signal: rawSignal,
        projectId,
        correctionIdentity,
        scope,
      });
      if (promotionBasis) {
        group.promotionBases.set(
          promotionBasis.sourceApprovalRef,
          promotionBasis,
        );
      }

      group.runs.set(runId, runEvidence);
      groups.set(groupKey, group);
    }
  };

  for (const { runId, entry } of runEntries) {
    addSignals(runId, entry, 'failures', 'failure');
    addSignals(
      runId,
      entry,
      'regressionVerifications',
      'success',
    );
  }

  return [...groups.entries()]
    .map(([groupDigest, group]): CrossRunEvidenceGroup => {
      const supportingRuns = [...group.runs.entries()]
        .map(([runId, evidence]) => ({
          runId,
          outcomes: [...evidence.outcomes].sort(),
          evidenceRefs: [...evidence.evidenceRefs].sort(),
          failureEvidenceRefs: [
            ...evidence.failureEvidenceRefs,
          ].sort(),
          successEvidenceRefs: [
            ...evidence.successEvidenceRefs,
          ].sort(),
          successObligationIds: [
            ...evidence.successObligationIds,
          ].sort(),
          staleEvidenceRefs: [...evidence.staleEvidenceRefs].sort(),
          contradictionEvidenceRefs: [
            ...evidence.contradictionEvidenceRefs,
          ].sort(),
        }))
        .sort((left, right) => left.runId.localeCompare(right.runId));
      const failureRunIds = supportingRuns
        .filter((entry) => entry.outcomes.includes('failure'))
        .map((entry) => entry.runId);
      const successRunIds = supportingRuns
        .filter((entry) => entry.outcomes.includes('success'))
        .map((entry) => entry.runId);
      const evidenceRefs = [...new Set(
        supportingRuns.flatMap((entry) => entry.evidenceRefs),
      )].sort();
      const failureEvidenceRefs = [...new Set(
        supportingRuns.flatMap((entry) => entry.failureEvidenceRefs),
      )].sort();
      const successEvidenceRefs = [...new Set(
        supportingRuns.flatMap((entry) => entry.successEvidenceRefs),
      )].sort();
      const staleEvidenceRefs = [...new Set(
        supportingRuns.flatMap((entry) => entry.staleEvidenceRefs),
      )].sort();
      const contradictionEvidenceRefs = [...new Set(
        supportingRuns.flatMap(
          (entry) => entry.contradictionEvidenceRefs,
        ),
      )].sort();
      const promotionBases = [...group.promotionBases.values()];
      const promotionBasis = promotionBases.length === 1
        ? promotionBases[0] ?? null
        : null;
      const promotionBasisConflict = promotionBases.length > 1;
      const status = (
        failureRunIds.length > 0
        && successRunIds.length > 0
      )
        ? 'repeated_with_resolution'
        : failureRunIds.length > 0
          ? 'repeated_failure'
          : 'repeated_success';

      return {
        schemaVersion: 1,
        groupId: `cross-run-${groupDigest.slice(-24)}`,
        projectId,
        correctionIdentity: group.correctionIdentity,
        scope: group.scope,
        statement: group.statement,
        supportingRuns,
        runCount: supportingRuns.length,
        failureRunIds,
        successRunIds,
        evidenceRefs,
        failureEvidenceRefs,
        successEvidenceRefs,
        staleEvidenceRefs,
        contradictionEvidenceRefs,
        failureFingerprints: [...group.failureFingerprints].sort(),
        causes: [...group.causes].sort(),
        promotionBasis,
        promotionBasisConflict,
        status,
        authority: 'episodic_only',
      };
    })
    .filter((group) => group.runCount >= 2)
    .sort((left, right) => left.groupId.localeCompare(right.groupId));
}

export const buildCrossRunEvidenceCandidate = (
  run: CrossRunRunLike,
  group: CrossRunEvidenceGroup,
): CrossRunCandidateLike => {
  const candidateId = `cand-${group.groupId}`;
  const base: CrossRunCandidateLike = {
    candidateId,
    runId: run.runId,
    projectId: run.projectId,
    proposedType: 'episodic_observation',
    statement: group.statement
      || `Cross-run evidence for correction ${group.correctionIdentity}`,
    scope: group.scope,
    relatedFiles: group.scope,
    sourceRefs: [],
    evidenceRefs: group.evidenceRefs,
    acceptanceIds: [],
    obligationIds: [],
    sourceKind: 'auto',
    signalKind: 'cross-run-evidence',
    signalFingerprint: group.failureFingerprints.length === 1
      ? group.failureFingerprints[0]
      : null,
    cause: group.causes.length === 1 ? group.causes[0] : null,
    confidence: 0.75,
    status: 'observed',
    trustTier: 'derived',
    supersedes: [],
    crossRunEvidenceGroup: group,
    evidenceBinding: {
      evidenceRefs: group.evidenceRefs,
      acceptanceIds: [],
      obligationIds: [],
      sourceDigest: null,
    },
  };

  const currentRunEvidence = group.supportingRuns.find(
    (entry) => entry.runId === run.runId,
  );
  const currentSuccessRefs = list(
    currentRunEvidence?.successEvidenceRefs,
  );
  const currentSuccessObligations = list(
    currentRunEvidence?.successObligationIds,
  );
  const promotionBasis = group.promotionBasis;
  if (
    group.projectId !== run.projectId
    || group.scope.length === 0
    || group.failureFingerprints.length !== 1
    || group.causes.length !== 1
    || group.status !== 'repeated_with_resolution'
    || !group.successRunIds.includes(run.runId)
    || group.staleEvidenceRefs.length > 0
    || group.contradictionEvidenceRefs.length > 0
    || group.promotionBasisConflict
    || !promotionBasis
    || currentSuccessRefs.length === 0
    || currentSuccessObligations.length === 0
  ) {
    return base;
  }

  const sourceRevision = digest({
    groupId: group.groupId,
    supportingRunIds: group.supportingRuns
      .map((entry) => entry.runId)
      .sort()
      .join('|'),
    evidenceRefs: group.evidenceRefs.join('|'),
    currentSuccessRefs: currentSuccessRefs.join('|'),
    currentSuccessObligations: currentSuccessObligations.join('|'),
    promotionBasis: promotionBasis.sourceApprovalRef,
  });
  const improvementPair = buildImprovementPair({
    correctionId: candidateId,
    projectId: run.projectId,
    sourceIdentity: `cross-run://${group.groupId}`,
    sourceRevision,
    scope: group.scope,
    sourceEvidenceRefs: group.evidenceRefs,
    mutationCandidate: {
      candidateId,
      projectId: run.projectId,
      sourceRevision,
      scope: group.scope,
      evidenceRefs: group.failureEvidenceRefs,
    },
    replayCandidate: {
      candidateId: `replay-${group.groupId}-${run.runId}`,
      projectId: run.projectId,
      sourceRevision,
      scope: group.scope,
      evidenceRefs: currentSuccessRefs,
      obligationIds: currentSuccessObligations,
    },
    scopeOwner: {
      owner: promotionBasis.scopeOwner,
      sourceRevision,
      scope: group.scope,
    },
    rollback: promotionBasis.rollback,
  });
  if (improvementPair.status !== 'ready') return base;

  return {
    ...base,
    proposedType: 'known_failure_pattern',
    signalKind: 'cross-run-promotion',
    confidence: 0.9,
    supersedes: promotionBasis.rollback.targetIds,
    improvementPair,
    crossRunPromotion: {
      sourcePairId: promotionBasis.sourcePairId,
      sourceApprovalRef: promotionBasis.sourceApprovalRef,
      sourceRevision,
    },
  };
};

export const evaluateCrossRunPromotionCandidate = ({
  candidate,
  runId,
  projectId,
}: {
  candidate: CrossRunCandidateLike;
  runId: string;
  projectId: string;
}): CrossRunPromotionAssessment => {
  if (!isRecord(candidate.crossRunEvidenceGroup)) {
    return { applies: false, eligible: true, reasons: [] };
  }

  const group = (
    candidate.crossRunEvidenceGroup as unknown as CrossRunEvidenceGroup
  );
  const expected = buildCrossRunEvidenceCandidate(
    { runId, projectId },
    group,
  );
  const reasons: string[] = [];
  if (expected.signalKind !== 'cross-run-promotion') {
    reasons.push('CROSS_RUN_GROUP_EPISODIC_ONLY');
  } else {
    if (text(candidate.projectId) !== projectId) {
      reasons.push('CROSS_RUN_PROJECT_MISMATCH');
    }
    if (!sameScope(
      normalizedScope(candidate.scope),
      normalizedScope(expected.scope),
    )) {
      reasons.push('CROSS_RUN_SCOPE_MISMATCH');
    }
    if (text(candidate.proposedType) !== 'known_failure_pattern') {
      reasons.push('CROSS_RUN_DURABLE_TYPE_MISMATCH');
    }
    if (text(candidate.signalKind) !== 'cross-run-promotion') {
      reasons.push('CROSS_RUN_PROMOTION_SIGNAL_MISSING');
    }
    if (
      !candidate.improvementPair
      || !expected.improvementPair
      || improvementPairApprovalRef(candidate.improvementPair)
        !== improvementPairApprovalRef(expected.improvementPair)
    ) {
      reasons.push('CROSS_RUN_PROMOTION_PAIR_MISMATCH');
    }
    const actualSupersedes = [
      ...new Set(list(candidate.supersedes)),
    ].sort();
    const expectedSupersedes = [
      ...new Set(list(expected.supersedes)),
    ].sort();
    if (!sameScope(actualSupersedes, expectedSupersedes)) {
      reasons.push('CROSS_RUN_SUPERSESSION_MISMATCH');
    }
  }

  return {
    applies: true,
    eligible: reasons.length === 0,
    reasons,
  };
};
