// Run Step Ledger (K2). Long work is not one atomic act — it is a sequence of
// units with dependencies, retries, and a cursor. Before this, that cursor lived
// only in whatever chat context happened to survive; a restarted process had to
// guess where it was. Here the cursor is state, and the rules that move it are
// pure functions over persisted rows.

export const STEP_STATES = Object.freeze([
  'planned', 'ready', 'running', 'reported', 'verifying',
  'passed', 'failed', 'blocked', 'superseded', 'cancelled',
]);

export const TERMINAL_STEP_STATES = Object.freeze(['passed', 'superseded', 'cancelled']);
export const LIVE_STEP_STATES = Object.freeze(['planned', 'ready', 'running', 'reported', 'verifying', 'failed', 'blocked']);

// A retry returns a failed step to `ready`; a replan supersedes it instead. Both
// are legal, and which one applies is decided by the stagnation signal, never by
// the worker that just failed.
const STEP_TRANSITIONS = Object.freeze({
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

export class RunStepError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'RunStepError';
    this.code = code;
    this.detail = detail;
  }
}

export const canTransitionStep = (from, to) => (STEP_TRANSITIONS[from] || []).includes(to);

export const assertStepTransition = (from, to) => {
  if (!STEP_STATES.includes(to)) throw new RunStepError('STEP_STATE_UNKNOWN', `Unknown run step state: ${to}`);
  if (!canTransitionStep(from, to)) throw new RunStepError('STEP_TRANSITION_INVALID', `Invalid run step transition ${from} -> ${to}`);
  return true;
};

// Dependencies are satisfied only by a PASSED step. Execution history is kept
// on attempts and receipts; it is not a second dependency lifecycle.
export const dependenciesSatisfied = (step, steps = []) => {
  const byId = new Map(steps.map((entry) => [entry.stepId, entry]));
  return (step?.dependencyIds || []).every((dependencyId) => byId.get(dependencyId)?.state === 'passed');
};

export const liveSteps = (steps = [], planRevision = null) => steps.filter((step) => (
  LIVE_STEP_STATES.includes(step.state) && (planRevision === null || step.planRevision === planRevision)
));

// Write sets are compared with the SAME semantics the scope matcher uses:
// separator- and case-insensitive. Comparing them case-sensitively here while
// `matchPathScope()` lowercases would call `src/Auth/**` and `src/auth/**`
// disjoint and let two workers race on the same files.
export const scopesOverlap = (left, right) => {
  const normalize = (value) => String(value || '').replaceAll('\\', '/').toLowerCase().replace(/\/\*+$/, '');
  const a = normalize(left);
  const b = normalize(right);
  if (!a || !b) return true;
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
};

// Selection rule (§7.6). Deterministic: the lowest sequence among the steps that
// are actually runnable now.
export const selectExecutableSteps = (steps = [], {
  planRevision = null,
  parallel = false,
  maxWorkers = 2,
} = {}) => {
  const runnable = steps
    .filter((step) => (planRevision === null || step.planRevision === planRevision))
    .filter((step) => step.state === 'ready' || step.state === 'failed')
    .filter((step) => dependenciesSatisfied(step, steps))
    .sort((a, b) => a.sequence - b.sequence);

  if (runnable.length === 0) return { steps: [], reason: 'no-runnable-step' };
  if (!parallel) return { steps: runnable.slice(0, 1), reason: 'sequential' };

  // Parallel execution is a derived view of the current ledger. It is safe
  // only when the runnable Steps have explicit, disjoint write scopes. There
  // is no persisted batch identity or completion state to reconcile later.
  const selected = [];
  const claimed = [];
  for (const step of runnable) {
    const paths = step.allowedPaths || [];
    if (paths.length === 0 || paths.includes('**')) {
      if (selected.length === 0) selected.push(step);
      break;
    }
    const conflicts = claimed.some((existing) => existing.some((path) => paths.some((candidate) => scopesOverlap(path, candidate))));
    if (conflicts) break;
    claimed.push(paths);
    selected.push(step);
    // The derived batch is capped by the host's transient worker bound;
    // overflow remains in the ledger for the next selection.
    if (selected.length >= maxWorkers) break;
  }
  return {
    steps: selected,
    reason: selected.length > 1 ? 'parallel' : 'parallel-scope-conflict',
  };
};

// Named for the result, not for a lifecycle. Callers may recompute this after
// every receipt or restart without consulting another persisted authority.
export const deriveParallelBatch = (steps = [], options = {}) => selectExecutableSteps(steps, {
  ...options,
  parallel: true,
});

