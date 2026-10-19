import { createHash } from 'node:crypto';
import { KERNEL_POLICY, loadKernelPrinciples, type KernelPrinciplesDocument } from '../policy.js';
import { summarizeModelRouting, type ModelUsageMetricReceipt } from './model-route-metrics.js';
import type { NormalizedModelRouteDecision } from '../../contracts/model-route.js';

interface MeasurementRun {
  sourceIdentity: string;
  currentWorkspaceIdentity?: string | null;
  objective: string;
  state: string;
  mutationRevision: number;
  requiredObligations: string[];
  replanCount?: number;
  interventionCount?: number;
  runSignals?: { efficiency?: unknown } | null;
  route?: { stages?: string[] } | null;
}
interface MeasurementVerification {
  executor?: unknown; status?: unknown; reuseOfVerificationId?: unknown;
}
interface MeasurementAttempt { startedAt?: string | null; finishedAt?: string | null; state?: string | null; status?: string }
interface MeasurementPromptSegment {
  kind?: unknown;
  renderedBytes?: unknown;
  tokenEstimate?: unknown;
  loaded?: unknown;
}
interface MeasurementPromptMeasurement {
  segments?: MeasurementPromptSegment[];
  renderedPromptBytes?: unknown;
  renderedPromptTokenEstimate?: unknown;
  cacheablePromptBytes?: unknown;
  cacheablePromptTokenEstimate?: unknown;
  providerMessageBytes?: unknown;
  providerMessageTokenEstimate?: unknown;
}
interface MeasurementUsageReceipt extends ModelUsageMetricReceipt {
  wallClockMs?: number | null;
  promptMeasurement?: MeasurementPromptMeasurement | null;
}
interface WorkflowMeasurementInput {
  run: MeasurementRun;
  verifications?: MeasurementVerification[];
  verificationHistory?: MeasurementVerification[];
  attempts?: MeasurementAttempt[];
  usageReceipts?: MeasurementUsageReceipt[];
  reviewReceipts?: unknown[];
}
interface KernelMeasurementInput extends WorkflowMeasurementInput {
  completion: { decision: string };
  principles?: Readonly<KernelPrinciplesDocument>;
  routeDecisions?: NormalizedModelRouteDecision[];
}

const observed = <T>(value: T): { status: 'observed'; value: T } => ({ status: 'observed', value });
const unavailable = (reason: string): { status: 'unavailable'; reason: string } => ({ status: 'unavailable', reason });

export const EFFICIENCY_TIMESTAMP_FIELDS = Object.freeze([
  'runStartedAt', 'goalResolvedAt', 'readinessCompletedAt', 'firstRepositoryReadAt',
  'firstMutationAt', 'lastMutationAt', 'focusedVerificationStartedAt',
  'focusedVerificationFinishedAt', 'goalRegressionStartedAt', 'goalRegressionFinishedAt',
  'reviewRequestedAt', 'reviewSpawnedAt', 'reviewFinishedAt', 'blockedAt',
]);
export const EFFICIENCY_COUNTER_FIELDS = Object.freeze([
  'reportCount', 'reportRejectedCount', 'contractRepairCount', 'scopeRejectedCount',
  'verificationTimeoutCount', 'waitTimeoutCount', 'contextCompactionCount',
  'repositorySearchCount', 'sameFileReadCount',
]);
export const EFFICIENCY_KPI_FIELDS = Object.freeze([
  'timeToGoalResolutionMs', 'timeToReadinessMs', 'timeToFirstMutationMs',
  'implementationWallMs', 'verificationWallMs', 'reviewQueueMs', 'reviewWallMs',
  'reportRepairTimeMs', 'blockedDiscoveryLatencyMs',
]);

const finiteTimestamp = (value: unknown) => {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : null;
};

const durationBetween = (start: unknown, finish: unknown) => {
  const startMs = finiteTimestamp(start);
  const finishMs = finiteTimestamp(finish);
  return startMs !== null && finishMs !== null && finishMs >= startMs ? finishMs - startMs : null;
};

const efficiencyTelemetryMeasurement = ({ run, workflowEfficiency = null }: { run: MeasurementRun; workflowEfficiency?: ReturnType<typeof workflowEfficiencyMeasurement> | null }) => {
  const candidate = run?.runSignals && typeof run.runSignals === 'object' && !Array.isArray(run.runSignals)
    ? run.runSignals.efficiency
    : null;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return unavailable('efficiency-telemetry-not-recorded');
  }
  const raw = candidate as Record<string, unknown>;
  const value: Record<string, unknown> = {};
  for (const field of EFFICIENCY_TIMESTAMP_FIELDS) value[field] = raw[field] || null;
  for (const field of EFFICIENCY_COUNTER_FIELDS) value[field] = Number.isFinite(Number(raw[field])) ? Number(raw[field]) : 0;
  value.timeToGoalResolutionMs = durationBetween(raw.runStartedAt, raw.goalResolvedAt);
  value.timeToReadinessMs = durationBetween(raw.runStartedAt, raw.readinessCompletedAt);
  value.timeToFirstMutationMs = durationBetween(raw.runStartedAt, raw.firstMutationAt);
  value.implementationWallMs = workflowEfficiency?.value?.executeMs ?? null;
  value.verificationWallMs = durationBetween(raw.focusedVerificationStartedAt, raw.focusedVerificationFinishedAt);
  value.reviewQueueMs = durationBetween(raw.reviewRequestedAt, raw.reviewSpawnedAt);
  value.reviewWallMs = durationBetween(raw.reviewSpawnedAt, raw.reviewFinishedAt);
  value.reportRepairTimeMs = null;
  value.blockedDiscoveryLatencyMs = durationBetween(raw.runStartedAt, raw.blockedAt);
  return observed(value);
};

