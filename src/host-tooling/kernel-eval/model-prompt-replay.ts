// Wave 3 thin replay helper.
//
// It owns no provider runner, workspace isolation, persistence, or scoring
// authority. A replay attempt uses the existing Host dispatcher. This module
// only binds its receipt to evaluator observations and applies the fixed
// adoption order: quality -> regression/rework -> efficiency.

import { dispatchKernelTurn } from '../../host/kernel/turn-dispatcher.js';

type RecordLike = Record<string, unknown>;
type ReplayArm = 'baseline' | 'candidate';
type ReplayAttemptStatus = 'completed' | 'failed' | 'incomplete';
type AllowedDifference = 'model' | 'effort' | 'promptPrefixDigest';
type DispatchInput = Parameters<typeof dispatchKernelTurn>[0];

export interface ModelPromptReplayEvaluation {
  taskSuccess: boolean;
  acceptanceSatisfied: boolean;
  criticalAuthorityViolationCount: number;
  scopeViolationCount: number;
  hardcodedSolutionCount: number;
  fallbackAbstractionGrowthCount: number;
  regressionCount: number;
  reworkCount: number;
  unnecessaryToolCalls: number;
  unnecessarySubagentCalls: number;
  unnecessaryClarificationBeforeAction: number;
  verificationDuplicationCount: number;
}

export interface ModelPromptReplayAttempt {
  caseId: string;
  arm: ReplayArm;
  order: number;
  repetition: number;
  attempt: number;
  status: ReplayAttemptStatus;
  receipt: RecordLike | null;
  promptMeasurement: RecordLike | null;
  evaluation: ModelPromptReplayEvaluation;
}

interface ReplayProtocol {
  execution: {
    runsPerArmPerCase: number;
    armOrder: ReplayArm[];
    maxRetriesPerRun: number;
    includeIncompleteRuns: boolean;
    maxProviderCallsPerCase: number;
  };
  gates: {
    criticalAuthorityViolationMax: number;
    efficiencyImprovement: {
      anyOf: Array<{
        metric: string;
        absoluteDecreaseAtLeast?: number;
        medianRelativeDecreaseAtLeast?: number;
      }>;
    };
  };
  cases: Array<{ id: string }>;
}

const record = (value: unknown): RecordLike => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as RecordLike
    : {}
);
const text = (value: unknown): string | null => (
  typeof value === 'string' && value.trim() ? value.trim() : null
);
const count = (value: unknown, field: string): number => {
  if (!Number.isInteger(value) || Number(value) < 0) {
    throw new TypeError(`${field} must be a non-negative integer`);
  }
  return Number(value);
};
const positiveCount = (value: unknown, field: string): number => {
  const normalized = count(value, field);
  if (normalized < 1) throw new TypeError(`${field} must be a positive integer`);
  return normalized;
};
const measure = (value: unknown): number | null => (
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
);

const resolveAttemptStatus = (
  explicit: ReplayAttemptStatus | undefined,
  receipt: RecordLike,
): ReplayAttemptStatus => {
  if (explicit) {
    if (!['completed', 'failed', 'incomplete'].includes(explicit)) {
      throw new TypeError('status must be completed, failed, or incomplete');
    }
    return explicit;
  }
  const resultStatus = text(receipt.resultStatus);
  if (resultStatus === 'failed') return 'failed';
  if (resultStatus === 'interrupted' || resultStatus === 'abandoned') return 'incomplete';
  return 'completed';
};

