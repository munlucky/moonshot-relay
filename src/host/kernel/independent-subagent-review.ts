// Host-owned independent reviewer transport.
//
// This is intentionally a transport, not a second Kernel authority. A Host
// may expose an independent-subagent launcher when its native reviewer bridge
// is unavailable. The launcher returns a structured reviewer result plus a
// Host attestation; the common dispatcher verifies that attestation before it
// allows the existing Kernel receipt path to ingest the verdict.

import { observeWorkspaceIdentity } from './workspace/workspace-identity.js';
import {
  buildModelVisiblePromptMessage,
  buildModelVisiblePromptView,
} from './model-capsule-view.js';

type UnknownRecord = Record<string, unknown>;
type ProviderScalar = string | number | boolean;

interface CallableRecord extends UnknownRecord {
  waitForOutcome?: () => unknown | Promise<unknown>;
  wait?: () => unknown | Promise<unknown>;
  result?: unknown;
  cancel?: () => unknown | Promise<unknown>;
  abort?: () => unknown | Promise<unknown>;
  terminate?: () => unknown | Promise<unknown>;
  close?: () => unknown | Promise<unknown>;
}

type ReviewerLauncher = (
  request: UnknownRecord & { signal?: AbortSignal },
) => unknown | Promise<unknown>;

interface ReviewResolution extends UnknownRecord {
  model?: unknown;
  effort?: unknown;
}

interface ReviewDecision extends UnknownRecord {
  role?: unknown;
}

interface ReviewAttestation extends UnknownRecord {
  schemaVersion?: unknown;
  transport?: unknown;
  executionId?: unknown;
  childSessionId?: unknown;
  parentSessionId?: unknown;
  requestedModel?: unknown;
  requestedEffort?: unknown;
  observedModel?: unknown;
  observedEffort?: unknown;
  workspaceIdentityBefore?: unknown;
  workspaceIdentityAfter?: unknown;
  actualWorkspaceIdentityBefore?: unknown;
  actualWorkspaceIdentityAfter?: unknown;
  mutationRevisionBefore?: unknown;
  mutationRevisionAfter?: unknown;
  capsuleDigest?: unknown;
  freshContext?: unknown;
  readOnly?: unknown;
  canCommit?: unknown;
  canDelegate?: unknown;
  cleanupStatus?: unknown;
}

interface ReviewSubject extends UnknownRecord {
  workspaceIdentity?: unknown;
  mutationRevision?: unknown;
  capsuleDigest?: unknown;
}

interface WorkspaceObservationLike {
  identity?: unknown;
}

interface ReviewCapabilities extends UnknownRecord {
  supportsUsageTokens?: unknown;
  supportsIndependentContext?: unknown;
  supportsIndependentSubagentReview?: unknown;
  supportsSubagentModel?: unknown;
  semantic?: UnknownRecord | null;
}

interface FailureInput {
  errorCode?: unknown;
  errorSummary?: unknown;
  failureStage?: unknown;
  failureCategory?: unknown;
  launcherFailure?: unknown;
  timedOut?: boolean;
}

interface InvocationResult {
  result: UnknownRecord;
  wallClockMs: number;
  timedOut: boolean;
}

interface TimedOutInvocation {
  result: UnknownRecord;
  wallClockMs: number;
  timedOut: true;
}

interface CompletedInvocation {
  result: UnknownRecord;
  wallClockMs: number;
  timedOut: false;
}

type InvocationOutcome = TimedOutInvocation | CompletedInvocation;

interface TransportDispatchInput {
  decision?: ReviewDecision | null;
  resolution?: ReviewResolution | null;
  modelInput?: UnknownRecord;
  executionCapsule?: UnknownRecord | null;
  workingDirectory?: string | null;
  environment?: unknown;
  parentSessionId?: string | null;
  concurrencyGroup?: string | null;
  childSession?: unknown;
  reviewSubject?: ReviewSubject | null;
}

export const INDEPENDENT_SUBAGENT_REVIEW_SCHEMA_VERSION = 1;
export const INDEPENDENT_SUBAGENT_REVIEW_TRANSPORT = 'independent-subagent';
export const INDEPENDENT_SUBAGENT_REVIEW_DEFAULT_TIMEOUT_MS = 90000;

const isObject = (value: unknown): value is UnknownRecord => (
  Boolean(value && typeof value === 'object' && !Array.isArray(value))
);

const recordOf = (value: unknown): UnknownRecord => (
  isObject(value) ? value : {}
);

