import process from 'node:process';
import path from 'node:path';
import readline from 'node:readline';
import { existsSync, realpathSync } from 'node:fs';
import { isDirectEntrypoint } from '../../shared/runtime-assets.js';
import { resolveKernelRuntimeHome } from '../runtime-home.js';
import { projectKernelModelView } from '../run/model-view.js';
import { createFinalizationIncompleteError } from '../run/invocation-resolver.js';
import {
  createKernelControlPlane,
  createHostWorkerSessions,
  continueKernelCodexLoop,
  saveKernelLoopHandoff,
  type KernelCodexLoopHost,
  createLocalWorkerControl,
  type LocalWorkerControlOptions,
  createKernelHostReviewBridge,
  createKernelRecoveryContinuity,
  isKernelReviewAction,
  resolveKernelWorktreeIdentity,
} from '../../host/kernel/mcp-composition.js';

type UnknownRecord = Record<string, unknown>;
type ControlPlane = Awaited<ReturnType<typeof createKernelControlPlane>>;
type HostReviewBridge = ReturnType<typeof createKernelHostReviewBridge>;
type ControlPlaneOptions = Parameters<typeof createKernelControlPlane>[0];
type ResolveRunIdInput = Parameters<ControlPlane['resolveRunId']>[0];
type ResolveBoundInvocationInput = Parameters<ControlPlane['resolveBoundInvocation']>[0];
type EnsureRunInput = Parameters<ControlPlane['ensureRun']>[0];
type StartSuccessorInput = Parameters<ControlPlane['startSuccessor']>[0];

interface McpParameters extends UnknownRecord {
  workspaceRoot?: string;
  contractJson?: UnknownRecord | null;
  runId?: string | null;
  surface?: string | null;
  verbose?: boolean;
  report?: UnknownRecord | null;
  handoff?: Parameters<typeof saveKernelLoopHandoff>[0]['notes'];
  worker?: { action?: 'start' | 'interrupt'; model?: string; effort?: string; attemptId?: string } | null;
  ioWrite?: unknown;
  ioRead?: unknown;
}

type HostBridgeFactory = (input: { surface: string | null }) => HostReviewBridge | null;

interface HostLifecycleBridge {
  assess?: (input: UnknownRecord) => unknown | Promise<unknown>;
  dispatchReview?: (input: UnknownRecord) => unknown | Promise<unknown>;
}

interface HandleMcpToolCallInput {
  name?: (string) | undefined;
  parameters?: McpParameters;
  runtimeHome?: string | null;
  env?: NodeJS.ProcessEnv;
  hostBridge?: HostLifecycleBridge | HostBridgeFactory | null;
  nativeHost?: typeof globalThis;
  codexLoop?: KernelCodexLoopHost | null;
}

interface McpRequest extends UnknownRecord {
  id?: unknown;
  method?: string;
  params?: {
    name?: string;
    arguments?: McpParameters;
    [key: string]: unknown;
  } | null;
}

interface StartMcpBridgeServerInput {
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  hostWorkerSessions?: ReturnType<typeof createHostWorkerSessions>;
  ioWriter?: LocalWorkerControlOptions['ioWriter'];
  ioReader?: LocalWorkerControlOptions['ioReader'];
  runtimeHome?: (string | null) | undefined;
  env?: NodeJS.ProcessEnv;
  hostBridge?: HostLifecycleBridge | HostBridgeFactory | null;
  nativeHost?: typeof globalThis;
  codexLoop?: KernelCodexLoopHost | null;
}

const asRecord = (value: unknown): UnknownRecord => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : {}
);

const errorRecord = (value: unknown): UnknownRecord => asRecord(value);

const MCP_PROTOCOL_VERSION = '2024-11-05';
const SERVER_NAME = 'moon-relay-kernel-bridge';
const SERVER_VERSION = '0.1.0';
export const KERNEL_MCP_ENTRYPOINT = 'bin/moon-relay-kernel.mjs';

export const resolveInstalledKernelEntrypoint = ({ runtimeHome = null, env = process.env }: { runtimeHome?: string | null; env?: NodeJS.ProcessEnv } = {}): string => {
  const root = runtimeHome || resolveKernelRuntimeHome({ env });
  const candidates = [
    path.join(root, KERNEL_MCP_ENTRYPOINT),
    path.join(root, '.moon-relay', 'kernel-payload', KERNEL_MCP_ENTRYPOINT),
    path.join(root, 'kernel-payload', KERNEL_MCP_ENTRYPOINT),
  ];
  return candidates.find((candidate) => existsSync(candidate)) || path.join(root, KERNEL_MCP_ENTRYPOINT);
};