const normalizeEvaluation = (
  value: ModelPromptReplayEvaluation,
  status: ReplayAttemptStatus,
): ModelPromptReplayEvaluation => ({
  taskSuccess: status === 'completed' && value.taskSuccess === true,
  acceptanceSatisfied: status === 'completed' && value.acceptanceSatisfied === true,
  criticalAuthorityViolationCount: count(value.criticalAuthorityViolationCount, 'criticalAuthorityViolationCount'),
  scopeViolationCount: count(value.scopeViolationCount, 'scopeViolationCount'),
  hardcodedSolutionCount: count(value.hardcodedSolutionCount, 'hardcodedSolutionCount'),
  fallbackAbstractionGrowthCount: count(value.fallbackAbstractionGrowthCount, 'fallbackAbstractionGrowthCount'),
  regressionCount: count(value.regressionCount, 'regressionCount'),
  reworkCount: count(value.reworkCount, 'reworkCount'),
  unnecessaryToolCalls: count(value.unnecessaryToolCalls, 'unnecessaryToolCalls'),
  unnecessarySubagentCalls: count(value.unnecessarySubagentCalls, 'unnecessarySubagentCalls'),
  unnecessaryClarificationBeforeAction: count(
    value.unnecessaryClarificationBeforeAction,
    'unnecessaryClarificationBeforeAction',
  ),
  verificationDuplicationCount: count(value.verificationDuplicationCount, 'verificationDuplicationCount'),
});

export const captureModelPromptReplayAttempt = ({
  caseId,
  arm,
  order,
  repetition,
  attempt = 1,
  status,
  hostResult,
  evaluation,
}: {
  caseId: string;
  arm: ReplayArm;
  order: number;
  repetition: number;
  attempt?: number;
  status?: ReplayAttemptStatus;
  hostResult: unknown;
  evaluation: ModelPromptReplayEvaluation;
}): Readonly<ModelPromptReplayAttempt> => {
  if (!caseId.trim()) throw new TypeError('caseId is required');
  if (arm !== 'baseline' && arm !== 'candidate') {
    throw new TypeError('arm must be baseline or candidate');
  }
  count(order, 'order');
  positiveCount(repetition, 'repetition');
  positiveCount(attempt, 'attempt');
  const rawReceipt = record(record(hostResult).receipt);
  const rawPromptMeasurement = record(record(hostResult).promptMeasurement);
  const resolvedStatus = resolveAttemptStatus(status, rawReceipt);
  return Object.freeze({
    caseId,
    arm,
    order,
    repetition,
    attempt,
    status: resolvedStatus,
    receipt: Object.keys(rawReceipt).length ? Object.freeze({ ...rawReceipt }) : null,
    promptMeasurement: Object.keys(rawPromptMeasurement).length
      ? Object.freeze({ ...rawPromptMeasurement })
      : null,
    evaluation: Object.freeze(normalizeEvaluation(evaluation, resolvedStatus)),
  });
};

export const dispatchModelPromptReplayAttempt = async ({
  caseId,
  arm,
  order,
  repetition,
  attempt = 1,
  dispatchInput,
  evaluation,
}: {
  caseId: string;
  arm: ReplayArm;
  order: number;
  repetition: number;
  attempt?: number;
  dispatchInput: DispatchInput;
  evaluation: ModelPromptReplayEvaluation;
}): Promise<Readonly<ModelPromptReplayAttempt>> => (
  captureModelPromptReplayAttempt({
    caseId,
    arm,
    order,
    repetition,
    attempt,
    hostResult: await dispatchKernelTurn(dispatchInput),
    evaluation,
  })
);

const identity = (attempt: ModelPromptReplayAttempt) => {
  const receipt = record(attempt.receipt);
  return {
    hostSurface: text(receipt.hostSurface),
    model: [text(receipt.requestedModel), text(receipt.resolvedModel), text(receipt.observedModel)],
    effort: [text(receipt.requestedEffort), text(receipt.resolvedEffort), text(receipt.observedEffort)],
    executionProfileRevision: text(receipt.executionProfileRevision),
    promptPrefixDigest: text(receipt.promptPrefixDigest),
    enforcementStatus: text(receipt.enforcementStatus),
  };
};