// Provider usage becomes observable only when the Host files receipts. Without
// them the fields stay `unavailable` — an unmeasured run must never look free.
const providerUsageMeasurement = (receipts: MeasurementUsageReceipt[] = []) => {
  const withTokens = receipts.filter((receipt) => receipt.inputTokens !== null || receipt.outputTokens !== null);
  const models = [...new Set(receipts.map((receipt) => receipt.resolvedModel).filter(Boolean))];
  const durations = receipts.map((receipt) => receipt.wallClockMs).filter((value): value is number => Number.isInteger(value));
  const sum = (key: 'inputTokens' | 'cachedInputTokens' | 'outputTokens') => withTokens.reduce((total, receipt) => total + (receipt[key] ?? 0), 0);
  return {
    providerModelIdentity: models.length > 0
      ? observed({ models, enforcedTurns: receipts.filter((receipt) => receipt.enforcementStatus === 'enforced').length, turns: receipts.length })
      : unavailable('provider-usage-not-recorded'),
    actualInputTokens: withTokens.length > 0 ? observed({ total: sum('inputTokens'), cached: sum('cachedInputTokens'), reportedTurns: withTokens.length }) : unavailable('provider-usage-not-recorded'),
    actualOutputTokens: withTokens.length > 0 ? observed({ total: sum('outputTokens'), reportedTurns: withTokens.length }) : unavailable('provider-usage-not-recorded'),
    wallClockMs: durations.length > 0 ? observed({ modelTurnsTotalMs: durations.reduce((total, value) => total + value, 0), reportedTurns: durations.length }) : unavailable('run-duration-not-recorded'),
  };
};

const promptFootprintMeasurement = (receipts: MeasurementUsageReceipt[] = []) => {
  const measurements = receipts
    .map((receipt) => receipt.promptMeasurement)
    .filter((value): value is MeasurementPromptMeasurement => Boolean(value && typeof value === 'object' && !Array.isArray(value)));
  if (measurements.length === 0) return null;

  const count = (value: unknown): number | null => (
    Number.isInteger(value) && Number(value) >= 0 ? Number(value) : null
  );
  const sumField = (key: keyof MeasurementPromptMeasurement) => {
    const values = measurements
      .map((measurement) => count(measurement[key]))
      .filter((value): value is number => value !== null);
    return values.length > 0
      ? { total: values.reduce((total, value) => total + value, 0), reportedTurns: values.length }
      : null;
  };
  const segments = new Map<string, { renderedBytes: number; tokenEstimate: number; loadedTurns: number; reportedTurns: number }>();
  for (const measurement of measurements) {
    for (const segment of Array.isArray(measurement.segments) ? measurement.segments : []) {
      const kind = typeof segment.kind === 'string' ? segment.kind : null;
      const renderedBytes = count(segment.renderedBytes);
      const tokenEstimate = count(segment.tokenEstimate);
      if (!kind || renderedBytes === null || tokenEstimate === null) continue;
      const current = segments.get(kind) || { renderedBytes: 0, tokenEstimate: 0, loadedTurns: 0, reportedTurns: 0 };
      current.renderedBytes += renderedBytes;
      current.tokenEstimate += tokenEstimate;
      current.loadedTurns += segment.loaded === true ? 1 : 0;
      current.reportedTurns += 1;
      segments.set(kind, current);
    }
  }

  return {
    turns: measurements.length,
    renderedPromptBytes: sumField('renderedPromptBytes'),
    renderedPromptTokenEstimate: sumField('renderedPromptTokenEstimate'),
    cacheablePromptBytes: sumField('cacheablePromptBytes'),
    cacheablePromptTokenEstimate: sumField('cacheablePromptTokenEstimate'),
    providerMessageBytes: sumField('providerMessageBytes'),
    providerMessageTokenEstimate: sumField('providerMessageTokenEstimate'),
    segments: Object.fromEntries([...segments.entries()].sort(([a], [b]) => a.localeCompare(b))),
  };
};