export const KERNEL_MCP_TOOLS = [
  {
    name: 'kernel_attach',
    description: 'Reattach to an existing Kernel Run without consuming next; return canonical Step, Attempt and durable resume evidence. A contractJson request retains the existing task-bootstrap behavior.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceRoot: { type: 'string', description: 'Canonical workspace root directory' },
        contractJson: { type: 'object', description: 'Semantic Task Contract input: objective, acceptance statements, constraints, nonGoals, and bounded scope when known. Kernel normalizes acceptance IDs, obligation wiring, digest, and revision.' },
        runId: { type: 'string', description: 'Explicit run id to attach to' },
        surface: { type: 'string', description: 'Surface identifier (e.g. codex_app, claude_app, qwen_code_cli)' },
        verbose: { type: 'boolean', description: 'Return full diagnostic snapshots instead of the compact model view' },
        worker: { type: 'object', description: 'Optional signal to an existing attached Host-owned Attempt; never grants Kernel completion', properties: { action: { type: 'string', enum: ['interrupt'] }, attemptId: { type: 'string' } }, required: ['action', 'attemptId'] },
      },
      required: ['workspaceRoot'],
    },
  },
  {
    name: 'kernel_next',
    description: 'Start, re-enter, or explicitly refresh the Run and fetch its bounded work unit, context capsule, and task contract.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceRoot: { type: 'string', description: 'Canonical workspace root directory' },
        contractJson: { type: 'object', description: 'Semantic Task Contract input for contract-first bootstrapping. Supply meaning, not Kernel-generated IDs or digests; omit unknown scope instead of sending an empty allowedPaths claim.' },
        runId: { type: 'string', description: 'Explicit run id' },
        surface: { type: 'string', description: 'Surface identifier' },
        verbose: { type: 'boolean', description: 'Return full diagnostic snapshots instead of the compact model view' },
        worker: { type: 'object', description: 'Explicitly start one Host-owned writable Worker for the canonical implementation Step; no automatic Owner Delivery', properties: { action: { type: 'string', enum: ['start'] }, model: { type: 'string' }, effort: { type: 'string' } }, required: ['action', 'model', 'effort'] },
      },
      required: ['workspaceRoot'],
    },
  },
  {
    name: 'kernel_report',
    description: 'Submit work unit completion, evidence, and observations, then return the canonical continuation in next. Consume that continuation directly after a normal report instead of immediately calling kernel_next only to advance. Git owner-direct paths are derived by Kernel; explicit changedPaths are validated when supplied and are required for non-Git workspaces.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceRoot: { type: 'string', description: 'Canonical workspace root directory' },
        runId: { type: 'string', description: 'Explicit run id' },
        report: { type: 'object', description: 'Structured report payload' },
        handoff: {
          type: 'object', description: 'Optional loop context to save after an accepted work boundary. Only the owning Host can later compact an idle conversation.',
          properties: {
            decisions: { type: 'array', items: { type: 'string' } },
            rejectedApproaches: { type: 'array', items: { type: 'string' } },
            remainingRisks: { type: 'array', items: { type: 'string' } },
          },
        },
        surface: { type: 'string', description: 'Surface identifier' },
        verbose: { type: 'boolean', description: 'Return full diagnostic snapshots instead of the compact model view' },
      },
      required: ['workspaceRoot', 'report'],
    },
  },
  {
    name: 'kernel_status',
    description: 'Inspect current Run status, worktree mutation lease, and pending obligations.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceRoot: { type: 'string', description: 'Canonical workspace root directory' },
        runId: { type: 'string', description: 'Explicit run id' },
      },
      required: ['workspaceRoot'],
    },
  },
  {
    name: 'kernel_detach',
    description: 'Detach the current surface from the Run.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceRoot: { type: 'string', description: 'Canonical workspace root directory' },
        runId: { type: 'string', description: 'Explicit run id' },
        surface: { type: 'string', description: 'Surface identifier' },
      },
      required: ['workspaceRoot'],
    },
  },
];

const ioRequestProperties = {
  stepId: { type: 'string' }, expectedWorkspaceIdentity: { type: 'string' },
  references: { type: 'array', items: { type: 'object', additionalProperties: false,
    properties: { path: { type: 'string' }, sha256: { type: 'string' } }, required: ['path', 'sha256'] } },
  maxInputBytes: { type: 'integer', minimum: 1 }, maxOutputBytes: { type: 'integer', minimum: 1 },
  timeoutMs: { type: 'integer', minimum: 1, maximum: 600000 },
};
// Advertised only by an explicitly enabled Host.
const ioWriteSchema = {
  type: 'object', additionalProperties: false,
  description: 'Host opt-in only: generate one isolated new file for the current Run/Step. No next, proof, Owner delivery or completion. Return metadata only.',
  properties: {
    ...ioRequestProperties, filePath: { type: 'string' }, specification: { type: 'string' },
  },
  required: ['stepId', 'expectedWorkspaceIdentity', 'filePath', 'specification', 'references', 'maxInputBytes', 'maxOutputBytes', 'timeoutMs'],
};
const ioReadSchema = {
  type: 'object', additionalProperties: false,
  description: 'Host opt-in only: answer a source question for the current Run/Step with checked quotes and required semantic review.',
  properties: { ...ioRequestProperties, references: { ...ioRequestProperties.references, minItems: 1 }, question: { type: 'string' } },
  required: [...Object.keys(ioRequestProperties), 'question'],
};