const readinessIssue = (attempt: ModelPromptReplayAttempt): string | null => {
  if (!attempt.receipt) return 'host-receipt-missing';
  const value = identity(attempt);
  if (value.enforcementStatus !== 'enforced') return 'host-model-enforcement-not-proven';
  if (value.model.some(part => !part)) return 'host-model-identity-unobserved';
  if (new Set(value.model).size !== 1) return 'host-model-identity-mismatch';
  if (value.effort.some(part => !part)) return 'host-effort-identity-unobserved';
  if (new Set(value.effort).size !== 1) return 'host-effort-identity-mismatch';
  if (!value.executionProfileRevision) return 'execution-profile-revision-missing';
  if (!value.promptPrefixDigest) return 'prompt-prefix-digest-missing';
  return null;
};

const scheduledKey = (attempt: Pick<
  ModelPromptReplayAttempt,
  'caseId' | 'order' | 'arm' | 'repetition'
>): string => `${attempt.caseId}:${attempt.order}:${attempt.arm}:${attempt.repetition}`;

const expectedKeys = (protocol: ReplayProtocol): string[] => protocol.cases.flatMap(testCase => {
  const repetition: Record<ReplayArm, number> = { baseline: 0, candidate: 0 };
  return protocol.execution.armOrder.map((arm, order) => {
    repetition[arm] += 1;
    return `${testCase.id}:${order}:${arm}:${repetition[arm]}`;
  });
});

const coverageIssues = (
  protocol: ReplayProtocol,
  attempts: ModelPromptReplayAttempt[],
): string[] => {
  const issues: string[] = [];
  const expected = expectedKeys(protocol);
  const expectedSet = new Set(expected);
  const firstAttempts = attempts.filter(entry => entry.attempt === 1).map(scheduledKey);
  if (
    firstAttempts.length !== expected.length
    || expected.some((key, index) => key !== firstAttempts[index])
  ) {
    issues.push('attempt-coverage-or-order-mismatch');
  }

  const byRun = new Map<string, number[]>();
  const callsByCase = new Map<string, number>();
  for (const entry of attempts) {
    const key = scheduledKey(entry);
    if (!expectedSet.has(key)) issues.push(`${key}:unexpected-scheduled-run`);
    if (entry.attempt > protocol.execution.maxRetriesPerRun + 1) {
      issues.push(`${key}:retry-budget-exceeded`);
    }
    const sequence = byRun.get(key) || [];
    sequence.push(entry.attempt);
    byRun.set(key, sequence);
    callsByCase.set(entry.caseId, (callsByCase.get(entry.caseId) || 0) + 1);
    if (!protocol.execution.includeIncompleteRuns && entry.status === 'incomplete') {
      issues.push(`${key}:incomplete-run-policy-mismatch`);
    }
  }

  for (const [key, sequence] of byRun.entries()) {
    const ordered = [...sequence].sort((a, b) => a - b);
    if (ordered.some((attempt, index) => attempt !== index + 1)) {
      issues.push(`${key}:attempt-sequence-invalid`);
    }
  }
  for (const [caseId, calls] of callsByCase.entries()) {
    if (calls > protocol.execution.maxProviderCallsPerCase) {
      issues.push(`${caseId}:provider-call-budget-exceeded`);
    }
  }
  return issues;
};

const sameIdentity = (left: ReturnType<typeof identity>, right: ReturnType<typeof identity>): boolean => (
  left.hostSurface === right.hostSurface
  && left.model[2] === right.model[2]
  && left.effort[2] === right.effort[2]
  && left.executionProfileRevision === right.executionProfileRevision
  && left.promptPrefixDigest === right.promptPrefixDigest
);

