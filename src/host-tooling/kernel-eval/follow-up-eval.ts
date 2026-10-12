import { createHash } from 'node:crypto';
import path from 'node:path';

type UnknownRecord = Record<string, unknown>;

export type FollowUpStrategy = 'verify-only' | 'always' | 'adaptive';
export type FollowUpStage = 'F1' | 'F2' | 'F3';
export type FollowUpAttemptStatus = 'completed' | 'failed' | 'incomplete';

export interface FollowUpProtocol {
  schemaVersion: number;
  protocolRevision: string;
  taskSetRevision: string;
  strategies: FollowUpStrategy[];
  stageOrder: FollowUpStage[];
  executionConditions: {
    conditionSource: string;
    requireEqual: string[];
  };
  isolation: {
    requiredMode: 'enforced';
    sameWorkspaceHiddenFilesAllowed: false;
    actorVisibleRootsMustExcludeEvaluatorHiddenRoot: true;
  };
  attemptBudget: {
    maxAttemptsPerStage: number;
    includeFailedAndIncomplete: true;
  };
  stopConditions: {
    criticalAuthorityViolation: 'halt';
    scopeViolation: 'halt';
    taskBindingMismatch: 'halt';
    sourceRevisionMismatch: 'halt';
    isolationFailure: 'not_ready';
    attemptBudgetExceeded: 'halt';
  };
  costContract: {
    aggregateScoreAllowed: false;
    units: string[];
    unavailableUsageRule: string;
  };
  f1Snapshot: {
    revision: string;
    workspaceSeed: Record<string, string>;
    task: {
      objective: string;
      acceptance: string[];
      allowedPaths: string[];
      requiredVerification: string[];
    };
  };
}

export interface FollowUpBinding {
  taskId: string;
  sourceRevision: string;
  f1SnapshotRevision: string;
}

export interface BlindIsolationEvidence {
  mode: 'enforced' | 'advisory' | 'none';
  mechanism: string;
  actorWorkspaceRoot: string;
  evaluatorHiddenRoot: string;
  actorVisibleRoots: string[];
}

export interface StageFreezeReceipt {
  taskId: string;
  sourceRevision: string;
  stage: FollowUpStage;
  snapshotRevision: string;
  snapshotDigest: string;
  status: 'frozen';
}

export interface FollowUpAttempt {
  caseId: string;
  strategy: FollowUpStrategy;
  stage: FollowUpStage;
  taskId: string;
  sourceRevision: string;
  attempt: number;
  status: FollowUpAttemptStatus;
  correctness: boolean | null;
  acceptanceSatisfied: boolean | null;
  scopeViolationCount: number;
  criticalAuthorityViolationCount: number;
  wallTimeMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  cachedTokens: number | null;
  changedFiles: number;
  changedLines: number;
  reworkCount: number;
  verificationTimeMs: number;
  humanInterventionCount: number;
}

const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as UnknownRecord)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableValue(entry)]),
  );
};

const stableJson = (value: unknown): string => JSON.stringify(stableValue(value));

export const digestFollowUpValue = (value: unknown): string => (
  `sha256:${createHash('sha256').update(stableJson(value)).digest('hex')}`
);

const normalizeRoot = (value: string): string => path.resolve(value);