const resolveConfiguredHostBridge = (hostBridge: HandleMcpToolCallInput['hostBridge'], parameters: McpParameters): HostLifecycleBridge | null => {
  if (typeof hostBridge === 'function') return hostBridge({ surface: parameters.surface || null });
  return hostBridge || null;
};

const resolveLifecycleSurface = (requestedSurface: string): 'ade' | 'claude' | 'gemini' | 'codex' => {
  const normalized = requestedSurface.trim().toLowerCase();
  if (['ade', 'ade_cli', 'ade-code'].includes(normalized) || normalized.startsWith('ade')) return 'ade';
  if (normalized.startsWith('claude')) return 'claude';
  if (normalized.startsWith('gemini') || normalized === 'antigravity') return 'gemini';
  return 'codex';
};

const readinessBlockedPayload = ({ modelInput, readiness }: { modelInput: UnknownRecord; readiness: UnknownRecord }): UnknownRecord => {
  const priorAction = asRecord(modelInput.action);
  const supportsOperatorApproval = priorAction.type === 'review' && priorAction.supportOperatorApproval === true;
  return {
    ...modelInput,
    status: 'execution-readiness-blocked',
    executionReadiness: readiness,
    action: {
      type: 'blocked',
      reason: 'execution-readiness',
      blockingClass: 'completion',
      guidance: supportsOperatorApproval
        ? 'The current Host cannot complete the required independent review and receipt path. Resolve the Host capability, or for outstanding judgment-only obligations in a single-session environment, submit self-review findings for operator confirmation using a Host-issued approval reference (hard evidence remains mandatory).'
        : 'The current Host cannot complete the required review and receipt path. Resolve the Host capability, then call kernel next again.',
      ...(supportsOperatorApproval ? {
        supportOperatorApproval: true,
        ...(Array.isArray(priorAction.outstandingObligations) ? { outstandingObligations: priorAction.outstandingObligations } : {}),
      } : {}),
    },
    next: modelInput,
  };
};

const processHostLifecycleOutput = async ({ bridge, controlPlane, runId, modelInput }: { bridge: HostLifecycleBridge | null; controlPlane: ControlPlane; runId: string | null; modelInput: UnknownRecord | null; parameters?: McpParameters }): Promise<{ output: UnknownRecord | null; hostReview: UnknownRecord | null; finalization?: UnknownRecord | null }> => {
  if (!modelInput || modelInput.status === 'contract-rejected') return { output: modelInput, hostReview: null, finalization: null };
  let activeModelInput = modelInput;
  if (runId && asRecord(activeModelInput.action).type === 'baseline-required'
    && typeof controlPlane.captureBaseline === 'function'
    && typeof controlPlane.next === 'function') {
    const commandRefs = Array.isArray(asRecord(activeModelInput.action).commandRefs)
      ? (asRecord(activeModelInput.action).commandRefs as unknown[]).filter((entry): entry is string => typeof entry === 'string')
      : [];
    await controlPlane.captureBaseline(runId, { commandRefs });
    activeModelInput = asRecord(await controlPlane.next(runId));
  }
  const kernelFinalization = asRecord(activeModelInput.finalization).completionStatus
    ? asRecord(activeModelInput.finalization)
    : null;
  if (!bridge) return { output: activeModelInput, hostReview: null, finalization: kernelFinalization };
  const action = asRecord(activeModelInput.action);
  const implementationOnly = ['implement', 'fix', 'debug'].includes(String(action.type || '').toLowerCase());
  const readinessValue = typeof bridge.assess === 'function'
    ? await bridge.assess({ controlPlane, runId, modelInput: activeModelInput, implementationOnly })
    : null;
  const readiness = readinessValue ? asRecord(readinessValue) : null;
  const readinessReview = asRecord(readiness?.review);
  const reviewRequired = Boolean(readinessReview.required || isKernelReviewAction(activeModelInput));

  // A required review must be executable and receipt-attestable before the Host
  // lets an owner mutate through this lifecycle. The model cannot opt out by
  // adding a parameter to the MCP call; implementation-only is a trusted Host
  // policy decision, not model input.
  if (reviewRequired && (!readiness || !readiness.canExecuteCurrentWork || (isKernelReviewAction(activeModelInput) && !readiness.canCompleteGoal))) {
    return {
      output: readinessBlockedPayload({ modelInput: activeModelInput, readiness: readiness || {
        schemaVersion: 1,
        status: 'BLOCKED',
        canStartMutation: false,
        canComplete: false,
        review: { required: true },
        blockers: ['host-review-readiness-unavailable'],
        degraded: [],
        nextAction: 'stop-before-mutation',
      } }),
      hostReview: null,
      finalization: null,
    };
  }

  if (!isKernelReviewAction(activeModelInput) || typeof bridge.dispatchReview !== 'function') {
    return {
      output: reviewRequired ? { ...activeModelInput, executionReadiness: readiness } : activeModelInput,
      hostReview: null,
      finalization: kernelFinalization,
    };
  }

  const outstandingObligations = Array.isArray(action.outstandingObligations)
    ? action.outstandingObligations
    : [];
  const dispatched = asRecord(await bridge.dispatchReview({
    controlPlane,
    runId,
    modelInput: activeModelInput,
    actionContext: {
      actionKind: 'review_engineering',
      obligationId: outstandingObligations[0] || null,
    },
  }));
  const dispatchedReview = asRecord(dispatched.review);
  const nestedReview = asRecord(dispatchedReview.review);
  const hostReview = dispatched.hostReview ? asRecord(dispatched.hostReview) : {
    schemaVersion: 1,
    status: dispatched.reviewReceiptId
      ? (dispatchedReview.proofSettled === false
        ? 'proof-settlement-failed'
        : (dispatchedReview.blockedReason ? 'settlement-blocked' : 'receipt-recorded'))
      : 'blocked',
    reviewReceiptId: dispatched.reviewReceiptId || null,
    verdict: nestedReview.verdict || null,
    findings: Array.isArray(nestedReview.findings) ? nestedReview.findings : [],
    evidenceRefs: Array.isArray(nestedReview.evidenceRefs) ? nestedReview.evidenceRefs : [],
    blocker: dispatched.blocker || null,
    readiness,
    wait: { owner: 'host', strategy: 'single-bounded-dispatch', repeatedPolling: false },
  };
  const dispatchedNext = dispatched.next && typeof dispatched.next === 'object'
    ? asRecord(dispatched.next)
    : null;
  const refreshedNext = dispatchedNext
    || (dispatched.reviewReceiptId && typeof controlPlane.next === 'function'
      ? asRecord(await controlPlane.next(runId as string))
      : activeModelInput);
  const finalization = (dispatched.finalization && typeof dispatched.finalization === 'object'
    ? asRecord(dispatched.finalization)
    : null)
    || (asRecord(refreshedNext.finalization).completionStatus
      ? asRecord(refreshedNext.finalization)
      : null);
  return {
    output: {
      ...refreshedNext,
      executionReadiness: readiness,
      hostReview,
      ...(finalization ? { finalization } : {}),
    },
    hostReview,
    finalization,
  };
};

