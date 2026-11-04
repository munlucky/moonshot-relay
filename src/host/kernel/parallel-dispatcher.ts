import type { HostAdapterDispatch } from './adapter-dispatch.js';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { runGit } from '../../shared/git-safe.js';
import { observeWorkspaceIdentity } from './workspace/workspace-identity.js';
import { readCanonicalParallelWorkerReceipts } from './workspace/canonical-worker-receipts.js';
import {
  prepareExecutionWorkspaces,
  prepareStepWorktree,
  prepareRecoveryIntegrationWorktree,
  createStepResultCommit,
  canUseExecutionWorkspace,
  cleanupExecutionWorkspaces,
} from './workspace/physical-worktree.js';
import { executeTrustedProof } from './proof/proof-executor.js';
import { buildUsageReceipt } from './usage-receipt.js';
import { prepareHostTurn } from './host-turn.js';
import { buildModelVisiblePromptView } from './model-capsule-view.js';
import { sanitizePersistentPayload } from '../../shared/persistent-sanitizer.js';
import type { WorkProfile } from '../../contracts/model-execution.js';

type UnknownRecord = Record<string, unknown>;

interface HostCapabilities extends UnknownRecord {
  surface?: string | null;
  supportsConcurrentSessions?: boolean;
  supportsIsolatedWorkingDirectory?: boolean;
  supportsPerSessionEnvironment?: boolean;
}

interface CommandLike {
  commandRef?: string;
}

interface StepLike extends UnknownRecord {
  stepId: string;
  allowedPaths?: string[];
  forbiddenPaths?: string[];
  obligationIds?: string[];
  expectedOutputs?: string[];
  objective?: unknown;
  workProfile?: WorkProfile | null;
  complexity?: unknown;
  sequence?: number;
  attemptCount?: number;
}

interface RunLike extends UnknownRecord {
  status?: string;
  projectId: string | null;
  worktreeId?: string | null;
  workspaceId?: string | null;
  taskContract?: UnknownRecord | null;
  proofTier?: string | null;
  independentReviewRequired?: boolean;
  mutationRevision?: number | null;
  currentWorkspaceIdentity?: string | null;
  baseCommitSha?: string | null;
}

interface WorkspaceLike extends UnknownRecord {
  workspaceRoot: string;
  workspaceId: string;
  stepId?: string;
  baseWorkspaceIdentity?: string | null;
}

interface AttemptLike extends UnknownRecord {
  id: number;
  attemptId?: string | null;
  bindingId?: string | null;
  actorSessionId?: string | null;
  mutationRevision?: number | null;
  capsuleId?: string | null;
  workspaceId?: string | null;
  resultWorkspaceIdentity?: string | null;
  resultCommitSha?: string | null;
  changedPaths?: string[];
  patchDigest?: string | null;
  workerReport?: unknown;
}

interface HostedLike extends UnknownRecord {
  status?: string;
  runId?: string;
  resolution?: UnknownRecord | null;
  strategy?: string;
  executionCapsule?: UnknownRecord | null;
  hostDirective?: UnknownRecord | null;
  hostExecutionContract?: UnknownRecord | null;
  executionContract?: UnknownRecord | null;
  modelInput?: UnknownRecord | null;
  envelope?: UnknownRecord | null;
  decision?: UnknownRecord | null;
  admission?: UnknownRecord | null;
  actorSessionId?: string | null;
}

interface DispatchResultLike extends UnknownRecord {
  status?: string;
  resultStatus?: string;
  errorSummary?: string;
  failureCategory?: string;
  actorSessionId?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  report?: UnknownRecord | null;
  kernelReport?: UnknownRecord | null;
}

interface StepDispatchResult extends UnknownRecord {
  status: string;
  failureCode?: string | null;
  result?: DispatchResultLike | null;
  workerReport?: UnknownRecord | null;
  reportResult?: UnknownRecord | null;
  hosted?: HostedLike;
  dispatchContext?: HostedLike | null;
  attempt?: AttemptLike | null;
}

interface ExecutableStepsLike extends UnknownRecord {
  steps: StepLike[];
  mode?: string;
  reason?: string | null;
  integrationVerification?: UnknownRecord | null;
}

interface OwnerFenceLike {
  lock: { workspaceId: string; fencingToken: number; sessionToken: string; expiresAt?: string | null };
}

type ControlPlaneLike = Awaited<ReturnType<typeof import('./control-plane-runtime.js').createKernelControlPlane>>;

type AdapterLike = {
  capabilities?: (HostCapabilities) | undefined;
  dispatch?: HostAdapterDispatch;
};

interface StepHostInput {
  controlPlane: StepControlPlane;
  runId: string;
  hostCapabilities: HostCapabilities;
  actionContext: UnknownRecord;
}
type StepControlPlane = {
  bindStepAttempt: (...args: Parameters<ControlPlaneLike['bindStepAttempt']>) => AttemptLike | null | Promise<AttemptLike | null>;
  updateStepAttempt?: (...args: Parameters<ControlPlaneLike['updateStepAttempt']>) => AttemptLike | null | Promise<AttemptLike | null>;
  report?: (...args: Parameters<ControlPlaneLike['report']>) => unknown | Promise<unknown>;
  getAttemptById?: (...args: Parameters<ControlPlaneLike['getAttemptById']>) => AttemptLike | null;
  recordModelUsage?: (...args: Parameters<ControlPlaneLike['recordModelUsage']>) => unknown | Promise<unknown>;
};
type ParallelControlPlane = StepControlPlane & {
  projectRoot?: string;
  // Read-only canonical observation: terminal settlement may release its own
  // Owner lock before this Host reaches the guarded finally block.
  stateStore?: { getWorkspaceMutationLockV2?: (workspaceId: string) => unknown };
  getExecutableSteps: (...args: Parameters<ControlPlaneLike['getExecutableSteps']>) => ExecutableStepsLike | Promise<ExecutableStepsLike>;
  getRun: (...args: Parameters<ControlPlaneLike['getRun']>) => RunLike | null | Promise<RunLike | null>;
  discoverProjectCommands?: () => CommandLike[];
  registerExecutionWorkspace?: (...args: Parameters<ControlPlaneLike['registerExecutionWorkspace']>) => { workspaceId: string };
  acquireOwnerWorkspaceMutationFence?: (...args: Parameters<ControlPlaneLike['acquireOwnerWorkspaceMutationFence']>) => OwnerFenceLike | Promise<OwnerFenceLike>;
  renewOwnerWorkspaceMutationFence?: (...args: Parameters<ControlPlaneLike['renewOwnerWorkspaceMutationFence']>) => OwnerFenceLike | Promise<OwnerFenceLike>;
  prepareNext?: (...args: Parameters<ControlPlaneLike['prepareNext']>) => unknown | Promise<unknown>;
} & {
  [K in 'assertOwnerWorkspaceMutationReady' | 'recordOwnerWorkspaceMutation' | 'releaseOwnerWorkspaceMutationFence' | 'settleParallelResult' | 'blockDeliveryMaterialization' | 'recordStepResult' | 'failStepAttempt']?: (...args: Parameters<ControlPlaneLike[K]>) => unknown | Promise<unknown>;
};
type PrepareHostFn = (input: StepHostInput) => HostedLike | Promise<HostedLike>;
type PrepareDispatchFn = (input: { hosted: HostedLike; step: StepLike; workspace: WorkspaceLike; parentSessionId: string | null }) => HostedLike | Promise<HostedLike>;
type DispatchStepFn = (input: { hosted: HostedLike; dispatchContext: HostedLike | null; adapter: AdapterLike; step: StepLike; workspace: WorkspaceLike; parentSessionId: string | null; parentSessionConfig: unknown }) => unknown | Promise<unknown>;
type SequentialDispatcherFn = (input: UnknownRecord) => unknown | Promise<unknown>;
type UsageReceiptInput = Parameters<typeof buildUsageReceipt>[0];
type RunGitOptions = NonNullable<Parameters<typeof runGit>[2]>;

interface VerificationRunnerInput extends UnknownRecord {
  commandRef: string;
  workspaceRoot: string;
}

interface MaterializeDeliveryInput extends UnknownRecord {
  patch: string;
  integrationWorkspaceIdentity: string;
  changedPaths: string[];
}

interface IntegrateParallelResultsInput {
  run: RunLike;
  steps: StepLike[];
  results: IntegrationReceipt[];
  integrationWorkspace: WorkspaceLike;
  deliveryWorkspace: { workspaceRoot?: string | null };
  integrationVerification: { commandRef: string };
  executeIntegrationVerification: (input: VerificationRunnerInput) => UnknownRecord | Promise<UnknownRecord>;
  beforeCherryPick?: (() => Promise<void>) | undefined;
  materializeDelivery: (input: MaterializeDeliveryInput) => UnknownRecord | Promise<UnknownRecord>;
  // Preflight creates only a protected candidate patch. No Owner CAS/Report.
  verifyOnly?: boolean;
  runtimeHome?: (string | null) | undefined;
  projectRoot: string;
  runId: string;
}

