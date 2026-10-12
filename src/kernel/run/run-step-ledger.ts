// Run Step Ledger (K2). Long work is a sequence of durable Work Units.
// These rules are provider-free and operate only on persisted Work state.

export const STEP_STATES = [
  'planned', 'ready', 'running', 'reported', 'verifying',
  'passed', 'failed', 'blocked', 'superseded', 'cancelled',
] as const;

export type StepState = typeof STEP_STATES[number];

export const TERMINAL_STEP_STATES = ['passed', 'superseded', 'cancelled'] as const;
export const LIVE_STEP_STATES = ['planned', 'ready', 'running', 'reported', 'verifying', 'failed', 'blocked'] as const;

const STEP_TRANSITIONS: Readonly<Record<StepState, readonly StepState[]>> = Object.freeze({
  planned: ['ready', 'blocked', 'superseded', 'cancelled'],
  ready: ['running', 'blocked', 'superseded', 'cancelled'],
  running: ['reported', 'failed', 'blocked', 'superseded', 'cancelled'],
  reported: ['verifying', 'failed', 'blocked', 'superseded'],
  verifying: ['passed', 'failed', 'blocked', 'superseded'],
  passed: ['superseded'],
  failed: ['ready', 'blocked', 'superseded', 'cancelled'],
  blocked: ['ready', 'superseded', 'cancelled'],
  superseded: [],
  cancelled: [],
});

export interface RunStep {
  stepId: string;
  sequence: number;
  planRevision: number;
  state: StepState;
  objective?: string | null;
  synthetic?: boolean;
  dependencyIds?: string[];
  acceptanceIds?: string[];
  obligationIds?: string[];
  allowedPaths?: string[];
  forbiddenPaths?: string[];
  baseWorkspaceIdentity?: string | null;
  executionWorkspaceId?: string | null;
  [key: string]: unknown;
}

export interface VerificationLike {
  obligationId: string;
  status?: string | null;
  verifiedMutationRevision?: number | null;
  verifiedRuntimeRevision?: number | null;
  acceptanceCoverage?: string[];
  evidenceIdentity?: {
    values?: {
      verificationScopeDigest?: unknown;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  } | null;
}

export interface AcceptanceLike {
  id: string;
  statement: string;
}

export interface RunForStepCompletion {
  mutationRevision?: number | null;
  currentWorkspaceIdentity?: string | null;
}

export interface StepAttemptLike {
  stepId?: string | null;
  status?: string | null;
  workspaceIdentityStart?: string | null;
  workspaceIdentityEnd?: string | null;
  resultDigest?: string | null;
}

export class RunStepError extends Error {
  readonly code: string;
  readonly detail: Record<string, unknown>;