export const currentStep = (steps = [], { planRevision = null } = {}) => {
  const active = steps.find((step) => ['running', 'reported', 'verifying'].includes(step.state)
    && (planRevision === null || step.planRevision === planRevision));
  if (active) return active;
  return selectExecutableSteps(steps, { planRevision }).steps[0] || null;
};

// True only when every step of the current plan revision is done and at least
// one of them actually passed. A run whose steps were all superseded has not
// finished anything.
export const allStepsPassed = (steps = [], planRevision = null) => {
  const scoped = steps.filter((step) => planRevision === null || step.planRevision === planRevision);
  // A run that has steps but none at the current revision has a broken plan,
  // not a finished one — treating that as settled would let a lost replacement
  // step complete the run.
  if (scoped.length === 0) return steps.length === 0;
  return scoped.every((step) => TERMINAL_STEP_STATES.includes(step.state))
    && scoped.some((step) => step.state === 'passed');
};

// What a step must have before it may be called passed (§7.7). Evidence alone is
// not enough: it must be evidence at the CURRENT revision, covering the
// acceptance this step is responsible for.
export const evaluateStepCompletion = ({
  step,
  verifications = [],
  run,
  acceptance = [],
  requiredObligationIds = null,
  changedPaths = [],
} = {}) => {
  const reasons = [];
  const byObligation = new Map(verifications.map((verification) => [verification.obligationId, verification]));

  for (const obligationId of requiredObligationIds || step.obligationIds || []) {
    const verification = byObligation.get(obligationId);
    if (!verification || verification.status !== 'passed') {
      reasons.push(`obligation-unsatisfied:${obligationId}`);
      continue;
    }
    const verifiedMutation = verification.verifiedMutationRevision ?? verification.verifiedRuntimeRevision;
    const hasAuthoritativeScope = Boolean(verification.evidenceIdentity?.values?.verificationScopeDigest);
    // Run-level completion validates a scoped receipt against the current
    // content digest. Its full-workspace mutation revision may legitimately be
    // newer because an unrelated Step changed outside that declared scope.
    // Do not reintroduce the old run-wide staleness gate at the Step boundary.
    if (run && verifiedMutation !== run.mutationRevision && !hasAuthoritativeScope) reasons.push(`obligation-stale:${obligationId}`);
  }

  // Coverage may be declared by acceptance id or by statement, exactly as the
  // run-level completion gate accepts it.
  const covered = new Set(verifications.filter((verification) => verification.status === 'passed').flatMap((verification) => verification.acceptanceCoverage || []));
  const statementOf = new Map(acceptance.map((item) => [item.id, item.statement]));
  for (const acceptanceId of step.acceptanceIds || []) {
    if (covered.has(acceptanceId)) continue;
    if (statementOf.has(acceptanceId) && covered.has(statementOf.get(acceptanceId))) continue;
    reasons.push(`acceptance-uncovered:${acceptanceId}`);
  }

  if (!run?.currentWorkspaceIdentity) reasons.push('workspace-identity-unobserved');

  return { complete: reasons.length === 0, reasons, changedPaths };
};

// Step-scoped stagnation (§7.9). The signal is about ONE unit of work failing
// the same way, which is what a run-wide attempt counter cannot see.
export const detectStepStagnation = ({ step, attempts = [], threshold = 3 } = {}) => {
  const stepAttempts = attempts.filter((attempt) => attempt.stepId === step?.stepId);
  const recent = stepAttempts.slice(-threshold);
  const consecutiveFailures = recent.length >= threshold && recent.every((attempt) => attempt.status === 'failed');

  const workspaceUnchanged = stepAttempts.filter((attempt) => (
    attempt.status === 'failed' && attempt.workspaceIdentityStart && attempt.workspaceIdentityStart === attempt.workspaceIdentityEnd
  )).length >= 2;

  const repeatedResult = (() => {
    const digests = stepAttempts.filter((attempt) => attempt.resultDigest).map((attempt) => attempt.resultDigest);
    return digests.length >= 2 && digests.at(-1) === digests.at(-2);
  })();

  const signals = { consecutiveFailures, workspaceUnchanged, repeatedResult };
  const stagnant = Object.values(signals).some(Boolean);
  return {
    stagnant,
    signals,
    attemptCount: stepAttempts.length,
    // A stagnant step is not retried into the ground: it is replanned, and at
    // T2/T3 by a frontier planner rather than the implementer that is stuck.
    recommendation: stagnant ? 'replan' : 'retry',
  };
};
