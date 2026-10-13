import path from 'node:path';
import { buildAgentRecovery } from '../../../kernel/run/agent-recovery.js';
import { discoverRunLocator, readRunRecoveryState, reconcileOrphanRunLocators } from '../../../kernel/run/run-locator.js';
import { observeWorkspaceIdentity } from '../workspace/workspace-identity.js';
import { resolveKernelWorktreeIdentity } from '../workspace/worktree-resolution.js';

export function diagnoseKernelRecovery({ projectRoot, runtimeHome, runId = null, sessionId = null,
  failure = null, previous = null, reconcile = false, env = {} }: {
  projectRoot: string; runtimeHome: string; runId?: string | null; sessionId?: string | null;
  failure?: unknown; previous?: unknown; reconcile?: boolean; env?: NodeJS.ProcessEnv;
}) {
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