const callableRecordOf = (value: unknown): CallableRecord => (
  isObject(value) ? value as CallableRecord : {}
);

const present = (value: unknown): boolean => (
  value !== null && value !== undefined && String(value).trim() !== ''
);

const providerEnvironment = (
  value: unknown,
): Readonly<Record<string, ProviderScalar>> | UnknownRecord | null => {
  if (!isObject(value)) return null;
  const safe: Record<string, ProviderScalar> = {};
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
        || (typeof next === 'number' && Number.isFinite(next))
      ) {
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

const providerChildSession = (_value: unknown) => ({
  role: 'reviewer',
  freshSessionRequired: true,
  canCommit: false,
  canDelegate: false,
  permissions: 'read_only',
});

const normalizeReviewOutcome = (value: unknown): UnknownRecord => {
  if (
    !isObject(value)
    || !['pass', 'fail', 'blocked'].includes(String(value.verdict || ''))
  ) {
    throw new Error(
      'independent_subagent_review_output_invalid: verdict must be pass, fail, or blocked',
    );
  }
  for (const field of ['findings', 'risks', 'evidenceRefs']) {
    if (!Array.isArray(value[field])) {
      throw new Error(
        `independent_subagent_review_output_invalid: ${field} must be an array`,
      );
    }
  }
  return value;
};

export const buildIndependentSubagentReviewPrompt = ({
  modelInput = {},
  executionCapsule = null,
}: {
  modelInput?: UnknownRecord;
  executionCapsule?: UnknownRecord | null;
} = {}): string => {
  const providerPrompt = buildModelVisiblePromptView({
    modelInput,
    capsule: executionCapsule,
  });
  return buildModelVisiblePromptMessage({
    prompt: providerPrompt,
    review: true,
  });
};

const methodFrom = (
  owner: UnknownRecord | null,
  key: string,
): ReviewerLauncher | null => {
  const candidate = owner?.[key];
  return typeof candidate === 'function'
    ? candidate.bind(owner) as ReviewerLauncher
    : null;
};

const resolveLauncher = ({
  spawnIndependentReviewer = null,
  host = globalThis,
}: {
  spawnIndependentReviewer?: ReviewerLauncher | null;
  host?: unknown;
} = {}): ReviewerLauncher | null => {
  if (typeof spawnIndependentReviewer === 'function') {
    return spawnIndependentReviewer;
  }
  const hostRecord = recordOf(host);
  const codex = isObject(hostRecord.codex) ? hostRecord.codex : null;
  const multiAgent = isObject(hostRecord.multi_agent)
    ? hostRecord.multi_agent
    : isObject(hostRecord.multiAgent)
      ? hostRecord.multiAgent
      : null;

  const candidates: Array<[UnknownRecord | null, string]> = [
    [hostRecord, 'spawn_independent_reviewer'],
    [hostRecord, 'spawnIndependentReviewer'],
    [hostRecord, 'spawn_independent_subagent'],
    [hostRecord, 'spawnIndependentSubagent'],
    [codex, 'spawn_independent_reviewer'],
    [codex, 'spawnIndependentReviewer'],
    [multiAgent, 'spawn_independent_reviewer'],
    [multiAgent, 'spawnIndependentReviewer'],
  ];
  for (const [owner, key] of candidates) {
    const resolved = methodFrom(owner, key);
    if (resolved) return resolved;
  }
  return null;
};

const cleanupHandle = async (
  handle: unknown,
  timeoutMs = 5000,
): Promise<boolean> => {
  if (!isObject(handle)) return false;
  const callable = callableRecordOf(handle);
  const method = ['cancel', 'abort', 'terminate', 'close']
    .find((name) => typeof callable[name] === 'function');
  if (!method) return false;
  const cleanupFn = callable[method];
  if (typeof cleanupFn !== 'function') return false;
  const cleanup = Promise.resolve().then(() => cleanupFn.call(callable));
  await Promise.race([
    cleanup.catch(() => null),
    new Promise((resolve) => setTimeout(resolve, Math.max(1, timeoutMs))),
  ]);
  return true;
};

const resolveHandleResult = async (handle: unknown): Promise<UnknownRecord> => {
  if (!isObject(handle)) return {};
  const callable = callableRecordOf(handle);
  if (typeof callable.waitForOutcome === 'function') {
    return recordOf(await callable.waitForOutcome());
  }
  if (typeof callable.wait === 'function') {
    return recordOf(await callable.wait());
  }
  if (typeof callable.result === 'function') {
    return recordOf(await callable.result());
  }
  return handle;
};

const mergeResult = (
  handle: unknown,
  completed: unknown,
): UnknownRecord => {
  const completedRecord = recordOf(completed);
  const nested = isObject(completedRecord.result)
    ? completedRecord.result
    : {};
  return {
    ...recordOf(handle),
    ...completedRecord,
    ...nested,
  };
};

const failureResult = ({
  errorCode = null,
  errorSummary = null,
  failureStage = null,
  failureCategory = 'provider/transport',
  launcherFailure = null,
  timedOut = false,
}: FailureInput = {}): UnknownRecord => ({
  status: 'failed',
  resultStatus: 'failed',
  errorCode,
  errorSummary,
  failureStage,
  failureCategory,
  launcherFailure,
  timedOut,
  dispatchMechanism: INDEPENDENT_SUBAGENT_REVIEW_TRANSPORT,
  executionMode: 'independent-review',
  outcome: null,
  report: null,
});

const invokeWithTimeout = async ({
  launcher,
  request,
  timeoutMs,
}: {
  launcher: ReviewerLauncher;
  request: UnknownRecord;
  timeoutMs: number;
}): Promise<InvocationOutcome> => {
  const controller = new AbortController();
  let handle: unknown = null;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const startedAt = Date.now();

  const launchPromise = Promise.resolve().then(
    () => launcher({ ...request, signal: controller.signal }),
  );
  launchPromise.then(async (value) => {
    handle = value;
    if (timedOut) await cleanupHandle(value);
  }).catch(() => null);

  const operation: Promise<CompletedInvocation> = launchPromise.then(
    async (value) => {
      handle = value;
      const completed = await resolveHandleResult(value);
      return {
        result: mergeResult(value, completed),
        wallClockMs: Date.now() - startedAt,
        timedOut: false,
      };
    },
  );

  const timeout = new Promise<TimedOutInvocation>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      resolve({
        result: {},
        timedOut: true,
        wallClockMs: Date.now() - startedAt,
      });
    }, timeoutMs);
  });

  const outcome = await Promise.race([operation, timeout]);
  if (timer) clearTimeout(timer);

  if (outcome.timedOut) {
    await cleanupHandle(handle);
    return {
      timedOut: true,
      wallClockMs: outcome.wallClockMs,
      result: failureResult({
        errorCode: 'independent-review-timeout',
        errorSummary:
          `Independent reviewer exceeded the ${timeoutMs}ms Host timeout`,
        failureStage: 'timeout',
        failureCategory: 'transport/infrastructure',
        launcherFailure: {
          status: 'failed',
          errorCode: 'independent-review-timeout',
          failureStage: 'timeout',
          cleanupStatus: handle ? 'requested' : 'unavailable',
        },
        timedOut: true,
      }),
    };
  }
  return outcome;
};

