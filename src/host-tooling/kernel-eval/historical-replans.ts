import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { HistoricalWorkCase } from './historical-improvement.js';

export const HISTORICAL_REPLAN_CAUSES = Object.freeze([
  'requirement-correction',
  'environment-failure',
  'verification-failure',
  'workspace/source-drift',
  'contract-repair',
  'operator-scope-change',
  'insufficient',
] as const);

export type HistoricalReplanCause = typeof HISTORICAL_REPLAN_CAUSES[number];
export type HistoricalReplanClassifiedCause = Exclude<HistoricalReplanCause, 'insufficient'>;

type UnknownRecord = Record<string, unknown>;

type RunRow = UnknownRecord & {
  run_id: string;
  replan_count?: number | null;
  plan_revision?: number | null;
};

export interface HistoricalReplanEvidence {
  failureCategories?: readonly string[];
  routeReasonCodes?: readonly string[];
  reviewFindings?: readonly unknown[];
  verificationFailed?: boolean;
  contractRevised?: boolean;
  operatorScopeChange?: boolean;
  boundaryAvailable?: boolean;
}

export interface HistoricalReplanClassification {
  cause: HistoricalReplanCause;
  candidateCauses: HistoricalReplanClassifiedCause[];
  evidenceKinds: string[];
  evidenceStatus: 'classified' | 'missing' | 'conflicting';
}

export interface HistoricalReplanEvent {
  schemaVersion: 'kernel-historical-replan-event.v1';
  eventId: string;
  caseId: string | null;
  targetPlanRevision: number;
  cause: HistoricalReplanCause;
  evidenceStatus: 'classified' | 'missing' | 'conflicting';
  evidenceKinds: string[];
  generationRelevance: 'current' | 'resolved' | 'stale' | 'insufficient';
  completionStatus: string | null;
  promotionAuthority: false;
}

export interface HistoricalReplanCauseAnalysis {
  schemaVersion: 'kernel-historical-replan-analysis.v1';
  eventCount: number;
  classifiedEventCount: number;
  classificationCoverage: number | null;
  conflictingEventCount: number;
  missingEvidenceEventCount: number;
  currentGenerationEventCount: number;
  causeCounts: Record<HistoricalReplanCause, number>;
  currentGenerationCauseCounts: Record<HistoricalReplanCause, number>;
  repeatedCurrentCauses: HistoricalReplanClassifiedCause[];
  productionRecommendation: 'DEFER';
  reason: string;
  promotionAuthority: false;
}

interface LoadHistoricalReplansOptions {
  dbPath: string;
  projectId: string;
  cases?: readonly HistoricalWorkCase[];
}

const record = (value: unknown): UnknownRecord => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : {}
);

const text = (value: unknown): string | null => (
  typeof value === 'string' && value.trim() ? value.trim() : null
);

const integer = (value: unknown): number | null => (
  Number.isInteger(value) && Number(value) >= 0 ? Number(value) : null
);

