// Codex Host adapter (§11.2). The installed Codex profile deliberately leaves
// model/model_provider unset, so a global frontier pin cannot leak into cheap
// implementation turns. Model selection happens per worker invocation only.

import { selectCodexProfileName } from '../codex-model-policy.js';
import { isNativeDelegationRequested, resolveCodexActorRoute } from '../codex-actor-router.js';
import { buildModelVisiblePromptMessage, buildModelVisiblePromptView } from '../model-capsule-view.js';
import {
  buildCodexMainSessionPolicy,
  compareCodexSessionConfig,
  CODEX_HOST_UNSUPPORTED_CAPABILITY,
  CODEX_PARENT_SESSION_REMEDIATION,
  CODEX_PARENT_SESSION_TELEMETRY_CAPABILITY,
  isCodexCapabilityUnavailable,
  resolveObservedCodexSessionConfig as resolveObservedCodexSessionConfigFromEvents,
  resolveObservedCodexSessionConfigFromRollout,
} from '../codex-session-observer.js';

type UnknownRecord = Record<string, unknown>;
type NativeLaunch = (input: UnknownRecord) => unknown | Promise<unknown>;

interface NativeAgentHost extends UnknownRecord {
  spawn_agent?: NativeLaunch;
  spawnAgent?: NativeLaunch;
  codex?: {
    spawn_agent?: NativeLaunch;
    spawnAgent?: NativeLaunch;
    [key: string]: unknown;
  };
}

interface CodexCapabilities extends UnknownRecord {
  surface?: string;
  supportsSubagentModel?: boolean;
  supportsSessionModelOverride?: boolean;
  supportsLaunchProfile?: boolean;
  supportsIndependentContext?: boolean;
  supportsCrossSurfaceReview?: boolean;
  supportsReadOnlyReview?: boolean;
  supportsUsageTokens?: boolean;
  supportsResolvedModelIdentity?: boolean;
  supportsSessionContinuation?: boolean;
  supportsPromptCache?: boolean;
  supportsExplicitCacheBreakpoints?: boolean;
  supportsCacheReadTokens?: boolean;
  supportsCacheWriteTokens?: boolean;
  supportsPersistedReasoning?: boolean;
  supportsProgrammaticToolCalling?: boolean;
  supportsProMode?: boolean;
  supportsFastMode?: boolean;
  supportsUltra?: boolean;
  semantic?: Readonly<Record<string, boolean>>;
}

interface CodexInvocation extends UnknownRecord {
  mechanism: string;
  model: string | null;
  effort: string | null;
  requestedModel: string | null;
  requestedEffort: string | null;
  profile: string;
  sandbox: string;
  approvalPolicy: string;
  freshSessionRequired: boolean;
  sessionPolicy: 'fresh' | 'reusable';
}

interface DecisionLike extends UnknownRecord {
  role?: unknown;
  actionKind?: unknown;
  permissions?: unknown;
  independentContextRequired?: unknown;
  workProfile?: UnknownRecord | null;
  reasonCodes?: readonly unknown[];
}

interface ResolutionLike extends UnknownRecord {
  model?: unknown;
  effort?: unknown;
}

interface NativeLauncherInput {
  invocation: UnknownRecord;
  message?: unknown;
  modelVisiblePrompt?: unknown;
  taskName?: string;
  parentSessionId?: unknown;
  childSession?: unknown;
  workingDirectory?: unknown;
  concurrencyGroup?: unknown;
}

interface ParentSessionObserverInput {
  parentSessionId?: unknown;
  phase?: unknown;
  parentSessionEnvironment?: UnknownRecord | null;
  parentEnvironment?: UnknownRecord | null;
  environment?: UnknownRecord | null;
  env?: NodeJS.ProcessEnv;
  startedAt?: Date;
}

interface UnsupportedCapabilityInput {
  capability?: unknown;
  reason?: unknown;
  remediation?: string;
}

interface DispatchBuilderInput extends UnknownRecord {
  invocation?: CodexInvocation | UnknownRecord | null;
  parentSessionId?: unknown;
  parentSessionPolicy?: unknown;
  actorRole?: unknown;
  sessionPolicy?: unknown;
  dispatchMechanism?: string;
  executionMode?: unknown;
  delegation?: unknown;
  capability?: unknown;
  reason?: unknown;
  remediation?: string;
  fallbackReason?: unknown;
  crossSurfaceAvailable?: boolean;
}

interface WorkerTelemetryInput {
  actualLauncher?: unknown;
  identityRequired?: unknown;
  observation?: ReturnType<typeof compareCodexSessionConfig> | null;
  lineageReason?: unknown;
}

interface CreateCodexAdapterInput {
  launch?: NativeLaunch | null;
  nativeLaunch?: NativeLaunch | null;
  nativeAgentHost?: NativeAgentHost;
  parentSessionObserver?: NativeLaunch | null;
  defaultParentSessionConfig?: unknown;
  parentSessionEnvironment?: UnknownRecord | null;
  parentEnvironment?: UnknownRecord | null;
  projectRoot?: unknown;
  images?: unknown[];
  timeoutMs?: number;
  capabilities?: CodexCapabilities;
  runtimeHome?: unknown;
  env?: NodeJS.ProcessEnv;
}

interface AdapterDispatchInput {
  decision: DecisionLike;
  resolution: ResolutionLike;
  strategy?: unknown;
  executionCapsule?: unknown;
  modelInput?: UnknownRecord;
  executionContract?: unknown;
  envelope?: unknown;
  workingDirectory?: unknown;
  environment?: unknown;
  parentSessionId?: unknown;
  parentSessionConfig?: unknown;
  parentSessionEnvironment?: UnknownRecord | null;
  parentEnvironment?: UnknownRecord | null;
  concurrencyGroup?: unknown;
  childSession?: unknown;
  executionMode?: unknown;
  delegationRequested?: boolean;
  requestedTransport?: unknown;
  actionContext?: UnknownRecord | null;
}

const asRecord = (value: unknown): UnknownRecord => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : {}
);

const asNativeHost = (value: unknown): NativeAgentHost => (
  asRecord(value) as NativeAgentHost
);

const nestedRecord = (record: UnknownRecord, key: string): UnknownRecord => asRecord(record[key]);

export const CODEX_WORKER_TIMEOUT_MS = 600000;