const observeWorkspace = (projectRoot: unknown): WorkspaceObservationLike | null => {
  if (!present(projectRoot)) return null;
  try {
    const observed = observeWorkspaceIdentity({
      projectRoot: String(projectRoot),
    });
    return observed?.identity ? observed : null;
  } catch {
    return null;
  }
};

const attestationFor = (result: unknown): ReviewAttestation | null => {
  const record = recordOf(result);
  const candidate = record.reviewTransportAttestation || record.attestation;
  return isObject(candidate) ? candidate as ReviewAttestation : null;
};

export const validateIndependentSubagentReviewAttestation = ({
  dispatch = null,
  invocation = null,
  reviewSubject = null,
  parentSessionId = null,
}: {
  dispatch?: UnknownRecord | null;
  invocation?: ReviewResolution | null;
  reviewSubject?: ReviewSubject | null;
  parentSessionId?: string | null;
} = {}) => {
  const attestation = attestationFor(dispatch);
  const reasons: string[] = [];

  if (!attestation) reasons.push('attestation-missing');
  if (
    attestation?.schemaVersion
    !== INDEPENDENT_SUBAGENT_REVIEW_SCHEMA_VERSION
  ) {
    reasons.push('attestation-schema-invalid');
  }
  if (attestation?.transport !== INDEPENDENT_SUBAGENT_REVIEW_TRANSPORT) {
    reasons.push('attestation-transport-invalid');
  }

  for (const field of [
    'executionId',
    'childSessionId',
    'observedModel',
    'observedEffort',
    'workspaceIdentityBefore',
    'workspaceIdentityAfter',
    'capsuleDigest',
  ]) {
    if (!present(attestation?.[field])) {
      reasons.push(`attestation-${field}-missing`);
    }
  }

  if (attestation?.freshContext !== true) {
    reasons.push('attestation-fresh-context-not-proven');
  }
  if (attestation?.readOnly !== true) {
    reasons.push('attestation-read-only-not-proven');
  }
  if (attestation?.canCommit !== false) {
    reasons.push('attestation-commit-capability-not-denied');
  }
  if (attestation?.canDelegate !== false) {
    reasons.push('attestation-delegation-capability-not-denied');
  }
  if (attestation?.cleanupStatus !== 'clean') {
    reasons.push('attestation-cleanup-not-proven');
  }

  if (
    invocation?.model
    && attestation?.requestedModel !== invocation.model
  ) {
    reasons.push('attestation-requested-model-mismatch');
  }
  if (
    invocation?.effort
    && String(attestation?.requestedEffort || '').toLowerCase()
      !== String(invocation.effort).toLowerCase()
  ) {
    reasons.push('attestation-requested-effort-mismatch');
  }
  if (
    invocation?.model
    && attestation?.observedModel !== invocation.model
  ) {
    reasons.push('attestation-observed-model-mismatch');
  }
  if (
    invocation?.effort
    && String(attestation?.observedEffort || '').toLowerCase()
      !== String(invocation.effort).toLowerCase()
  ) {
    reasons.push('attestation-observed-effort-mismatch');
  }
  if (
    present(parentSessionId)
    && attestation?.parentSessionId !== parentSessionId
  ) {
    reasons.push('attestation-parent-session-mismatch');
  }
  if (
    present(parentSessionId)
    && attestation?.childSessionId === parentSessionId
  ) {
    reasons.push('attestation-child-session-not-distinct');
  }
  if (
    dispatch?.actorSessionId
    && dispatch.actorSessionId !== attestation?.childSessionId
  ) {
    reasons.push('attestation-dispatch-session-mismatch');
  }

  const expectedWorkspaceIdentity = reviewSubject?.workspaceIdentity || null;
  const expectedMutationRevision = Number(reviewSubject?.mutationRevision);
  const expectedCapsuleDigest = reviewSubject?.capsuleDigest || null;

  if (
    expectedWorkspaceIdentity
    && attestation?.workspaceIdentityBefore !== expectedWorkspaceIdentity
  ) {
    reasons.push('attestation-workspace-before-mismatch');
  }
  if (
    expectedWorkspaceIdentity
    && attestation?.workspaceIdentityAfter !== expectedWorkspaceIdentity
  ) {
    reasons.push('attestation-workspace-after-mismatch');
  }
  if (
    Number.isInteger(expectedMutationRevision)
    && Number(attestation?.mutationRevisionBefore) !== expectedMutationRevision
  ) {
    reasons.push('attestation-mutation-before-mismatch');
  }
  if (
    Number.isInteger(expectedMutationRevision)
    && Number(attestation?.mutationRevisionAfter) !== expectedMutationRevision
  ) {
    reasons.push('attestation-mutation-after-mismatch');
  }
  if (
    expectedCapsuleDigest
    && attestation?.capsuleDigest !== expectedCapsuleDigest
  ) {
    reasons.push('attestation-capsule-digest-mismatch');
  }
  if (
    attestation?.actualWorkspaceIdentityBefore
    !== attestation?.workspaceIdentityBefore
  ) {
    reasons.push('attestation-actual-workspace-before-mismatch');
  }
  if (
    attestation?.actualWorkspaceIdentityAfter
    !== attestation?.workspaceIdentityAfter
  ) {
    reasons.push('attestation-actual-workspace-after-mismatch');
  }
  if (
    attestation?.actualWorkspaceIdentityBefore
    !== attestation?.actualWorkspaceIdentityAfter
  ) {
    reasons.push('attestation-workspace-mutated');
  }

  return Object.freeze({
    valid: reasons.length === 0,
    reasons: Object.freeze([...new Set(reasons)]),
  });
};