const workflowEfficiencyMeasurement = ({ run, verifications = [], verificationHistory = [], attempts = [], usageReceipts = [], reviewReceipts = [] }: WorkflowMeasurementInput) => {
  const stages = Array.isArray(run.route?.stages) ? run.route.stages : [];
  const currentStageIndex = stages.indexOf(run.state);
  const rawEfficiency = run.runSignals?.efficiency;
  const efficiency = rawEfficiency && typeof rawEfficiency === 'object' && !Array.isArray(rawEfficiency)
    ? rawEfficiency as Record<string, unknown>
    : {};
  const durationByStage: Record<string, number> = Object.fromEntries(['FRAME', 'EXECUTE', 'PROVE', 'CLOSE'].map((stage) => [stage, 0]));
  for (const attempt of attempts) {
    const started = Date.parse(attempt.startedAt || '');
    const finished = Date.parse(attempt.finishedAt || '');
    if (!Number.isFinite(started) || !Number.isFinite(finished) || finished < started) continue;
    if (Object.prototype.hasOwnProperty.call(durationByStage, attempt.state || '')) {
      durationByStage[attempt.state || ''] = (durationByStage[attempt.state || ''] ?? 0) + finished - started;
    }
  }
  const history = verificationHistory.length > 0 ? verificationHistory : verifications;
  return observed({
    // The route is persisted, so this count remains available without adding
    // a transition-history table. It counts the reached route positions,
    // including the initial FRAME position (CLOSE on a completed standard
    // route therefore reports four).
    transitions: currentStageIndex >= 0 ? currentStageIndex + 1 : stages.length,
    modelTurns: usageReceipts.length,
    proofExecutions: history.filter((verification) => verification.executor === 'kernel-runtime' && !verification.reuseOfVerificationId).length,
    proofReuses: history.filter((verification) => Boolean(verification.reuseOfVerificationId)).length,
    reviewExecutions: reviewReceipts.length,
    frameMs: durationByStage.FRAME,
    executeMs: durationByStage.EXECUTE,
    proveMs: durationByStage.PROVE,
    closeMs: durationByStage.CLOSE,
    proofWallMs: durationBetween(efficiency.focusedVerificationStartedAt, efficiency.focusedVerificationFinishedAt),
    reviewWallMs: durationBetween(efficiency.reviewSpawnedAt, efficiency.reviewFinishedAt),
    // next() intentionally remains a pure read. No write is added only to
    // measure its payload or lock wait, so absent telemetry stays null.
    lockWaitMs: null,
    nextPayloadBytes: null,
    promptFootprint: promptFootprintMeasurement(usageReceipts),
  });
};

export const buildKernelMeasurement = ({ run, completion, principles = loadKernelPrinciples(), verifications = [], verificationHistory = [], attempts = [], routeDecisions = [], usageReceipts = [], reviewReceipts = [] }: KernelMeasurementInput) => {
  const workflowEfficiency = workflowEfficiencyMeasurement({ run, verifications, verificationHistory, attempts, usageReceipts, reviewReceipts });
  const failedWorkAttempts = attempts.filter((attempt) => attempt.status === 'failed').length;
  const failedProofExecutions = verificationHistory.filter((verification) => verification.status === 'failed').length;
  const retryCount = Math.max(
    Math.max(0, attempts.length - 1),
    Math.max(0, failedWorkAttempts - 1),
    Math.max(0, failedProofExecutions - 1),
  );
  return {
    schemaVersion: 2,
    harnessIdentity: 'moon-relay-kernel',
    sourceIdentity: run.sourceIdentity,
    currentWorkspaceIdentity: run.currentWorkspaceIdentity ? observed(run.currentWorkspaceIdentity) : unavailable('workspace-identity-not-observed'),
    hardEvidenceCoverage: observed({
      kernelRuntimePassed: verifications.filter((verification) => verification.executor === 'kernel-runtime' && verification.status === 'passed').length,
      callerAttestedPassed: verifications.filter((verification) => verification.executor !== 'kernel-runtime' && verification.status === 'passed').length,
      total: verifications.length,
      requiredForCompletion: run.mutationRevision > 0,
    }),
    promptTokenBudget: observed({
      stableTokenBudget: KERNEL_POLICY.context.stableTokenBudget,
      stageTokenBudget: KERNEL_POLICY.context.stageTokenBudget,
    }),
    taskIdentity: `task-${createHash('sha256').update(run.objective).digest('hex').slice(0, 16)}`,
    ...providerUsageMeasurement(usageReceipts),
    modelRouting: routeDecisions.length > 0 ? observed(summarizeModelRouting(routeDecisions, usageReceipts)) : unavailable('model-routing-not-recorded'),
    estimatedStaticTokens: Math.ceil(JSON.stringify(principles.principles).length / 4),
    successDecision: observed(completion.decision === 'accepted'),
    falseCompletionDecision: unavailable('false-completion-evaluation-not-run'),
    retryCount: observed(retryCount),
    replanCount: observed(run.replanCount || 0),
    userInterventionCount: observed(run.interventionCount || 0),
    evidenceCoverage: observed({ passed: verifications.filter((verification) => verification.status === 'passed').length, total: verifications.length, required: run.requiredObligations.length }),
    workflowEfficiency,
    efficiencyTelemetry: efficiencyTelemetryMeasurement({ run, workflowEfficiency }),
    contaminationSignals: observed({ relayStateMutation: false, profileMutation: false, source: 'kernel-runtime-boundary' }),
  };
};