const parseArray = (value: unknown): unknown[] => {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

const placeholders = (count: number): string => Array.from({ length: count }, () => '?').join(',');

const select = <T extends UnknownRecord>(db: DatabaseSync, sql: string, params: string[] = []): T[] => (
  db.prepare(sql).all(...params) as T[]
);

const environmentFailure = (value: string): boolean => {
  const category = value.trim().toLowerCase();
  return category === 'host'
    || category === 'transport'
    || category.startsWith('provider/')
    || category.startsWith('transport/')
    || category.includes('infrastructure');
};

const workspaceSourceDrift = (value: string): boolean => {
  const category = value.trim().toLowerCase();
  if (category === 'delivery_workspace_drift') return true;
  const scope = category.includes('workspace') || category.includes('source');
  const drift = category.includes('drift') || category.includes('mismatch');
  return scope && drift;
};

const verificationFailure = (value: string): boolean => new Set([
  'proof',
  'evidence-rejected',
  'incomplete_review_chain',
  'report-rejected',
]).has(value.trim().toLowerCase());

const addCandidate = (
  candidates: Set<HistoricalReplanClassifiedCause>,
  evidenceKinds: Set<string>,
  cause: HistoricalReplanClassifiedCause,
  evidenceKind: string,
): void => {
  candidates.add(cause);
  evidenceKinds.add(evidenceKind);
};

export const classifyHistoricalReplanEvidence = ({
  failureCategories = [],
  routeReasonCodes = [],
  reviewFindings = [],
  verificationFailed = false,
  contractRevised = false,
  operatorScopeChange = false,
  boundaryAvailable = true,
}: HistoricalReplanEvidence): HistoricalReplanClassification => {
  if (!boundaryAvailable) {
    return {
      cause: 'insufficient',
      candidateCauses: [],
      evidenceKinds: ['missing-plan-boundary'],
      evidenceStatus: 'missing',
    };
  }

  const candidates = new Set<HistoricalReplanClassifiedCause>();
  const evidenceKinds = new Set<string>();

  for (const failureCategory of failureCategories) {
    if (workspaceSourceDrift(failureCategory)) {
      addCandidate(candidates, evidenceKinds, 'workspace/source-drift', 'attempt-workspace/source-drift');
    } else if (environmentFailure(failureCategory)) {
      addCandidate(candidates, evidenceKinds, 'environment-failure', 'attempt-environment');
    } else if (verificationFailure(failureCategory)) {
      addCandidate(candidates, evidenceKinds, 'verification-failure', 'attempt-verification');
    }
  }

  for (const reasonCode of routeReasonCodes) {
    if (reasonCode === 'PLAN_INVALID_REPLAN' || reasonCode === 'ARCHITECTURE_DEVIATION_REPLAN') {
      addCandidate(candidates, evidenceKinds, 'contract-repair', 'route-contract-repair');
    }
  }

  for (const rawFinding of reviewFindings) {
    const finding = record(rawFinding);
    const category = text(finding.category)?.toLowerCase() || '';
    const requiredAction = text(finding.requiredAction)?.toLowerCase() || '';
    if (requiredAction === 'replan' && (category === 'contract' || category === 'architecture')) {
      addCandidate(candidates, evidenceKinds, 'contract-repair', 'review-contract-repair');
    } else if (category === 'verification' && (requiredAction === 'fix' || requiredAction === 'replan')) {
      addCandidate(candidates, evidenceKinds, 'verification-failure', 'review-verification');
    } else if (requiredAction === 'replan' && (category.includes('workspace') || category.includes('source'))) {
      addCandidate(candidates, evidenceKinds, 'workspace/source-drift', 'review-workspace/source-drift');
    }
  }

  if (verificationFailed) {
    addCandidate(candidates, evidenceKinds, 'verification-failure', 'verification-failed');
  }
  if (contractRevised) {
    addCandidate(candidates, evidenceKinds, 'requirement-correction', 'contract-revised');
  }
  if (operatorScopeChange) {
    addCandidate(candidates, evidenceKinds, 'operator-scope-change', 'operator-scope-change');
  }

  const candidateCauses = [...candidates].sort();
  const sortedEvidence = [...evidenceKinds].sort();
  if (candidateCauses.length === 1) {
    return {
      cause: candidateCauses[0]!,
      candidateCauses,
      evidenceKinds: sortedEvidence,
      evidenceStatus: 'classified',
    };
  }
  if (candidateCauses.length > 1) {
    return {
      cause: 'insufficient',
      candidateCauses,
      evidenceKinds: ['conflicting-evidence', ...sortedEvidence],
      evidenceStatus: 'conflicting',
    };
  }
  return {
    cause: 'insufficient',
    candidateCauses: [],
    evidenceKinds: ['no-causal-evidence'],
    evidenceStatus: 'missing',
  };
};

const rowsByRun = <T extends UnknownRecord>(rows: readonly T[]): Map<string, T[]> => {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const runId = text(row.run_id);
    if (!runId) continue;
    const group = grouped.get(runId) || [];
    group.push(row);
    grouped.set(runId, group);
  }
  return grouped;
};