export const createIndependentSubagentReviewTransport = ({
  spawnIndependentReviewer = null,
  host = globalThis,
  surface = 'codex',
  timeoutMs = null,
  env = process.env,
  capabilities = {},
}: {
  spawnIndependentReviewer?: ReviewerLauncher | null;
  host?: unknown;
  surface?: string;
  timeoutMs?: number | null;
  env?: NodeJS.ProcessEnv;
  capabilities?: ReviewCapabilities;
} = {}) => {
  const launcher = resolveLauncher({ spawnIndependentReviewer, host });
  const configuredEnvTimeoutRaw = env.MOON_RELAY_KERNEL_REVIEW_TIMEOUT_MS;
  const configuredEnvTimeout = configuredEnvTimeoutRaw != null
    && configuredEnvTimeoutRaw.trim() !== ''
    ? Number(configuredEnvTimeoutRaw)
    : null;
  const usableTimeoutMs = Number.isFinite(Number(timeoutMs))
    && Number(timeoutMs) > 0
    ? Number(timeoutMs)
    : (
      configuredEnvTimeout !== null
      && Number.isFinite(configuredEnvTimeout)
      && configuredEnvTimeout > 0
        ? configuredEnvTimeout
        : INDEPENDENT_SUBAGENT_REVIEW_DEFAULT_TIMEOUT_MS
    );
  const available = typeof launcher === 'function';

  const capabilityInput = recordOf(capabilities);
  const semanticInput = recordOf(capabilities.semantic);
  const resolvedCapabilities: UnknownRecord = {
    surface,
    supportsSubagentModel: available,
    supportsSessionModelOverride: false,
    supportsIndependentContext: available,
    supportsIndependentSubagentReview: available,
    supportsCrossSurfaceReview: false,
    supportsReadOnlyReview: true,
    supportsUsageTokens: capabilities.supportsUsageTokens === true,
    supportsResolvedModelIdentity: true,
    ...capabilityInput,
  };
  resolvedCapabilities.supportsIndependentContext = (
    available && capabilities.supportsIndependentContext !== false
  );
  resolvedCapabilities.supportsIndependentSubagentReview = (
    available && capabilities.supportsIndependentSubagentReview !== false
  );
  resolvedCapabilities.supportsSubagentModel = (
    available && capabilities.supportsSubagentModel !== false
  );
  const resolvedSemantic: UnknownRecord = {
    freshContext: available,
    workspaceWrite: false,
    workspaceIsolation: false,
    parallelExecution: false,
    independentReview: available,
    modelSelection: false,
    ...semanticInput,
  };
  resolvedSemantic.freshContext = (
    available && semanticInput.freshContext !== false
  );
  resolvedSemantic.independentReview = (
    available && semanticInput.independentReview !== false
  );
  resolvedSemantic.workspaceWrite = false;
  resolvedCapabilities.semantic = Object.freeze(resolvedSemantic);

  return {
    surface,
    capabilities: Object.freeze(resolvedCapabilities),
    nativeDelegationAvailable: available,
    ownerDirectAvailable: false,
    ownerDirectDefault: false,
    timeoutMs: usableTimeoutMs,

    async dispatch({
      decision = null,
      resolution = null,
      modelInput = {},
      executionCapsule = null,
      workingDirectory = null,
      environment = null,
      parentSessionId = null,
      concurrencyGroup = null,
      childSession = null,
      reviewSubject = null,
    }: TransportDispatchInput = {}) {
      const invocation: ReviewResolution = {
        model: resolution?.model || null,
        effort: resolution?.effort || null,
        freshSessionRequired: true,
        readOnly: true,
        dispatchMechanism: INDEPENDENT_SUBAGENT_REVIEW_TRANSPORT,
      };

      if (decision?.role !== 'reviewer') {
        return {
          ...failureResult({
            errorCode: 'independent-review-role-required',
            errorSummary:
              'The independent subagent transport only accepts reviewer turns',
            failureStage: 'pre-spawn',
            failureCategory: 'transport',
          }),
          invocation,
        };
      }

      if (!available || !launcher) {
        return {
          ...failureResult({
            errorCode: 'launcher-unavailable',
            errorSummary:
              'The Host does not expose an independent reviewer launcher',
            failureStage: 'pre-spawn',
            failureCategory: 'provider/transport',
          }),
          invocation,
        };
      }

      if (!invocation.model || !invocation.effort) {
        return {
          ...failureResult({
            errorCode: 'independent-review-route-incomplete',
            errorSummary:
              'Independent review requires an explicit model and reasoning effort',
            failureStage: 'pre-spawn',
            failureCategory: 'transport',
          }),
          invocation,
        };
      }

      const before = observeWorkspace(workingDirectory);
      const request: UnknownRecord = {
        schemaVersion: INDEPENDENT_SUBAGENT_REVIEW_SCHEMA_VERSION,
        taskName: 'kernel_reviewer',
        task_name: 'kernel_reviewer',
        model: invocation.model,
        reasoningEffort: invocation.effort,
        reasoning_effort: invocation.effort,
        message: buildIndependentSubagentReviewPrompt({
          modelInput,
          executionCapsule,
        }),
        parentSessionId:
          typeof parentSessionId === 'string' ? parentSessionId : null,
        parent_session_id:
          typeof parentSessionId === 'string' ? parentSessionId : null,
        childSession: providerChildSession(childSession),
        child_session: providerChildSession(childSession),
        workingDirectory:
          typeof workingDirectory === 'string' ? workingDirectory : null,
        working_directory:
          typeof workingDirectory === 'string' ? workingDirectory : null,
        environment: providerEnvironment(environment),
        concurrencyGroup:
          typeof concurrencyGroup === 'string' ? concurrencyGroup : null,
        concurrency_group:
          typeof concurrencyGroup === 'string' ? concurrencyGroup : null,
        timeoutMs: usableTimeoutMs,
        timeout_ms: usableTimeoutMs,
      };

      let invoked: InvocationResult;
      try {
        invoked = await invokeWithTimeout({
          launcher,
          request,
          timeoutMs: usableTimeoutMs,
        });
      } catch (error: unknown) {
        const errorRecord = recordOf(error);
        const details = recordOf(errorRecord.details);
        const failureStage = errorRecord.failureStage
          || details.failureStage
          || 'pre-spawn';
        return {
          ...failureResult({
            errorCode: errorRecord.code || 'independent-review-launch-failed',
            errorSummary:
              error instanceof Error ? error.message : String(error),
            failureStage,
            failureCategory:
              errorRecord.failureCategory
              || details.failureCategory
              || 'provider/transport',
          }),
          invocation,
        };
      }

      const after = observeWorkspace(workingDirectory);
      const result = invoked.result;
      if (invoked.timedOut) {
        return {
          ...result,
          wallClockMs: invoked.wallClockMs,
          invocation,
        };
      }

      let outcome: UnknownRecord;
      try {
        outcome = normalizeReviewOutcome(result.outcome || result.report);
      } catch (error: unknown) {
        return {
          ...failureResult({
            errorCode: 'independent-review-output-invalid',
            errorSummary:
              error instanceof Error ? error.message : String(error),
            failureStage: 'post-spawn',
            failureCategory: 'transport/infrastructure',
          }),
          wallClockMs: invoked.wallClockMs,
          invocation,
          reviewTransportAttestation: attestationFor(result),
        };
      }

      const attestation = attestationFor(result);
      const normalizedAttestation: ReviewAttestation | null = attestation
        ? {
            ...attestation,
            schemaVersion:
              attestation.schemaVersion
              ?? INDEPENDENT_SUBAGENT_REVIEW_SCHEMA_VERSION,
            transport:
              attestation.transport
              ?? INDEPENDENT_SUBAGENT_REVIEW_TRANSPORT,
            actualWorkspaceIdentityBefore: before?.identity || null,
            actualWorkspaceIdentityAfter: after?.identity || null,
          }
        : null;
      const actorSessionId = normalizedAttestation?.childSessionId || null;
      const observedModel = normalizedAttestation?.observedModel || null;
      const observedEffort = normalizedAttestation?.observedEffort || null;

      return {
        status: 'completed',
        resultStatus: 'completed',
        requestedModel: invocation.model,
        requestedEffort: invocation.effort,
        resolvedModel: observedModel,
        resolvedEffort: observedEffort,
        observedModel,
        observedEffort,
        dispatchMechanism: INDEPENDENT_SUBAGENT_REVIEW_TRANSPORT,
        executionMode: 'independent-review',
        actorRole: 'reviewer',
        actorSessionId,
        sessionId: actorSessionId,
        parentSessionId: parentSessionId || null,
        outcome,
        report: null,
        wallClockMs: invoked.wallClockMs,
        inputTokens: result.inputTokens ?? null,
        outputTokens: result.outputTokens ?? null,
        reasoningTokens: result.reasoningTokens ?? null,
        costMicros: result.costMicros ?? null,
        reviewTransportAttestation: normalizedAttestation,
        invocation,
      };
    },
  };
};
