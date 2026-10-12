// Kernel next/report -> Host execution bridge (Wave R4).
//
// This module is an internal Host integration surface. It deliberately adds no
// MCP tool and no Kernel workflow stage. A trusted embedding Host supplies a
// provider adapter (or a native Host object); the existing turn dispatcher
// remains the only path that can mint usage and ReviewReceipt provenance.

import { createClaudeAdapter } from './adapters/claude.js';
import { createCodexAdapter } from './adapters/codex.js';
import { createAdeAdapter } from './adapters/ade.js';
import { createGeminiAdapter } from './adapters/gemini.js';
import { createModelRegistry } from './model-registry.js';
import { dispatchKernelTurn } from './turn-dispatcher.js';
import { assessReviewReadiness } from './review-readiness.js';
import {
  createIndependentSubagentReviewTransport,
} from './independent-subagent-review.js';

type UnknownRecord = Record<string, unknown>;
type ReadinessInput = NonNullable<Parameters<typeof assessReviewReadiness>[0]>;
type ObjectFactory = (input: UnknownRecord) => unknown;
type AsyncObjectPort = (input: UnknownRecord) => unknown | Promise<unknown>;

interface ActionLike extends UnknownRecord {
  type?: unknown;
  independentReviewRequired?: unknown;
  outstandingObligations?: unknown;
  step?: UnknownRecord | null;
}

interface WorkAuthorityLike {
  currentWorkUnit?: UnknownRecord | null;
}

interface ModelInputLike extends UnknownRecord {
  action?: ActionLike | null;
  changedPaths?: unknown;
  workAuthority?: WorkAuthorityLike | null;
}

interface RunLike extends UnknownRecord {
  taskContract?: UnknownRecord | null;
  mutationRevision?: unknown;
}

interface AdapterCapabilitiesLike extends UnknownRecord {
  surface?: unknown;
  supportsIndependentContext?: unknown;
  supportsReadOnlyReview?: unknown;
}

interface AdapterLike extends UnknownRecord {
  capabilities?: AdapterCapabilitiesLike | null;
  surface?: unknown;
  nativeDelegationAvailable?: unknown;
  dispatch?: unknown;
}

interface CandidateEntry extends UnknownRecord {
  adapter?: AdapterLike | null;
  registry?: UnknownRecord | null;
}

type DispatcherInput = NonNullable<Parameters<typeof dispatchKernelTurn>[0]>;
type ControlPlaneLike = NonNullable<DispatcherInput['controlPlane']> & {
  getRunObligations?: (runId: string) => unknown[];
  getRun?: (runId: string) => RunLike | null | Promise<RunLike | null>;
  getRunVerifications?: (runId: string) => unknown[];
  recordRunEfficiency?: (runId: string, patch: UnknownRecord) => unknown;
}

interface ReadinessLike extends UnknownRecord {
  canComplete?: unknown;
  status?: unknown;
  blockers?: readonly unknown[];
}

interface DispatchResultLike extends UnknownRecord {
  reviewReceiptId?: unknown;
  dispatched?: unknown;
  blocker?: unknown;
  receipt?: UnknownRecord | null;
  wait?: UnknownRecord | null;
  dispatch?: UnknownRecord | null;
  review?: UnknownRecord | null;
}

interface AssessInput {
  controlPlane?: ControlPlaneLike | null;
  runId?: string | null;
  modelInput?: ModelInputLike | null;
  implementationOnly?: boolean;
  workspaceBaseline?: UnknownRecord | null;
  verificationCommands?: UnknownRecord[] | null;
}

interface DispatchReviewInput {
  controlPlane?: ControlPlaneLike | null;
  runId?: string | null;
  modelInput?: ModelInputLike | null;
  actionContext?: UnknownRecord;
  implementationOnly?: boolean;
}