export const handleMcpToolCall = async ({
  name,
  parameters = {},
  runtimeHome = null,
  env = process.env,
  hostBridge = null,
  nativeHost = globalThis,
  codexLoop = null,
}: HandleMcpToolCallInput = {}): Promise<unknown> => {
  if (Object.hasOwn(parameters, 'ioWrite') || Object.hasOwn(parameters, 'ioRead')) {
    throw Object.assign(new Error('host_io_requires_owning_handler'), { code: 'host_io_requires_owning_handler' });
  }
  const workspaceRoot = parameters.workspaceRoot;
  if (!workspaceRoot || typeof workspaceRoot !== 'string') {
    throw new Error('workspaceRoot is required and must be a string path');
  }

  const resolvedWorkspaceRoot = path.resolve(workspaceRoot);
  const resolvedRuntimeHome = runtimeHome || resolveKernelRuntimeHome({ env });
  const worktreeIdentity = resolveKernelWorktreeIdentity({
    cwd: resolvedWorkspaceRoot,
    workspaceRoot: resolvedWorkspaceRoot,
    env,
  });

  const hasDeclaredSession = Boolean(String(env.MOON_RELAY_KERNEL_SESSION_ID || '').trim());
  const openControlPlane = () => createKernelControlPlane({
    runtimeHome: resolvedRuntimeHome,
    projectRoot: resolvedWorkspaceRoot,
    env: {
      ...env,
      MOON_RELAY_KERNEL_PROJECT_ID: worktreeIdentity.projectId,
      ...(parameters.surface ? { MOON_RELAY_KERNEL_SURFACE: parameters.surface } : {}),
      ...(parameters.runId ? { MOON_RELAY_KERNEL_RUN_ID: parameters.runId } : {}),
    },
    requireHostBinding: hasDeclaredSession,
  });
  const cp = await openControlPlane();
  const requestedSurface = String(parameters.surface || env.MOON_RELAY_KERNEL_SURFACE || '').trim().toLowerCase();
  const lifecycleSurface = resolveLifecycleSurface(requestedSurface);
  const configuredHostBridge = resolveConfiguredHostBridge(hostBridge, parameters)
    || createKernelHostReviewBridge({
      surface: lifecycleSurface,
      nativeAgentHost: nativeHost,
      runtimeHome: resolvedRuntimeHome,
      env,
    });
  const lifecycleBridge = configuredHostBridge;

  try {
    if (name === 'kernel_attach' && !parameters.contractJson) {
      // Reconnecting a Main is observation, not a new invocation. Never
      // ensure/successor the Run, consume next, or dispatch a reviewer.
      const runId = parameters.runId || await cp.resolveRunId({
        explicitRunId: null,
        envRunId: env.MOON_RELAY_KERNEL_RUN_ID || null,
      });
      const run = await cp.getRun(runId);
      if (!run) return { schemaVersion: 1, runId, status: 'not_found' };
      const step = cp.getCurrentStep(runId);
      const attempts = cp.getHostRoutingSnapshot(runId).stepAttempts;
      // Reuse the existing Kernel projection; a fresh Main recovers the
      // original Contract/Evidence without a model-authored handoff or an
      // executable next. This is observation, NOT Fresh Worker authorization.
      const status = asRecord(await cp.status(runId));
      return {
        schemaVersion: 1, runId, status: 'attached', runStatus: run.status,
        currentStep: step ? { stepId: step.stepId, state: step.state } : null,
        resume: status.resume ?? null,
        // These are the same read-only Kernel authorities exposed by status.
        // A replacement Main can inspect scope and proof freshness without
        // issuing next or relying on a model-authored handoff summary.
        workAuthority: status.workAuthority ?? null,
        trustAuthority: status.trustAuthority ?? null,
        workerAttempts: attempts.map(attempt => ({
          attemptId: attempt.attemptId,
          stepId: attempt.stepId,
          status: attempt.status,
          workspaceId: attempt.workspaceId,
          provenanceKind: attempt.provenanceKind,
          liveState: 'unobserved' as const,
          writerExitVerified: false as const,
        })),
      };
    }
    if (name === 'kernel_attach' && parameters.worker?.action === 'interrupt') {
      // A signal must never bootstrap a task or smuggle a contract revision.
      throw new Error('host_worker_signal_contract_not_allowed');
    }
    if (name === 'kernel_attach' || name === 'kernel_next') {
      const taskContract = parameters.contractJson || null;
      const explicitRunId = parameters.runId || null;
      const startsWorker = name === 'kernel_next' && parameters.worker?.action === 'start';
      let res: UnknownRecord;
      if (taskContract) {
        const invocation = cp.resolveBoundInvocation({
          explicitRunId,
          envRunId: env.MOON_RELAY_KERNEL_RUN_ID || null,
          taskContract,
        });
        if (invocation.mode === 'successor') {
          const successor = asRecord(await cp.startSuccessor({
            invocation,
            objective: typeof taskContract.objective === 'string' ? taskContract.objective : undefined,
            taskContract,
            includeNext: !startsWorker,
          }));
          if (startsWorker) return { runId: invocation.runId };
          res = asRecord(successor.next);
        } else if (invocation.mode === 'finalization-retry') {
          throw createFinalizationIncompleteError(invocation);
        } else if (invocation.mode === 'done') {
          res = asRecord(await cp.next(String(invocation.runId || '')));
        } else {
          const ensured = asRecord(await cp.ensureRun({
            runId: invocation.runId,
            objective: typeof taskContract.objective === 'string' ? taskContract.objective : undefined,
            taskContract,
            includeNext: !startsWorker,
          }));
          if (startsWorker) return { runId: invocation.runId };
          res = asRecord(ensured.next);
        }
      } else {
        const runId = await cp.resolveRunId({
          explicitRunId,
          envRunId: env.MOON_RELAY_KERNEL_RUN_ID || null,
        });
        if (startsWorker) {
          // Resolve the same Run/Worktree binding without preparing next.
          // HostWorkerSessions decides whether this is a start or a reattach.
          return { runId };
        }
        const ensured = asRecord(await cp.ensureRun({ runId }));
        res = asRecord(ensured.next);
      }
      const processed = await processHostLifecycleOutput({
        bridge: lifecycleBridge,
        controlPlane: cp,
        runId: String(res.runId || explicitRunId || '') || null,
        modelInput: res,
        parameters,
      });
      return projectKernelModelView(processed.output, { verbose: parameters.verbose === true });
    }

    if (name === 'kernel_report') {
      const explicitRunId = parameters.runId || null;
      const runId = await cp.resolveRunId({
        explicitRunId,
        envRunId: env.MOON_RELAY_KERNEL_RUN_ID || null,
      });
      const res = asRecord(await cp.report(runId, parameters.report || {}));
      // A replayed historical Report returns its durable stored result without
      // re-entering Host review dispatch from a stale `review` directive.
      if (res.idempotentReplay === true) {
        return projectKernelModelView(res, { verbose: parameters.verbose === true });
      }
      const processed = await processHostLifecycleOutput({
        bridge: lifecycleBridge,
        controlPlane: cp,
        runId,
        modelInput: res.next ? asRecord(res.next) : null,
        parameters,
      });
      const loop = codexLoop?.transport.observeTurn().contextRunId === runId ? codexLoop : undefined;
      if ((parameters.handoff || loop) && !processed.hostReview && processed.output?.status !== 'execution-readiness-blocked') {
        const { handoff: loopHandoff, boundary } = await saveKernelLoopHandoff({
          controlPlane: cp, runtimeHome: resolvedRuntimeHome, runId, report: res,
          summary: parameters.report?.summary,
          ...(parameters.handoff ? { notes: parameters.handoff } : {}),
        });
        const view = asRecord(projectKernelModelView(res, { verbose: parameters.verbose === true }));
        if (!boundary || !loop) return { ...view, loopHandoff };
        const directive = asRecord(res.next);
        const continueWith = (controlPlane: ControlPlane) =>
          continueKernelCodexLoop({ controlPlane, host: loop, boundary, directive });
        const settlement = loop.transport.currentTurnSettlement();
        if (settlement) {
          const notify = loop.onContinuation?.bind(loop);
          if (!notify) {
            return { ...view, loopHandoff, loopContinuation: { status: 'deferred', reason: 'host_continuation_observer_required' } };
          }
          // A model may Report from inside its own Turn. Release its MCP
          // request before waiting for that Turn to settle.
          void settlement.then(async turnStatus => {
            if (turnStatus !== 'completed') return { status: 'deferred' as const,
              reason: turnStatus === 'unknown' ? 'host_turn_unconfirmed' : `host_turn_${turnStatus}` };
            const continuationControlPlane = await openControlPlane();
            try {
              return await continueWith(continuationControlPlane);
            } finally {
              await continuationControlPlane.close();
            }
          }).catch(() => ({ status: 'deferred' as const, reason: 'loop_continuation_failed' }))
            .then(result => notify({ runId, stepId: boundary.stepId, result }))
            .catch(() => undefined);
          return { ...view, loopHandoff, loopContinuation: { status: 'deferred', reason: 'host_turn_settling' } };
        }
        return {
          ...view, loopHandoff,
          loopContinuation: await continueWith(cp),
        };
      }
      if (!processed.hostReview && !processed.finalization && processed.output?.status !== 'execution-readiness-blocked' && processed.output === res.next) {
        return projectKernelModelView(res, { verbose: parameters.verbose === true });
      }
      const finalizationRecord = asRecord(processed.finalization);
      const finalizedCompletion = finalizationRecord.completionStatus === 'accepted';
      const finalizationCompleted = finalizedCompletion && finalizationRecord.finalizationStatus === 'completed';
      return projectKernelModelView({
        ...res,
        ...(finalizedCompletion ? {
          status: finalizationCompleted ? 'completed' : 'finalization-incomplete',
          workUnitStatus: 'complete',
          goalStatus: finalizationCompleted ? 'complete' : 'active',
          continuation: { action: finalizationCompleted ? 'none' : 'finalize', stepId: null },
          finalization: processed.finalization,
        } : processed.finalization ? {
          finalization: processed.finalization,
        } : {}),
        next: processed.output,
        ...(processed.hostReview ? { hostReview: processed.hostReview } : {}),
      }, { verbose: parameters.verbose === true });
    }

    if (name === 'kernel_status') {
      const explicitRunId = parameters.runId || null;
      const runId = explicitRunId || await cp.resolveRunId({
        explicitRunId,
        envRunId: env.MOON_RELAY_KERNEL_RUN_ID || null,
      });
      const res = await cp.status(runId);
      if (!res || !('run' in res)) return res || { status: 'not_found' };
      // W2: expose persisted Attempt identity for reconnecting Main clients.
      // A started Attempt is not proof of a live OS Writer or a resumable Turn.
      const attempts = cp.getHostRoutingSnapshot(runId).stepAttempts;
      return {
        ...res,
        workerAttempts: attempts.map((attempt) => ({
          attemptId: attempt.attemptId,
          stepId: attempt.stepId,
          status: attempt.status,
          workspaceId: attempt.workspaceId,
          provenanceKind: attempt.provenanceKind,
          liveState: 'unobserved',
          writerExitVerified: false,
        })),
      };
    }

    if (name === 'kernel_detach') {
      return {
        status: 'detached',
        projectId: worktreeIdentity.projectId,
        worktreeId: worktreeIdentity.worktreeId,
      };
    }

    throw new Error(`Unknown Kernel MCP tool: ${name}`);
  } finally {
    await cp.close();
  }
};