export const CODEX_REVIEW_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['pass', 'fail', 'blocked'] },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['critical', 'important', 'minor'] },
          category: { type: 'string', enum: ['contract', 'architecture', 'implementation', 'security', 'verification'] },
          path: { type: ['string', 'null'] },
          summary: { type: 'string' },
          requiredAction: { type: 'string', enum: ['fix', 'replan', 'block'] },
        },
        required: ['severity', 'category', 'path', 'summary', 'requiredAction'],
        additionalProperties: false,
      },
    },
    risks: { type: 'array', items: { type: 'string' } },
    evidenceRefs: { type: 'array', items: { type: 'string' } },
  },
  required: ['verdict', 'findings', 'risks', 'evidenceRefs'],
  additionalProperties: false,
});

export const CODEX_WORKER_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['completed', 'blocked', 'failed'] },
    summary: { type: 'string' },
    changedPaths: { type: 'array', items: { type: 'string' } },
    risks: { type: 'array', items: { type: 'string' } },
    verifications: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          obligationId: { type: 'string' },
          commandRef: { type: 'string' },
          acceptanceCoverage: { type: 'array', items: { type: 'string' } },
        },
        required: ['obligationId', 'commandRef', 'acceptanceCoverage'],
        additionalProperties: false,
      },
    },
    requestedVerifications: { type: 'array', items: { type: 'string' } },
    judgments: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          obligationId: { type: 'string' },
          verdict: { type: 'string', enum: ['pass', 'fail'] },
          reviewReceiptId: { type: ['string', 'null'] },
          acceptanceCoverage: { type: 'array', items: { type: 'string' } },
        },
        required: ['obligationId', 'verdict', 'reviewReceiptId', 'acceptanceCoverage'],
        additionalProperties: false,
      },
    },
    knowledgeObservations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          proposedType: { type: 'string' },
          statement: { type: 'string' },
          scope: { type: 'array', items: { type: 'string' } },
          evidenceRefs: { type: 'array', items: { type: 'string' } },
          acceptanceIds: { type: 'array', items: { type: 'string' } },
          obligationIds: { type: 'array', items: { type: 'string' } },
        },
        required: ['proposedType', 'statement', 'scope', 'evidenceRefs', 'acceptanceIds', 'obligationIds'],
        additionalProperties: false,
      },
    },
    blocker: { type: ['string', 'null'] },
  },
  required: ['status', 'summary', 'changedPaths', 'risks', 'verifications', 'requestedVerifications', 'judgments', 'knowledgeObservations', 'blocker'],
  additionalProperties: false,
});

const assertWorkerOutcome = (value: unknown): UnknownRecord => {
  const record = asRecord(value);
  if (!['completed', 'blocked', 'failed'].includes(String(record.status || ''))) {
    throw new Error('codex_worker_output_invalid: status must be completed, blocked, or failed');
  }
  for (const field of ['changedPaths', 'risks', 'requestedVerifications', 'judgments', 'knowledgeObservations']) {
    if (!Array.isArray(record[field])) throw new Error(`codex_worker_output_invalid: ${field} must be an array`);
  }
  if (typeof record.summary !== 'string' || (record.blocker !== null && typeof record.blocker !== 'string')) {
    throw new Error('codex_worker_output_invalid: summary and blocker have invalid types');
  }
  return record;
};

const assertReviewOutcome = (value: unknown): UnknownRecord => {
  const record = asRecord(value);
  if (!['pass', 'fail', 'blocked'].includes(String(record.verdict || ''))) {
    throw new Error('codex_review_output_invalid: verdict must be pass, fail, or blocked');
  }
  for (const field of ['findings', 'risks', 'evidenceRefs']) {
    if (!Array.isArray(record[field])) throw new Error(`codex_review_output_invalid: ${field} must be an array`);
  }
  return record;
};

const resolveNativeSpawnAgent = ({ spawnAgent = null, host = asNativeHost(globalThis) }: { spawnAgent?: NativeLaunch | null; host?: NativeAgentHost } = {}): NativeLaunch | null => {
  if (typeof spawnAgent === 'function') return spawnAgent;
  if (typeof host?.spawn_agent === 'function') return host.spawn_agent.bind(host);
  if (typeof host?.spawnAgent === 'function') return host.spawnAgent.bind(host);
  if (typeof host?.codex?.spawn_agent === 'function') return host.codex.spawn_agent.bind(host.codex);
  if (typeof host?.codex?.spawnAgent === 'function') return host.codex.spawnAgent.bind(host.codex);
  return null;
};

const firstNativeValue = (values: readonly unknown[]): string | null => {
  const value = values.find((candidate) => candidate !== undefined && candidate !== null && String(candidate).trim());
  return value === undefined || value === null ? null : String(value);
};

const providerEnvironment = (value: unknown): Readonly<UnknownRecord> | UnknownRecord | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = asRecord(value);
  const safe: UnknownRecord = {};
  let requiresProjection = false;
  let keys = [];
  try { keys = Object.keys(record); } catch { return null; }
  for (const key of keys) {
    try {
      const next = record[key];
      if (typeof next === 'string' || typeof next === 'boolean' || (typeof next === 'number' && Number.isFinite(next))) {
        safe[key] = next;
      } else {
        requiresProjection = true;
      }
    } catch {
      // A malformed runtime value is omitted at the provider boundary.
    }
  }
  return requiresProjection ? Object.freeze(safe) : record;
};

const providerChildSession = (value: unknown): UnknownRecord => {
  const record = asRecord(value);
  if (Object.keys(record).length === 0) return { canDelegate: false, canCommit: false, maxNestedAgents: 0 };
  const hasMaxNested = Number.isInteger(record.maxNestedAgents) && Number(record.maxNestedAgents) >= 0;
  return {
    canDelegate: false,
    canCommit: false,
    ...(hasMaxNested ? { maxNestedAgents: 0 } : {}),
  };
};

const CODEX_PROVIDER_EXECUTION_EVIDENCE_FIELDS = Object.freeze([
  'actorSessionId', 'actor_session_id', 'sessionId', 'session_id', 'childSessionId', 'child_session_id',
  'providerRequestId', 'provider_request_id', 'requestId', 'request_id', 'responseId', 'response_id',
  'turnId', 'turn_id',
  'terminalEvents', 'terminal_events', 'events', 'observedSessionConfig', 'observedConfig',
  'observed_session_config', 'observed_config', 'inputTokens', 'input_tokens', 'cachedInputTokens',
  'cached_input_tokens', 'cacheReadInputTokens', 'cache_read_input_tokens', 'cacheWriteInputTokens',
  'cache_write_input_tokens', 'outputTokens', 'output_tokens', 'reasoningTokens', 'reasoning_tokens',
  'costMicros', 'cost_micros', 'wallClockMs', 'wall_clock_ms', 'durationMs', 'duration_ms',
  'previousResponseId', 'previous_response_id', 'startedAt', 'started_at', 'finishedAt', 'finished_at', 'usage',
]);

