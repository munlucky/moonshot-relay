import path from 'node:path';
import { buildAgentRecovery } from '../../../kernel/run/agent-recovery.js';
import { discoverRunLocator, readRunRecoveryState, reconcileOrphanRunLocators } from '../../../kernel/run/run-locator.js';
import { observeWorkspaceIdentity } from '../workspace/workspace-identity.js';
import { resolveKernelWorktreeIdentity } from '../workspace/worktree-resolution.js';

export interface DiagnoseKernelRecoveryInput {
  projectRoot: string;
  runtimeHome: string;
  runId?: string | null;
  sessionId?: string | null;
  failure?: unknown;
  previous?: unknown;
  reconcile?: boolean;
  env?: NodeJS.ProcessEnv;
}

export function diagnoseKernelRecovery({ projectRoot, runtimeHome, runId = null, sessionId = null,
  failure = null, previous = null, reconcile = false, env = {} }: DiagnoseKernelRecoveryInput) {
  const observationErrors: string[] = [];
  let reconciliation = null;
  if (reconcile) reconciliation = reconcileOrphanRunLocators({ projectRoot, runtimeHome, runId });
  const discovery = discoverRunLocator({ projectRoot, runtimeHome, runId });
  const observedRunId = runId || (discovery.status === 'resolved' ? discovery.locator?.runId || null : null);
  let state: ReturnType<typeof readRunRecoveryState> = null;
  let workspace: ReturnType<typeof observeWorkspaceIdentity> | null = null;
  let boundWorktree = false;
  try { state = readRunRecoveryState({ runtimeHome, runId: observedRunId }); }
  catch { observationErrors.push('durable-state-unreadable'); }
  try {
    workspace = observeWorkspaceIdentity({ projectRoot });
    const identity = resolveKernelWorktreeIdentity({ cwd: projectRoot, env });
    boundWorktree = identity.worktreeId === state?.run.worktreeId
      && identity.projectId === state?.run.projectId;
  } catch { observationErrors.push('workspace-observation-unavailable'); }
  const expiresAt = state?.owner?.expiresAt;
  const recovery = buildAgentRecovery({
    failure, previous,
    observation: {
      projectRoot: path.resolve(projectRoot), runtimeHome: path.resolve(runtimeHome), runId: observedRunId,
      discoveryStatus: discovery.status, workspaceIdentity: workspace?.identity || null,
      workspaceStatus: workspace?.changedPaths ? 'known' : 'unknown', changedPaths: workspace?.changedPaths || [],
      run: state?.run || null, step: state?.step || null, sessionId, ownerSessionId: state?.owner?.sessionId ? String(state.owner.sessionId) : null,
      ownerBindingActive: boundWorktree && state?.owner?.status === 'active' && state.owner.accessMode === 'owner'
        && (!expiresAt || Date.parse(String(expiresAt)) > Date.now()),
      worktreeLeaseOwned: boundWorktree && state?.lease?.holderRunId === observedRunId && state?.lease?.projectId === state?.run.projectId,
      observationErrors,
    },
  });
  return { schemaVersion: 1, status: 'recovery-required', runId: observedRunId,
    action: { type: recovery.mode === 'repair' ? 'fix' : recovery.mode === 'escalate' ? 'blocked' : 'analysis',
      mode: recovery.mode, guidance: recovery.nextAction }, recovery, reconciliation };
}

const continuityKey = ({
  projectRoot,
  runtimeHome,
  runId = null,
  sessionId = null,
}: Pick<DiagnoseKernelRecoveryInput, 'projectRoot' | 'runtimeHome' | 'runId' | 'sessionId'>): string => (
  JSON.stringify([
    path.resolve(projectRoot),
    path.resolve(runtimeHome),
    runId || null,
    sessionId || null,
  ])
);

const fallbackContinuityKey = (
  input: Pick<DiagnoseKernelRecoveryInput, 'projectRoot' | 'runtimeHome' | 'sessionId'>,
): string => continuityKey({ ...input, runId: null });

export function createKernelRecoveryContinuity() {
  // Host-owned, process-local continuity only. Durable Run/owner/scope/proof
  // authority stays in Kernel state; this cache merely feeds the previous
  // diagnosis capsule back into the existing fingerprint comparison.
  const previousByContext = new Map<string, unknown>();
  const failureStatuses = new Set([
    'error',
    'blocked',
    'contract-rejected',
    'evidence-rejected',
    'execution-readiness-blocked',
  ]);

  const diagnose = (input: DiagnoseKernelRecoveryInput) => {
    const fallbackKey = fallbackContinuityKey(input);
    const explicitKey = input.runId ? continuityKey(input) : null;
    const previous = input.previous
      ?? (explicitKey ? previousByContext.get(explicitKey) : null)
      ?? previousByContext.get(fallbackKey)
      ?? null;
    const result = diagnoseKernelRecovery({ ...input, previous });
    previousByContext.set(fallbackKey, result.recovery);
    if (result.runId) {
      previousByContext.set(continuityKey({ ...input, runId: result.runId }), result.recovery);
    }
    return result;
  };

  const decorateOne = (
    value: unknown,
    input: Omit<DiagnoseKernelRecoveryInput, 'failure' | 'previous'>,
  ): unknown => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const payload = value as Record<string, unknown>;
    const existing = payload.recovery && typeof payload.recovery === 'object' && !Array.isArray(payload.recovery)
      ? payload.recovery as Record<string, unknown>
      : {};
    if (existing.kind === 'agent-recovery' || !failureStatuses.has(String(payload.status || ''))) return payload;
    try {
      const result = diagnose({
        ...input,
        runId: String(payload.runId || input.runId || '') || null,
        failure: payload,
      });
      return {
        ...payload,
        ...(payload.recovery ? { bindingRecovery: payload.recovery } : {}),
        recovery: result.recovery,
      };
    } catch {
      return payload;
    }
  };

  return {
    diagnose,
    decorate(
      value: unknown,
      input: Omit<DiagnoseKernelRecoveryInput, 'failure' | 'previous'>,
    ) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
      const payload = value as Record<string, unknown>;
      const next = payload.next && typeof payload.next === 'object' && !Array.isArray(payload.next)
        ? decorateOne(payload.next, input)
        : payload.next;
      return decorateOne(next === payload.next ? payload : { ...payload, next }, input);
    },
    hasRecovery(value: unknown): boolean {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
      const payload = value as Record<string, unknown>;
      const recovery = payload.recovery && typeof payload.recovery === 'object' && !Array.isArray(payload.recovery)
        ? payload.recovery as Record<string, unknown>
        : {};
      if (recovery.kind === 'agent-recovery') return true;
      const next = payload.next && typeof payload.next === 'object' && !Array.isArray(payload.next)
        ? payload.next as Record<string, unknown>
        : {};
      const nextRecovery = next.recovery && typeof next.recovery === 'object' && !Array.isArray(next.recovery)
        ? next.recovery as Record<string, unknown>
        : {};
      return nextRecovery.kind === 'agent-recovery';
    },
    clear(input: Pick<DiagnoseKernelRecoveryInput, 'projectRoot' | 'runtimeHome' | 'runId' | 'sessionId'>) {
      previousByContext.delete(fallbackContinuityKey(input));
      if (input.runId) previousByContext.delete(continuityKey(input));
    },
  };
}

export type KernelRecoveryContinuity = ReturnType<typeof createKernelRecoveryContinuity>;