export const createMcpBridgeHandler = ({ runtimeHome = null, env = process.env, hostBridge = null, nativeHost = globalThis, hostWorkerSessions = undefined, ioWriter = undefined, ioReader = undefined, codexLoop = null }: Omit<HandleMcpToolCallInput, 'name' | 'parameters'> & {
  hostWorkerSessions?: ReturnType<typeof createHostWorkerSessions>;
  ioWriter?: LocalWorkerControlOptions['ioWriter'];
  ioReader?: LocalWorkerControlOptions['ioReader'];
} = {}) => {
  const recoveryContinuity = createKernelRecoveryContinuity();
  // The owning Host may reuse this exact control surface across Main
  // connections. An isolated Handler still owns its local sessions by default.
  const workerSessions = hostWorkerSessions || createHostWorkerSessions({ env });
  // Keep the existing Writer's process-local duplicate guard across requests.
  // Canonical roots share one control even when Main uses a path alias.
  const ioControls = new Map<string, ReturnType<typeof createLocalWorkerControl>>();
  const tools = ioWriter || ioReader ? KERNEL_MCP_TOOLS.map(tool => tool.name === 'kernel_attach'
    ? { ...tool, inputSchema: { ...tool.inputSchema, properties: { ...tool.inputSchema.properties,
      ...(ioWriter ? { ioWrite: ioWriteSchema } : {}), ...(ioReader ? { ioRead: ioReadSchema } : {}) } } }
    : tool) : KERNEL_MCP_TOOLS;
  return async (request: McpRequest) => {
    const { id, method, params } = request || {};

    if (method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          serverInfo: {
            name: SERVER_NAME,
            version: SERVER_VERSION,
          },
          capabilities: {
            tools: {},
          },
        },
      };
    }

    if (method === 'notifications/initialized' || method === 'initialized') {
      return null;
    }

    if (method === 'ping') {
      return { jsonrpc: '2.0', id, result: {} };
    }

    if (method === 'tools/list') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          tools,
        },
      };
    }

    if (method === 'tools/call') {
      const { name, arguments: toolArgs } = params || {};
      const callArgs = toolArgs || {};
      const resolvedRuntimeHome = runtimeHome || resolveKernelRuntimeHome({ env });
      try {
        const worker = asRecord(callArgs.worker);
        const writesIo = Object.hasOwn(callArgs, 'ioWrite');
        const readsIo = Object.hasOwn(callArgs, 'ioRead');
        const handlesIo = writesIo || readsIo;
        const startsWorker = !handlesIo && name === 'kernel_next' && worker.action === 'start';
        // A contract can create or revise a Run, so check capability before
        // accepting it. Requests without a contract may read back an Attempt.
        if (startsWorker && callArgs.contractJson) workerSessions.assertNativeStartAvailable();
        const workerModel = typeof worker.model === 'string' ? worker.model : '';
        const workerEffort = typeof worker.effort === 'string' ? worker.effort : '';
        if (startsWorker && (!workerModel || !workerEffort)) throw new Error('host_worker_request_invalid');
        let resultData: unknown;
        if (handlesIo) {
          const request = readsIo ? callArgs.ioRead : callArgs.ioWrite;
          const fields = readsIo ? ioReadSchema.required : ioWriteSchema.required;
          const fixed = asRecord(request);
          if ((readsIo && writesIo) || name !== 'kernel_attach' || callArgs.contractJson != null || callArgs.worker != null || callArgs.report != null
            || typeof callArgs.workspaceRoot !== 'string' || typeof callArgs.runId !== 'string' || !callArgs.runId.trim()
            || fields.some(key => !Object.hasOwn(fixed, key))
            || Object.keys(fixed).some(key => !fields.includes(key))) {
            throw Object.assign(new Error('host_io_request_invalid'), { code: 'host_io_request_invalid' });
          }
          if (!(readsIo ? ioReader : ioWriter)) throw Object.assign(new Error('host_io_not_enabled'), { code: 'host_io_not_enabled' });
          const root = realpathSync(path.resolve(callArgs.workspaceRoot));
          let control = ioControls.get(root);
          if (!control) {
            control = createLocalWorkerControl({ projectRoot: root, runtimeHome: resolvedRuntimeHome, env,
              hostWorkerSessions: workerSessions, ...(ioWriter ? { ioWriter } : {}), ...(ioReader ? { ioReader } : {}) });
            ioControls.set(root, control);
          }
          resultData = await control({ ...fixed, action: readsIo ? 'io-read' : 'io-write', runId: callArgs.runId });
        } else resultData = await handleMcpToolCall({
          name,
          parameters: callArgs,
          runtimeHome,
          env,
          hostBridge,
          nativeHost,
          codexLoop,
        });
        const modelInput = asRecord(resultData);
        let resultWithWorker: unknown = resultData;
        if (startsWorker && asRecord(modelInput.action).type !== 'done') {
          if (typeof callArgs.workspaceRoot !== 'string') throw new Error('host_worker_workspace_required');
          const runId = String(modelInput.runId || callArgs.runId || '');
          if (!runId) throw new Error('host_worker_request_invalid');
          const startInput = {
            projectRoot: callArgs.workspaceRoot, runtimeHome: resolvedRuntimeHome, runId,
            model: workerModel, effort: workerEffort,
          };
          const running = await workerSessions.startLocal(startInput);
          resultWithWorker = { schemaVersion: 1, runId, status: 'host-worker-attached', hostWorker: running };
        } else if (worker.action === 'interrupt' && name === 'kernel_attach') {
          if (modelInput.status === 'not_found') {
            resultWithWorker = modelInput;
          } else {
            if (typeof callArgs.workspaceRoot !== 'string' || typeof worker.attemptId !== 'string') {
              throw new Error('host_worker_signal_invalid');
            }
            const runId = String(modelInput.runId || callArgs.runId || '');
            const signal = await workerSessions.interrupt(callArgs.workspaceRoot, resolvedRuntimeHome, runId, worker.attemptId);
            resultWithWorker = { ...modelInput, hostWorkerSignal: signal };
          }
        } else if (!startsWorker && Object.keys(worker).length > 0) {
          throw new Error('host_worker_action_unsupported');
        } else if (!handlesIo && (name === 'kernel_status' || name === 'kernel_attach')
          && typeof callArgs.workspaceRoot === 'string'
          && (name !== 'kernel_attach' || !callArgs.contractJson)) {
          const runId = String(asRecord(modelInput.run).runId || modelInput.runId || callArgs.runId || '');
          const live = modelInput.status !== 'not_found' && runId
            ? await workerSessions.status(callArgs.workspaceRoot, resolvedRuntimeHome, runId) : null;
          resultWithWorker = { ...modelInput, liveWorker: live };
        }
        const recoveryInput = typeof callArgs.workspaceRoot === 'string'
          ? {
              projectRoot: callArgs.workspaceRoot,
              runtimeHome: resolvedRuntimeHome,
              runId: String(asRecord(resultData).runId || callArgs.runId || env.MOON_RELAY_KERNEL_RUN_ID || '') || null,
              sessionId: env.MOON_RELAY_KERNEL_SESSION_ID || null,
              env,
            }
          : null;
        const decoratedResult = recoveryInput
          ? recoveryContinuity.decorate(resultWithWorker, recoveryInput)
          : resultWithWorker;
        if (recoveryInput && !recoveryContinuity.hasRecovery(decoratedResult)) recoveryContinuity.clear(recoveryInput);
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [
              {
                type: 'text',
                text: typeof decoratedResult === 'string' ? decoratedResult : JSON.stringify(decoratedResult, null, 2),
              },
            ],
            isError: handlesIo && ['failed', 'error', 'unsupported', 'not_found'].includes(String(asRecord(resultWithWorker).status)),
          },
        };
      } catch (error: unknown) {
        const failure = errorRecord(error);
        const errorPayload = {
          status: 'error',
          error: String(failure.message || error),
          code: failure.code || failure.errorCode || 'KERNEL_BRIDGE_ERROR',
          details: failure.details || null,
        };
        const decoratedError = typeof callArgs.workspaceRoot === 'string'
          ? recoveryContinuity.decorate(errorPayload, {
              projectRoot: callArgs.workspaceRoot,
              runtimeHome: resolvedRuntimeHome,
              runId: String(failure.runId || callArgs.runId || env.MOON_RELAY_KERNEL_RUN_ID || '') || null,
              sessionId: env.MOON_RELAY_KERNEL_SESSION_ID || null,
              env,
            })
          : errorPayload;
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [
              {
                type: 'text',
                text: JSON.stringify(decoratedError, null, 2),
              },
            ],
            isError: true,
          },
        };
      }
    }

    return {
      jsonrpc: '2.0',
      id,
      error: {
        code: -32601,
        message: `Method not found: ${method}`,
      },
    };
  };
};

