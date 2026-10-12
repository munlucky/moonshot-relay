// Claude Host adapter (§11.1). Maps an explicitly delegated Kernel role onto a
// Claude subagent and injects the model id from the Host registry. Ordinary
// work remains in the current native owner surface.

import { isNativeDelegationRequested } from '../codex-actor-router.js';
import {
  buildModelVisiblePromptMessage,
  buildModelVisiblePromptView,
} from '../model-capsule-view.js';

type UnknownRecord = Record<string, unknown>;
type ClaudeRole = keyof typeof CLAUDE_AGENT_FOR_ROLE;
type Launcher = (request: UnknownRecord) => unknown | Promise<unknown>;

interface ClaudeDecision extends UnknownRecord {
  role: string;
  permissions?: unknown;
  independentContextRequired?: unknown;
}

interface ClaudeResolution extends UnknownRecord {
  model?: unknown;
  effort?: unknown;
}

interface ClaudeCapabilities extends UnknownRecord {}

interface ClaudeDispatchInput extends UnknownRecord {
  decision: ClaudeDecision;
  resolution: ClaudeResolution;
  strategy?: unknown;
  executionCapsule?: unknown;
  modelInput?: unknown;
  executionContract?: unknown;
  envelope?: unknown;
  workingDirectory?: unknown;
  environment?: unknown;
  parentSessionId?: unknown;
  concurrencyGroup?: unknown;
  childSession?: unknown;
  executionMode?: unknown;
  delegationRequested?: boolean;
  actionContext?: unknown;
}

interface ClaudeAdapterInput {
  launch?: Launcher | null;
  capabilities?: ClaudeCapabilities;
}

export const CLAUDE_AGENT_FOR_ROLE = Object.freeze({
  planner: 'kernel-planner',
  implementer: 'kernel-implementer',
  reviewer: 'kernel-reviewer',
} as const);

export const CLAUDE_CAPABILITIES = Object.freeze({
  surface: 'claude',
  supportsSubagentModel: true,
  supportsSessionModelOverride: false,
  supportsIndependentContext: false,
  supportsCrossSurfaceReview: false,
  supportsReadOnlyReview: true,
  supportsUsageTokens: true,
  supportsResolvedModelIdentity: true,
  supportsPromptCache: true,
  supportsExplicitCacheBreakpoints: true,
  supportsCacheReadTokens: true,
  supportsCacheWriteTokens: true,
  supportsSessionContinuation: true,
  supportsPersistedReasoning: false,
  supportsProgrammaticToolCalling: false,
  supportsProMode: false,
  supportsFastMode: false,
  supportsUltra: false,
});

const isRecord = (value: unknown): value is UnknownRecord => Boolean(
  value && typeof value === 'object' && !Array.isArray(value),
);

const asRole = (value: unknown): ClaudeRole | null => (
  typeof value === 'string'
  && Object.hasOwn(CLAUDE_AGENT_FOR_ROLE, value)
    ? value as ClaudeRole
    : null
);

export const buildClaudeInvocation = ({
  decision,
  resolution,
}: {
  decision: ClaudeDecision;
  resolution: ClaudeResolution;
}) => {
  const role = asRole(decision.role);
  const subagent = role
    ? CLAUDE_AGENT_FOR_ROLE[role]
    : null;
  if (!subagent) {
    throw new Error(
      `No Claude subagent is defined for Kernel role: ${decision.role}`,
    );
  }
  return {
    subagent,
    model: resolution.model,
    effort: resolution.effort,
    permissions: decision.permissions,
    readOnly: decision.permissions === 'read_only',
    freshContext:
      decision.role !== 'implementer'
      || decision.independentContextRequired === true,
    independentSessionRequired:
      decision.independentContextRequired === true,
  };
};

const ownerDirectDispatch = ({
  decision,
  resolution,
  parentSessionId = null,
}: {
  decision?: ClaudeDecision | null;
  resolution?: ClaudeResolution | null;
  parentSessionId?: unknown;
} = {}) => ({
  status: 'owner-direct',
  resultStatus: 'interrupted',
  executionMode: 'owner-direct',
  dispatchMechanism: 'owner-direct',
  requestedModel: resolution?.model || null,
  requestedEffort: resolution?.effort || null,
  actorRole: decision?.role || null,
  actorSessionId: null,
  parentSessionId,
  outcome: null,
  report: null,
});