const driftIssues = (
  attempts: ModelPromptReplayAttempt[],
  allowed: Set<AllowedDifference>,
): string[] => {
  const issues: string[] = [];
  for (const caseId of new Set(attempts.map(attempt => attempt.caseId))) {
    const entries = attempts.filter(attempt => attempt.caseId === caseId);
    for (const arm of ['baseline', 'candidate'] as const) {
      const sameArm = entries.filter(entry => entry.arm === arm);
      const reference = sameArm.find(entry => entry.attempt === 1);
      if (
        reference
        && sameArm.some(entry => !sameIdentity(identity(reference), identity(entry)))
      ) {
        issues.push(`${caseId}:${arm}:attempt-identity-drift`);
      }
    }

    const baseline = entries.find(entry => entry.arm === 'baseline' && entry.attempt === 1);
    const candidate = entries.find(entry => entry.arm === 'candidate' && entry.attempt === 1);
    if (!baseline || !candidate) continue;
    const a = identity(baseline);
    const b = identity(candidate);
    if (a.hostSurface !== b.hostSurface) issues.push(`${caseId}:host-surface-drift`);
    if (!allowed.has('model') && a.model[2] !== b.model[2]) issues.push(`${caseId}:model-drift`);
    if (!allowed.has('effort') && a.effort[2] !== b.effort[2]) issues.push(`${caseId}:effort-drift`);
    if (!allowed.has('promptPrefixDigest') && a.promptPrefixDigest !== b.promptPrefixDigest) {
      issues.push(`${caseId}:prompt-prefix-drift`);
    }
    if (a.executionProfileRevision !== b.executionProfileRevision) {
      issues.push(`${caseId}:execution-profile-drift`);
    }
  }
  return issues;
};

const median = (values: number[]): number | null => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[mid] ?? null
    : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
};

const summarize = (attempts: ModelPromptReplayAttempt[]) => {
  const sum = (pick: (attempt: ModelPromptReplayAttempt) => number) => (
    attempts.reduce((total, attempt) => total + pick(attempt), 0)
  );
  const rate = (pick: (attempt: ModelPromptReplayAttempt) => boolean) => (
    attempts.length ? attempts.filter(pick).length / attempts.length : 0
  );
  const tokens = attempts.map(attempt => {
    const receipt = record(attempt.receipt);
    const input = measure(receipt.inputTokens);
    const output = measure(receipt.outputTokens);
    return input === null || output === null ? null : input + output;
  });
  const latency = attempts.map(attempt => measure(record(attempt.receipt).wallClockMs));
  return Object.freeze({
    attempts: attempts.length,
    retryCount: attempts.filter(attempt => attempt.attempt > 1).length,
    failedAttemptCount: attempts.filter(attempt => attempt.status === 'failed').length,
    incompleteAttemptCount: attempts.filter(attempt => attempt.status === 'incomplete').length,
    taskSuccessRate: rate(attempt => attempt.evaluation.taskSuccess),
    acceptanceRate: rate(attempt => attempt.evaluation.acceptanceSatisfied),
    criticalAuthorityViolationCount: sum(attempt => attempt.evaluation.criticalAuthorityViolationCount),
    scopeViolationCount: sum(attempt => attempt.evaluation.scopeViolationCount),
    hardcodedSolutionCount: sum(attempt => attempt.evaluation.hardcodedSolutionCount),
    fallbackAbstractionGrowthCount: sum(attempt => attempt.evaluation.fallbackAbstractionGrowthCount),
    regressionCount: sum(attempt => attempt.evaluation.regressionCount),
    reworkCount: sum(attempt => attempt.evaluation.reworkCount),
    unnecessaryActionCount: sum(attempt => {
      const value = attempt.evaluation;
      return value.unnecessaryToolCalls
        + value.unnecessarySubagentCalls
        + value.unnecessaryClarificationBeforeAction
        + value.verificationDuplicationCount;
    }),
    medianTotalTokens: tokens.every(value => value !== null) ? median(tokens as number[]) : null,
    medianLatencyMs: latency.every(value => value !== null) ? median(latency as number[]) : null,
  });
};

const relativeDecrease = (baseline: number, candidate: number): number | null => (
  baseline > 0 ? (baseline - candidate) / baseline : null
);