interface BridgeOptions {
  adapter?: unknown;
  registry?: unknown;
  surface?: string;
  nativeAgentHost?: NonNullable<Parameters<typeof createCodexAdapter>[0]>['nativeAgentHost'];
  runtimeHome?: string | null;
  env?: NodeJS.ProcessEnv;
  overrides?: import('./model-registry.js').ModelOverrideMap & { geminiLauncher?: NonNullable<Parameters<typeof createGeminiAdapter>[0]>['launch']; geminiCapabilities?: UnknownRecord };
  reviewFallbacks?: unknown[];
  hostAdapters?: unknown[];
  reviewTransports?: unknown[];
  parentSessionId?: string | null;
  parentSessionConfig?: unknown;
  parentSessionObserver?: NonNullable<Parameters<typeof createCodexAdapter>[0]>['parentSessionObserver'];
  toolPolicy?: UnknownRecord;
  permissionPolicy?: UnknownRecord;
  economics?: UnknownRecord;
}

export const KERNEL_HOST_REVIEW_BRIDGE_SCHEMA_VERSION = 1;

const isObject = (value: unknown): value is UnknownRecord => Boolean(
  value && typeof value === 'object' && !Array.isArray(value),
);

const recordOf = (value: unknown): UnknownRecord => (
  isObject(value) ? value : {}
);

const adapterOf = (value: unknown): AdapterLike => (
  isObject(value) ? value as AdapterLike : {}
);

const entryOf = (value: unknown): CandidateEntry => (
  isObject(value) ? value as CandidateEntry : {}
);

const list = (value: unknown): unknown[] => (
  Array.isArray(value) ? value : []
);

const first = (value: unknown): string | null => (
  list(value).length > 0 ? String(list(value)[0]) : null
);

const dispatcherAdapter = (value: unknown): NonNullable<DispatcherInput['adapter']> => {
  const record = recordOf(value);
  if (typeof record.dispatch !== 'function') throw new Error('host_adapter_dispatch_required');
  if (record.surface != null && typeof record.surface !== 'string') throw new Error('host_adapter_surface_invalid');
  if (record.capabilities != null && !isObject(record.capabilities)) throw new Error('host_adapter_capabilities_invalid');
  return { ...record, dispatch: record.dispatch as NonNullable<DispatcherInput['adapter']>['dispatch'], surface: typeof record.surface === 'string' ? record.surface : undefined, capabilities: isObject(record.capabilities) ? record.capabilities : undefined };
};
const dispatcherRegistry = (value: unknown): NonNullable<DispatcherInput['registry']> => {
  const record = recordOf(value);
  if (typeof record.resolve !== 'function') throw new Error('host_registry_resolve_required');
  return { ...record, resolve: record.resolve as NonNullable<DispatcherInput['registry']>['resolve'] };
};

const isReviewAction = (modelInput: ModelInputLike = {}): boolean => Boolean(
  modelInput.action?.type === 'review'
  && modelInput.action?.independentReviewRequired === true
);

const runObligationsFor = (
  controlPlane: ControlPlaneLike | null | undefined,
  runId: string,
): unknown[] => (
  typeof controlPlane?.getRunObligations === 'function'
    ? controlPlane.getRunObligations(runId)
    : []
);

const runFor = async (
  controlPlane: ControlPlaneLike | null | undefined,
  runId: string,
): Promise<RunLike | null> => (
  typeof controlPlane?.getRun === 'function'
    ? await controlPlane.getRun(runId)
    : null
);

const recordEfficiency = (
  controlPlane: ControlPlaneLike | null | undefined,
  runId: string,
  patch: UnknownRecord = {},
): void => {
  if (typeof controlPlane?.recordRunEfficiency !== 'function') return;
  try {
    controlPlane.recordRunEfficiency(runId, patch);
  } catch {
    // Telemetry never changes review authority.
  }
};

const actionContextForReview = ({
  modelInput = {},
  actionContext = {},
}: {
  modelInput?: ModelInputLike;
  actionContext?: UnknownRecord;
} = {}): UnknownRecord => ({
  ...actionContext,
  actionKind: 'review_engineering',
  obligationId:
    actionContext.obligationId
    || first(modelInput.action?.outstandingObligations),
  executionMode: 'native-subagent',
  delegationRequested: true,
  independentReviewRequired: true,
  changedPaths: actionContext.changedPaths || modelInput.changedPaths || [],
});