  constructor(code: string, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = 'RunStepError';
    this.code = code;
    this.detail = detail;
  }
}

const isStepState = (value: unknown): value is StepState => (
  typeof value === 'string' && (STEP_STATES as readonly string[]).includes(value)
);

export const canTransitionStep = (from: StepState, to: StepState) => STEP_TRANSITIONS[from].includes(to);

export const assertStepTransition = (from: StepState, to: unknown) => {
  if (!isStepState(to)) throw new RunStepError('STEP_STATE_UNKNOWN', `Unknown run step state: ${String(to)}`);
  if (!canTransitionStep(from, to)) throw new RunStepError('STEP_TRANSITION_INVALID', `Invalid run step transition ${from} -> ${to}`);
  return true;
};

export const dependenciesSatisfied = (step: RunStep, steps: RunStep[] = []) => {
  const byId = new Map(steps.map((entry) => [entry.stepId, entry]));
  return (step.dependencyIds || []).every((dependencyId) => byId.get(dependencyId)?.state === 'passed');
};

export const liveSteps = (steps: RunStep[] = [], planRevision: number | null = null) => steps.filter((step) => (
  (LIVE_STEP_STATES as readonly string[]).includes(step.state)
  && (planRevision === null || step.planRevision === planRevision)
));

export const scopesOverlap = (left: unknown, right: unknown) => {
  const normalize = (value: unknown) => String(value || '').replaceAll('\\', '/').toLowerCase().replace(/\/\*+$/, '');
  const a = normalize(left);
  const b = normalize(right);
  if (!a || !b) return true;
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
};

export interface SelectExecutableStepOptions {
  planRevision?: number | null;
  parallel?: boolean;
  maxWorkers?: number;
}

export const selectExecutableSteps = (
  steps: RunStep[] = [],
  {
    planRevision = null,
    parallel = false,
    maxWorkers = 2,
  }: SelectExecutableStepOptions = {},
) => {
  const runnable = steps
    .filter((step) => planRevision === null || step.planRevision === planRevision)
    .filter((step) => step.state === 'ready' || step.state === 'failed')
    .filter((step) => dependenciesSatisfied(step, steps))
    .sort((a, b) => a.sequence - b.sequence);

  if (runnable.length === 0) return { steps: [] as RunStep[], reason: 'no-runnable-step' };
  if (!parallel) return { steps: runnable.slice(0, 1), reason: 'sequential' };

  const selected: RunStep[] = [];
  const claimed: string[][] = [];
  for (const step of runnable) {
    const paths = step.allowedPaths || [];
    if (paths.length === 0 || paths.includes('**')) {
      if (selected.length === 0) selected.push(step);
      break;
    }
    const conflicts = claimed.some((existing) => (
      existing.some((claimedPath) => paths.some((candidate) => scopesOverlap(claimedPath, candidate)))
    ));
    if (conflicts) break;
    claimed.push(paths);
    selected.push(step);
    if (selected.length >= maxWorkers) break;
  }
  return {
    steps: selected,
    reason: selected.length > 1 ? 'parallel' : 'parallel-scope-conflict',
  };
};

export const deriveParallelBatch = (
  steps: RunStep[] = [],
  options: SelectExecutableStepOptions = {},
) => selectExecutableSteps(steps, { ...options, parallel: true });

export const currentStep = (
  steps: RunStep[] = [],
  { planRevision = null }: Pick<SelectExecutableStepOptions, 'planRevision'> = {},
) => {
  const active = steps.find((step) => ['running', 'reported', 'verifying'].includes(step.state)
    && (planRevision === null || step.planRevision === planRevision));
  if (active) return active;
  return selectExecutableSteps(steps, { planRevision }).steps[0] || null;
};

export const allStepsPassed = (steps: RunStep[] = [], planRevision: number | null = null) => {
  const scoped = steps.filter((step) => planRevision === null || step.planRevision === planRevision);
  if (scoped.length === 0) return steps.length === 0;
  return scoped.every((step) => (TERMINAL_STEP_STATES as readonly string[]).includes(step.state))
    && scoped.some((step) => step.state === 'passed');
};

export interface EvaluateStepCompletionInput {
  step: RunStep;
  verifications?: VerificationLike[];
  run?: RunForStepCompletion | null;
  acceptance?: AcceptanceLike[];
  requiredObligationIds?: string[] | null;
  changedPaths?: string[];
}

export const evaluateStepCompletion = ({
  step,
  verifications = [],
  run = null,
  acceptance = [],
  requiredObligationIds = null,
  changedPaths = [],
}: EvaluateStepCompletionInput) => {
  const reasons: string[] = [];
  const byObligation = new Map(verifications.map((verification) => [verification.obligationId, verification]));

  for (const obligationId of requiredObligationIds || step.obligationIds || []) {
    const verification = byObligation.get(obligationId);
    if (!verification || verification.status !== 'passed') {
      reasons.push(`obligation-unsatisfied:${obligationId}`);
      continue;
    }
    const verifiedMutation = verification.verifiedMutationRevision ?? verification.verifiedRuntimeRevision;
    const hasAuthoritativeScope = Boolean(verification.evidenceIdentity?.values?.verificationScopeDigest);
    if (run && verifiedMutation !== run.mutationRevision && !hasAuthoritativeScope) {
      reasons.push(`obligation-stale:${obligationId}`);
    }
  }

  const covered = new Set(
    verifications
      .filter((verification) => verification.status === 'passed')
      .flatMap((verification) => verification.acceptanceCoverage || []),
  );
  const statementOf = new Map(acceptance.map((item) => [item.id, item.statement]));
  for (const acceptanceId of step.acceptanceIds || []) {
    if (covered.has(acceptanceId)) continue;
    const statement = statementOf.get(acceptanceId);
    if (statement && covered.has(statement)) continue;
    reasons.push(`acceptance-uncovered:${acceptanceId}`);
  }

  if (!run?.currentWorkspaceIdentity) reasons.push('workspace-identity-unobserved');
  return { complete: reasons.length === 0, reasons, changedPaths };
};

export interface DetectStepStagnationInput {
  step?: Pick<RunStep, 'stepId'> | null;
  attempts?: StepAttemptLike[];
  threshold?: number;
}

export const detectStepStagnation = ({
  step = null,
  attempts = [],
  threshold = 3,
}: DetectStepStagnationInput = {}) => {
  const stepAttempts = attempts.filter((attempt) => attempt.stepId === step?.stepId);
  const recent = stepAttempts.slice(-threshold);
  const consecutiveFailures = recent.length >= threshold && recent.every((attempt) => attempt.status === 'failed');

  const workspaceUnchanged = stepAttempts.filter((attempt) => (
    attempt.status === 'failed'
    && Boolean(attempt.workspaceIdentityStart)
    && attempt.workspaceIdentityStart === attempt.workspaceIdentityEnd
  )).length >= 2;

  const repeatedResult = (() => {
    const digests = stepAttempts
      .map((attempt) => attempt.resultDigest)
      .filter((digest): digest is string => Boolean(digest));
    return digests.length >= 2 && digests.at(-1) === digests.at(-2);
  })();

  const signals = { consecutiveFailures, workspaceUnchanged, repeatedResult };
  const stagnant = Object.values(signals).some(Boolean);
  return {
    stagnant,
    signals,
    attemptCount: stepAttempts.length,
    recommendation: stagnant ? 'replan' : 'retry',
  };
};