type PreparedWorkspace = Awaited<ReturnType<typeof prepareExecutionWorkspaces>>['integration'];
type RegisteredWorkspace = PreparedWorkspace & UnknownRecord & {
  workspaceId: string;
};
interface RegisteredWorkspaces {
  integration: RegisteredWorkspace | null;
  steps: RegisteredWorkspace[];
}

interface ParallelAdmissionInput {
  run?: RunLike | null;
  steps?: StepLike[];
  commands?: CommandLike[];
  hostCapabilities?: HostCapabilities;
  git?: { ready?: boolean; reason?: string | null };
  maxWorkers?: number;
  integrationVerification?: CommandLike | null;
}

interface DispatchDefaultStepInput {
  adapter: AdapterLike;
  hosted: HostedLike;
  dispatchContext?: HostedLike | null;
  workspace: WorkspaceLike;
  parentSessionId?: string | null;
  parentSessionConfig?: unknown;
  runId: string;
  step: StepLike;
  env?: NodeJS.ProcessEnv;
}

interface DispatchKernelStepOptions {
  runId: string;
  step: StepLike;
  workspace: WorkspaceLike;
  adapter: AdapterLike;
  hostCapabilities: HostCapabilities;
  parentSessionId?: string | null;
  parentSessionConfig?: unknown;
  actionContext?: NonNullable<Parameters<typeof prepareHostTurn>[0]>['actionContext'];
  dispatchStep?: DispatchStepFn | null;
  prepareDispatch?: PrepareDispatchFn | null;
  env?: NodeJS.ProcessEnv;
  deferReport?: boolean;
}
type DispatchKernelStepInput = DispatchKernelStepOptions & (
  | { controlPlane: ControlPlaneLike; prepareHost?: undefined }
  | { controlPlane: StepControlPlane; prepareHost: PrepareHostFn }
);

interface DispatchKernelParallelOptions {
  runId: string;
  adapter: AdapterLike;
  projectRoot?: string | null;
  runtimeHome?: (string | null) | undefined;
  parentSessionId?: string | null;
  parentSessionConfig?: unknown;
  env?: NodeJS.ProcessEnv;
  actionContext?: UnknownRecord;
  sequentialDispatcher?: SequentialDispatcherFn | null;
  dispatchStep?: DispatchStepFn | null;
  prepareDispatch?: PrepareDispatchFn | null;
  executeIntegrationVerification?: ((input: VerificationRunnerInput) => UnknownRecord | Promise<UnknownRecord>) | null;
  // Explicit macOS-only guarded delivery. Does not authorize Native Writer
  // replay or consumption of an unretired Writer's canonical result.
  guardedIntegration?: boolean;
}
type DispatchKernelParallelInput = DispatchKernelParallelOptions & (
  | { controlPlane: ControlPlaneLike; prepareHost?: undefined }
  | { controlPlane: ParallelControlPlane; prepareHost: PrepareHostFn }
);

interface IntegrationReceipt extends UnknownRecord {
  stepId: string;
  step: StepLike;
  workspace: WorkspaceLike;
  outcome: StepDispatchResult;
  resultCommitSha: string;
  changedPaths: string[];
  patchDigest: string | null;
  resultWorkspaceIdentity: string;
}

interface IntegrationResult extends UnknownRecord {
  status: string;
  failureCode?: string | null;
  deliveryWorkspaceIdentity?: unknown;
  integrationWorkspaceIdentity?: unknown;
  preIntegrationIdentity?: unknown;
  changedPaths?: string[];
  verification?: UnknownRecord;
  patch?: string;
  deliveryMutation?: UnknownRecord | null;
  error?: unknown;
}

const optionalText = (value: unknown): string | null => value == null ? null : typeof value === 'string' ? value : (() => { throw new TypeError('Host receipt string required'); })();

const asRecord = (value: unknown): UnknownRecord => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : {}
);

const errorRecord = (value: unknown): UnknownRecord => asRecord(value);
const nestedRecord = (record: UnknownRecord | null | undefined, key: string): UnknownRecord => asRecord(record?.[key]);

const baseCommit = (repoRoot: string): string | null => {
  const result = runGit(repoRoot, ['rev-parse', '--verify', 'HEAD']);
  if (result.error || result.status !== 0) return null;
  return String(result.stdout || '').trim();
};

const digest = (value: unknown): string => `sha256:${createHash('sha256').update(String(value || '')).digest('hex')}`;

// The owner fence is a lease. A synchronous, unbounded `git apply` could
// outlive that lease while still changing the Delivery workspace, so the
// mutating subprocess always receives a deadline strictly before the fence
// expires. The existing post-apply CAS remains the authoritative witness.
const DELIVERY_APPLY_MAX_MS = 60_000;
const DELIVERY_APPLY_SAFETY_MS = 1_000;
export const deliveryApplyTimeoutMs = ({ expiresAt = null, now = Date.now(), maxMs = DELIVERY_APPLY_MAX_MS }: { expiresAt?: string | null; now?: number; maxMs?: number } = {}): number => {
  const expiry = expiresAt ? Date.parse(expiresAt) : Number.NaN;
  const remaining = Number.isFinite(expiry) ? expiry - Number(now) : Number(maxMs) + DELIVERY_APPLY_SAFETY_MS;
  return Math.max(0, Math.min(Number(maxMs), Math.floor(remaining - DELIVERY_APPLY_SAFETY_MS)));
};

const normalizeHostCapabilities = (capabilities: HostCapabilities = {}) => ({
  supportsConcurrentSessions: capabilities.supportsConcurrentSessions === true,
  supportsIsolatedWorkingDirectory: capabilities.supportsIsolatedWorkingDirectory === true,
  supportsPerSessionEnvironment: capabilities.supportsPerSessionEnvironment === true,
});

export const hostSupportsParallel = (capabilities: HostCapabilities = {}): boolean => Object.values(normalizeHostCapabilities(capabilities)).every(Boolean);