const CLAUDE_PROVIDER_EXECUTION_EVIDENCE_FIELDS = Object.freeze([
  'providerExecutionEvidence',
  'sessionId',
  'actorSessionId',
  'childSessionId',
  'providerRequestId',
  'requestId',
  'responseId',
  'turnId',
  'terminalEvents',
  'events',
  'observedSessionConfig',
  'observedConfig',
  'observed_session_config',
  'observed_config',
  'inputTokens',
  'cachedInputTokens',
  'cacheReadInputTokens',
  'cacheWriteInputTokens',
  'outputTokens',
  'reasoningTokens',
  'costMicros',
  'wallClockMs',
  'durationMs',
  'previousResponseId',
  'startedAt',
  'finishedAt',
  'usage',
] as const);

const hasMeaningfulEvidenceValue = (value: unknown): boolean => {
  if (value === null || value === undefined || value === '') {
    return false;
  }
  if (Array.isArray(value)) return value.length > 0;
  if (isRecord(value)) {
    return Object.values(value).some(
      hasMeaningfulEvidenceValue,
    );
  }
  if (typeof value === 'boolean') return value;
  return true;
};

const hasClaudeProviderExecutionEvidence = (
  value: unknown,
): boolean => {
  if (!isRecord(value)) return false;
  return CLAUDE_PROVIDER_EXECUTION_EVIDENCE_FIELDS.some(
    (field) => hasMeaningfulEvidenceValue(value[field]),
  );
};

const providerEnvironment = (
  value: unknown,
): UnknownRecord | null => {
  if (!isRecord(value)) return null;
  const safe: UnknownRecord = {};
  let requiresProjection = false;
  let keys: string[] = [];
  try {
    keys = Object.keys(value);
  } catch {
    return null;
  }
  for (const key of keys) {
    try {
      const next = value[key];
      if (
        typeof next === 'string'
        || typeof next === 'boolean'
        || (
          typeof next === 'number'
          && Number.isFinite(next)
        )
      ) {
        safe[key] = next;
      } else {
        requiresProjection = true;
      }
    } catch {
      // A malformed runtime value is omitted at the provider boundary.
    }
  }
  return requiresProjection
    ? Object.freeze(safe)
    : value;
};

const providerChildSession = (
  value: unknown,
): Readonly<UnknownRecord> => {
  if (!isRecord(value)) {
    return {
      canDelegate: false,
      canCommit: false,
      maxNestedAgents: 0,
    };
  }
  const hasMaxNested =
    Number.isInteger(value.maxNestedAgents)
    && Number(value.maxNestedAgents) >= 0;
  return {
    canDelegate: false,
    canCommit: false,
    ...(hasMaxNested ? { maxNestedAgents: 0 } : {}),
  };
};

const reviewPendingDispatch = ({
  decision,
  resolution,
  parentSessionId = null,
}: {
  decision?: ClaudeDecision | null;
  resolution?: ClaudeResolution | null;
  parentSessionId?: unknown;
} = {}) => ({
  status: 'review-required',
  resultStatus: 'interrupted',
  executionMode: 'independent-review',
  dispatchMechanism: 'independent-review',
  requestedModel: resolution?.model || null,
  requestedEffort: resolution?.effort || null,
  actorRole: decision?.role || 'reviewer',
  actorSessionId: null,
  parentSessionId,
  review: {
    required: true,
    status: 'pending',
    independent: true,
    crossSurface: false,
  },
  outcome: null,
  report: null,
});