const timestampInWindow = (value: unknown, start: string, end: string): boolean => {
  const timestamp = text(value);
  return Boolean(timestamp && timestamp > start && timestamp <= end);
};

const caseByRunId = (cases: readonly HistoricalWorkCase[]): Map<string, HistoricalWorkCase> => {
  const map = new Map<string, HistoricalWorkCase>();
  for (const item of cases) {
    for (const runId of item.lineageRunIds) map.set(runId, item);
  }
  return map;
};

const routeReasons = (rows: readonly UnknownRecord[]): string[] => [...new Set(
  rows.flatMap((row) => parseArray(row.reason_codes_json).map(String)),
)].sort();

const reviewFindings = (rows: readonly UnknownRecord[]): unknown[] => rows.flatMap((row) => parseArray(row.findings_json));

export const loadHistoricalReplanEvents = ({
  dbPath,
  projectId,
  cases = [],
}: LoadHistoricalReplansOptions): HistoricalReplanEvent[] => {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const runs = select<RunRow>(db, `
      SELECT run_id,replan_count,plan_revision
      FROM runs
      WHERE project_id=? AND replan_count>0
      ORDER BY updated_at,run_id
    `, [projectId]);
    if (runs.length === 0) return [];
    const runIds = runs.map((run) => String(run.run_id));
    const inRuns = placeholders(runIds.length);
    const steps = select(db, `SELECT run_id,plan_revision,created_at FROM run_steps WHERE run_id IN (${inRuns}) ORDER BY run_id,plan_revision,created_at`, runIds);
    const attempts = select(db, `SELECT run_id,plan_revision,failure_category FROM run_step_attempts WHERE run_id IN (${inRuns}) ORDER BY run_id,plan_revision,started_at,id`, runIds);
    const routes = select(db, `SELECT run_id,plan_revision,reason_codes_json FROM model_route_decisions WHERE run_id IN (${inRuns}) ORDER BY run_id,plan_revision,created_at`, runIds);
    const reviews = select(db, `SELECT run_id,plan_revision,findings_json FROM review_receipts WHERE run_id IN (${inRuns}) ORDER BY run_id,plan_revision,created_at`, runIds);
    const verifications = select(db, `SELECT run_id,status,exit_code,observed_at FROM verifications WHERE run_id IN (${inRuns}) ORDER BY run_id,observed_at,id`, runIds);
    const journals = select(db, `SELECT run_id,kind,created_at FROM run_journal WHERE run_id IN (${inRuns}) ORDER BY run_id,created_at,id`, runIds);

    const stepGroups = rowsByRun(steps);
    const attemptGroups = rowsByRun(attempts);
    const routeGroups = rowsByRun(routes);
    const reviewGroups = rowsByRun(reviews);
    const verificationGroups = rowsByRun(verifications);
    const journalGroups = rowsByRun(journals);
    const casesByRun = caseByRunId(cases);
    const events: HistoricalReplanEvent[] = [];

    for (const run of runs) {
      const runId = String(run.run_id);
      const replanCount = integer(run.replan_count) || 0;
      const planRevision = integer(run.plan_revision) || 1;
      const runSteps = stepGroups.get(runId) || [];
      const revisionStart = new Map<number, string>();
      for (const step of runSteps) {
        const revision = integer(step.plan_revision);
        const createdAt = text(step.created_at);
        if (revision === null || !createdAt) continue;
        const current = revisionStart.get(revision);
        if (!current || createdAt < current) revisionStart.set(revision, createdAt);
      }
      const linkedCase = casesByRun.get(runId) || null;

      for (let offset = 1; offset <= replanCount; offset += 1) {
        const targetPlanRevision = offset + 1;
        const previousPlanRevision = targetPlanRevision - 1;
        const start = revisionStart.get(previousPlanRevision) || null;
        const end = revisionStart.get(targetPlanRevision) || null;
        const boundaryAvailable = targetPlanRevision <= planRevision && Boolean(start && end);
        const previousAttempts = (attemptGroups.get(runId) || []).filter((row) => integer(row.plan_revision) === previousPlanRevision);
        const previousRoutes = (routeGroups.get(runId) || []).filter((row) => integer(row.plan_revision) === previousPlanRevision);
        const previousReviews = (reviewGroups.get(runId) || []).filter((row) => integer(row.plan_revision) === previousPlanRevision);
        const windowVerifications = start && end
          ? (verificationGroups.get(runId) || []).filter((row) => timestampInWindow(row.observed_at, start, end))
          : [];
        const windowJournals = start && end
          ? (journalGroups.get(runId) || []).filter((row) => timestampInWindow(row.created_at, start, end))
          : [];
        const classification = classifyHistoricalReplanEvidence({
          failureCategories: previousAttempts.map((row) => text(row.failure_category)).filter((value): value is string => Boolean(value)),
          routeReasonCodes: routeReasons(previousRoutes),
          reviewFindings: reviewFindings(previousReviews),
          verificationFailed: windowVerifications.some((row) => (
            text(row.status) !== 'passed' || (row.exit_code !== null && Number(row.exit_code) !== 0)
          )),
          contractRevised: windowJournals.some((row) => row.kind === 'contract-revised'),
          boundaryAvailable,
        });

        events.push({
          schemaVersion: 'kernel-historical-replan-event.v1',
          eventId: `replan-${sha256(`${runId}|${targetPlanRevision}`).slice(0, 24)}`,
          caseId: linkedCase?.caseId || null,
          targetPlanRevision,
          cause: classification.cause,
          evidenceStatus: classification.evidenceStatus,
          evidenceKinds: classification.evidenceKinds,
          generationRelevance: linkedCase?.generationRelevance || 'insufficient',
          completionStatus: linkedCase?.completionStatus || null,
          promotionAuthority: false,
        });
      }
    }

    return events.sort((left, right) => left.eventId.localeCompare(right.eventId));
  } finally {
    db.close();
  }
};

