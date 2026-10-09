// Claude Host adapter (§11.1). Maps an explicitly delegated Kernel role onto a
// Claude subagent and injects the model id from the Host registry. Ordinary
// work remains in the current native owner surface.

import { isNativeDelegationRequested } from '../codex-actor-router.mjs';
import { buildModelVisiblePromptMessage, buildModelVisiblePromptView } from '../model-capsule-view.mjs';

export const CLAUDE_AGENT_FOR_ROLE = Object.freeze({
  planner: 'kernel-planner',
  implementer: 'kernel-implementer',
  reviewer: 'kernel-reviewer',
});

export const CLAUDE_CAPABILITIES = Object.freeze({
  surface: 'claude',
  supportsSubagentModel: true,
  supportsSessionModelOverride: false,
  // A capability describes this concrete adapter, not every Host surface the
  // caller might be able to reach.  The constructor below enables independent
  // context only when an actual launcher was supplied.
  supportsIndependentContext: false,
  supportsCrossSurfaceReview: false,
  supportsReadOnlyReview: true,
  supportsUsageTokens: true,
  supportsResolvedModelIdentity: true,
  // Wave 7. Claude marks cacheable prefixes explicitly and reports read and
  // write token counts separately, so both are observable rather than inferred.
  supportsPromptCache: true,
  supportsExplicitCacheBreakpoints: true,
  supportsCacheReadTokens: true,
  supportsCacheWriteTokens: true,
  supportsSessionContinuation: true,
  // Responses-API-only features. Claude has no equivalent surface here, and
  // claiming one would produce requests that fail at dispatch.
  supportsPersistedReasoning: false,
  supportsProgrammaticToolCalling: false,
  supportsProMode: false,
  supportsFastMode: false,
  supportsUltra: false,
});

export const buildClaudeInvocation = ({ decision, resolution }) => {
  const subagent = CLAUDE_AGENT_FOR_ROLE[decision.role];
  if (!subagent) throw new Error(`No Claude subagent is defined for Kernel role: ${decision.role}`);
  return {
    subagent,
    model: resolution.model,
    effort: resolution.effort,
    permissions: decision.permissions,
    readOnly: decision.permissions === 'read_only',
    // Reviews and escalated work must not inherit the implementer's context;
    // T3 additionally requires a distinct session identity.
    freshContext: decision.role !== 'implementer' || decision.independentContextRequired,
    independentSessionRequired: decision.independentContextRequired === true,
  };
};

const ownerDirectDispatch = ({ decision, resolution, parentSessionId = null } = {}) => ({
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

// Model/effort fields can be copied from the request even when a launcher
// fails before spawning a provider. Only concrete session, request, terminal,
// usage, or timing evidence makes a pre-spawn result contradictory.
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
]);

const hasMeaningfulEvidenceValue = (value) => {
  if (value === null || value === undefined || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.values(value).some(hasMeaningfulEvidenceValue);
  if (typeof value === 'boolean') return value;
  return true;
};

const hasClaudeProviderExecutionEvidence = (value) => {
  if (!value || typeof value !== 'object') return false;
  return CLAUDE_PROVIDER_EXECUTION_EVIDENCE_FIELDS.some((field) => hasMeaningfulEvidenceValue(value[field]));
};

const providerEnvironment = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const safe = {};
  let requiresProjection = false;
  let keys = [];
  try { keys = Object.keys(value); } catch { return null; }
  for (const key of keys) {
    try {
      const next = value[key];
      if (typeof next === 'string' || typeof next === 'boolean' || (typeof next === 'number' && Number.isFinite(next))) {
        safe[key] = next;
      } else {
        requiresProjection = true;
      }
    } catch {
      // A malformed runtime value is omitted at the provider boundary.
    }
  }
  return requiresProjection ? Object.freeze(safe) : value;
};

const providerChildSession = (value) => {
  if (!value || typeof value !== 'object') return { canDelegate: false, canCommit: false, maxNestedAgents: 0 };
  const hasMaxNested = Number.isInteger(value.maxNestedAgents) && value.maxNestedAgents >= 0;
  return {
    canDelegate: false,
    canCommit: false,
    ...(hasMaxNested ? { maxNestedAgents: 0 } : {}),
  };
};

const reviewPendingDispatch = ({ decision, resolution, parentSessionId = null } = {}) => ({
  status: 'review-required',
  resultStatus: 'interrupted',
  executionMode: 'independent-review',
  dispatchMechanism: 'independent-review',
  requestedModel: resolution?.model || null,
  requestedEffort: resolution?.effort || null,
  actorRole: decision?.role || 'reviewer',
  actorSessionId: null,
  parentSessionId,
  review: { required: true, status: 'pending', independent: true, crossSurface: false },
  outcome: null,
  report: null,
});