const hasMeaningfulEvidenceValue = (value: unknown): boolean => {
  if (value === null || value === undefined || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.values(value).some(hasMeaningfulEvidenceValue);
  if (typeof value === 'boolean') return value;
  return true;
};

const hasCodexProviderExecutionEvidence = (value: unknown): boolean => {
  const record = asRecord(value);
  if (Object.keys(record).length === 0) return false;
  return CODEX_PROVIDER_EXECUTION_EVIDENCE_FIELDS.some((field) => hasMeaningfulEvidenceValue(record[field]));
};

const CODEX_REVIEWER_RESULT_FIELDS = Object.freeze([
  'outcome',
  'report',
  'reviewerOutcome',
  'review',
  'reviewReceipt',
  'reviewReceiptId',
  'verdict',
  'reviewVerdict',
  'findings',
  'evidenceRefs',
  'risks',
]);

const codexReviewerResultFields = (source: unknown): UnknownRecord => {
  const record = asRecord(source);
  return Object.fromEntries(CODEX_REVIEWER_RESULT_FIELDS
    .filter((field) => record[field] !== undefined && record[field] !== null)
    .map((field) => [field, record[field]]));
};

export const createCodexNativeAgentLauncher = ({
  spawnAgent = null,
  host = asNativeHost(globalThis),
}: {
  spawnAgent?: NativeLaunch | null;
  host?: NativeAgentHost;
} = {}): NativeLaunch | null => {
  const dispatch = resolveNativeSpawnAgent({ spawnAgent, host });
  if (!dispatch) return null;
  return async (input: UnknownRecord) => {
    const {
      invocation,
      message = null,
      modelVisiblePrompt = null,
      taskName = 'kernel_worker',
      parentSessionId = null,
      childSession = null,
      workingDirectory = null,
      concurrencyGroup = null,
    } = { ...input, invocation: asRecord(input.invocation), taskName: typeof input.taskName === 'string' ? input.taskName : 'kernel_worker' };
    if (!invocation.model || !invocation.effort) throw new Error('codex_native_worker_requires_explicit_model_and_effort');
    const reviewer = taskName === 'kernel_reviewer';
    const safeChildSession = providerChildSession(childSession);
    const handle = asRecord(await dispatch({
      task_name: taskName,
      model: invocation.model,
      reasoning_effort: invocation.effort,
      message: message || buildModelVisiblePromptMessage({ prompt: asRecord(modelVisiblePrompt) }),
      parent_session_id: parentSessionId,
      child_session: safeChildSession,
      working_directory: workingDirectory,
      concurrency_group: concurrencyGroup,
    }));
    const callNoArg = async (value: unknown): Promise<unknown> => (
      await (value as () => unknown | Promise<unknown>)()
    );
    const completedValue = typeof handle.waitForOutcome === 'function'
      ? await callNoArg(handle.waitForOutcome)
      : typeof handle.wait === 'function'
        ? await callNoArg(handle.wait)
        : typeof handle.result === 'function'
          ? await callNoArg(handle.result)
          : null;
    const completed = asRecord(completedValue);
    const candidate: UnknownRecord = {
      ...handle,
      ...completed,
      ...asRecord(completed.result),
    };
    const outcome = candidate.outcome || candidate.report || null;
    if (outcome) {
      if (reviewer) assertReviewOutcome(outcome);
      else assertWorkerOutcome(outcome);
    }
    const terminalEvents = Array.isArray(candidate.terminalEvents)
      ? candidate.terminalEvents
      : Array.isArray(candidate.events) ? candidate.events : [];
    const terminalConfig = resolveObservedCodexSessionConfigFromEvents(terminalEvents);
    const observedConfig = asRecord(
      candidate.observedSessionConfig
      || candidate.observedConfig
      || candidate.observed_session_config
      || candidate.observed_config
      || terminalConfig,
    );
    const outcomeRecord = asRecord(outcome);
    const resolvedModel = firstNativeValue([observedConfig.model]);
    const resolvedEffort = firstNativeValue([
      observedConfig.effort,
      observedConfig.reasoning_effort,
      observedConfig.reasoningEffort,
    ]);
    const sessionId = firstNativeValue([
      candidate.sessionId,
      candidate.session_id,
      candidate.actorSessionId,
      candidate.actor_session_id,
      candidate.threadId,
      candidate.thread_id,
    ]);
    const observedSessionConfig = resolvedModel || resolvedEffort
      ? { model: resolvedModel, effort: resolvedEffort }
      : null;
    return {
      ...candidate,
      status: candidate.status || (outcomeRecord.status === 'completed' ? 'completed' : outcomeRecord.status || 'completed'),
      resultStatus: candidate.resultStatus || (candidate.status === 'failed' || outcomeRecord.status === 'failed' ? 'failed' : 'completed'),
      resolvedModel,
      resolvedEffort,
      observedSessionConfig,
      observedConfig: observedSessionConfig,
      observed_session_config: observedSessionConfig,
      observed_config: observedSessionConfig,
      observedModel: resolvedModel,
      observedEffort: resolvedEffort,
      effortObserved: Boolean(resolvedEffort),
      sessionId,
      outcome: outcome || null,
      report: reviewer ? null : candidate.report || (outcome && candidate.outcome ? outcome : null),
    };
  };
};

const defaultParentSessionObserver = async ({
  parentSessionId,
  parentSessionEnvironment = null,
  parentEnvironment = null,
  environment = null,
  env = process.env,
  startedAt = new Date(),
}: ParentSessionObserverInput = {}) => {
  if (!parentSessionId) return null;
  const observationEnvironment = parentSessionEnvironment || parentEnvironment
    ? { ...(parentEnvironment || {}), ...(parentSessionEnvironment || {}) }
    : { ...env, ...(environment || {}) };
  const observed = await resolveObservedCodexSessionConfigFromRollout({
    threadId: nativeSessionId(parentSessionId),
    env: observationEnvironment as NodeJS.ProcessEnv,
    startedAt,
  });
  return normalizeParentObservation(observed, parentSessionId);
};

export const CODEX_CAPABILITIES: Readonly<CodexCapabilities> = Object.freeze({
  surface: 'codex',
  supportsSubagentModel: false,
  supportsSessionModelOverride: true,
  supportsLaunchProfile: true,
  // Cross-surface review belongs to Host orchestration, not to one Codex
  // adapter.  Independent context is enabled on the concrete instance below
  // only when its native worker launcher is actually usable.
  supportsIndependentContext: false,
  supportsCrossSurfaceReview: false,
  supportsReadOnlyReview: true,
  supportsUsageTokens: false,
  supportsResolvedModelIdentity: true,
  // Wave 7. Session continuation is the one cache mechanism the CLI surface
  // actually gives us. Explicit breakpoints, cache token counts, persisted
  // reasoning, Programmatic Tool Calling, Pro mode, Fast mode, and Ultra are
  // Responses-API or app-surface features: a Host that has them says so by
  // overriding this, and until then the turn falls back honestly rather than
  // sending a request the CLI will reject.
  supportsSessionContinuation: true,
  supportsPromptCache: false,
  supportsExplicitCacheBreakpoints: false,
  supportsCacheReadTokens: false,
  supportsCacheWriteTokens: false,
  supportsPersistedReasoning: false,
  supportsProgrammaticToolCalling: false,
  supportsProMode: false,
  supportsFastMode: false,
  supportsUltra: false,
});

// Support order (§11.2): per-worker model override, then a separate session
// override, then a named launch profile; anything else can only be advisory.
// The selected profile is carried independently of that mechanism because the
// CLI profile also supplies non-model settings (approval, sandbox defaults,
// network policy, and verbosity) while explicit invocation flags remain the
// authority for model and effort.
export const selectCodexMechanism = ({ capabilities, resolution }: { capabilities: CodexCapabilities; resolution: ResolutionLike }): string => {
  if (!resolution.model) return capabilities.supportsResolvedModelIdentity ? 'host-default' : 'unsupported';
  if (capabilities.supportsSubagentModel) return 'worker-model-override';
  if (capabilities.supportsSessionModelOverride) return 'session-model-override';
  if (capabilities.supportsLaunchProfile === true) return 'launch-profile';
  return 'advisory';
};

export const buildCodexInvocation = ({ decision, resolution, capabilities }: { decision: DecisionLike; resolution: ResolutionLike; capabilities: CodexCapabilities }): CodexInvocation => {
  const mechanism = selectCodexMechanism({ capabilities, resolution });
  const repeatedFailure = decision.workProfile?.repeatedFailure === true
    || (decision.reasonCodes || []).some((code: unknown) => code === 'RETRY_ESCALATION' || code === 'PROTECTED_OBLIGATION_FAILURE' || code === 'ESCALATION_LOCKED');
  const freshSessionRequired = decision.independentContextRequired === true
    || decision.workProfile?.independentContextRequired === true
    || decision.role === 'reviewer'
    || repeatedFailure;
  const model = resolution.model ? String(resolution.model) : null;
  const effort = resolution.effort ? String(resolution.effort) : null;
  const profile = selectCodexProfileName({
    actionKind: String(decision.actionKind || 'implement'),
    complexity: String(decision.workProfile?.complexity || 'standard'),
  });
  return {
    mechanism,
    model,
    effort,
    requestedModel: model,
    requestedEffort: effort,
    // Named by the materialized profile (default/plan/review/batch), which a
    // Kernel model class alone cannot distinguish — a protected review and a
    // routine implementation can share `frontier_reasoning`.
    profile,
    sandbox: decision.permissions === 'workspace_write' ? 'workspace-write' : 'read-only',
    approvalPolicy: decision.permissions === 'workspace_write' ? 'on-failure' : 'on-request',
    freshSessionRequired,
    sessionPolicy: freshSessionRequired ? 'fresh' : 'reusable',
  };
};

const nativeSessionId = (parentSessionId: unknown): string => {
  const value = String(parentSessionId || '').trim();
  const separator = value.indexOf(':');
  return separator >= 0 ? value.slice(separator + 1) : value;
};

const normalizeParentObservation = (value: unknown, parentSessionId: unknown): UnknownRecord | null => {
  const record = asRecord(value);
  if (Object.keys(record).length === 0) return null;
  return {
    ...record,
    sessionId: record.sessionId || parentSessionId || null,
  };
};

const buildUnsupportedCapability = ({ capability, reason, remediation = CODEX_PARENT_SESSION_REMEDIATION }: UnsupportedCapabilityInput = {}) => Object.freeze({
  type: 'unsupported-capability',
  code: CODEX_HOST_UNSUPPORTED_CAPABILITY,
  capability,
  reason,
  remediation,
});

const isIndependentReviewRequired = ({
  decision = {},
  actorRoute = null,
  executionContract = null,
}: {
  decision?: unknown;
  actorRoute?: unknown;
  executionContract?: unknown;
} = {}): boolean => {
  const decisionRecord = asRecord(decision);
  const routeRecord = asRecord(actorRoute);
  const contractRecord = asRecord(executionContract);
  return Boolean(
    (routeRecord.role === 'reviewer' || decisionRecord.role === 'reviewer')
    && (
      decisionRecord.independentContextRequired === true
      || contractRecord.independentReviewRequired === true
      || contractRecord.independentReview === true
      || contractRecord.reviewMode === 'independent'
    )
  );
};

const buildUnsupportedDispatch = ({
  invocation = null,
  parentSessionId = null,
  parentSessionPolicy = null,
  actorRole = null,
  sessionPolicy = null,
  dispatchMechanism = 'capability-guard',
  executionMode = null,
  delegation = null,
  capability = null,
  reason = null,
  remediation = CODEX_PARENT_SESSION_REMEDIATION,
  fallbackReason = null,
}: DispatchBuilderInput = {}) => {
  const unsupportedCapability = buildUnsupportedCapability({ capability, reason, remediation });
  return {
    status: 'unsupported',
    // `completed` is reserved for a worker outcome. Unsupported capability
    // is a terminal Host refusal, so receipts cannot mistake it for worker
    // completion even though the dispatch call itself returned normally.
    resultStatus: 'failed',
    resolvedModel: null,
    resolvedEffort: null,
    requestedModel: invocation?.model || null,
    requestedEffort: invocation?.effort || null,
    observedModel: null,
    observedEffort: null,
    dispatchMechanism,
    executionMode,
    delegation,
    actorRole,
    sessionPolicy,
    parentSessionPolicy,
    enforcementStatus: 'unsupported',
    enforcementReason: reason,
    fallbackReason,
    errorCode: CODEX_HOST_UNSUPPORTED_CAPABILITY,
    errorSummary: `${capability} is unavailable: ${reason}. ${remediation}`,
    capability: unsupportedCapability,
    unsupportedCapability,
    actorSessionId: null,
    outcome: null,
    report: null,
    parentSessionId: parentSessionId || null,
    invocation,
  };
};

// A missing optional worker launcher is not a failed implementation. The
// current native Codex owner can execute the already-issued bounded work unit
// and later call Kernel report. This intent deliberately has no outcome or
// report: returning either would fabricate completion before the owner acts.
const buildOwnerDirectDispatch = ({ invocation = null, parentSessionId = null, actorRole = null, sessionPolicy = null }: DispatchBuilderInput = {}) => ({
  status: 'owner-direct',
  resultStatus: 'interrupted',
  resolvedModel: null,
  resolvedEffort: null,
  requestedModel: invocation?.model || null,
  requestedEffort: invocation?.effort || null,
  observedModel: null,
  observedEffort: null,
  dispatchMechanism: 'owner-direct',
  executionMode: 'owner-direct',
  delegation: {
    mode: 'optional',
    available: false,
    actorRole,
  },
  actorRole,
  sessionPolicy,
  parentSessionPolicy: null,
  enforcementStatus: 'advisory',
  enforcementReason: 'owner-session-execution',
  fallbackReason: null,
  errorCode: null,
  errorSummary: null,
  capability: null,
  unsupportedCapability: null,
  actorSessionId: null,
  outcome: null,
  report: null,
  parentSessionId: parentSessionId || null,
  invocation,
});

const buildIndependentReviewPending = ({ invocation = null, parentSessionId = null, actorRole = 'reviewer', sessionPolicy = null, crossSurfaceAvailable = true }: DispatchBuilderInput = {}) => ({
  status: 'review-required',
  resultStatus: 'interrupted',
  resolvedModel: null,
  resolvedEffort: null,
  requestedModel: invocation?.model || null,
  requestedEffort: invocation?.effort || null,
  observedModel: null,
  observedEffort: null,
  dispatchMechanism: 'independent-review',
  executionMode: 'independent-review',
  delegation: { mode: 'required', available: crossSurfaceAvailable, requested: false, actorRole },
  actorRole,
  sessionPolicy,
  parentSessionPolicy: null,
  enforcementStatus: 'advisory',
  enforcementReason: 'independent-review-pending',
  fallbackReason: null,
  errorCode: null,
  errorSummary: null,
  capability: null,
  unsupportedCapability: null,
  actorSessionId: null,
  outcome: null,
  report: null,
  review: { required: true, status: 'pending', independent: true, crossSurfaceAvailable },
  parentSessionId: parentSessionId || null,
  invocation,
});

const WORKER_TELEMETRY_MISSING_REASONS = new Set([
  'model-observation-missing',
  'effort-observation-missing',
  'worker-session-observation-missing',
  'parent-session-missing',
]);

const isWorkerTelemetryUnavailable = ({ actualLauncher, identityRequired, observation, lineageReason }: WorkerTelemetryInput = {}) => Boolean(
  actualLauncher
  && (
    WORKER_TELEMETRY_MISSING_REASONS.has(String(observation?.reason || ''))
    || WORKER_TELEMETRY_MISSING_REASONS.has(String(lineageReason || ''))
  )
  && (identityRequired || Boolean(lineageReason)),
);

export const createCodexAdapter = ({
  launch = null,
  nativeLaunch = null,
  nativeAgentHost = asNativeHost(globalThis),
  parentSessionObserver = null,
  defaultParentSessionConfig = null,
  parentSessionEnvironment = null,
  parentEnvironment = null,
  projectRoot = null,
  images = [],
  timeoutMs = CODEX_WORKER_TIMEOUT_MS,
  capabilities = {},
  runtimeHome = null,
  env = process.env,
}: CreateCodexAdapterInput = {}) => {
  const automaticNativeLaunch = nativeLaunch === null ? createCodexNativeAgentLauncher({ host: nativeAgentHost }) : null;
  // The injected launch seam is usable only after an explicit delegation
  // request; it never changes the ordinary owner-direct default.
  const effectiveNativeLaunch = nativeLaunch || automaticNativeLaunch || launch;
  const resolved: CodexCapabilities = {
    ...CODEX_CAPABILITIES,
    ...capabilities,
    ...(capabilities.supportsSubagentModel === undefined && effectiveNativeLaunch ? { supportsSubagentModel: true } : {}),
  };
  const nativeDelegationAvailable = Boolean(effectiveNativeLaunch && resolved.supportsSubagentModel === true);
  resolved.supportsIndependentContext = nativeDelegationAvailable;
  resolved.supportsCrossSurfaceReview = false;
  resolved.semantic = Object.freeze({
    freshContext: nativeDelegationAvailable,
    workspaceWrite: true,
    workspaceIsolation: true,
    parallelExecution: nativeDelegationAvailable,
    independentReview: nativeDelegationAvailable,
    modelSelection: true,
  });
  const observeParentSession = parentSessionObserver || defaultParentSessionObserver;
  const configuredParentSessionEnvironment = parentSessionEnvironment || parentEnvironment || null;
  return {
    surface: 'codex',
    capabilities: resolved,
    ownerDirectAvailable: true,
    ownerDirectDefault: true,
    // The Host may request this explicit transport after classifying a pure
    // pre-spawn native-worker failure.  The adapter advertises only whether a
    // concrete owner transport launcher exists; it never decides to retry it.
    supportsOwnerDirectRetry: Boolean(launch),
    nativeDelegationAvailable,
    async dispatch({ decision, resolution, strategy, executionCapsule = null, modelInput = {}, executionContract, envelope = null, workingDirectory = null, environment = null, parentSessionId = null, parentSessionConfig = defaultParentSessionConfig, parentSessionEnvironment: dispatchParentSessionEnvironment = null, parentEnvironment: dispatchParentEnvironment = null, concurrencyGroup = null, childSession = null, executionMode = null, delegationRequested = false, requestedTransport = null, actionContext = null }: AdapterDispatchInput) {
      const invocation = buildCodexInvocation({ decision, resolution, capabilities: resolved });
      // Reproject at the adapter/provider boundary. A caller-supplied prompt
      // is intentionally not accepted as an authority for provider input.
      const providerPrompt = buildModelVisiblePromptView({ modelInput, capsule: executionCapsule });
      const providerMessage = buildModelVisiblePromptMessage({ prompt: providerPrompt, review: decision.role === 'reviewer' });
      const providerInvocation = { model: invocation.model, effort: invocation.effort };
      const taskName = decision.role === 'reviewer' ? 'kernel_reviewer' : 'kernel_implementer';
      const nativeAvailable = Boolean(effectiveNativeLaunch && resolved.supportsSubagentModel === true);
      const nativeRequested = isNativeDelegationRequested({
        executionMode,
        delegationRequested,
        actionContext,
        executionContract,
        executionCapsule,
        decision,
        modelInput,
        capabilities: resolved,
        hasNativeLauncher: Boolean(effectiveNativeLaunch),
      });
      const actorRoute = resolveCodexActorRoute({
        decision,
        invocation,
        capabilities: resolved,
        hasNativeLauncher: Boolean(effectiveNativeLaunch),
        delegationRequested: nativeRequested,
        parentSessionId,
        parentSessionConfig,
        executionCapsule,
        executionContract,
        actionContext,
        modelInput,
      });
      const ownerDirectTransportRequested = requestedTransport === 'owner-direct';
      // A missing native launcher only removes optional delegation. The
      // owner-direct path is the normal interactive Codex execution surface;
      // it must not require parent/child telemetry or invent a worker result.
      // An explicit owner-direct transport is different: it is a Host-selected
      // retry transport and may use the injected owner launcher.  The Host is
      // responsible for deciding whether this request is safe.
      if (ownerDirectTransportRequested && !launch) {
        return buildOwnerDirectDispatch({
          invocation,
          parentSessionId,
          actorRole: actorRoute.role,
          sessionPolicy: actorRoute.sessionPolicy,
        });
      }
      if ((!nativeRequested || !nativeAvailable) && !ownerDirectTransportRequested) {
        const independentReviewRequired = isIndependentReviewRequired({ decision, actorRoute, executionContract });
        if (independentReviewRequired) {
          return buildIndependentReviewPending({
            invocation,
            parentSessionId,
            actorRole: actorRoute.role,
            sessionPolicy: actorRoute.sessionPolicy,
            crossSurfaceAvailable: resolved.supportsCrossSurfaceReview === true || resolved.supportsIndependentContext === true,
          });
        }
        if (!independentReviewRequired) {
          return buildOwnerDirectDispatch({
            invocation,
            parentSessionId,
            actorRole: actorRoute.role,
            sessionPolicy: actorRoute.sessionPolicy,
          });
        }
        return buildIndependentReviewPending({
          invocation,
          parentSessionId,
          actorRole: actorRoute.role,
          sessionPolicy: actorRoute.sessionPolicy,
          crossSurfaceAvailable: resolved.supportsCrossSurfaceReview === true || resolved.supportsIndependentContext === true,
        });
      }

      const parentSessionConfigRecord = asRecord(parentSessionConfig);
      const suppliedPair = Boolean(parentSessionConfigRecord.before || parentSessionConfigRecord.after);
      const observationEnvironment = dispatchParentSessionEnvironment || dispatchParentEnvironment || configuredParentSessionEnvironment;
      const observeParent = async (phase: 'before' | 'after') => {
        if (suppliedPair) return normalizeParentObservation(parentSessionConfigRecord[phase], parentSessionId);
        if (parentSessionConfig && phase === 'before') return normalizeParentObservation(parentSessionConfig, parentSessionId);
        try {
          return normalizeParentObservation(await observeParentSession({
            parentSessionId,
            phase,
            parentSessionEnvironment: observationEnvironment,
            parentEnvironment: observationEnvironment,
            environment: environment && typeof environment === 'object' ? asRecord(environment) : null,
            env,
            startedAt: new Date(),
          }), parentSessionId);
        } catch {
          return null;
        }
      };
      const parentBefore = await observeParent('before');
      const parentBeforePolicy = buildCodexMainSessionPolicy({ parentSessionId, observed: parentBefore || {} });
      const routeParentCapabilityUnavailable = isCodexCapabilityUnavailable(actorRoute.parentSessionPolicy);
      const parentBeforeCapabilityUnavailable = isCodexCapabilityUnavailable(parentBeforePolicy);
      if (routeParentCapabilityUnavailable || parentBeforeCapabilityUnavailable || actorRoute.parentSessionPolicy.observationStatus === 'failed' || !['observed', 'enforced'].includes(parentBeforePolicy.observationStatus)) {
        const parentSessionPolicy = actorRoute.parentSessionPolicy.observationStatus === 'failed'
          ? actorRoute.parentSessionPolicy
          : parentBeforePolicy;
        if (isCodexCapabilityUnavailable(parentSessionPolicy)) {
          return buildUnsupportedDispatch({
            invocation,
            parentSessionId,
            parentSessionPolicy,
            actorRole: actorRoute.role,
            sessionPolicy: actorRoute.sessionPolicy,
            dispatchMechanism: 'parent-session-guard',
            capability: parentSessionPolicy.capability?.capability || CODEX_PARENT_SESSION_TELEMETRY_CAPABILITY,
            reason: parentSessionPolicy.capability?.reason || parentSessionPolicy.observationReason,
            remediation: parentSessionPolicy.capability?.remediation || CODEX_PARENT_SESSION_REMEDIATION,
          });
        }
        return {
          status: 'failed',
          resultStatus: 'failed',
          resolvedModel: null,
          resolvedEffort: null,
          requestedModel: invocation.model || null,
          requestedEffort: invocation.effort || null,
          observedModel: null,
          observedEffort: null,
          dispatchMechanism: 'parent-session-guard',
          actorRole: actorRoute.role,
          sessionPolicy: actorRoute.sessionPolicy,
          parentSessionPolicy,
          enforcementStatus: 'failed',
          enforcementReason: `parent-session-invariant-${parentSessionPolicy.observationReason}`,
          errorCode: 'parent-session-invariant-failed',
          actorSessionId: null,
          invocation,
        };
      }
      // A snapshot is enough to prove the parent before launch, but it is not
      // the final invariant. The after snapshot below must match the same
      // parent session identity before this dispatch can be reported as
      // successful; its model and effort remain telemetry only.
      const parentSessionPolicyBefore = parentBeforePolicy;
      const invoke = async (
        selectedLaunch: NativeLaunch | null,
        selectedDispatchMechanism: string,
        selectedFallbackReason: unknown = null,
      ): Promise<{ result: UnknownRecord; dispatchMechanism: string; fallbackReason: unknown }> => {
        if (!selectedLaunch) return { result: {}, dispatchMechanism: selectedDispatchMechanism, fallbackReason: selectedFallbackReason };
        const result = asRecord(await selectedLaunch({
          invocation: providerInvocation,
          message: providerMessage,
          modelVisiblePrompt: providerPrompt,
          taskName,
          workingDirectory: typeof workingDirectory === 'string' ? workingDirectory : null,
          environment: providerEnvironment(environment),
          parentSessionId: typeof parentSessionId === 'string' ? parentSessionId : null,
          concurrencyGroup: typeof concurrencyGroup === 'string' ? concurrencyGroup : null,
          childSession: providerChildSession(childSession),
        }));
        return { result, dispatchMechanism: selectedDispatchMechanism, fallbackReason: selectedFallbackReason };
      };

      const nativeSelected = requestedTransport === 'native-subagent'
        ? nativeAvailable
        : ownerDirectTransportRequested
          ? false
          : nativeAvailable;
      let selectedLaunch: NativeLaunch | null = nativeSelected ? effectiveNativeLaunch : launch;
      let dispatchMechanism = nativeSelected ? 'native-subagent' : 'owner-direct';
      let fallbackReason: unknown = actionContext?.transportFallbackReason || null;
      let invocationResult: { result: UnknownRecord; dispatchMechanism: string; fallbackReason: unknown };
      let caughtError: unknown = null;
      try {
        invocationResult = await invoke(selectedLaunch, dispatchMechanism);
      } catch (error: unknown) {
        caughtError = error;
        const errorRecord = asRecord(error);
        const failureDetailsRecord = asRecord(errorRecord.details);
        const failureDetails = Object.keys(failureDetailsRecord).length > 0 ? failureDetailsRecord : null;
        const failureStage = errorRecord.failureStage || failureDetailsRecord.failureStage || 'launch';
        const providerExecutionEvidence = hasCodexProviderExecutionEvidence(errorRecord)
          || hasCodexProviderExecutionEvidence(failureDetails);
        const semanticErrorPayload = {
          ...codexReviewerResultFields(failureDetailsRecord.result),
          ...codexReviewerResultFields(failureDetails),
          ...codexReviewerResultFields(errorRecord),
        };
        const errorLauncherFailure = errorRecord.launcherFailure || failureDetailsRecord.launcherFailure || null;
        invocationResult = {
          result: {
            status: 'failed',
            resultStatus: 'failed',
            errorCode: errorRecord.code || 'codex-launch-failed',
            errorSummary: errorRecord.message || String(error),
            failureCategory: errorRecord.failureCategory || failureDetailsRecord.failureCategory || 'provider/infrastructure',
            failureStage,
            remediation: failureDetailsRecord.remediation || null,
            ...semanticErrorPayload,
            runtimePreflight: failureDetails && failureStage === 'pre-spawn' && !providerExecutionEvidence ? {
              status: 'failed',
              errorCode: errorRecord.code || 'codex-launch-failed',
              failureCategory: failureDetailsRecord.failureCategory || 'provider/infrastructure',
              failureStage,
              remediation: failureDetailsRecord.remediation || null,
              credentialContentsInspected: failureDetailsRecord.credentialContentsInspected ?? null,
              userHomeAuthAvailable: failureDetailsRecord.userHomeAuthAvailable ?? null,
              cacheStatus: failureDetailsRecord.cacheStatus || null,
              cacheClientVersion: failureDetailsRecord.cacheClientVersion || null,
              executableVersion: failureDetailsRecord.executableVersion || null,
              probeTimeoutMs: failureDetailsRecord.probeTimeoutMs ?? null,
              effectiveSandbox: failureDetailsRecord.effectiveSandbox || null,
              effectiveApprovalPolicy: failureDetailsRecord.effectiveApprovalPolicy || null,
              effectivePermissionProfile: failureDetailsRecord.effectivePermissionProfile || null,
              ...codexReviewerResultFields(failureDetailsRecord.runtimePreflight),
            } : null,
            // Provider execution evidence makes a claimed pre-spawn failure
            // contradictory. Preserve that fact as a terminal launcher failure
            // so the review dispatcher cannot safely retry another reviewer.
            launcherFailure: errorLauncherFailure || ((providerExecutionEvidence || (failureDetails && failureStage !== 'pre-spawn')) ? {
              status: 'failed',
              errorCode: errorRecord.code || 'codex-launch-failed',
              failureStage,
              providerExecutionEvidence,
              cleanupStatus: failureDetailsRecord.cleanupStatus || null,
              cleanupClassification: failureDetailsRecord.cleanupClassification || null,
              lineageSource: failureDetailsRecord.lineageSource || null,
              survivorCount: failureDetailsRecord.survivors ?? null,
            } : null),
          },
          dispatchMechanism,
          fallbackReason,
        };
      }
      let result: UnknownRecord = invocationResult.result;

      const actualLauncher = Boolean(selectedLaunch);
      const preSpawnFailure = (result.status === 'failed' || result.resultStatus === 'failed')
        && result.failureStage === 'pre-spawn';
      const providerExecutionEvidence = hasCodexProviderExecutionEvidence(result);
      const launcherFailure = result.launcherFailure ?? (preSpawnFailure && providerExecutionEvidence ? {
        status: 'failed',
        errorCode: result.errorCode || 'codex-launch-failed',
        failureStage: 'pre-spawn',
        providerExecutionEvidence: true,
      } : null);
      const identityRequired = Boolean(invocation.model || invocation.effort);
      const observeResult = (candidateValue: unknown, mechanism: string) => {
        const candidate = asRecord(candidateValue);
        const terminalEvents = Array.isArray(candidate.terminalEvents)
          ? candidate.terminalEvents
          : Array.isArray(candidate.events) ? candidate.events : [];
        const observedConfig = asRecord(
          candidate.observedSessionConfig
          || candidate.observedConfig
          || candidate.observed_session_config
          || candidate.observed_config
          || (terminalEvents.length > 0 ? resolveObservedCodexSessionConfigFromEvents(terminalEvents) : null),
        );
        const requiresTerminalTelemetry = mechanism === 'native-subagent';
        const observedModel = requiresTerminalTelemetry
          ? observedConfig?.model ?? null
          : candidate.resolvedModel ?? candidate.observedModel ?? null;
        const observedEffort = requiresTerminalTelemetry
          ? observedConfig?.effort ?? observedConfig?.reasoning_effort ?? observedConfig?.reasoningEffort ?? null
          : candidate.resolvedEffort ?? candidate.observedEffort ?? null;
        let observation = compareCodexSessionConfig({
          requested: { model: invocation.model, effort: invocation.effort },
          observed: { model: observedModel, effort: observedEffort },
        });
        const lineageReason = requiresTerminalTelemetry && !candidate.sessionId
          ? 'worker-session-observation-missing'
          : requiresTerminalTelemetry && !parentSessionId
            ? 'parent-session-missing'
            : requiresTerminalTelemetry && (String(candidate.sessionId) === String(parentSessionId)
              || nativeSessionId(candidate.sessionId) === nativeSessionId(parentSessionId))
              ? 'worker-session-not-distinct'
              : null;
        if (lineageReason) observation = { ...observation, exact: false, reason: lineageReason };
        return { observedModel, observedEffort, observation, lineageReason };
      };
      let observedResult = observeResult(result, dispatchMechanism);
      if (preSpawnFailure && !providerExecutionEvidence) {
        // A failed launcher may echo the requested model/config even though
        // no provider process existed. Keep that echo out of the receipt and
        // out of any later enforcement interpretation.
        observedResult = {
          ...observedResult,
          observedModel: null,
          observedEffort: null,
        };
      }
      let resolvedModel = observedResult.observedModel;
      let resolvedEffort = observedResult.observedEffort;
      let observation = observedResult.observation;
      const dispatchMismatch = () => actualLauncher && (identityRequired ? !observation.exact : Boolean(observedResult.lineageReason));
      const parentAfter = await observeParent('after');
      const parentSessionPolicy = buildCodexMainSessionPolicy({
        parentSessionId,
        observed: { before: parentBefore || {}, after: parentAfter || {} },
      });
      const parentCapabilityUnavailable = isCodexCapabilityUnavailable(parentSessionPolicy);
      const parentInvariantFailed = parentSessionPolicy.observationStatus !== 'enforced';
      const explicitDispatchFailure = result.status === 'failed'
        || result.resultStatus === 'failed'
        || Boolean(result.errorCode);
      const workerCapabilityUnavailable = dispatchMechanism === 'native-subagent' && !explicitDispatchFailure && isWorkerTelemetryUnavailable({
        actualLauncher,
        identityRequired,
        observation,
        lineageReason: observedResult.lineageReason,
      });
      const capabilityUnavailable = parentCapabilityUnavailable || workerCapabilityUnavailable;
      const failedByEnforcement = parentInvariantFailed || (!explicitDispatchFailure && dispatchMismatch());
      const dispatchFailed = explicitDispatchFailure || failedByEnforcement;
      const explicitFailureCode = result.errorCode
        || (explicitDispatchFailure ? 'codex-worker-failed' : null);
      const unsupportedReason = parentCapabilityUnavailable
        ? parentSessionPolicy.capability?.reason || parentSessionPolicy.observationReason
        : workerCapabilityUnavailable
          ? observation.reason || observedResult.lineageReason
          : null;
      const unsupportedCapability = parentCapabilityUnavailable
        ? parentSessionPolicy.capability?.capability || CODEX_PARENT_SESSION_TELEMETRY_CAPABILITY
        : workerCapabilityUnavailable ? 'worker-session-telemetry' : null;
      const completionOutcome = capabilityUnavailable ? null : (result.outcome ?? null);
      const completionReport = capabilityUnavailable ? null : (result.report ?? null);
      return {
        status: capabilityUnavailable ? 'unsupported' : dispatchFailed ? 'failed' : (result.status || 'completed'),
        resultStatus: capabilityUnavailable ? 'failed' : dispatchFailed ? 'failed' : (result.resultStatus || (result.status === 'failed' ? 'failed' : 'completed')),
        // Codex reports no usage tokens today; they stay unavailable rather
        // than being invented as zeros.
        resolvedModel,
        resolvedEffort,
        requestedModel: invocation.model || null,
        requestedEffort: invocation.effort || null,
        observedModel: resolvedModel,
        observedEffort: resolvedEffort,
        dispatchMechanism,
        actorRole: actorRoute.role,
        sessionPolicy: actorRoute.sessionPolicy,
        parentSessionPolicy,
        enforcementStatus: capabilityUnavailable ? 'unsupported' : dispatchFailed ? 'failed' : (actualLauncher && identityRequired ? 'enforced' : null),
        enforcementReason: capabilityUnavailable
          ? unsupportedReason
          : parentInvariantFailed
          ? `parent-session-invariant-${parentSessionPolicy.observationReason}`
          : explicitDispatchFailure
          ? explicitFailureCode
          : failedByEnforcement
          ? observation.reason
          : null,
        fallbackReason,
        errorCode: capabilityUnavailable
          ? CODEX_HOST_UNSUPPORTED_CAPABILITY
          : parentInvariantFailed
          ? 'parent-session-invariant-failed'
          : explicitDispatchFailure
          ? explicitFailureCode
          : failedByEnforcement ? 'model-enforcement-failed' : (result.errorCode ?? null),
        errorSummary: capabilityUnavailable
          ? `${unsupportedCapability} is unavailable: ${unsupportedReason}. ${parentSessionPolicy.capability?.remediation || CODEX_PARENT_SESSION_REMEDIATION}`
          : result.errorSummary ?? null,
        failureCategory: result.failureCategory ?? null,
        failureStage: result.failureStage ?? null,
        remediation: result.remediation ?? null,
        launcherFailure,
        capability: capabilityUnavailable
          ? buildUnsupportedCapability({
            capability: unsupportedCapability,
            reason: unsupportedReason,
            remediation: parentSessionPolicy.capability?.remediation || CODEX_PARENT_SESSION_REMEDIATION,
          })
          : null,
        unsupportedCapability: capabilityUnavailable
          ? buildUnsupportedCapability({
            capability: unsupportedCapability,
            reason: unsupportedReason,
            remediation: parentSessionPolicy.capability?.remediation || CODEX_PARENT_SESSION_REMEDIATION,
          })
          : null,
        actorSessionId: result.sessionId || null,
        wallClockMs: result.wallClockMs ?? null,
        inputTokens: result.inputTokens ?? null,
        cachedInputTokens: result.cachedInputTokens ?? null,
        outputTokens: result.outputTokens ?? null,
        runtimePreflight: result.runtimePreflight ?? null,
        outcome: completionOutcome,
        report: completionReport,
        // Only forwarded when the Host observed them; the receipt gates these
        // on the declared capability regardless.
        cacheReadInputTokens: result.cacheReadInputTokens ?? null,
        cacheWriteInputTokens: result.cacheWriteInputTokens ?? null,
        previousResponseId: result.previousResponseId ?? null,
        speedMode: result.speedMode ?? null,
        parentSessionId: parentSessionId || null,
        invocation,
      };
    },
  };
};
