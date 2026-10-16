import process from 'node:process';
import path from 'node:path';
import readline from 'node:readline';
import { existsSync } from 'node:fs';
import { isDirectEntrypoint } from '../../shared/runtime-assets.js';
import { resolveKernelRuntimeHome } from '../runtime-home.js';
import { projectKernelModelView } from '../run/model-view.js';
import {
  createKernelControlPlane,
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
  runtimeHome?: (string | null) | undefined;
  env?: NodeJS.ProcessEnv;
  hostBridge?: HostLifecycleBridge | HostBridgeFactory | null;
  nativeHost?: typeof globalThis;
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
    description: 'Attach native harness surface to Moon Relay Kernel Run for the workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceRoot: { type: 'string', description: 'Canonical workspace root directory' },
        contractJson: { type: 'object', description: 'Semantic Task Contract input: objective, acceptance statements, constraints, nonGoals, and bounded scope when known. Kernel normalizes acceptance IDs, obligation wiring, digest, and revision.' },
        runId: { type: 'string', description: 'Explicit run id to attach to' },
        surface: { type: 'string', description: 'Surface identifier (e.g. codex_app, claude_app, qwen_code_cli)' },
        verbose: { type: 'boolean', description: 'Return full diagnostic snapshots instead of the compact model view' },
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

const resolveConfiguredHostBridge = (hostBridge: HandleMcpToolCallInput['hostBridge'], parameters: McpParameters): HostLifecycleBridge | null => {
  if (typeof hostBridge === 'function') return hostBridge({ surface: parameters.surface || null });
  return hostBridge || null;
};

const readinessBlockedPayload = ({ modelInput, readiness }: { modelInput: UnknownRecord; readiness: UnknownRecord }): UnknownRecord => ({
  ...modelInput,
  status: 'execution-readiness-blocked',
  executionReadiness: readiness,
  action: {
    type: 'blocked',
    reason: 'execution-readiness',
    blockingClass: 'completion',
    guidance: 'The current Host cannot complete the required review and receipt path. Resolve the Host capability, then call kernel next again.',
  },
  next: modelInput,
});

const processHostLifecycleOutput = async ({ bridge, controlPlane, runId, modelInput, parameters = {} }: { bridge: HostLifecycleBridge | null; controlPlane: ControlPlane; runId: string | null; modelInput: UnknownRecord | null; parameters?: McpParameters }): Promise<{ output: UnknownRecord | null; hostReview: UnknownRecord | null }> => {
  if (!bridge || !modelInput || modelInput.status === 'contract-rejected') return { output: modelInput, hostReview: null };
  const action = asRecord(modelInput.action);
  const implementationOnly = ['implement', 'fix', 'debug'].includes(String(action.type || '').toLowerCase());
  const readinessValue = typeof bridge.assess === 'function'
    ? await bridge.assess({ controlPlane, runId, modelInput, implementationOnly })
    : null;
  const readiness = readinessValue ? asRecord(readinessValue) : null;
  const readinessReview = asRecord(readiness?.review);
  const reviewRequired = Boolean(readinessReview.required || isKernelReviewAction(modelInput));

  // A required review must be executable and receipt-attestable before the Host
  // lets an owner mutate through this lifecycle. The model cannot opt out by
  // adding a parameter to the MCP call; implementation-only is a trusted Host
  // policy decision, not model input.
  if (reviewRequired && (!readiness || !readiness.canExecuteCurrentWork || (isKernelReviewAction(modelInput) && !readiness.canCompleteGoal))) {
    return {
      output: readinessBlockedPayload({ modelInput, readiness: readiness || {
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
    };
  }

  if (!isKernelReviewAction(modelInput) || typeof bridge.dispatchReview !== 'function') {
    return {
      output: reviewRequired ? { ...modelInput, executionReadiness: readiness } : modelInput,
      hostReview: null,
    };
  }

  const outstandingObligations = Array.isArray(action.outstandingObligations)
    ? action.outstandingObligations
    : [];
  const dispatched = asRecord(await bridge.dispatchReview({
    controlPlane,
    runId,
    modelInput,
    actionContext: {
      actionKind: 'review_engineering',
      obligationId: outstandingObligations[0] || null,
    },
  }));
  const dispatchedReview = asRecord(dispatched.review);
  const nestedReview = asRecord(dispatchedReview.review);
  const hostReview = dispatched.hostReview ? asRecord(dispatched.hostReview) : {
    schemaVersion: 1,
    status: dispatched.reviewReceiptId ? 'receipt-recorded' : 'blocked',
    reviewReceiptId: dispatched.reviewReceiptId || null,
    verdict: nestedReview.verdict || null,
    findings: Array.isArray(nestedReview.findings) ? nestedReview.findings : [],
    evidenceRefs: Array.isArray(nestedReview.evidenceRefs) ? nestedReview.evidenceRefs : [],
    blocker: dispatched.blocker || null,
    readiness,
    wait: { owner: 'host', strategy: 'single-bounded-dispatch', repeatedPolling: false },
  };
  const refreshedNext = dispatched.reviewReceiptId && typeof controlPlane.next === 'function'
    ? asRecord(await controlPlane.next(runId as string))
    : modelInput;
  return {
    output: {
      ...refreshedNext,
      executionReadiness: readiness,
      hostReview,
    },
    hostReview,
  };
};

export const handleMcpToolCall = async ({
  name,
  parameters = {},
  runtimeHome = null,
  env = process.env,
  hostBridge = null,
  nativeHost = globalThis,
}: HandleMcpToolCallInput = {}): Promise<unknown> => {
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

  const cp = await createKernelControlPlane({
    runtimeHome: resolvedRuntimeHome,
    projectRoot: resolvedWorkspaceRoot,
    env: {
      ...env,
      MOON_RELAY_KERNEL_PROJECT_ID: worktreeIdentity.projectId,
      ...(parameters.surface ? { MOON_RELAY_KERNEL_SURFACE: parameters.surface } : {}),
      ...(parameters.runId ? { MOON_RELAY_KERNEL_RUN_ID: parameters.runId } : {}),
    },
    requireHostBinding: false,
  });
  const requestedSurface = String(parameters.surface || env.MOON_RELAY_KERNEL_SURFACE || '').trim().toLowerCase();
  const lifecycleSurface = ['ade', 'ade_cli', 'ade-code'].includes(requestedSurface) ? 'ade' : 'codex';
  const configuredHostBridge = resolveConfiguredHostBridge(hostBridge, parameters)
    || createKernelHostReviewBridge({
      surface: lifecycleSurface,
      nativeAgentHost: nativeHost,
      runtimeHome: resolvedRuntimeHome,
      env,
    });
  const lifecycleBridge = configuredHostBridge;

  try {
    if (name === 'kernel_attach' || name === 'kernel_next') {
      const taskContract = parameters.contractJson || null;
      const explicitRunId = parameters.runId || null;
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
          }));
          res = asRecord(successor.next);
        } else if (invocation.mode === 'finalization-retry') {
          throw Object.assign(new Error('finalization_incomplete'), {
            code: 'finalization_incomplete',
            errorCode: 'finalization_incomplete',
            nextAction: 'retry-finalization',
            runId: invocation.runId,
          });
        } else if (invocation.mode === 'done') {
          res = asRecord(await cp.next(String(invocation.runId || '')));
        } else {
          const ensured = asRecord(await cp.ensureRun({
            runId: invocation.runId,
            objective: typeof taskContract.objective === 'string' ? taskContract.objective : undefined,
            taskContract,
          }));
          res = asRecord(ensured.next);
        }
      } else {
        const runId = await cp.resolveRunId({
          explicitRunId,
          envRunId: env.MOON_RELAY_KERNEL_RUN_ID || null,
        });
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
      const processed = await processHostLifecycleOutput({
        bridge: lifecycleBridge,
        controlPlane: cp,
        runId,
        modelInput: res.next ? asRecord(res.next) : null,
        parameters,
      });
      if (!processed.hostReview && processed.output?.status !== 'execution-readiness-blocked') return projectKernelModelView(res, { verbose: parameters.verbose === true });
      return projectKernelModelView({
        ...res,
        next: processed.output,
        ...(processed.hostReview ? { hostReview: processed.hostReview } : {}),
      }, { verbose: parameters.verbose === true });
    }

    if (name === 'kernel_status') {
      const explicitRunId = parameters.runId || null;
      const runId = await cp.resolveRunId({
        explicitRunId,
        envRunId: env.MOON_RELAY_KERNEL_RUN_ID || null,
      });
      const res = await cp.status(runId);
      return res || { status: 'not_found' };
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

export const createMcpBridgeHandler = ({ runtimeHome = null, env = process.env, hostBridge = null, nativeHost = globalThis }: Omit<HandleMcpToolCallInput, 'name' | 'parameters'> = {}) => {
  const recoveryContinuity = createKernelRecoveryContinuity();
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
          tools: KERNEL_MCP_TOOLS,
        },
      };
    }

    if (method === 'tools/call') {
      const { name, arguments: toolArgs } = params || {};
      const callArgs = toolArgs || {};
      const resolvedRuntimeHome = runtimeHome || resolveKernelRuntimeHome({ env });
      try {
        const resultData = await handleMcpToolCall({
          name,
          parameters: callArgs,
          runtimeHome,
          env,
          hostBridge,
          nativeHost,
        });
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
          ? recoveryContinuity.decorate(resultData, recoveryInput)
          : resultData;
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
            isError: false,
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
}: StartMcpBridgeServerInput = {}) => {
  const handler = createMcpBridgeHandler({ runtimeHome, env, hostBridge, nativeHost });
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