const summarizeReviewDispatch = (
  resultValue: unknown,
  readiness: ReadinessLike,
): UnknownRecord => {
  const result = recordOf(resultValue);
  const dispatch = recordOf(result.dispatch);
  const review = recordOf(result.review);
  const nestedReview = recordOf(review.review);
  return {
    schemaVersion: KERNEL_HOST_REVIEW_BRIDGE_SCHEMA_VERSION,
    status: result.reviewReceiptId
      ? 'receipt-recorded'
      : result.dispatched
        ? (review.status || 'pending')
        : 'blocked',
    reviewReceiptId: result.reviewReceiptId || null,
    transport: dispatch.dispatchMechanism || null,
    verdict: nestedReview.verdict || null,
    findings: nestedReview.findings || [],
    evidenceRefs: nestedReview.evidenceRefs || [],
    blocker: result.blocker || (review.blockedReason ? {
      reason: review.blockedReason,
      detail: review.errorSummary || null,
    } : null),
    readiness,
    wait: {
      owner: 'host',
      strategy: 'single-bounded-dispatch',
      repeatedPolling: false,
    },
  };
};

export const createKernelHostReviewBridge = ({
  adapter = null,
  registry = null,
  surface = 'codex',
  nativeAgentHost = globalThis,
  runtimeHome = null,
  env = process.env,
  overrides = {},
  reviewFallbacks = [],
  hostAdapters = [],
  reviewTransports = [],
  parentSessionId = null,
  parentSessionConfig = null,
  parentSessionObserver = null,
  toolPolicy = {},
  permissionPolicy = {},
  economics = {},
}: BridgeOptions = {}) => {
  const suppliedAdapter = adapterOf(adapter);
  const suppliedCapabilities = adapterOf(suppliedAdapter.capabilities);
  const effectiveSurface = String(
    suppliedCapabilities.surface
    || suppliedAdapter.surface
    || surface
    || 'codex',
  ).toLowerCase();

  const createdAdapter = effectiveSurface === 'codex'
    ? createCodexAdapter({
        nativeAgentHost,
        runtimeHome,
        env,
        parentSessionObserver,
      })
    : effectiveSurface === 'claude'
      ? createClaudeAdapter({})
      : effectiveSurface === 'gemini'
        ? createGeminiAdapter({
            launch: overrides.geminiLauncher || null,
            capabilities: recordOf(overrides.geminiCapabilities),
          })
        : ['ade', 'ade_cli'].includes(effectiveSurface)
          ? createAdeAdapter({ nativeAgentHost })
          : null;

  const effectiveAdapter = adapter
    ? suppliedAdapter
    : adapterOf(createdAdapter);

  const effectiveRegistry = registry
    ? recordOf(registry)
    : recordOf(createModelRegistry({
        surface: effectiveSurface,
        runtimeHome,
        env,
        overrides,
      }));

  const independentSubagentTransport = createIndependentSubagentReviewTransport({
    host: nativeAgentHost,
    surface: effectiveSurface,
    env,
  });
  const independentAdapter = adapterOf(independentSubagentTransport);
  const effectiveReviewTransports: CandidateEntry[] = [
    ...reviewTransports.map(entryOf),
    ...(independentSubagentTransport.nativeDelegationAvailable
      ? [{ adapter: independentAdapter, registry: effectiveRegistry }]
      : []),
  ];

  const reviewCandidateForReadiness = (): CandidateEntry & {
    adapter: AdapterLike;
    registry: UnknownRecord;
    available?: false;
  } => {
    const entries: CandidateEntry[] = [
      { adapter: effectiveAdapter, registry: effectiveRegistry },
      ...reviewFallbacks.map(entryOf),
      ...hostAdapters.map(entryOf),
      ...effectiveReviewTransports,
    ];

    for (const entry of entries) {
      const candidate = entry.adapter || adapterOf(entry);
      const capabilities = adapterOf(candidate.capabilities);
      if (
        candidate.nativeDelegationAvailable !== true
        || typeof candidate.dispatch !== 'function'
        || capabilities.supportsIndependentContext !== true
        || capabilities.supportsReadOnlyReview !== true
      ) {
        continue;
      }

      const candidateSurface = String(
        capabilities.surface || candidate.surface || '',
      ).toLowerCase();
      const candidateRegistry = entry.registry
        ? recordOf(entry.registry)
        : candidateSurface === effectiveSurface
          ? effectiveRegistry
          : recordOf(createModelRegistry({
              surface: candidateSurface,
              runtimeHome,
              env,
              overrides,
            }));

      return {
        adapter: candidate,
        registry: candidateRegistry,
      };
    }

    return {
      adapter: effectiveAdapter,
      registry: effectiveRegistry,
      available: false,
    };
  };

  // `kernel_next` can be delivered concurrently to two Host callers. Keep the
  // review launch itself single-flight for one run/revision/obligation so both
  // callers observe the same Kernel receipt instead of creating two provider
  // sessions. This is process-local by design; the durable receipt remains the
  // cross-process authority and no new state table is introduced.
  const inFlightReviews = new Map<string, Promise<UnknownRecord>>();

  const assess = async ({
    controlPlane = null,
    runId = null,
    modelInput = null,
    implementationOnly = false,
    workspaceBaseline = null,
    verificationCommands = null,
  }: AssessInput = {}): Promise<ReadinessLike> => {
    const activeRunId = String(runId || '');
    const run = await runFor(controlPlane, activeRunId);
    const obligations = runObligationsFor(controlPlane, activeRunId);
    const verifications = typeof controlPlane?.getRunVerifications === 'function'
      ? controlPlane.getRunVerifications(activeRunId)
      : [];
    const reviewCandidate = reviewCandidateForReadiness();
    const reviewAvailable = reviewCandidate.available !== false;
    const capabilities = adapterOf(reviewCandidate.adapter.capabilities);

    const result = await assessReviewReadiness({
      run: run as ReadinessInput['run'],
      contract: (run?.taskContract || null) as ReadinessInput['contract'],
      modelInput: modelInput as ReadinessInput['modelInput'],
      obligations: obligations as ReadinessInput['obligations'],
      adapter: reviewCandidate.adapter,
      registry: reviewCandidate.registry,
      controlPlane: controlPlane
        ? controlPlane
        : null,
      verifications: verifications as ReadinessInput['verifications'],
      workspaceBaseline:
        workspaceBaseline as ReadinessInput['workspaceBaseline'],
      verificationCommands:
        verificationCommands as ReadinessInput['verificationCommands'],
      permission: modelInput?.action?.type === 'review'
        ? { filesystem: 'read_only' }
        : null,
      reviewExecutionAvailable: reviewAvailable,
      reviewIndependentContextAvailable:
        reviewAvailable
        && capabilities.supportsIndependentContext === true,
      reviewReadOnlyAvailable:
        reviewAvailable
        && capabilities.supportsReadOnlyReview === true,
      implementationOnly,
      env,
    });
    return result as ReadinessLike;
  };

  const reviewDispatchKey = async ({
    controlPlane = null,
    runId = null,
    modelInput = null,
  }: Pick<DispatchReviewInput, 'controlPlane' | 'runId' | 'modelInput'> = {}): Promise<string> => {
    const activeRunId = String(runId || '');
    const run = await runFor(controlPlane, activeRunId);
    const currentWorkUnit = recordOf(modelInput?.workAuthority?.currentWorkUnit);
    return JSON.stringify({
      runId: activeRunId,
      mutationRevision: run?.mutationRevision ?? null,
      stepId:
        modelInput?.action?.step?.stepId
        || currentWorkUnit.stepId
        || null,
      obligations: [
        ...new Set(
          list(modelInput?.action?.outstandingObligations).map(String),
        ),
      ].sort(),
    });
  };

  const dispatchReview = async ({
    controlPlane = null,
    runId = null,
    modelInput = null,
    actionContext = {},
    implementationOnly = false,
  }: DispatchReviewInput = {}): Promise<UnknownRecord> => {
    if (!controlPlane || !runId || !modelInput || !isReviewAction(modelInput)) {
      return {
        schemaVersion: KERNEL_HOST_REVIEW_BRIDGE_SCHEMA_VERSION,
        dispatched: false,
        status: 'blocked',
        reason: 'review-action-required',
        review: {
          required: true,
          status: 'blocked',
          blockedReason: 'review-action-required',
        },
        reviewReceipt: null,
        reviewReceiptId: null,
      };
    }

    recordEfficiency(controlPlane, runId, {
      timestamps: { reviewRequestedAt: new Date().toISOString() },
    });

    const key = await reviewDispatchKey({
      controlPlane,
      runId,
      modelInput,
    });
    const inFlight = inFlightReviews.get(key);
    if (inFlight) return inFlight;

    const operation = (async (): Promise<UnknownRecord> => {
      const readiness = await assess({
        controlPlane,
        runId,
        modelInput,
        implementationOnly,
      });
      const blockers = Array.isArray(readiness.blockers)
        ? readiness.blockers
        : [];
      if (readiness.canComplete !== true) {
        const degraded = readiness.status === 'DEGRADED';
        const reason = degraded
          ? 'review-receipt-attestation-unavailable'
          : String(blockers[0] || 'review-readiness-blocked');
        return {
          schemaVersion: KERNEL_HOST_REVIEW_BRIDGE_SCHEMA_VERSION,
          runId,
          dispatched: false,
          executionMode: 'independent-review',
          reason,
          readiness,
          modelInput,
          review: {
            required: true,
            independent: true,
            status: 'blocked',
            blockedReason: reason,
          },
          reviewReceipt: null,
          reviewReceiptId: null,
        };
      }

      recordEfficiency(controlPlane, runId, {
        timestamps: { reviewSpawnedAt: new Date().toISOString() },
      });

      let result: DispatchResultLike | null = null;
      try {
        const dispatched = await dispatchKernelTurn({
          controlPlane,
          runId,
          adapter: dispatcherAdapter(effectiveAdapter),
          registry: dispatcherRegistry(effectiveRegistry),
          runtimeHome,
          env,
          overrides,
          actionContext: actionContextForReview({
            modelInput,
            actionContext,
          }),
          parentSessionId,
          parentSessionConfig,
          toolPolicy,
          permissionPolicy,
          economics,
          reviewFallbacks,
          hostAdapters,
          reviewTransports: effectiveReviewTransports,
        });
        result = recordOf(dispatched) as DispatchResultLike;
        return {
          ...result,
          readiness,
          hostReview: summarizeReviewDispatch(result, readiness),
        };
      } finally {
        const receipt = recordOf(result?.receipt);
        const wait = recordOf(result?.wait);
        recordEfficiency(controlPlane, runId, {
          timestamps: {
            reviewFinishedAt:
              receipt.finishedAt || new Date().toISOString(),
          },
          increments:
            wait.timedOut === true || wait.status === 'timeout'
              ? { waitTimeoutCount: 1 }
              : {},
        });
      }
    })();

    inFlightReviews.set(key, operation);
    try {
      return await operation;
    } finally {
      if (inFlightReviews.get(key) === operation) {
        inFlightReviews.delete(key);
      }
    }
  };

  return Object.freeze({
    schemaVersion: KERNEL_HOST_REVIEW_BRIDGE_SCHEMA_VERSION,
    kind: 'kernel-host-review-bridge',
    hostCapabilities: effectiveAdapter.capabilities || null,
    assess,
    dispatchReview,
  });
};

export const isKernelReviewAction = isReviewAction;