export const startMcpBridgeServer = ({
  stdin = process.stdin,
  stdout = process.stdout,
  runtimeHome = null,
  env = process.env,
  hostBridge = null,
  nativeHost = globalThis,
  codexLoop = null,
  hostWorkerSessions = undefined,
  ioWriter = undefined,
  ioReader = undefined,
}: StartMcpBridgeServerInput = {}) => {
  const handler = createMcpBridgeHandler({ runtimeHome, env, hostBridge, nativeHost, codexLoop,
    ...(ioWriter ? { ioWriter } : {}),
    ...(ioReader ? { ioReader } : {}),
    ...(hostWorkerSessions ? { hostWorkerSessions } : {}),
  });
  const rl = readline.createInterface({ input: stdin, output: stdout, terminal: false });

  rl.on('line', async (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let request: McpRequest;
    try {
      request = JSON.parse(trimmed);
    } catch {
      stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`);
      return;
    }

    try {
      const response = await handler(request);
      if (response) {
        stdout.write(`${JSON.stringify(response)}\n`);
      }
    } catch (err: unknown) {
      const failure = errorRecord(err);
      stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id ?? null, error: { code: -32603, message: String(failure.message || err) } })}\n`);
    }
  });

  return {
    close() {
      rl.close();
    },
  };
};

if (isDirectEntrypoint(import.meta.url)) {
  startMcpBridgeServer();
}
