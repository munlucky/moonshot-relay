// Kernel next/report -> Host execution bridge (Wave R4).
//
// This module is an internal Host integration surface. It deliberately adds no
// MCP tool and no Kernel workflow stage. A trusted embedding Host supplies a
// provider adapter (or a native Host object); the existing turn dispatcher
// remains the only path that can mint usage and ReviewReceipt provenance.

import { createClaudeAdapter } from './adapters/claude.mjs';
import { createCodexAdapter } from './adapters/codex.mjs';
import { createAdeAdapter } from './adapters/ade.mjs';
import { createModelRegistry } from './model-registry.mjs';
import { dispatchKernelTurn } from './turn-dispatcher.mjs';
import { assessReviewReadiness } from './review-readiness.mjs';
import { createIndependentSubagentReviewTransport } from './independent-subagent-review.mjs';

export const KERNEL_HOST_REVIEW_BRIDGE_SCHEMA_VERSION = 1;

const list = (value) => (Array.isArray(value) ? value : []);
const first = (value) => (list(value).length > 0 ? String(value[0]) : null);
const isReviewAction = (modelInput = {}) => Boolean(
  modelInput?.action?.type === 'review'
  && modelInput?.action?.independentReviewRequired === true,
);

const runObligationsFor = (controlPlane, runId) => {
  if (typeof controlPlane?.getRunObligations === 'function') return controlPlane.getRunObligations(runId);
  if (typeof controlPlane?.stateStore?.getRunObligations === 'function') return controlPlane.stateStore.getRunObligations(runId);
  return [];
};

const runFor = async (controlPlane, runId) => {
  if (typeof controlPlane?.getRun === 'function') return controlPlane.getRun(runId);
  if (typeof controlPlane?.stateStore?.getRun === 'function') return controlPlane.stateStore.getRun(runId);
  return null;
};

const recordEfficiency = (controlPlane, runId, patch = {}) => {
  const store = controlPlane?.stateStore;
  if (!store || typeof store.recordRunEfficiency !== 'function') return;
  try { store.recordRunEfficiency(runId, patch); } catch { /* telemetry never changes review authority */ }
};

const actionContextForReview = ({ modelInput = {}, actionContext = {} } = {}) => ({
  ...actionContext,
  actionKind: 'review_engineering',
  obligationId: actionContext.obligationId || first(modelInput.action?.outstandingObligations),
  executionMode: 'native-subagent',
  delegationRequested: true,
  independentReviewRequired: true,
  changedPaths: actionContext.changedPaths || modelInput.changedPaths || [],
});

