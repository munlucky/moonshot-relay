// Host review readiness (Wave R4).
//
// This is a derived preflight view. It does not create a Run, acquire a
// mutation lock, open an attempt, or persist a receipt. The caller uses it to
// decide whether the existing Host dispatcher can take the current Run all the
// way through an independent review and Kernel-owned receipt.

import { resolveClaudeEffort } from './claude-effort-policy.js';
import { resolveCodexModelPolicy } from './codex-model-policy.js';
import { resolveOptimizationModes } from './provider-prompt-policy.js';

type UnknownRecord = Record<string, unknown>;

interface RunLike extends UnknownRecord {
  taskContract?: UnknownRecord | null;
  independentReviewRequired?: unknown;
  projectMode?: unknown;
  runStartWorkspaceIdentity?: unknown;
  currentWorkspaceIdentity?: unknown;
  proofTier?: unknown;
}

interface ActionLike extends UnknownRecord {
  type?: unknown;
  independentReviewRequired?: unknown;
}

interface ModelInputLike extends UnknownRecord {
  action?: ActionLike | null;
}

interface ObligationLike extends UnknownRecord {
  evidenceClass?: unknown;
  protected?: unknown;
  obligationId?: unknown;
  independentReviewRequired?: unknown;
  status?: unknown;
  allowedCommandRefs?: unknown;
}

interface VerificationLike extends UnknownRecord {
  status?: unknown;
  obligationId?: unknown;
}

interface AdapterCapabilities extends UnknownRecord {
  surface?: unknown;
  supportsReadOnlyReview?: unknown;
  supportsIndependentContext?: unknown;
}

interface AdapterLike extends UnknownRecord {
  capabilities?: AdapterCapabilities | null;
  surface?: unknown;
  nativeDelegationAvailable?: unknown;
  dispatch?: unknown;
}

interface RegistryResolution {
  model?: unknown;
  effort?: unknown;
  source?: unknown;
}

interface RegistryLike {
  surface?: unknown;
  resolveExecutionClass?: ((executionClass: string) => RegistryResolution | null) | null;
  resolve?: ((modelClass: string) => RegistryResolution | null) | null;
}

interface ControlPlaneLike {
  ingestReviewerOutcome?: unknown;
}

interface WorkspaceBaselineLike extends UnknownRecord {
  status?: unknown;
  reason?: unknown;
}

interface VerificationCommandLike extends UnknownRecord {
  commandRef?: unknown;
}

interface PermissionLike extends UnknownRecord {
  filesystem?: unknown;
}

export const REVIEW_READINESS_SCHEMA_VERSION = 1;
export const REVIEW_READINESS_STATUSES = Object.freeze([
  'READY',
  'DEGRADED',
  'BLOCKED',
] as const);

const isObject = (value: unknown): value is UnknownRecord => Boolean(
  value && typeof value === 'object' && !Array.isArray(value),
);

const present = (value: unknown): boolean => (
  value !== null
  && value !== undefined
  && String(value).trim() !== ''
);

const list = (value: unknown): unknown[] => (
  Array.isArray(value) ? value : []
);

const recordList = (value: unknown): UnknownRecord[] => (
  list(value).filter(isObject)
);

const obligationNeedsIndependentReview = (
  obligation: ObligationLike = {},
): boolean => Boolean(
  obligation.evidenceClass === 'judgment'
  || obligation.protected === true
  || obligation.independentReviewRequired === true
);

export const reviewRequiredForRun = ({
  run = null,
  modelInput = null,
  obligations = [],
  verifications = [],
}: {
  run?: RunLike | null;
  modelInput?: ModelInputLike | null;
  obligations?: ObligationLike[];
  verifications?: VerificationLike[];
} = {}): boolean => {
  const action = modelInput?.action || {};
  if (action.type === 'review') return true;

  const passedObligations = new Set(
    verifications
      .filter(
        (verification) => (
          String(verification.status || '').toLowerCase() === 'passed'
        ),
      )
      .map((verification) => String(verification.obligationId)),
  );
  const reviewObligations = obligations.filter(
    obligationNeedsIndependentReview,
  );
  const pendingReviewObligation = reviewObligations.some(
    (obligation) => (
      obligationNeedsIndependentReview(obligation)
      && String(obligation.status || '').toLowerCase() !== 'passed'
      && !passedObligations.has(String(obligation.obligationId))
    ),
  );

  const flags = isObject(run?.taskContract?.flags)
    ? run.taskContract.flags
    : {};
  const explicitlyRequested = Boolean(
    action.independentReviewRequired === true
    || run?.independentReviewRequired === true
    || flags.independentReviewRequired === true
    || flags.reviewRequired === true
    || run?.taskContract?.independentReview === true
  );
  if (explicitlyRequested) {
    return reviewObligations.length === 0 || pendingReviewObligation;
  }
  return pendingReviewObligation;
};