export const createClaudeAdapter = ({ launch = null, capabilities = {} } = {}) => {
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
  async dispatch({ decision, resolution, strategy, executionCapsule = null, modelInput = {}, executionContract, envelope = null, workingDirectory = null, environment = null, parentSessionId = null, concurrencyGroup = null, childSession = null, executionMode = null, delegationRequested = false, actionContext = null }) {
    const invocation = buildClaudeInvocation({ decision, resolution });
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
    const independentReviewRequired = decision.role === 'reviewer' && decision.independentContextRequired === true;
    if (independentReviewRequired && !hasLauncher) {
      // Independent review cannot silently fall back to the owner's context,
      // even when a caller explicitly requested optional native delegation.
      return { ...reviewPendingDispatch({ decision, resolution, parentSessionId }), invocation };
    }
    if (!nativeRequested || !hasLauncher) {
      return { ...ownerDirectDispatch({ decision, resolution, parentSessionId }), invocation };
    }
    // Reproject from the current Host capsule at the provider boundary. The
    // caller's prior projection is deliberately not trusted or forwarded.
    // `envelope` remains Host-only for receipt/accounting and never crosses
    // into the provider launcher.
    const providerPrompt = buildModelVisiblePromptView({ modelInput, capsule: executionCapsule });
    const providerInvocation = {
      subagent: invocation.subagent,
      model: invocation.model,
      effort: invocation.effort,
    };
    const result = (await launch({
      invocation: providerInvocation,
      message: buildModelVisiblePromptMessage({ prompt: providerPrompt, review: decision.role === 'reviewer' }),
      modelVisiblePrompt: providerPrompt,
      prompt: providerPrompt,
      workingDirectory: typeof workingDirectory === 'string' ? workingDirectory : null,
      environment: providerEnvironment(environment),
      parentSessionId: typeof parentSessionId === 'string' ? parentSessionId : null,
      concurrencyGroup: typeof concurrencyGroup === 'string' ? concurrencyGroup : null,
      childSession: providerChildSession(childSession),
    })) || {};
    const preSpawnFailure = (result.status === 'failed' || result.resultStatus === 'failed')
      && result.failureStage === 'pre-spawn';
    const providerExecutionEvidence = hasClaudeProviderExecutionEvidence(result);
    return {
      status: result.status || 'completed',
      resultStatus: result.resultStatus || (result.status === 'failed' ? 'failed' : 'completed'),
      resolvedModel: preSpawnFailure ? null : result.resolvedModel ?? null,
      // The requested effort is not provider telemetry. Do not echo it as a
      // resolved/observed value when the launcher explicitly failed before a
      // provider process could exist.
      resolvedEffort: result.resolvedEffort ?? (preSpawnFailure ? null : invocation.effort ?? null),
      // The Claude Host launcher exposes the provider identity it observed;
      // keeping these separate lets the common receipt builder fail closed
      // when a launcher omits terminal/session telemetry.
      observedModel: preSpawnFailure ? null : result.observedModel ?? result.resolvedModel ?? null,
      observedEffort: preSpawnFailure ? null : result.observedEffort ?? result.resolvedEffort ?? invocation.effort ?? null,
      actorSessionId: preSpawnFailure ? null : result.sessionId || null,
      observedSessionConfig: result.observedSessionConfig
        ?? result.observed_session_config
        ?? result.observedConfig
        ?? result.observed_config
        ?? null,
      observedConfig: result.observedConfig
        ?? result.observed_config
        ?? result.observedSessionConfig
        ?? result.observed_session_config
        ?? null,
      inputTokens: result.inputTokens ?? null,
      cachedInputTokens: result.cachedInputTokens ?? result.cacheReadInputTokens ?? null,
      cacheReadInputTokens: result.cacheReadInputTokens ?? result.cachedInputTokens ?? null,
      cacheWriteInputTokens: result.cacheWriteInputTokens ?? null,
      uncachedInputTokens: result.uncachedInputTokens ?? null,
      outputTokens: result.outputTokens ?? null,
      reasoningTokens: result.reasoningTokens ?? null,
      wallClockMs: result.wallClockMs ?? null,
      errorCode: result.errorCode ?? null,
      errorSummary: result.errorSummary ?? null,
      failureCategory: result.failureCategory ?? null,
      failureStage: result.failureStage ?? null,
      runtimePreflight: result.runtimePreflight ?? null,
      launcherFailure: result.launcherFailure ?? (preSpawnFailure && providerExecutionEvidence ? {
        status: 'failed',
        errorCode: result.errorCode ?? 'claude-launch-failed',
        failureStage: 'pre-spawn',
        providerExecutionEvidence: true,
      } : null),
      remediation: result.remediation ?? null,
      outcome: result.outcome ?? (decision.role === 'reviewer' ? result.report ?? null : null),
      report: result.report ?? (decision.role === 'reviewer' ? null : result.outcome ?? null),
      invocation,
    };
  },
  };
};