export const createClaudeAdapter = ({
  launch = null,
  capabilities = {},
}: ClaudeAdapterInput = {}) => {
  const hasLauncher = typeof launch === 'function';
  const resolvedCapabilities = {
    ...CLAUDE_CAPABILITIES,
    ...capabilities,
    supportsIndependentContext: hasLauncher,
    supportsCrossSurfaceReview: false,
    semantic: Object.freeze({
      freshContext: hasLauncher,
      workspaceWrite: true,
      workspaceIsolation: true,
      parallelExecution: hasLauncher,
      independentReview: hasLauncher,
      modelSelection: true,
    }),
  };

  return {
    surface: 'claude',
    capabilities: resolvedCapabilities,
    ownerDirectAvailable: true,
    ownerDirectDefault: true,
    nativeDelegationAvailable: hasLauncher,
    async dispatch({
      decision,
      resolution,
      strategy: _strategy,
      executionCapsule = null,
      modelInput = {},
      executionContract,
      envelope: _envelope = null,
      workingDirectory = null,
      environment = null,
      parentSessionId = null,
      concurrencyGroup = null,
      childSession = null,
      executionMode = null,
      delegationRequested = false,
      actionContext = null,
    }: ClaudeDispatchInput) {
      const invocation = buildClaudeInvocation({
        decision,
        resolution,
      });
      const nativeRequested = isNativeDelegationRequested({
        executionMode,
        delegationRequested,
        actionContext,
        executionContract,
        executionCapsule,
        decision,
        modelInput,
        capabilities: resolvedCapabilities,
        hasNativeLauncher: hasLauncher,
      });
      const independentReviewRequired =
        decision.role === 'reviewer'
        && decision.independentContextRequired === true;
      if (independentReviewRequired && !hasLauncher) {
        return {
          ...reviewPendingDispatch({
            decision,
            resolution,
            parentSessionId,
          }),
          invocation,
        };
      }
      if (!nativeRequested || !launch) {
        return {
          ...ownerDirectDispatch({
            decision,
            resolution,
            parentSessionId,
          }),
          invocation,
        };
      }

      const providerPrompt = buildModelVisiblePromptView({
        modelInput,
        capsule: executionCapsule,
      });
      const providerInvocation = {
        subagent: invocation.subagent,
        model: invocation.model,
        effort: invocation.effort,
      };
      const launched = await launch({
        invocation: providerInvocation,
        message: buildModelVisiblePromptMessage({
          prompt: providerPrompt,
          review: decision.role === 'reviewer',
        }),
        modelVisiblePrompt: providerPrompt,
        prompt: providerPrompt,
        workingDirectory:
          typeof workingDirectory === 'string'
            ? workingDirectory
            : null,
        environment: providerEnvironment(environment),
        parentSessionId:
          typeof parentSessionId === 'string'
            ? parentSessionId
            : null,
        concurrencyGroup:
          typeof concurrencyGroup === 'string'
            ? concurrencyGroup
            : null,
        childSession: providerChildSession(childSession),
      });
      const result = isRecord(launched) ? launched : {};
      const preSpawnFailure =
        (
          result.status === 'failed'
          || result.resultStatus === 'failed'
        )
        && result.failureStage === 'pre-spawn';
      const providerExecutionEvidence =
        hasClaudeProviderExecutionEvidence(result);

      return {
        status: result.status || 'completed',
        resultStatus:
          result.resultStatus
          || (
            result.status === 'failed'
              ? 'failed'
              : 'completed'
          ),
        resolvedModel: preSpawnFailure
          ? null
          : result.resolvedModel ?? null,
        resolvedEffort:
          result.resolvedEffort
          ?? (
            preSpawnFailure
              ? null
              : invocation.effort ?? null
          ),
        observedModel: preSpawnFailure
          ? null
          : (
              result.observedModel
              ?? result.resolvedModel
              ?? null
            ),
        observedEffort: preSpawnFailure
          ? null
          : (
              result.observedEffort
              ?? result.resolvedEffort
              ?? invocation.effort
              ?? null
            ),
        actorSessionId: preSpawnFailure
          ? null
          : result.sessionId || null,
        observedSessionConfig:
          result.observedSessionConfig
          ?? result.observed_session_config
          ?? result.observedConfig
          ?? result.observed_config
          ?? null,
        observedConfig:
          result.observedConfig
          ?? result.observed_config
          ?? result.observedSessionConfig
          ?? result.observed_session_config
          ?? null,
        inputTokens: result.inputTokens ?? null,
        cachedInputTokens:
          result.cachedInputTokens
          ?? result.cacheReadInputTokens
          ?? null,
        cacheReadInputTokens:
          result.cacheReadInputTokens
          ?? result.cachedInputTokens
          ?? null,
        cacheWriteInputTokens:
          result.cacheWriteInputTokens ?? null,
        uncachedInputTokens:
          result.uncachedInputTokens ?? null,
        outputTokens: result.outputTokens ?? null,
        reasoningTokens: result.reasoningTokens ?? null,
        wallClockMs: result.wallClockMs ?? null,
        errorCode: result.errorCode ?? null,
        errorSummary: result.errorSummary ?? null,
        failureCategory: result.failureCategory ?? null,
        failureStage: result.failureStage ?? null,
        runtimePreflight: result.runtimePreflight ?? null,
        launcherFailure:
          result.launcherFailure
          ?? (
            preSpawnFailure && providerExecutionEvidence
              ? {
                  status: 'failed',
                  errorCode:
                    result.errorCode
                    ?? 'claude-launch-failed',
                  failureStage: 'pre-spawn',
                  providerExecutionEvidence: true,
                }
              : null
          ),
        remediation: result.remediation ?? null,
        outcome:
          result.outcome
          ?? (
            decision.role === 'reviewer'
              ? result.report ?? null
              : null
          ),
        report:
          result.report
          ?? (
            decision.role === 'reviewer'
              ? null
              : result.outcome ?? null
          ),
        invocation,
      };
    },
  };
};