export const compareModelPromptReplay = ({
  protocol,
  attempts,
  experiment = {},
}: {
  protocol: ReplayProtocol;
  attempts: ModelPromptReplayAttempt[];
  experiment?: { allowedDifferences?: AllowedDifference[] };
}) => {
  const issues: string[] = [];
  if (protocol.execution.runsPerArmPerCase !== 2) issues.push('unsupported-runs-per-arm');
  issues.push(...coverageIssues(protocol, attempts));
  for (const attempt of attempts) {
    const issue = readinessIssue(attempt);
    if (issue) {
      issues.push(
        `${attempt.caseId}:${attempt.arm}:${attempt.repetition}:${attempt.attempt}:${issue}`,
      );
    }
  }
  issues.push(...driftIssues(attempts, new Set(experiment.allowedDifferences || [])));

  const baseline = summarize(attempts.filter(attempt => attempt.arm === 'baseline'));
  const candidate = summarize(attempts.filter(attempt => attempt.arm === 'candidate'));
  const base = { baseline, candidate, issues: Object.freeze([...new Set(issues)]) };

  if (issues.length) {
    return Object.freeze({
      ...base,
      status: 'not-ready' as const,
      decision: 'keep-baseline' as const,
      qualityGate: 'not-evaluated' as const,
      reworkGate: 'not-evaluated' as const,
      efficiencyGate: 'not-evaluated' as const,
    });
  }

  const qualityPassed = candidate.taskSuccessRate >= baseline.taskSuccessRate
    && candidate.acceptanceRate >= baseline.acceptanceRate
    && baseline.criticalAuthorityViolationCount <= protocol.gates.criticalAuthorityViolationMax
    && candidate.criticalAuthorityViolationCount <= protocol.gates.criticalAuthorityViolationMax
    && candidate.scopeViolationCount <= baseline.scopeViolationCount
    && candidate.hardcodedSolutionCount <= baseline.hardcodedSolutionCount
    && candidate.fallbackAbstractionGrowthCount <= baseline.fallbackAbstractionGrowthCount;
  if (!qualityPassed) {
    return Object.freeze({
      ...base,
      status: 'rejected-quality' as const,
      decision: 'keep-baseline' as const,
      qualityGate: 'failed' as const,
      reworkGate: 'not-evaluated' as const,
      efficiencyGate: 'not-evaluated' as const,
    });
  }

  if (
    candidate.regressionCount > baseline.regressionCount
    || candidate.reworkCount > baseline.reworkCount
  ) {
    return Object.freeze({
      ...base,
      status: 'rejected-rework' as const,
      decision: 'keep-baseline' as const,
      qualityGate: 'passed' as const,
      reworkGate: 'failed' as const,
      efficiencyGate: 'not-evaluated' as const,
    });
  }

  const efficiencyEvidence = protocol.gates.efficiencyImprovement.anyOf.map(rule => {
    if (rule.metric === 'unnecessaryActionCount') {
      const delta = baseline.unnecessaryActionCount - candidate.unnecessaryActionCount;
      return {
        metric: rule.metric,
        available: true,
        improved: delta >= (rule.absoluteDecreaseAtLeast || 0),
        delta,
      };
    }
    const values = rule.metric === 'totalTokens'
      ? [baseline.medianTotalTokens, candidate.medianTotalTokens]
      : rule.metric === 'latencyMs'
        ? [baseline.medianLatencyMs, candidate.medianLatencyMs]
        : [null, null];
    const available = values.every(value => value !== null);
    const delta = available ? relativeDecrease(values[0] as number, values[1] as number) : null;
    return {
      metric: rule.metric,
      available,
      improved: delta !== null && delta >= (rule.medianRelativeDecreaseAtLeast || 0),
      relativeDecrease: delta,
    };
  });
  const efficiencyPassed = efficiencyEvidence.some(evidence => evidence.improved);
  return Object.freeze({
    ...base,
    status: efficiencyPassed ? 'eligible' as const : 'insufficient-efficiency-evidence' as const,
    decision: efficiencyPassed ? 'candidate-eligible' as const : 'keep-baseline' as const,
    qualityGate: 'passed' as const,
    reworkGate: 'passed' as const,
    efficiencyGate: efficiencyPassed ? 'passed' as const : 'unproven' as const,
    efficiencyEvidence: Object.freeze(efficiencyEvidence),
  });
};