const emptyCauseCounts = (): Record<HistoricalReplanCause, number> => Object.fromEntries(
  HISTORICAL_REPLAN_CAUSES.map((cause) => [cause, 0]),
) as Record<HistoricalReplanCause, number>;

export const analyzeHistoricalReplanCauses = (
  events: readonly HistoricalReplanEvent[],
): HistoricalReplanCauseAnalysis => {
  const causeCounts = emptyCauseCounts();
  const currentGenerationCauseCounts = emptyCauseCounts();
  for (const event of events) {
    causeCounts[event.cause] += 1;
    if (event.generationRelevance === 'current') currentGenerationCauseCounts[event.cause] += 1;
  }
  const classifiedEventCount = events.length - causeCounts.insufficient;
  const repeatedCurrentCauses = HISTORICAL_REPLAN_CAUSES
    .filter((cause): cause is HistoricalReplanClassifiedCause => cause !== 'insufficient')
    .filter((cause) => currentGenerationCauseCounts[cause] > 1)
    .sort();

  return {
    schemaVersion: 'kernel-historical-replan-analysis.v1',
    eventCount: events.length,
    classifiedEventCount,
    classificationCoverage: events.length > 0 ? classifiedEventCount / events.length : null,
    conflictingEventCount: events.filter((event) => event.evidenceStatus === 'conflicting').length,
    missingEvidenceEventCount: events.filter((event) => event.evidenceStatus === 'missing').length,
    currentGenerationEventCount: events.filter((event) => event.generationRelevance === 'current').length,
    causeCounts,
    currentGenerationCauseCounts,
    repeatedCurrentCauses,
    productionRecommendation: 'DEFER',
    reason: repeatedCurrentCauses.length > 0
      ? 'Repeated current-generation causes are diagnostic candidates only; production changes still require a single-variable replay.'
      : 'No repeated current-generation classified cause justifies a production workflow change.',
    promotionAuthority: false,
  };
};