const rootContains = (root: string, candidate: string): boolean => {
  const normalizedRoot = normalizeRoot(root);
  const normalizedCandidate = normalizeRoot(candidate);
  const relative = path.relative(normalizedRoot, normalizedCandidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

export const assessBlindIsolation = ({
  evidence,
}: {
  evidence: BlindIsolationEvidence;
}) => {
  const reasons: string[] = [];
  const actorRoot = normalizeRoot(evidence.actorWorkspaceRoot);
  const hiddenRoot = normalizeRoot(evidence.evaluatorHiddenRoot);
  const visibleRoots = evidence.actorVisibleRoots.map(normalizeRoot);

  if (evidence.mode !== 'enforced') reasons.push('filesystem-isolation-not-enforced');
  if (!evidence.mechanism.trim()) reasons.push('isolation-mechanism-missing');
  if (!visibleRoots.some((root) => rootContains(root, actorRoot))) {
    reasons.push('actor-workspace-not-visible');
  }
  if (visibleRoots.some((root) => rootContains(root, hiddenRoot))) {
    reasons.push('hidden-root-visible-to-actor');
  }
  if (rootContains(actorRoot, hiddenRoot)) {
    reasons.push('same-workspace-hidden-files');
  }

  return {
    status: reasons.length === 0 ? 'ready' as const : 'not_ready' as const,
    reasons,
    boundary: {
      actorWorkspaceRoot: actorRoot,
      evaluatorHiddenRoot: hiddenRoot,
      actorVisibleRoots: visibleRoots,
      mechanism: evidence.mechanism,
    },
  };
};

export const buildF1ActorPackage = ({
  protocol,
  strategy,
  binding,
  isolationEvidence,
}: {
  protocol: FollowUpProtocol;
  strategy: FollowUpStrategy;
  binding: FollowUpBinding;
  isolationEvidence: BlindIsolationEvidence;
}) => {
  const isolation = assessBlindIsolation({ evidence: isolationEvidence });
  const reasons = [...isolation.reasons];

  if (!protocol.strategies.includes(strategy)) reasons.push('strategy-not-in-protocol');
  if (binding.f1SnapshotRevision !== protocol.f1Snapshot.revision) {
    reasons.push('f1-snapshot-revision-mismatch');
  }
  if (!binding.taskId) reasons.push('task-binding-missing');
  if (!binding.sourceRevision) reasons.push('source-revision-missing');

  if (reasons.length > 0) {
    return {
      status: 'not_ready' as const,
      reasons: [...new Set(reasons)],
      actorPackage: null,
    };
  }

  return {
    status: 'ready' as const,
    reasons: [],
    actorPackage: {
      schemaVersion: 1,
      protocolRevision: protocol.protocolRevision,
      taskSetRevision: protocol.taskSetRevision,
      strategy,
      stage: 'F1' as const,
      binding: {
        taskId: binding.taskId,
        sourceRevision: binding.sourceRevision,
        f1SnapshotRevision: binding.f1SnapshotRevision,
      },
      executionConditions: protocol.executionConditions,
      attemptBudget: protocol.attemptBudget,
      stopConditions: protocol.stopConditions,
      f1Snapshot: protocol.f1Snapshot,
      f1SnapshotDigest: digestFollowUpValue(protocol.f1Snapshot),
      isolation: {
        mode: 'enforced' as const,
        mechanism: isolation.boundary.mechanism,
        actorWorkspaceRoot: isolation.boundary.actorWorkspaceRoot,
        actorVisibleRoots: isolation.boundary.actorVisibleRoots,
      },
    },
  };
};

export const auditHiddenExposure = ({
  hiddenNeedles,
  surfaces,
}: {
  hiddenNeedles: string[];
  surfaces: Record<'prompt' | 'knowledge' | 'fileSearch' | 'logs' | 'actorPackage', unknown>;
}) => {
  const findings: Array<{ surface: string; needle: string }> = [];
  for (const [surface, value] of Object.entries(surfaces)) {
    const serialized = stableJson(value).toLowerCase();
    for (const needle of hiddenNeedles.filter(Boolean)) {
      if (serialized.includes(needle.toLowerCase())) {
        findings.push({ surface, needle });
      }
    }
  }
  return {
    status: findings.length === 0 ? 'passed' as const : 'failed' as const,
    findings,
  };
};

export const freezeFollowUpStage = ({
  binding,
  stage,
  snapshotRevision,
  snapshot,
}: {
  binding: Pick<FollowUpBinding, 'taskId' | 'sourceRevision'>;
  stage: FollowUpStage;
  snapshotRevision: string;
  snapshot: unknown;
}): StageFreezeReceipt => ({
  taskId: binding.taskId,
  sourceRevision: binding.sourceRevision,
  stage,
  snapshotRevision,
  snapshotDigest: digestFollowUpValue(snapshot),
  status: 'frozen',
});

const previousStage = (stage: FollowUpStage): FollowUpStage | null => {
  if (stage === 'F2') return 'F1';
  if (stage === 'F3') return 'F2';
  return null;
};

export const revealFollowUp = ({
  stage,
  hiddenInput,
  binding,
  priorFreeze,
}: {
  stage: Exclude<FollowUpStage, 'F1'>;
  hiddenInput: unknown;
  binding: Pick<FollowUpBinding, 'taskId' | 'sourceRevision'>;
  priorFreeze: StageFreezeReceipt;
}) => {
  const reasons: string[] = [];
  const requiredPrior = previousStage(stage);

  if (priorFreeze.status !== 'frozen') reasons.push('prior-stage-not-frozen');
  if (priorFreeze.stage !== requiredPrior) reasons.push('reveal-order-invalid');
  if (priorFreeze.taskId !== binding.taskId) reasons.push('task-binding-mismatch');
  if (priorFreeze.sourceRevision !== binding.sourceRevision) {
    reasons.push('source-revision-mismatch');
  }

  return reasons.length > 0
    ? { status: 'blocked' as const, reasons, reveal: null }
    : {
        status: 'revealed' as const,
        reasons: [],
        reveal: {
          stage,
          input: hiddenInput,
          priorSnapshotDigest: priorFreeze.snapshotDigest,
        },
      };
};

export const evaluateAttemptStop = ({
  protocol,
  attempt,
  expectedBinding,
}: {
  protocol: FollowUpProtocol;
  attempt: FollowUpAttempt;
  expectedBinding: Pick<FollowUpBinding, 'taskId' | 'sourceRevision'>;
}) => {
  const reasons: string[] = [];
  if (attempt.taskId !== expectedBinding.taskId) reasons.push('task-binding-mismatch');
  if (attempt.sourceRevision !== expectedBinding.sourceRevision) {
    reasons.push('source-revision-mismatch');
  }
  if (attempt.criticalAuthorityViolationCount > 0) {
    reasons.push('critical-authority-violation');
  }
  if (attempt.scopeViolationCount > 0) reasons.push('scope-violation');
  if (attempt.attempt > protocol.attemptBudget.maxAttemptsPerStage) {
    reasons.push('attempt-budget-exceeded');
  }
  return {
    decision: reasons.length > 0 ? 'halt' as const : 'continue' as const,
    reasons,
  };
};

const sum = (attempts: FollowUpAttempt[], key: keyof FollowUpAttempt): number => (
  attempts.reduce((total, attempt) => {
    const value = attempt[key];
    return total + (typeof value === 'number' ? value : 0);
  }, 0)
);

const actualUsage = (
  attempts: FollowUpAttempt[],
  key: 'inputTokens' | 'outputTokens' | 'reasoningTokens' | 'cachedTokens',
) => {
  const values = attempts.map((attempt) => attempt[key]);
  return values.some((value) => value === null)
    ? {
        status: 'unavailable' as const,
        value: null,
        reason: 'one-or-more-attempts-missing-provider-usage',
      }
    : {
        status: 'available' as const,
        value: values.reduce<number>((total, value) => total + Number(value), 0),
      };
};

export const aggregateFollowUpDryRun = ({
  protocol,
  attempts,
}: {
  protocol: FollowUpProtocol;
  attempts: FollowUpAttempt[];
}) => {
  const groups = new Map<string, FollowUpAttempt[]>();
  for (const attempt of attempts) {
    const key = `${attempt.caseId}::${attempt.strategy}`;
    const current = groups.get(key) || [];
    current.push(attempt);
    groups.set(key, current);
  }

  const results = [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entries]) => {
      const [caseId, strategy] = key.split('::') as [string, FollowUpStrategy];
      const failed = entries.filter((entry) => entry.status === 'failed').length;
      const incomplete = entries.filter((entry) => entry.status === 'incomplete').length;
      return {
        caseId,
        strategy,
        attemptCount: entries.length,
        completedCount: entries.filter((entry) => entry.status === 'completed').length,
        failedCount: failed,
        incompleteCount: incomplete,
        allAttemptsIncluded: entries.length === (
          entries.filter((entry) => (
            entry.status === 'completed'
            || entry.status === 'failed'
            || entry.status === 'incomplete'
          )).length
        ),
        correctnessPass: entries.every((entry) => (
          entry.status === 'completed'
          && entry.correctness === true
          && entry.acceptanceSatisfied === true
          && entry.scopeViolationCount === 0
          && entry.criticalAuthorityViolationCount === 0
        )),
        costs: {
          wallTimeMs: sum(entries, 'wallTimeMs'),
          inputTokens: actualUsage(entries, 'inputTokens'),
          outputTokens: actualUsage(entries, 'outputTokens'),
          reasoningTokens: actualUsage(entries, 'reasoningTokens'),
          cachedTokens: actualUsage(entries, 'cachedTokens'),
          changedFiles: sum(entries, 'changedFiles'),
          changedLines: sum(entries, 'changedLines'),
          reworkCount: sum(entries, 'reworkCount'),
          verificationTimeMs: sum(entries, 'verificationTimeMs'),
          humanInterventionCount: sum(entries, 'humanInterventionCount'),
          failureCount: failed,
          incompleteCount: incomplete,
        },
      };
    });

  return {
    schemaVersion: 1,
    protocolRevision: protocol.protocolRevision,
    aggregateScore: null,
    aggregateScoreAllowed: protocol.costContract.aggregateScoreAllowed,
    attemptCount: attempts.length,
    results,
  };
};