const resolveReviewModelAndEffort = ({
  adapter = null,
  registry = null,
  riskTier = 'T3',
  actionKind = 'review_engineering',
  env = process.env,
}: {
  adapter?: AdapterLike | null;
  registry?: RegistryLike | null;
  riskTier?: unknown;
  actionKind?: string;
  env?: NodeJS.ProcessEnv;
} = {}) => {
  const surface = String(
    adapter?.capabilities?.surface
    || adapter?.surface
    || registry?.surface
    || '',
  ).toLowerCase();

  let registryResolution: RegistryResolution | null = null;
  try {
    registryResolution = typeof registry?.resolveExecutionClass === 'function'
      ? registry.resolveExecutionClass('review')
      : typeof registry?.resolve === 'function'
        ? registry.resolve('frontier_reasoning')
        : null;
  } catch {
    registryResolution = null;
  }

  const modes = resolveOptimizationModes(env);
  const codexPolicy = surface === 'codex'
    && modes.codexModelPolicyMode === 'on'
    ? resolveCodexModelPolicy({
        executionClass: 'review',
        actionKind,
      })
    : null;
  const claudePolicy = surface === 'claude'
    ? resolveClaudeEffort({
        actionKind,
        riskTier: String(riskTier || 'T3'),
      })
    : null;
  const policyEnabled = surface === 'codex'
    ? modes.codexModelPolicyMode === 'on'
    : surface === 'claude'
      ? modes.modelPolicyMode === 'on'
      : false;
  const invocationOverride = (
    registryResolution?.source === 'invocation-override'
  );
  const appliedPolicyModel = !invocationOverride && policyEnabled
    ? codexPolicy?.model || null
    : null;
  const appliedPolicyEffort = !invocationOverride && policyEnabled
    ? codexPolicy?.effort || claudePolicy?.effort || null
    : null;
  const model = appliedPolicyModel || registryResolution?.model || null;
  const effort = appliedPolicyEffort || registryResolution?.effort || null;

  return {
    surface: surface || null,
    model,
    effort,
    source: registryResolution?.model && !appliedPolicyModel
      ? registryResolution.source || 'registry'
      : appliedPolicyModel
        ? 'codex-model-policy'
        : null,
    registryResolution,
    policy: codexPolicy || claudePolicy || null,
    policyEnabled,
  };
};

const baselineCheck = ({
  run = null,
  workspaceBaseline = null,
}: {
  run?: RunLike | null;
  workspaceBaseline?: WorkspaceBaselineLike | null;
} = {}) => {
  if (
    workspaceBaseline
    && typeof workspaceBaseline.status === 'string'
  ) {
    const status = workspaceBaseline.status.toLowerCase();
    return {
      status: ['captured', 'ready', 'not-applicable'].includes(status)
        ? 'ready'
        : status === 'blocked'
          ? 'blocked'
          : 'unknown',
      reason: workspaceBaseline.reason || workspaceBaseline.status,
    };
  }
  if (run?.projectMode === 'greenfield') {
    return {
      status: 'ready',
      reason: 'greenfield-not-applicable',
    };
  }
  if (
    present(run?.runStartWorkspaceIdentity)
    && present(run?.currentWorkspaceIdentity)
  ) {
    return {
      status: 'ready',
      reason: 'run-start-and-current-identities-present',
    };
  }
  return {
    status: 'unknown',
    reason: 'workspace-baseline-not-observed-by-readiness',
  };
};