const normalizePaths = (paths: readonly unknown[] = []): string[] => [...new Set(paths.map((entry) => String(entry).replaceAll('\\', '/').replace(/^\.\//u, '')).filter(Boolean))].sort();
const pathWithin = (value: unknown, scope: unknown): boolean => {
  const normalizedValue = String(value).replaceAll('\\', '/').toLowerCase();
  const normalizedScope = String(scope).replaceAll('\\', '/').toLowerCase().replace(/\/\*+$/u, '').replace(/\*+$/u, '').replace(/\/$/u, '');
  return normalizedValue === normalizedScope || normalizedValue.startsWith(`${normalizedScope}/`);
};
const scopeOverlaps = (left: readonly unknown[], right: readonly unknown[]): boolean => {
  const a = normalizePaths(left);
  const b = normalizePaths(right);
  return a.some((candidate) => b.some((other) => pathWithin(candidate, other) || pathWithin(other, candidate)));
};

const commandCandidates = (run: RunLike | null | undefined, explicit: CommandLike | null = null): string[] => {
  const refs: unknown[] = [explicit?.commandRef];
  const contract = asRecord(run?.taskContract);
  if (Array.isArray(contract.requiredVerifications)) {
    for (const itemValue of contract.requiredVerifications) {
      const item = asRecord(itemValue);
      if (Array.isArray(item.commandRefs)) refs.push(...item.commandRefs);
      else if (item.commandRef) refs.push(item.commandRef);
    }
  }
  if (Array.isArray(contract.acceptance)) {
    for (const itemValue of contract.acceptance) {
      const evidencePlan = nestedRecord(asRecord(itemValue), 'evidencePlan');
      if (Array.isArray(evidencePlan.commandRefs)) refs.push(...evidencePlan.commandRefs);
    }
  }
  return refs.filter(Boolean).map(String);
};

// Admission is a pure check over the current Step Ledger and host facts. It
// deliberately returns no identity that would need to be persisted.
export const deriveParallelAdmission = ({
  run = null,
  steps = [],
  commands = [],
  hostCapabilities = {},
  git = {},
  maxWorkers = 2,
  integrationVerification = null,
}: ParallelAdmissionInput = {}) => {
  const reasons: string[] = [];
  if (run?.status !== 'active') reasons.push('run-not-active');
  if (steps.length < 2) reasons.push('fewer-than-two-executable-steps');
  if (steps.some((step) => !Array.isArray(step.allowedPaths) || step.allowedPaths.length === 0)) reasons.push('step-write-scope-missing');
  if (steps.some((step) => (step.allowedPaths || []).some((scope: string) => ['*', '**'].includes(String(scope).trim())))) reasons.push('unbounded-write-scope');
  if (steps.some((step) => !((step.obligationIds || []).length || (step.expectedOutputs || []).length))) reasons.push('step-verification-missing');
  if (steps.some((step, index) => steps.slice(index + 1).some((other) => scopeOverlaps(step.allowedPaths || [], other.allowedPaths || [])))) reasons.push('write-scope-overlap');
  for (const [name, supported] of Object.entries(normalizeHostCapabilities(hostCapabilities))) {
    if (!supported) reasons.push(`host-${name}-unsupported`);
  }
  if (git.ready === false) reasons.push(git.reason || 'git-workspace-unavailable');

  const commandRef = commandCandidates(run, integrationVerification)
    .find((candidate) => commands.some((command) => command.commandRef === candidate)) || null;
  if (!commandRef) reasons.push('integration-command-missing');
  const contract = asRecord(run?.taskContract);
  const flags = nestedRecord(contract, 'flags');
  const t3Review = run?.proofTier === 'T3'
    && (run?.independentReviewRequired === true || flags.independentReviewRequired === true || contract.independentReview === true);
  const boundedLimit = t3Review ? 3 : 2;
  return {
    admitted: reasons.length === 0,
    reasons,
    workerLimit: Math.max(1, Math.min(Number(maxWorkers) || 2, boundedLimit, steps.length)),
    integrationVerification: commandRef ? { commandRef } : null,
  };
};

const fallback = async ({
  sequentialDispatcher,
  reason,
  context,
}: {
  sequentialDispatcher?: SequentialDispatcherFn | null;
  reason: string;
  context: UnknownRecord;
}) => {
  if (typeof sequentialDispatcher === 'function') return sequentialDispatcher(context);
  return { schemaVersion: 1, dispatched: false, fallback: true, reason };
};

const dispatchDefaultStep = async ({
  adapter,
  hosted,
  dispatchContext = null,
  workspace,
  parentSessionId = null,
  parentSessionConfig = null,
  runId,
  step,
  env = process.env,
}: DispatchDefaultStepInput): Promise<DispatchResultLike> => {
  if (!adapter.dispatch) throw new Error('parallel worker adapter requires dispatch');
  const context = dispatchContext || hosted;
  if (!context.resolution) throw Object.assign(new Error('parallel worker dispatch requires an admitted model resolution'), { code: 'WORKER_ROUTE_UNRESOLVED' });
  const contextDirective = asRecord(context.hostDirective);
  const hostedDirective = asRecord(hosted.hostDirective);
  const contextAssignment = nestedRecord(contextDirective, 'executionAssignment');
  const hostedAssignment = nestedRecord(hostedDirective, 'executionAssignment');
  const contextDelegation = nestedRecord(contextAssignment, 'delegation');
  const hostedDelegation = nestedRecord(hostedAssignment, 'delegation');
  const capsule = context.executionCapsule
    ? {
      ...context.executionCapsule,
      permissions: {
        ...nestedRecord(context.executionCapsule, 'permissions'),
        canCommit: false,
        canDelegate: false,
      },
    }
    : null;
  const executionMode = contextAssignment.executionMode || hostedAssignment.executionMode || null;
  const delegationRequested = contextDelegation.requested === true || hostedDelegation.requested === true;
  const decision = context.decision || contextDirective.modelRouteDecision || hostedDirective.modelRouteDecision || {};
  // Ignore any caller-provided projection. The adapter will reproject this
  // current capsule again at the provider boundary.
  const modelInput = context.modelInput || hosted.modelInput || { action: { type: 'implement' } };
  const modelVisiblePrompt = buildModelVisiblePromptView({ modelInput, capsule });
  return asRecord(await adapter.dispatch({
    decision: { ...asRecord(decision), role: String(asRecord(decision).role || '') },
    resolution: asRecord(context.resolution),
    strategy: context.strategy || contextDirective.enforcementStrategy || hostedDirective.enforcementStrategy || 'isolated',
    executionCapsule: capsule,
    hostExecutionContract: context.hostExecutionContract || hosted.hostExecutionContract || hostedDirective.executionContract,
    modelInput,
    modelVisiblePrompt,
    executionContract: context.executionContract || hosted.executionContract || {
      objective: step.objective,
      role: 'worker',
      permissions: { filesystem: 'workspace_write', canCommit: false, canDelegate: false },
      action: { type: 'implement', guidance: step.objective },
    },
    envelope: context.envelope || hosted.envelope || null,
    workingDirectory: workspace.workspaceRoot,
    environment: {
      ...env,
      MOON_RELAY_KERNEL_RUN_ID: context.runId || hosted.runId || runId,
      MOON_RELAY_KERNEL_STEP_ID: step.stepId,
      MOON_RELAY_KERNEL_WORKSPACE_ID: workspace.workspaceId,
      MOON_RELAY_KERNEL_SESSION_ID: context.actorSessionId || hosted.actorSessionId || `worker:${step.stepId}`,
    },
    parentSessionId,
    parentSessionConfig,
    concurrencyGroup: runId,
    childSession: { parentSessionId, maxNestedAgents: 0, canDelegate: false, canCommit: false },
    executionMode,
    delegationRequested,
    actionContext: { executionMode, delegationRequested },
  })) as DispatchResultLike;
};

export const dispatchKernelStep = async ({
  controlPlane,
  runId,
  step,
  workspace,
  adapter,
  hostCapabilities,
  parentSessionId = null,
  parentSessionConfig = null,
  actionContext = {},
  dispatchStep = null,
  prepareDispatch = null,
  prepareHost,
  env = process.env,
  deferReport = false,
}: DispatchKernelStepInput = {} as DispatchKernelStepInput): Promise<StepDispatchResult> => {
  let boundAttempt: AttemptLike | null = null;
  if (controlPlane?.bindStepAttempt) {
    boundAttempt = await controlPlane.bindStepAttempt(runId, step.stepId, {
      actorSessionId: `${parentSessionId || 'parent'}:worker:${step.stepId}`,
      workspaceId: workspace.workspaceId,
      workspaceIdentity: workspace.baseWorkspaceIdentity,
      baseWorkspaceIdentity: workspace.baseWorkspaceIdentity,
    });
  }
  const hosted: HostedLike = controlPlane
    ? await (prepareHost ? prepareHost({
      controlPlane,
      runId,
      hostCapabilities,
      actionContext: {
        ...actionContext,
        stepId: step.stepId,
        attemptId: boundAttempt?.attemptId || null,
        workingDirectory: workspace.workspaceRoot,
        workspaceId: workspace.workspaceId,
        workspaceIdentity: workspace.baseWorkspaceIdentity,
        parentSessionId,
        workProfile: step.workProfile || actionContext.workProfile || null,
        complexity: step.complexity || actionContext.complexity || null,
      },
    }) : prepareHostTurn({ controlPlane, runId, hostCapabilities, actionContext: {
      ...actionContext, stepId: step.stepId, attemptId: boundAttempt?.attemptId || null,
      workingDirectory: workspace.workspaceRoot, workspaceId: workspace.workspaceId,
      workspaceIdentity: workspace.baseWorkspaceIdentity, parentSessionId,
      workProfile: step.workProfile || actionContext.workProfile || null,
      complexity: step.complexity || actionContext.complexity || null,
    } }))
    : { runId, executionCapsule: null, hostDirective: {}, modelInput: { action: { type: 'implement' } } };
  if (hosted.status === 'not_found') return { status: 'failed', failureCode: 'run-not-found', hosted };
  if (boundAttempt && hosted.executionCapsule && controlPlane?.updateStepAttempt) {
    const updatedAttempt = await controlPlane.updateStepAttempt(String(boundAttempt.id), {
      capsuleId: hosted.executionCapsule.capsuleId,
      capsuleDigest: nestedRecord(hosted.executionCapsule, 'provenance').capsuleDigest || null,
    });
    if (updatedAttempt && typeof updatedAttempt === 'object' && updatedAttempt.attemptId) boundAttempt = updatedAttempt;
  }
  const dispatchContext = typeof prepareDispatch === 'function'
    ? await prepareDispatch({ hosted, step, workspace, parentSessionId })
    : null;
  if (dispatchContext?.status === 'failed') return { status: 'failed', failureCode: String(dispatchContext.failureCode || 'worker-route-rejected'), hosted, dispatchContext, attempt: boundAttempt };
  if (!dispatchContext && typeof dispatchStep !== 'function') return { status: 'failed', failureCode: 'worker-route-unresolved', hosted, attempt: boundAttempt };

  let result: DispatchResultLike;
  try {
    result = await (typeof dispatchStep === 'function'
      ? asRecord(await dispatchStep({ hosted, dispatchContext, adapter, step, workspace, parentSessionId, parentSessionConfig })) as DispatchResultLike
      : await dispatchDefaultStep({ adapter, hosted, dispatchContext, workspace, parentSessionId, parentSessionConfig, runId, step, env }));
  } catch (error: unknown) {
    const errorInfo = errorRecord(error);
    result = { status: 'failed', resultStatus: 'failed', errorSummary: String(errorInfo.message || error), failureCategory: 'provider/infrastructure' };
  }
  result = asRecord(sanitizePersistentPayload(result)) as DispatchResultLike;
  const usageContext = dispatchContext || hosted;
  const usageDirective = asRecord(usageContext.hostDirective);
  const hostedDirective = asRecord(hosted.hostDirective);
  const usageDecision = asRecord(usageContext.decision || usageDirective.modelRouteDecision || hostedDirective.modelRouteDecision);
  const directiveAttempt = asRecord(usageDirective.attempt);
  const usageAttempt = boundAttempt || (Object.keys(directiveAttempt).length > 0 ? directiveAttempt as AttemptLike : null);
  if (Object.keys(usageDecision).length > 0 && usageContext.resolution && usageContext.admission && controlPlane.recordModelUsage) {
    const usageReceipt = buildUsageReceipt({
      decision: usageDecision,
      capabilities: hostCapabilities,
      strategy: usageContext.strategy || String(usageDirective.enforcementStrategy || 'unsupported'),
      resolution: usageContext.resolution,
      dispatch: result,
      capsule: usageContext.executionCapsule || hosted.executionCapsule || null,
      admission: usageContext.admission,
      attemptId: usageAttempt?.attemptId || usageDirective.attemptId || null,
      bindingId: usageAttempt?.bindingId || null,
      actorSessionId: result.actorSessionId || `${hostCapabilities.surface}:${String(usageDecision.decisionId || '')}`,
      parentSessionId,
      startedAt: result.startedAt || null,
      finishedAt: result.finishedAt || new Date().toISOString(),
      envelope: usageContext.envelope || hosted.envelope || null,
    });
    await controlPlane.recordModelUsage(runId, usageReceipt);
    if (boundAttempt?.attemptId) boundAttempt = controlPlane.getAttemptById?.(runId, boundAttempt.attemptId) || boundAttempt;
  }
  const workerReportValue = result.report || result.kernelReport || null;
  const workerReport = Object.keys(asRecord(workerReportValue)).length > 0 ? asRecord(workerReportValue) : null;
  let reportResult: UnknownRecord | null = null;
  if (workerReport && !deferReport && controlPlane.report) {
    const hostedAssignment = nestedRecord(hostedDirective, 'executionAssignment');
    reportResult = asRecord(await controlPlane.report(runId, {
      ...workerReport,
      stepId: step.stepId,
      attemptId: optionalText(boundAttempt?.attemptId || workerReport.attemptId),
      capsuleId: optionalText(hosted.executionCapsule?.capsuleId || workerReport.capsuleId),
      workspaceId: workspace.workspaceId,
      bindingId: optionalText(boundAttempt?.bindingId || workerReport.bindingId),
      assignmentId: optionalText(workerReport.assignmentId || hostedAssignment.assignmentId || null),
      actorSessionId: optionalText(result.actorSessionId || boundAttempt?.actorSessionId || workerReport.actorSessionId),
    }));
  }
  const workerCompleted = ['passed', 'completed', 'success'].includes(String(result.status || result.resultStatus || ''));
  const reportAccepted = deferReport ? Boolean(workerReport) : nestedRecord(reportResult, 'step').state === 'passed';
  return {
    status: workerCompleted && reportAccepted ? 'passed' : 'failed',
    failureCode: !workerReport ? 'worker-report-missing' : !reportAccepted ? String(reportResult?.status || 'worker-report-not-passed') : null,
    result,
    workerReport,
    reportResult,
    hosted,
    dispatchContext,
    attempt: boundAttempt,
  };
};

const git = (root: string, args: string[], options: RunGitOptions = {}): string => {
  const result = runGit(root, args, { maxBuffer: 64 * 1024 * 1024, ...options });
  if (result.error || result.status !== 0) throw Object.assign(new Error(String(result.stderr || '').trim() || `git ${args[0]} failed`), { code: 'PARALLEL_INTEGRATION_FAILED', result });
  return String(result.stdout || '');
};

const stagedPaths = (root: string): string[] => normalizePaths(git(root, ['diff', '--name-only', '--cached', '--']).split(/\r?\n/u).filter(Boolean));

const integrateParallelResults = async ({ run, steps, results, integrationWorkspace, deliveryWorkspace, integrationVerification, executeIntegrationVerification, beforeCherryPick, materializeDelivery, verifyOnly = false, runtimeHome, projectRoot, runId }: IntegrateParallelResultsInput): Promise<IntegrationResult> => {
  const ordered = [...results].sort((left, right) => (steps.find((step) => step.stepId === left.stepId)?.sequence || 0) - (steps.find((step) => step.stepId === right.stepId)?.sequence || 0));
  const base = run.baseCommitSha || git(integrationWorkspace.workspaceRoot, ['rev-parse', 'HEAD']).trim();
  const preIntegrationIdentity = observeWorkspaceIdentity({ projectRoot: integrationWorkspace.workspaceRoot }).identity;
  try {
    if (git(integrationWorkspace.workspaceRoot, ['rev-parse', 'HEAD']).trim() !== base) throw new Error('parallel integration base changed');
    for (const result of ordered) {
      const step = steps.find((candidate) => candidate.stepId === result.stepId);
      if (!step || !result.resultCommitSha) throw new Error(`missing execution result for ${result.stepId || '<unknown>'}`);
      for (const changedPath of result.changedPaths || []) {
        if (!(step.allowedPaths || []).some((scope) => pathWithin(changedPath, scope)) || (step.forbiddenPaths || []).some((scope) => pathWithin(changedPath, scope))) {
          throw new Error(`execution result path is outside Step scope: ${changedPath}`);
        }
      }
      if (beforeCherryPick) await beforeCherryPick();
      git(integrationWorkspace.workspaceRoot, ['cherry-pick', '--no-commit', result.resultCommitSha]);
    }
    const integratedPaths = stagedPaths(integrationWorkspace.workspaceRoot);
    const declaredPaths = normalizePaths(ordered.flatMap((result) => result.changedPaths || []));
    if (JSON.stringify(integratedPaths) !== JSON.stringify(declaredPaths)) {
      throw Object.assign(new Error('integrated diff does not match execution receipts'), { code: 'integration_receipt_paths_mismatch' });
    }
    const preVerificationPatch = git(integrationWorkspace.workspaceRoot, ['diff', '--cached', '--binary', base]);
    const verification = asRecord(await executeIntegrationVerification({
      commandRef: integrationVerification.commandRef,
      workspaceRoot: integrationWorkspace.workspaceRoot,
      run,
      steps,
    }));
    if (verification.status !== 'passed' || verification.passed !== true) {
      throw Object.assign(new Error('parallel integration verification failed'), { code: 'integration_verification_failed' });
    }
    // Verification is trusted proof, not a second mutation authority. Re-read
    // both the staged path set and the exact patch after it runs so a helper
    // that stages an extra file (or changes an integrated file) cannot smuggle
    // content into Delivery outside the execution receipts.
    const postVerificationPaths = stagedPaths(integrationWorkspace.workspaceRoot);
    const postVerificationPatch = git(integrationWorkspace.workspaceRoot, ['diff', '--cached', '--binary', base]);
    if (JSON.stringify(postVerificationPaths) !== JSON.stringify(integratedPaths)
      || JSON.stringify(postVerificationPaths) !== JSON.stringify(declaredPaths)
      || postVerificationPatch !== preVerificationPatch) {
      throw Object.assign(new Error('integration verification changed the staged Delivery patch'), { code: 'integration_verification_changed_paths' });
    }
    const integrationIdentity = observeWorkspaceIdentity({ projectRoot: integrationWorkspace.workspaceRoot }).identity;
    const patch = postVerificationPatch;
    if (!patch) throw Object.assign(new Error('delivery_patch_empty'), { code: 'delivery_patch_empty' });
    if (verifyOnly) {
      return {
        status: 'verified', changedPaths: integratedPaths,
        integrationWorkspaceIdentity: integrationIdentity, preIntegrationIdentity,
        verification, patchDigest: digest(patch),
        deliveryMutation: null, deliveryAuthorized: false,
      };
    }
    if (typeof materializeDelivery !== 'function') {
      throw Object.assign(new Error('delivery_authority_unavailable'), { code: 'delivery_authority_unavailable' });
    }
    const deliveryMutation = asRecord(await materializeDelivery({
      patch,
      baseCommit: base,
      integrationWorkspaceIdentity: integrationIdentity,
      changedPaths: integratedPaths,
      deliveryRoot: deliveryWorkspace.workspaceRoot || projectRoot,
    }));
    return {
      status: 'integrated',
      deliveryWorkspaceIdentity: deliveryMutation.deliveryWorkspaceIdentity,
      integrationWorkspaceIdentity: integrationIdentity,
      preIntegrationIdentity,
      changedPaths: integratedPaths,
      verification,
      patch,
      deliveryMutation,
    };
  } catch (error: unknown) {
    try { runGit(integrationWorkspace.workspaceRoot, ['cherry-pick', '--abort']); } catch {}
    const failure = errorRecord(error);
    return { status: 'failed', failureCode: String(failure.code || 'parallel-integration-failed'), error, changedPaths: [] };
  }
};

export const dispatchKernelParallel = async (options: DispatchKernelParallelInput = {} as DispatchKernelParallelInput) => {
  let prepareHost: PrepareHostFn;
  if (options.prepareHost) prepareHost = options.prepareHost;
  else {
    const fullControlPlane = options.controlPlane;
    prepareHost = input => prepareHostTurn({ ...input, controlPlane: fullControlPlane });
  }
  const {
  controlPlane,
  runId,
  adapter,
  projectRoot,
  runtimeHome,
  parentSessionId = null,
  parentSessionConfig = null,
  env = process.env,
  actionContext = {},
  sequentialDispatcher = null,
  dispatchStep = null,
  prepareDispatch = null,
  executeIntegrationVerification = null,
  guardedIntegration = false,
  } = options;
  // Do not fall back to an uncontained Proof or a caller supplied verifier.
  // This opt-in is deliberately unavailable on Linux/Windows.
  if (guardedIntegration && (process.platform !== 'darwin' || executeIntegrationVerification)) {
    return { schemaVersion: 1, runId, dispatched: false, status: 'failed',
      failureCode: 'guarded_integration_os_proof_unavailable' };
  }
  const executable = await controlPlane.getExecutableSteps(runId);
  if ((executable.steps || []).length < 2 || executable.mode !== 'parallel') {
    return fallback({ sequentialDispatcher, reason: String(executable.reason || 'sequential-fast-path'), context: { runId, executable } });
  }
  const runCandidate = await controlPlane.getRun(runId);
  const repoRootCandidate = projectRoot || (typeof controlPlane.projectRoot === 'string' ? controlPlane.projectRoot : undefined);
  const commands = controlPlane.discoverProjectCommands ? controlPlane.discoverProjectCommands() : [];
  const gitCheck = repoRootCandidate ? canUseExecutionWorkspace(repoRootCandidate) : { ready: false, reason: 'project-root-missing' };
  const requestedIntegrationVerification = asRecord(actionContext.integrationVerification);
  const integrationVerification = requestedIntegrationVerification.commandRef
    ? { commandRef: String(requestedIntegrationVerification.commandRef) }
    : null;
  const admission = deriveParallelAdmission({
    run: runCandidate,
    steps: executable.steps,
    commands,
    hostCapabilities: adapter.capabilities || {},
    git: gitCheck,
    maxWorkers: executable.steps.length,
    integrationVerification,
  });
  if (!admission.admitted || !hostSupportsParallel(adapter.capabilities || {})) {
    if (guardedIntegration) return { schemaVersion: 1, runId, dispatched: false,
      status: 'failed', failureCode: 'guarded_integration_admission_denied' };
    return fallback({ sequentialDispatcher, reason: admission.reasons[0] || 'parallel-unavailable', context: { runId, executable, admission } });
  }
  if (!runCandidate?.projectId) throw new Error('PROJECT_ID_REQUIRED');
  const run = { ...runCandidate, projectId: runCandidate.projectId };
  const repoRoot = repoRootCandidate as string;
  const base = baseCommit(repoRoot);
  if (!base) {
    if (guardedIntegration) return { schemaVersion: 1, runId, dispatched: false,
      status: 'failed', failureCode: 'guarded_integration_head_unavailable' };
    return fallback({ sequentialDispatcher, reason: 'head-unavailable', context: { runId, executable } });
  }
  const deliveryIdentity = observeWorkspaceIdentity({ projectRoot: repoRoot }).identity;
  const deliverySnapshot = {
    expectedMutationRevision: Number(run?.mutationRevision || 0),
    expectedWorkspaceIdentity: run?.currentWorkspaceIdentity || deliveryIdentity,
    expectedHeadCommitSha: base,
    expectedProjectId: run?.projectId || null,
    expectedWorktreeId: run?.worktreeId || null,
    expectedWorkspaceId: run?.workspaceId || null,
  };
  if (run?.currentWorkspaceIdentity && run.currentWorkspaceIdentity !== deliveryIdentity) {
    return { schemaVersion: 1, runId, dispatched: false, status: 'failed', failureCode: 'delivery_workspace_drift', deliverySnapshot };
  }
  if (!controlPlane.acquireOwnerWorkspaceMutationFence
    || !controlPlane.renewOwnerWorkspaceMutationFence
    || !controlPlane.assertOwnerWorkspaceMutationReady
    || !controlPlane.recordOwnerWorkspaceMutation
    || !controlPlane.releaseOwnerWorkspaceMutationFence
    || !controlPlane.settleParallelResult
    || !controlPlane.blockDeliveryMaterialization
    || !controlPlane.recordStepResult) {
    if (guardedIntegration) return { schemaVersion: 1, runId, dispatched: false,
      status: 'failed', failureCode: 'guarded_integration_delivery_authority_unavailable' };
    return fallback({ sequentialDispatcher, reason: 'delivery-authority-unavailable', context: { runId, executable, deliverySnapshot } });
  }
  const acquireOwnerFence = controlPlane.acquireOwnerWorkspaceMutationFence;
  const renewOwnerFence = controlPlane.renewOwnerWorkspaceMutationFence;
  const assertOwnerMutationReady = controlPlane.assertOwnerWorkspaceMutationReady;
  const recordOwnerMutation = controlPlane.recordOwnerWorkspaceMutation;
  const releaseOwnerFence = controlPlane.releaseOwnerWorkspaceMutationFence;
  // The canonical Kernel settlement method calls other Control Plane methods
  // through `this`. Retain its receiver when crossing the Host dispatcher.
  const settleParallelResult = controlPlane.settleParallelResult.bind(controlPlane);
  const blockDeliveryMaterialization = controlPlane.blockDeliveryMaterialization;
  const recordStepResult = controlPlane.recordStepResult;

  let workspaces: RegisteredWorkspaces;
  try {
    // Do not touch the reusable `integration` checkout in guarded mode. A
    // previous Proof's unknown descendants could still write there.
    let prepared: {
      integration: PreparedWorkspace | null;
      steps: PreparedWorkspace[];
    };
    if (guardedIntegration) {
      const steps: PreparedWorkspace[] = [];
      for (const step of executable.steps) {
        steps.push(await prepareStepWorktree({
          repoRoot, baseCommit: base, runId, projectId: run.projectId,
          runtimeHome, stepId: step.stepId,
        }));
      }
      prepared = { integration: null, steps };
    } else {
      prepared = await prepareExecutionWorkspaces({
        repoRoot, baseCommit: base, runId, projectId: run.projectId,
        runtimeHome, steps: executable.steps,
      });
    }
    // Without physical Writer-exit evidence, never reuse an existing Step
    // checkout in this explicit guarded path. The legacy path is unchanged.
    if (guardedIntegration && prepared.steps.some((step) => step.reused)) {
      throw Object.assign(new Error('guarded Step workspace could still have a Writer'),
        { code: 'guarded_step_workspace_reused' });
    }
    if (!controlPlane.registerExecutionWorkspace) {
      throw Object.assign(new Error('logical workspace registration authority unavailable'), { code: 'workspace_authority_unavailable' });
    }
    const registerWorkspace = controlPlane.registerExecutionWorkspace;
    const register = (workspace: PreparedWorkspace): RegisteredWorkspace => ({
      ...workspace,
      ...registerWorkspace(runId, workspace.workspaceRoot),
    }) as RegisteredWorkspace;
    workspaces = {
      integration: prepared.integration ? register(prepared.integration) : null,
      steps: prepared.steps.map(register),
    };
  } catch (error: unknown) {
    if (guardedIntegration) return { schemaVersion: 1, runId, dispatched: false,
      status: 'failed', failureCode: String(errorRecord(error).code || 'guarded_execution_workspace_unavailable') };
    return fallback({ sequentialDispatcher, reason: 'execution-workspace-preparation-failed', context: { runId, executable, error } });
  }
  const workspaceByStep = new Map<string, RegisteredWorkspace>(
    workspaces.steps.map((workspace) => [String(workspace.stepId || ''), workspace]),
  );
  const dispatched = await Promise.allSettled(executable.steps.map((step) => dispatchKernelStep({
    controlPlane,
    runId,
    step,
    workspace: workspaceByStep.get(step.stepId) as RegisteredWorkspace,
    adapter,
    hostCapabilities: adapter.capabilities || {},
    parentSessionId,
    parentSessionConfig,
    actionContext,
    dispatchStep,
    prepareDispatch,
    prepareHost: input => prepareHost({ ...input, controlPlane }),
    env,
    deferReport: true,
  })));
  const successful: IntegrationReceipt[] = [];
  const dispatchFailures: Array<{ stepId: string; failureCode: string }> = [];
  const resultProcessingFailures: Array<{ stepId: string; failureCode: string; errorSummary: string }> = [];
  for (let index = 0; index < dispatched.length; index += 1) {
    const entry = dispatched[index]!;
    const step = executable.steps[index]!;
    if (entry.status !== 'fulfilled' || entry.value.status !== 'passed') {
      const failureCode = entry.status === 'rejected'
        ? String(errorRecord(entry.reason).code || 'worker-dispatch-failed')
        : String(entry.value.failureCode || 'worker-failed');
      dispatchFailures.push({ stepId: step.stepId, failureCode });
      // A concurrent Host lost the pre-spawn Step claim. Its failure must not
      // fail the winner's active Canonical Attempt or permit another Writer.
      if (failureCode !== 'STEP_ATTEMPT_ALREADY_CLAIMED' && controlPlane.failStepAttempt) {
        await controlPlane.failStepAttempt(runId, step.stepId, { code: failureCode });
      }
      continue;
    }
    try {
      const workspace = workspaceByStep.get(step.stepId) as RegisteredWorkspace;
      const commit = createStepResultCommit({
        workspaceRoot: workspace.workspaceRoot,
        runId,
        stepId: step.stepId,
        attemptNumber: Number(step.attemptCount || 0) + 1,
      });
      if (!commit.commitSha) throw new Error(`worker ${step.stepId} produced no result commit`);
      const resultWorkspaceIdentity = observeWorkspaceIdentity({ projectRoot: workspace.workspaceRoot }).identity;
      const executionReceipt: IntegrationReceipt = {
        stepId: step.stepId,
        step,
        workspace,
        outcome: entry.value,
        resultCommitSha: commit.commitSha,
        changedPaths: commit.changedPaths,
        patchDigest: commit.patch ? digest(commit.patch) : null,
        resultWorkspaceIdentity,
      };
      // Persist the worker's complete execution receipt before the owner
      // mutation. Delivery settlement is allowed to consume only this
      // canonical State Store row, never a dispatcher-memory projection.
      const workerReportAttemptId = entry.value.workerReport?.attemptId;
      const attemptId = entry.value.attempt?.attemptId || (workerReportAttemptId ? String(workerReportAttemptId) : null);
      if (!attemptId) throw Object.assign(new Error(`worker ${step.stepId} produced no canonical attempt id`), { code: 'worker_receipt_persistence_failed' });
      await recordStepResult(runId, step.stepId, {
        attemptId,
        executionWorkspaceId: workspace.workspaceId,
        mutationRevision: entry.value.attempt?.mutationRevision ?? run.mutationRevision ?? 0,
        resultWorkspaceIdentity,
        resultCommitSha: commit.commitSha,
        changedPaths: commit.changedPaths,
        patchDigest: executionReceipt.patchDigest,
        workerReport: entry.value.workerReport,
        recordMutationProvenance: false,
      });
      const persistedAttempt = controlPlane.getAttemptById?.(runId, attemptId) || null;
      if (!persistedAttempt
        || persistedAttempt.attemptId !== attemptId
        || persistedAttempt.workspaceId !== workspace.workspaceId
        || persistedAttempt.resultWorkspaceIdentity !== resultWorkspaceIdentity
        || persistedAttempt.resultCommitSha !== commit.commitSha
        || JSON.stringify(persistedAttempt.changedPaths || []) !== JSON.stringify(commit.changedPaths || [])
        || persistedAttempt.patchDigest !== executionReceipt.patchDigest
        || JSON.stringify(persistedAttempt.workerReport || null) !== JSON.stringify(entry.value.workerReport || null)) {
        throw Object.assign(new Error(`worker ${step.stepId} execution receipt was not durably persisted`), { code: 'worker_receipt_persistence_failed' });
      }
      successful.push(executionReceipt);
    } catch (error: unknown) {
      const failure = errorRecord(error);
      const failureCode = String(failure.code || 'worker-result-commit-failed');
      resultProcessingFailures.push({
        stepId: step.stepId,
        failureCode,
        errorSummary: String(failure.message || error),
      });
      if (controlPlane.failStepAttempt) await controlPlane.failStepAttempt(runId, step.stepId, { code: failureCode });
    }
  }
  const integrationRunner: (input: VerificationRunnerInput) => UnknownRecord | Promise<UnknownRecord> = executeIntegrationVerification
    || (async ({ commandRef, workspaceRoot }: VerificationRunnerInput) => {
      const execution = executeTrustedProof({
        projectRoot: workspaceRoot,
        commandRef,
        evidenceDir: path.join(runtimeHome as string, 'evidence', run.projectId, runId, 'parallel-integration'),
        ...(guardedIntegration ? { writeScope: workspaceRoot } : {}),
      });
      return {
        status: execution.status,
        passed: execution.status === 'passed',
        evidenceRef: execution.evidenceRef,
        verificationRef: execution.evidenceRef,
        execution,
      };
    });
  const admittedIntegrationVerification = admission.integrationVerification as { commandRef: string };
  // A concurrent Host owns at least one Step in our selected batch. Never
  // deliver only this Host's subset: a permissive integration command could
  // otherwise approve an incomplete patch and consume the Owner CAS.
  // Ordinary worker failures remain eligible for the existing partial-result
  // policy; only the canonical cross-Host claim conflict blocks Delivery.
  const competingStepClaim = dispatchFailures.some((failure) => failure.failureCode === 'STEP_ATTEMPT_ALREADY_CLAIMED');
  const guardedBatchReady = successful.length === executable.steps.length
    && dispatchFailures.length === 0 && resultProcessingFailures.length === 0;
  let guardedOwnerFence: OwnerFenceLike | null = null;
  let guardedFailure: string | null = null;
  let integrationWorkspace: RegisteredWorkspace | null = workspaces.integration;
  if (guardedIntegration && guardedBatchReady) {
    try {
      // This lock precedes the FIRST integration write, not just Owner CAS.
      guardedOwnerFence = await acquireOwnerFence(runId, deliverySnapshot);
      const fresh = await prepareRecoveryIntegrationWorktree({
        repoRoot, baseCommit: base, runtimeHome,
        runId, projectId: run.projectId,
      });
      const registered = await controlPlane.registerExecutionWorkspace?.(runId, fresh.workspaceRoot);
      if (!registered?.workspaceId) throw Object.assign(
        new Error('guarded integration registration unavailable'),
        { code: 'workspace_authority_unavailable' },
      );
      integrationWorkspace = { ...fresh, ...registered } as RegisteredWorkspace;
    } catch (error: unknown) {
      guardedFailure = String(errorRecord(error).code || 'guarded_integration_preparation_failed');
    }
  }
  const renewGuardedFence = async (
    snapshot: typeof deliverySnapshot = deliverySnapshot,
    phase: 'pre' | 'post-commit' = 'pre',
  ): Promise<void> => {
    if (!guardedOwnerFence) return;
    const renewed = await renewOwnerFence(runId, {
      ...snapshot,
      workspaceId: guardedOwnerFence.lock.workspaceId,
      fencingToken: guardedOwnerFence.lock.fencingToken,
      sessionToken: guardedOwnerFence.lock.sessionToken,
      phase,
    });
    if (!renewed.lock) throw Object.assign(new Error('guarded Owner fence lost'), { code: 'delivery_mutation_fence_lost' });
    guardedOwnerFence = { ...renewed, lock: renewed.lock };
  };
  const integration: IntegrationResult = guardedIntegration && !guardedBatchReady
    ? { status: 'failed', failureCode: 'guarded_integration_receipts_incomplete' }
    : guardedFailure
      ? { status: 'failed', failureCode: guardedFailure }
      : !integrationWorkspace
        ? { status: 'failed', failureCode: 'guarded_integration_workspace_unavailable' }
        : successful.length > 0 && !competingStepClaim
    ? await integrateParallelResults({
      run: { ...run, baseCommitSha: base },
      steps: executable.steps,
      results: successful,
      integrationWorkspace: integrationWorkspace as RegisteredWorkspace,
      beforeCherryPick: guardedOwnerFence ? renewGuardedFence : undefined,
      deliveryWorkspace: { workspaceRoot: repoRoot },
      integrationVerification: admittedIntegrationVerification,
      executeIntegrationVerification: integrationRunner,
      materializeDelivery: async ({
        patch,
        integrationWorkspaceIdentity,
        changedPaths,
      }: MaterializeDeliveryInput): Promise<UnknownRecord> => {
        if (path.resolve(repoRoot) !== path.resolve(controlPlane.projectRoot || repoRoot)) {
          throw Object.assign(new Error('delivery_workspace_mismatch'), { code: 'delivery_workspace_mismatch' });
        }
        let ownerFence: OwnerFenceLike | null = guardedOwnerFence;
        let applyAttempted = false;
        let primaryError: UnknownRecord | null = null;
        try {
          if (!ownerFence) ownerFence = await acquireOwnerFence(runId, deliverySnapshot);
          const check = runGit(repoRoot, ['apply', '--check', '--binary', '-'], { input: patch, maxBuffer: 64 * 1024 * 1024 });
          if (check.error || check.status !== 0) throw Object.assign(new Error(String(check.stderr || '').trim() || 'delivery patch check failed'), { code: 'delivery_patch_check_failed' });
          // The check itself can take long enough for the owner lease to
          // expire. Renew and re-run the full owner CAS immediately before the
          // mutating git apply; a lost/reissued fence therefore fails closed
          // before any Delivery bytes are changed.
          const renewedFence = await renewOwnerFence(runId, {
            ...deliverySnapshot,
            workspaceId: ownerFence.lock.workspaceId,
            fencingToken: ownerFence.lock.fencingToken,
            sessionToken: ownerFence.lock.sessionToken,
          });
          if (!renewedFence.lock) throw new Error('delivery_mutation_fence_lost');
          ownerFence = { ...renewedFence, lock: renewedFence.lock };
          await assertOwnerMutationReady(runId, {
            ...deliverySnapshot,
            expectedWorkspaceId: ownerFence.lock.workspaceId,
            fencingToken: ownerFence.lock.fencingToken,
            sessionToken: ownerFence.lock.sessionToken,
            integrationWorkspaceIdentity,
            changedPaths,
            patchDigest: digest(patch),
          });
          applyAttempted = true;
          const applyTimeoutMs = deliveryApplyTimeoutMs({ expiresAt: ownerFence.lock.expiresAt ?? null });
          if (applyTimeoutMs <= 0) {
            throw Object.assign(new Error('delivery mutation fence has insufficient remaining lease for patch apply'), { code: 'delivery_mutation_fence_lost' });
          }
          const apply = runGit(repoRoot, ['apply', '--binary', '-'], {
            input: patch,
            maxBuffer: 64 * 1024 * 1024,
            timeout: applyTimeoutMs,
            killSignal: 'SIGTERM',
          });
          if (apply.error || apply.status !== 0) {
            const timedOut = (apply.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
            throw Object.assign(new Error(String(apply.stderr || '').trim() || (timedOut ? 'delivery patch apply exceeded the owner fence deadline' : 'delivery patch failed')), {
              code: timedOut ? 'delivery_patch_apply_timeout' : 'delivery_patch_apply_failed',
            });
          }
          const mutation = asRecord(await recordOwnerMutation(runId, {
            ...deliverySnapshot,
            fencingToken: ownerFence.lock.fencingToken,
            sessionToken: ownerFence.lock.sessionToken,
            integrationWorkspaceIdentity,
            changedPaths,
            patchDigest: digest(patch),
          }));
          return { ...mutation, snapshot: deliverySnapshot };
        } catch (error: unknown) {
          primaryError = errorRecord(error);
          if (applyAttempted) {
            try {
              await blockDeliveryMaterialization(runId, {
                reason: 'delivery_materialization_recovery_required',
                detail: String(primaryError.message || error),
              });
            } catch (recoveryError: unknown) {
              primaryError.recoveryError = recoveryError;
            }
          }
          throw error;
        } finally {
          if (ownerFence && !guardedIntegration) {
            try {
              await releaseOwnerFence(runId, {
                workspaceId: ownerFence.lock.workspaceId,
                fencingToken: ownerFence.lock.fencingToken,
                sessionToken: ownerFence.lock.sessionToken,
              });
            } catch (releaseError: unknown) {
              if (primaryError) {
                primaryError.releaseError = releaseError;
              } else {
                const releaseFailure = errorRecord(releaseError);
                try {
                  await blockDeliveryMaterialization(runId, {
                    reason: 'delivery_materialization_recovery_required',
                    detail: String(releaseFailure.message || releaseError),
                  });
                } catch (recoveryError: unknown) {
                  releaseFailure.recoveryError = recoveryError;
                }
                throw releaseError;
              }
            }
          }
        }
      },
      runtimeHome,
      projectRoot: repoRoot,
      runId,
    })
    : { status: 'failed', failureCode: competingStepClaim ? 'parallel_step_claim_conflict' : 'no-successful-worker-result' };

  const reported: Array<IntegrationReceipt & { reportResult: UnknownRecord }> = [];
  const settlementFailures: Array<{ stepId: string; reportResult: UnknownRecord | null }> = [];
  try {
  if (integration.status === 'integrated') {
    for (const item of successful) {
      if (guardedOwnerFence) {
        // After CAS the expected revision and identity must advance. Renew
        // under the SAME token; never acquire a fresh token after mutation.
        const current = await controlPlane.getRun(runId);
        await renewGuardedFence({
          ...deliverySnapshot,
          expectedMutationRevision: Number(current?.mutationRevision ?? -1),
          expectedWorkspaceIdentity: observeWorkspaceIdentity({ projectRoot: repoRoot }).identity,
        }, 'post-commit');
      }
      const workerReport = item.outcome.workerReport;
      const reportResult = workerReport
        ? asRecord(await settleParallelResult(runId, {
          ...workerReport,
          stepId: item.step.stepId,
          attemptId: optionalText(item.outcome.attempt?.attemptId || workerReport.attemptId),
          capsuleId: optionalText(item.outcome.attempt?.capsuleId || workerReport.capsuleId),
          workspaceId: item.workspace.workspaceId,
          bindingId: optionalText(item.outcome.attempt?.bindingId || workerReport.bindingId),
          actorSessionId: optionalText(item.outcome.result?.actorSessionId || item.outcome.attempt?.actorSessionId || workerReport.actorSessionId),
        }, {
          deliveryMutation: integration.deliveryMutation,
          result: {
            attemptId: optionalText(item.outcome.attempt?.attemptId || workerReport.attemptId || null),
            executionWorkspaceId: item.workspace.workspaceId,
            workerWorkspaceIdentity: item.workspace.baseWorkspaceIdentity,
            resultWorkspaceIdentity: item.resultWorkspaceIdentity,
            resultCommitSha: item.resultCommitSha,
            changedPaths: item.changedPaths,
            patchDigest: item.patchDigest,
            workerReport,
          },
        }))
        : null;
      const reportStep = nestedRecord(reportResult, 'step');
      if (reportStep.state === 'passed') {
        reported.push({ ...item, reportResult: reportResult as UnknownRecord });
      } else if (controlPlane.failStepAttempt) {
        settlementFailures.push({ stepId: item.step.stepId, reportResult });
        await controlPlane.failStepAttempt(runId, item.step.stepId, { code: String(reportResult?.status || 'worker-report-not-passed') });
      }
    }
  }
  } catch (error: unknown) {
    // Owner CAS might already have committed. An uncertain settlement is a
    // blocked recovery, never permission to rerun Worker/Owner mutation.
    if (guardedOwnerFence && integration.status === 'integrated') {
      await blockDeliveryMaterialization(runId, {
        reason: 'delivery_materialization_recovery_required',
        detail: String(errorRecord(error).message || error),
      });
    }
    throw error;
  } finally {
    if (guardedOwnerFence) {
      try {
        // The final Report can complete the Run and Kernel terminal
        // reconciliation releases its Owner lock atomically. Treat that
        // verified terminal/no-lock observation as already retired, rather
        // than attempting a second release of a non-existent lock. Never
        // suppress stale-token or lost-fence failures for an active Run.
        const terminal = (await controlPlane.getRun(runId))?.status === 'completed';
        const readLock = controlPlane.stateStore?.getWorkspaceMutationLockV2;
        const releasedByTerminalSettlement = terminal && typeof readLock === 'function'
          && readLock(guardedOwnerFence.lock.workspaceId) === null;
        if (!releasedByTerminalSettlement) await releaseOwnerFence(runId, {
          workspaceId: guardedOwnerFence.lock.workspaceId,
          fencingToken: guardedOwnerFence.lock.fencingToken,
          sessionToken: guardedOwnerFence.lock.sessionToken,
        });
      } catch (error: unknown) {
        if (integration.status === 'integrated') {
          await blockDeliveryMaterialization(runId, {
            reason: 'delivery_materialization_recovery_required',
            detail: String(errorRecord(error).message || error),
          });
        }
        throw error;
      }
    }
  }
  const failed = dispatchFailures.length + resultProcessingFailures.length + settlementFailures.length;
  const continuation = integration.status === 'integrated' && failed === 0 && controlPlane.prepareNext
    ? asRecord(await controlPlane.prepareNext(runId))
    : null;
  // The guarded OS-scoped Proof may have detached children whose lifetime is
  // unknown. Never remove its Run/Step worktrees on mere Report success.
  const cleanup = integration.status === 'integrated' && failed === 0 && !guardedIntegration
    ? await cleanupExecutionWorkspaces({ runtimeHome, projectId: run.projectId, runId, repoRoot, retain: false })
    : await cleanupExecutionWorkspaces({ runtimeHome, projectId: run.projectId, runId, repoRoot, retain: true });
  return {
    schemaVersion: 1,
    runId,
    dispatched: true,
    status: integration.status === 'integrated' && settlementFailures.length === 0 && failed === 0
      ? 'passed'
      : integration.status === 'integrated' ? 'partial-failure' : 'failed',
    workerResults: dispatched,
    dispatchFailures,
    resultProcessingFailures,
    executionResults: reported,
    settlementFailures,
    integration,
    deliveryMutation: integration.deliveryMutation || null,
    next: continuation,
    cleanup,
    baseWorkspaceIdentity: deliveryIdentity,
  };
};

export const dispatchKernelRun = (options: DispatchKernelParallelInput = {} as DispatchKernelParallelInput) => dispatchKernelParallel(options);

// T42-B preflight: assemble and verify old canonical Worker results without
// claiming that the old Native Writer or any detached descendant has exited.
// The caller cannot turn this result into a Delivery authorization.
export const verifyCanonicalParallelRecoveryCandidate = async ({
  controlPlane, runId, projectRoot, runtimeHome, commandRef,
}: {
  controlPlane: ControlPlaneLike;
  runId: string;
  projectRoot: string;
  runtimeHome: string;
  commandRef: string;
}): Promise<UnknownRecord> => {
  const refusal = (failureCode: string): UnknownRecord => ({
    schemaVersion: 1, runId, status: 'blocked', failureCode,
    writerExitVerified: false, deliveryAuthorized: false,
  });
  // T35 OS-scoped Proof is required for known and unknown post-Proof writers.
  if (process.platform !== 'darwin') return refusal('recovery_os_write_scope_unavailable');
  if (!commandRef || !runtimeHome) return refusal('recovery_proof_command_missing');
  const run = await controlPlane.getRun(runId);
  const snapshot = readCanonicalParallelWorkerReceipts({ controlPlane, runId, projectRoot, runtimeHome });
  if (snapshot.status !== 'ready') return refusal(snapshot.code);
  if (!run?.projectId || !run.workspaceId) return refusal('recovery_owner_authority_unavailable');
  const stepRows = controlPlane.getRunSteps(runId);
  const steps = stepRows as StepLike[];
  if (steps.length !== snapshot.receipts.length) return refusal('recovery_step_count_changed');
  const ownerBase = baseCommit(projectRoot);
  if (!ownerBase) return refusal('recovery_owner_base_unavailable');
  const expected = {
    expectedMutationRevision: Number(run.mutationRevision ?? -1),
    expectedWorkspaceIdentity: run.currentWorkspaceIdentity ?? observeWorkspaceIdentity({ projectRoot }).identity,
    expectedHeadCommitSha: ownerBase,
    expectedProjectId: run.projectId,
    expectedWorktreeId: run.worktreeId,
    expectedWorkspaceId: run.workspaceId,
  };
  let fence: OwnerFenceLike | null = null;
  let integrationWorkspace: RegisteredWorkspace | null = null;
  let outcome: UnknownRecord = refusal('recovery_preflight_not_started');
  try {
    // Acquire before any Git integration writes; the competing recovery Host
    // is denied by the existing Kernel Owner Fence, not by a new lock system.
    fence = await controlPlane.acquireOwnerWorkspaceMutationFence(runId, expected);
    const reread = readCanonicalParallelWorkerReceipts({ controlPlane, runId, projectRoot, runtimeHome });
    if (reread.status !== 'ready'
      || JSON.stringify(reread.receipts) !== JSON.stringify(snapshot.receipts)) {
      throw Object.assign(new Error('recovery_receipt_changed_under_fence'), { code: 'recovery_receipt_changed_under_fence' });
    }
    const prepared = await prepareRecoveryIntegrationWorktree({
      repoRoot: projectRoot, baseCommit: ownerBase,
      runtimeHome, runId, projectId: run.projectId,
    });
    const registered = controlPlane.registerExecutionWorkspace(runId, prepared.workspaceRoot);
    if (!registered?.workspaceId) throw Object.assign(new Error('recovery_integration_registration_unavailable'), { code: 'recovery_integration_registration_unavailable' });
    integrationWorkspace = { ...prepared, ...registered } as RegisteredWorkspace;
    const renew = async (): Promise<void> => {
      if (!fence) throw Object.assign(new Error('recovery_fence_missing'), { code: 'delivery_mutation_fence_lost' });
      const updated = await controlPlane.renewOwnerWorkspaceMutationFence(runId, {
        ...expected, workspaceId: fence.lock.workspaceId,
        fencingToken: fence.lock.fencingToken,
        sessionToken: fence.lock.sessionToken,
      });
      if (!updated.lock) throw Object.assign(new Error('recovery_fence_lost'), { code: 'delivery_mutation_fence_lost' });
      fence = { lock: updated.lock };
    };
    const integrated = await integrateParallelResults({
      run: { ...run, baseCommitSha: ownerBase },
      steps,
      results: snapshot.receipts.map((receipt) => ({
        stepId: receipt.stepId,
        step: steps.find((item) => item.stepId === receipt.stepId)!,
        workspace: { workspaceRoot: receipt.workspaceRoot, workspaceId: receipt.executionWorkspaceId },
        outcome: { status: 'passed', workerReport: receipt.workerReport },
        resultCommitSha: receipt.resultCommitSha,
        changedPaths: receipt.changedPaths,
        patchDigest: receipt.patchDigest,
        resultWorkspaceIdentity: receipt.resultWorkspaceIdentity,
      })),
      integrationWorkspace,
      deliveryWorkspace: { workspaceRoot: projectRoot },
      integrationVerification: { commandRef },
      executeIntegrationVerification: async ({ commandRef: ref, workspaceRoot }) => {
        const execution = executeTrustedProof({
          projectRoot: workspaceRoot, commandRef: ref,
          writeScope: workspaceRoot,
          evidenceDir: path.join(runtimeHome, 'evidence', run.projectId!, runId, 'recovery-preflight'),
        });
        const mechanism = execution.writeContainment?.mechanism;
        return {
          status: mechanism === 'macos-seatbelt' ? execution.status : 'failed',
          passed: execution.status === 'passed' && mechanism === 'macos-seatbelt',
          verificationRef: execution.evidenceRef,
          execution,
        };
      },
      beforeCherryPick: renew,
      materializeDelivery: () => { throw new Error('recovery_preflight_has_no_delivery_authority'); },
      verifyOnly: true,
      runtimeHome, projectRoot, runId,
    });
    if (integrated.status !== 'verified') throw Object.assign(new Error('recovery_integration_verification_failed'), { code: String(integrated.failureCode || 'recovery_integration_verification_failed') });
    await renew();
    const afterProof = readCanonicalParallelWorkerReceipts({ controlPlane, runId, projectRoot, runtimeHome });
    if (afterProof.status !== 'ready'
      || JSON.stringify(afterProof.receipts) !== JSON.stringify(snapshot.receipts)) {
      throw Object.assign(new Error('recovery_receipt_changed_during_proof'), { code: 'recovery_receipt_changed_during_proof' });
    }
    outcome = {
      schemaVersion: 1, runId, status: 'verified',
      candidate: {
        changedPaths: integrated.changedPaths,
        patchDigest: integrated.patchDigest,
        integrationWorkspaceIdentity: integrated.integrationWorkspaceIdentity,
        integrationWorkspaceRoot: integrationWorkspace.workspaceRoot,
      },
      verification: integrated.verification,
      writerExitVerified: false, deliveryAuthorized: false,
    };
  } catch (error: unknown) {
    outcome = refusal(String(errorRecord(error).code || 'recovery_preflight_failed'));
  } finally {
    if (fence) {
      // Do not release silently: after expiry the previous Host cannot make
      // any Owner claim about this preflight (even though it changed no Owner).
      try {
        await controlPlane.releaseOwnerWorkspaceMutationFence(runId, {
          workspaceId: fence.lock.workspaceId,
          fencingToken: fence.lock.fencingToken,
          sessionToken: fence.lock.sessionToken,
        });
      } catch {
        outcome = refusal('recovery_owner_fence_release_unconfirmed');
      }
    }
  }
  // Do not cleanup the physical integration Worktree: unknown Proof children
  // could remain alive even after the synchronous Proof runner returned.
  return outcome;
};