const summarizeReviewDispatch = (result, readiness) => ({
  schemaVersion: KERNEL_HOST_REVIEW_BRIDGE_SCHEMA_VERSION,
  status: result?.reviewReceiptId
    ? 'receipt-recorded'
    : result?.dispatched
      ? (result?.review?.status || 'pending')
      : 'blocked',
  reviewReceiptId: result?.reviewReceiptId || null,
  transport: result?.dispatch?.dispatchMechanism || null,
  verdict: result?.review?.review?.verdict || null,
  findings: result?.review?.review?.findings || [],
  evidenceRefs: result?.review?.review?.evidenceRefs || [],
  blocker: result?.blocker || (result?.review?.blockedReason ? {
    reason: result.review.blockedReason,
    detail: result.review.errorSummary || null,
  } : null),
  readiness,
  wait: {
    owner: 'host',
    strategy: 'single-bounded-dispatch',
    repeatedPolling: false,
  },
});

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
} = {}) => {
  const effectiveSurface = String(adapter?.capabilities?.surface || adapter?.surface || surface || 'codex').toLowerCase();
  const effectiveAdapter = adapter || (effectiveSurface === 'codex'
    ? createCodexAdapter({ nativeAgentHost, runtimeHome, env, parentSessionObserver })
    : effectiveSurface === 'claude'
      ? createClaudeAdapter({})
      : ['ade', 'ade_cli'].includes(effectiveSurface)
        ? createAdeAdapter({ nativeAgentHost })
        : null);
  const effectiveRegistry = registry || createModelRegistry({
    surface: effectiveSurface,
    runtimeHome,
    env,
    overrides,
  });
  // The normal Codex/Claude adapter remains the preferred transport. When the
  // embedding Host exposes only a generic independent-subagent launcher, make
  // that capability visible as the final same-provider fallback. This keeps
  // the public MCP surface unchanged while allowing the existing dispatcher
  // and Kernel receipt path to enforce the same review boundary.
  const independentSubagentTransport = createIndependentSubagentReviewTransport({
    host: nativeAgentHost,
    surface: effectiveSurface,
    env,
  });
  const effectiveReviewTransports = [
    ...(Array.isArray(reviewTransports) ? reviewTransports : []),
    ...(independentSubagentTransport.nativeDelegationAvailable ? [{ adapter: independentSubagentTransport, registry: effectiveRegistry }] : []),
  ];

  const reviewCandidateForReadiness = () => {
    const entries = [
      { adapter: effectiveAdapter, registry: effectiveRegistry },
      ...(Array.isArray(reviewFallbacks) ? reviewFallbacks : []),
      ...(Array.isArray(hostAdapters) ? hostAdapters : []),
      ...effectiveReviewTransports,
    ];
    for (const entry of entries) {
      const candidate = entry?.adapter || entry;
      if (candidate?.nativeDelegationAvailable !== true
        || typeof candidate.dispatch !== 'function'
        || candidate.capabilities?.supportsIndependentContext !== true
        || candidate.capabilities?.supportsReadOnlyReview !== true) continue;
      const candidateSurface = String(candidate.capabilities?.surface || candidate.surface || '').toLowerCase();
      const candidateRegistry = entry?.registry || (candidateSurface === effectiveSurface ? effectiveRegistry : createModelRegistry({
        surface: candidateSurface,
        runtimeHome,
        env,
        overrides,
      }));
      return { adapter: candidate, registry: candidateRegistry };
    }
    return { adapter: effectiveAdapter, registry: effectiveRegistry, available: false };
  };
  // `kernel_next` can be delivered concurrently to two Host callers. Keep the
  // review launch itself single-flight for one run/revision/obligation so both
  // callers observe the same Kernel receipt instead of creating two provider
  // sessions. This is process-local by design; the durable receipt remains the
  // cross-process authority and no new state table is introduced.
  const inFlightReviews = new Map();

  const assess = async ({ controlPlane, runId, modelInput = null, implementationOnly = false, workspaceBaseline = null, verificationCommands = null } = {}) => {
    const run = await runFor(controlPlane, runId);
    const obligations = runObligationsFor(controlPlane, runId);
    const verifications = typeof controlPlane?.stateStore?.getVerifications === 'function'
      ? controlPlane.stateStore.getVerifications(runId)
      : [];
    const reviewCandidate = reviewCandidateForReadiness();
    const reviewAvailable = reviewCandidate.available !== false;
    return assessReviewReadiness({
      run,
      contract: run?.taskContract || null,
      modelInput,
      obligations,
      adapter: reviewCandidate.adapter,
      registry: reviewCandidate.registry,
      controlPlane,
      verifications,
      workspaceBaseline,
      verificationCommands,
      permission: modelInput?.action?.type === 'review' ? { filesystem: 'read_only' } : null,
      reviewExecutionAvailable: reviewAvailable,
      reviewIndependentContextAvailable: reviewAvailable && reviewCandidate.adapter?.capabilities?.supportsIndependentContext === true,
      reviewReadOnlyAvailable: reviewAvailable && reviewCandidate.adapter?.capabilities?.supportsReadOnlyReview === true,
      implementationOnly,
      env,
    });
  };

  const reviewDispatchKey = async ({ controlPlane, runId, modelInput } = {}) => {
    const run = await runFor(controlPlane, runId);
    return JSON.stringify({
      runId: String(runId || ''),
      mutationRevision: run?.mutationRevision ?? null,
      stepId: modelInput?.action?.step?.stepId || modelInput?.workAuthority?.currentWorkUnit?.stepId || null,
      obligations: [...new Set(list(modelInput?.action?.outstandingObligations).map(String))].sort(),
    });
  };

  const dispatchReview = async ({ controlPlane, runId, modelInput, actionContext = {}, implementationOnly = false } = {}) => {
    if (!controlPlane || !runId || !isReviewAction(modelInput)) {
      return {
        schemaVersion: KERNEL_HOST_REVIEW_BRIDGE_SCHEMA_VERSION,
        dispatched: false,
        status: 'blocked',
        reason: 'review-action-required',
        review: { required: true, status: 'blocked', blockedReason: 'review-action-required' },
        reviewReceipt: null,
        reviewReceiptId: null,
      };
    }

    recordEfficiency(controlPlane, runId, { timestamps: { reviewRequestedAt: new Date().toISOString() } });

    const key = await reviewDispatchKey({ controlPlane, runId, modelInput });
    const inFlight = inFlightReviews.get(key);
    if (inFlight) return inFlight;

    const operation = (async () => {
      const readiness = await assess({ controlPlane, runId, modelInput, implementationOnly });
      if (!readiness.canComplete) {
        return {
          schemaVersion: KERNEL_HOST_REVIEW_BRIDGE_SCHEMA_VERSION,
          runId,
          dispatched: false,
          executionMode: 'independent-review',
          reason: readiness.status === 'DEGRADED'
            ? 'review-receipt-attestation-unavailable'
            : (readiness.blockers[0] || 'review-readiness-blocked'),
          readiness,
          modelInput,
          review: {
            required: true,
            independent: true,
            status: 'blocked',
            blockedReason: readiness.status === 'DEGRADED'
              ? 'review-receipt-attestation-unavailable'
              : (readiness.blockers[0] || 'review-readiness-blocked'),
          },
          reviewReceipt: null,
          reviewReceiptId: null,
        };
      }

      recordEfficiency(controlPlane, runId, { timestamps: { reviewSpawnedAt: new Date().toISOString() } });
      let result = null;
      try {
        result = await dispatchKernelTurn({
          controlPlane,
          runId,
          adapter: effectiveAdapter,
          registry: effectiveRegistry,
          runtimeHome,
          env,
          overrides,
          actionContext: actionContextForReview({ modelInput, actionContext }),
          parentSessionId,
          parentSessionConfig,
          toolPolicy,
          permissionPolicy,
          economics,
          reviewFallbacks,
          hostAdapters,
          reviewTransports: effectiveReviewTransports,
        });
        return {
          ...result,
          readiness,
          hostReview: summarizeReviewDispatch(result, readiness),
        };
      } finally {
        // A launcher can fail after the Host has spawned the reviewer. Preserve
        // the end of that attempt even when no receipt exists; otherwise the
        // efficiency projection would report an in-flight review forever.
        recordEfficiency(controlPlane, runId, {
          timestamps: { reviewFinishedAt: result?.receipt?.finishedAt || new Date().toISOString() },
          increments: result?.wait?.timedOut === true || result?.wait?.status === 'timeout'
            ? { waitTimeoutCount: 1 }
            : {},
        });
      }
    })();

    inFlightReviews.set(key, operation);
    try {
      return await operation;
    } finally {
      if (inFlightReviews.get(key) === operation) inFlightReviews.delete(key);
    }
  };

  const bridge = {
    schemaVersion: KERNEL_HOST_REVIEW_BRIDGE_SCHEMA_VERSION,
    kind: 'kernel-host-review-bridge',
    hostCapabilities: effectiveAdapter?.capabilities || null,
    assess,
    dispatchReview,
  };
  return Object.freeze(bridge);
};

export const isKernelReviewAction = isReviewAction;