const verificationCheck = ({
  obligations = [],
  verificationCommands = null,
}: {
  obligations?: ObligationLike[];
  verificationCommands?: unknown[] | null;
} = {}) => {
  if (
    verificationCommands === null
    || verificationCommands === undefined
  ) {
    return {
      status: 'unknown',
      reason: 'verification-command-catalog-not-supplied',
    };
  }

  const commands = verificationCommands;
  const hardObligations = obligations.filter(
    (obligation) => obligation.evidenceClass === 'hard',
  );
  const commandRefs = new Set(
    commands.map((command) => (
      isObject(command)
        ? String((command as VerificationCommandLike).commandRef || '')
        : String(command || '')
    )),
  );
  const missing = hardObligations
    .filter(
      (obligation) => list(obligation.allowedCommandRefs).length > 0,
    )
    .filter(
      (obligation) => !list(obligation.allowedCommandRefs).some(
        (commandRef) => commandRefs.has(String(commandRef)),
      ),
    )
    .map((obligation) => obligation.obligationId);

  return missing.length > 0
    ? {
        status: 'blocked',
        reason: 'required-verification-command-missing',
        missing,
      }
    : {
        status: 'ready',
        reason: 'required-verification-commands-visible',
      };
};

export const assessReviewReadiness = ({
  run = null,
  contract = run?.taskContract || null,
  modelInput = null,
  obligations = [],
  adapter = null,
  registry = null,
  controlPlane = null,
  verifications = [],
  receiptAttestationAvailable = null,
  reviewExecutionAvailable = null,
  reviewModelAvailable = null,
  reviewReadOnlyAvailable = null,
  reviewIndependentContextAvailable = null,
  workspaceBaseline = null,
  verificationCommands = null,
  permission = null,
  implementationOnly = false,
  env = process.env,
}: {
  run?: (RunLike | null) | undefined;
  contract?: (UnknownRecord | null) | undefined;
  modelInput?: (ModelInputLike | null) | undefined;
  obligations?: (ObligationLike[]) | undefined;
  adapter?: AdapterLike | null;
  registry?: RegistryLike | null;
  controlPlane?: ControlPlaneLike | null;
  verifications?: (VerificationLike[]) | undefined;
  receiptAttestationAvailable?: boolean | null;
  reviewExecutionAvailable?: boolean | null;
  reviewModelAvailable?: boolean | null;
  reviewReadOnlyAvailable?: boolean | null;
  reviewIndependentContextAvailable?: boolean | null;
  workspaceBaseline?: (WorkspaceBaselineLike | null) | undefined;
  verificationCommands?: (unknown[] | null) | undefined;
  permission?: PermissionLike | boolean | null;
  implementationOnly?: boolean;
  env?: NodeJS.ProcessEnv;
} = {}) => {
  const action = modelInput?.action || {};
  const reviewRequired = reviewRequiredForRun({
    run,
    modelInput,
    obligations,
    verifications,
  });
  const contractReady = isObject(contract)
    && (
      present(contract.objective)
      || list(contract.acceptance).length > 0
      || list(contract.steps).length > 0
    );
  const baseline = baselineCheck({ run, workspaceBaseline });
  const verification = verificationCheck({
    obligations,
    verificationCommands,
  });
  const modelRoute = resolveReviewModelAndEffort({
    adapter,
    registry,
    riskTier: run?.proofTier || 'T3',
    env,
  });

  const executionAvailable = (
    reviewExecutionAvailable === null
    || reviewExecutionAvailable === undefined
  )
    ? Boolean(
        adapter?.nativeDelegationAvailable === true
        && typeof adapter?.dispatch === 'function',
      )
    : reviewExecutionAvailable === true;

  const modelAvailable = (
    reviewModelAvailable === null
    || reviewModelAvailable === undefined
  )
    ? Boolean(
        present(modelRoute.model)
        && present(modelRoute.effort),
      )
    : reviewModelAvailable === true;

  const readOnlyAvailable = (
    reviewReadOnlyAvailable === null
    || reviewReadOnlyAvailable === undefined
  )
    ? adapter?.capabilities?.supportsReadOnlyReview === true
    : reviewReadOnlyAvailable === true;

  const independentContextAvailable = (
    reviewIndependentContextAvailable === null
    || reviewIndependentContextAvailable === undefined
  )
    ? adapter?.capabilities?.supportsIndependentContext === true
    : reviewIndependentContextAvailable === true;

  const receiptAvailable = (
    receiptAttestationAvailable === null
    || receiptAttestationAvailable === undefined
  )
    ? Boolean(
        typeof controlPlane?.ingestReviewerOutcome === 'function',
      )
    : receiptAttestationAvailable === true;

  const permissionReady = (
    permission === null
    || permission === undefined
  )
    ? true
    : permission === true
      || (
        isObject(permission)
        && permission.filesystem === 'read_only'
      );

  const blockers: string[] = [];
  const degraded: string[] = [];
  if (!contractReady) blockers.push('contract-unavailable');
  if (baseline.status === 'blocked') {
    blockers.push(`workspace-baseline:${String(baseline.reason)}`);
  }
  if (verification.status === 'blocked') {
    blockers.push(`verification:${String(verification.reason)}`);
  }
  if (!permissionReady) {
    blockers.push('review-permission-not-read-only');
  }

  const review = {
    required: reviewRequired,
    reviewExecutionAvailable: reviewRequired
      ? executionAvailable
      : null,
    reviewReceiptAttestationAvailable: reviewRequired
      ? receiptAvailable
      : null,
    reviewModelAvailable: reviewRequired
      ? modelAvailable
      : null,
    reviewReadOnlyAvailable: reviewRequired
      ? readOnlyAvailable
      : null,
    reviewIndependentContextAvailable: reviewRequired
      ? independentContextAvailable
      : null,
    model: reviewRequired ? modelRoute.model : null,
    effort: reviewRequired ? modelRoute.effort : null,
    modelSource: reviewRequired ? modelRoute.source : null,
  };

  const completionBlockers: string[] = [];
  if (reviewRequired) {
    if (!executionAvailable) {
      completionBlockers.push('review-execution-unavailable');
    }
    if (!modelAvailable) {
      completionBlockers.push('review-model-or-effort-unavailable');
    }
    if (!readOnlyAvailable) {
      completionBlockers.push('review-read-only-unavailable');
    }
    if (!independentContextAvailable) {
      completionBlockers.push('review-independent-context-unavailable');
    }
    if (!receiptAvailable) {
      degraded.push('review-receipt-attestation-unavailable');
    }
  }

  const currentWorkIsReview = action.type === 'review';
  const status = (
    blockers.length > 0
    || (
      currentWorkIsReview
      && completionBlockers.length > 0
    )
  )
    ? 'BLOCKED'
    : degraded.length > 0 || completionBlockers.length > 0
      ? 'DEGRADED'
      : 'READY';
  const canComplete = status === 'READY';
  const canExecuteCurrentWork = (
    status !== 'BLOCKED'
    && (
      !currentWorkIsReview
      || completionBlockers.length === 0
    )
  );
  const canStartMutation = (
    canExecuteCurrentWork
    && (
      canComplete
      || implementationOnly === true
    )
  );

  return Object.freeze({
    schemaVersion: REVIEW_READINESS_SCHEMA_VERSION,
    status,
    canStartMutation,
    canExecuteCurrentWork,
    canComplete,
    canCompleteGoal: canComplete,
    review,
    checks: {
      contract: {
        status: contractReady ? 'ready' : 'blocked',
        reason: contractReady
          ? 'contract-present'
          : 'contract-unavailable',
      },
      workspaceBaseline: baseline,
      verificationCommands: verification,
      permission: {
        status: permissionReady ? 'ready' : 'blocked',
        reason: permissionReady
          ? 'read-only-review-permission'
          : 'review-permission-not-read-only',
      },
    },
    blockers: Object.freeze([
      ...new Set([...blockers, ...completionBlockers]),
    ]),
    executionBlockers: Object.freeze([
      ...new Set(blockers),
    ]),
    completionBlockers: Object.freeze([
      ...new Set(completionBlockers),
    ]),
    degraded: Object.freeze([
      ...new Set(degraded),
    ]),
    implementationOnly: implementationOnly === true,
    nextAction: status === 'READY'
      ? 'continue'
      : (
          status === 'DEGRADED'
          && implementationOnly === true
          && canExecuteCurrentWork
        )
        ? 'continue-with-degraded-review'
        : 'stop-before-mutation',
  });
};
