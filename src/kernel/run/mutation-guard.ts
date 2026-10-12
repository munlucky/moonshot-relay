import { capsuleStaleness } from './execution-capsule.js';
import { findScopeViolations } from './capsule-selection.js';
import { canonicalPathIdentity } from '../../shared/path-identity.js';
import {
  assertRunWorktreeMutationAuthority,
  type KernelWorktreeIdentity,
  type RunWorktreeLike,
  type WorktreeLeaseStore,
} from '../../contracts/worktree-authority.js';

export { canonicalPathIdentity } from '../../shared/path-identity.js';

type UnknownRecord = Record<string, unknown>;

interface KernelMutationError extends Error {
  code: string;
}

interface WorkspaceLike {
  workspaceId?: unknown;
  projectId?: unknown;
  worktreeId?: unknown;
  canonicalRoot?: unknown;
}

interface WorkspaceMutationLockLike {
  holderRunId?: unknown;
  fencingToken?: unknown;
  sessionToken?: unknown;
}

interface RunLike extends RunWorktreeLike, UnknownRecord {
  runId: string;
  currentWorkspaceIdentity?: unknown;
  mutationRevision?: unknown;
  contractRevision?: unknown;
  planRevision?: unknown;
}

interface StepLike {
  state?: unknown;
  executionWorkspaceId?: unknown;
  baseWorkspaceIdentity?: unknown;
}

interface CapsulePermissionsLike extends UnknownRecord {
  canCommit?: unknown;
}

interface CapsuleWorkUnitLike extends UnknownRecord {
  allowedPaths?: string[];
  forbiddenPaths?: string[];
}

interface CapsuleLike extends UnknownRecord {
  stepId?: unknown;
  role?: unknown;
  expiresAt?: unknown;
  permissions?: CapsulePermissionsLike | null;
  workUnit?: CapsuleWorkUnitLike | null;
}

interface MutationGuardStore extends WorktreeLeaseStore {
  getRun(runId: string): RunLike | null | undefined;
  getProjectWorkspace?(workspaceId: string): WorkspaceLike | null | undefined;
  getWorkspaceMutationLockV2(workspaceId: string): WorkspaceMutationLockLike | null | undefined;
  getRunStep(runId: string, stepId: string): StepLike | null | undefined;
  getExecutionCapsule(
    capsuleId: string,
    input: { runId: string },
  ): CapsuleLike | null | undefined;
}

interface MutationPathObservation {
  withinWorkspace?: boolean;
  relativePath?: unknown;
}

export type MutationPathResolver = (input: {
  workspaceRoot: string;
  targetPath: string;
  platform: NodeJS.Platform;
}) => MutationPathObservation | null | undefined;

export const MUTATION_OPERATIONS = Object.freeze([
  'file_write', 'file_delete', 'git_commit', 'git_checkout', 'git_reset',
  'dependency_install', 'migration', 'destructive_command',
] as const);

export type MutationOperation = (typeof MUTATION_OPERATIONS)[number];
type MutationMode = 'mutation' | 'delivery';
type DeliveryPhase = 'pre' | 'post' | 'post-commit';

const mutationError = (code: string, message: unknown): KernelMutationError => {
  const error = new Error(`${code}: ${String(message)}`) as KernelMutationError;
  error.code = code;
  return error;
};

const fail = (code: string, message: unknown): never => {
  throw mutationError(code, message);
};

const errorCode = (error: unknown, fallback: string): string => (
  error && typeof error === 'object' && 'code' in error
    ? String(error.code || fallback)
    : fallback
);

const errorMessage = (error: unknown): string => (
  error instanceof Error ? error.message : String(error)
);

const failForMode = (
  mode: MutationMode,
  genericCode: string,
  deliveryCode: string,
  message: unknown,
): never => fail(
  mode === 'delivery' ? deliveryCode : genericCode,
  message,
);

const registeredWorkspaceFor = ({
  stateStore,
  workspaceId,
}: {
  stateStore: MutationGuardStore;
  workspaceId: string | null;
  run: RunLike;
}): WorkspaceLike | null => (
  workspaceId && stateStore.getProjectWorkspace
    ? stateStore.getProjectWorkspace(workspaceId) || null
    : null
);

export const canonicalMutationPath = ({
  workspaceRoot,
  targetPath,
  resolveMutationPath,
  platform = process.platform,
}: {
  workspaceRoot?: string;
  targetPath?: string;
  resolveMutationPath?: MutationPathResolver | null;
  platform?: NodeJS.Platform;
} = {}): string => {
  if (typeof resolveMutationPath !== 'function') {
    throw mutationError(
      'mutation_guard_invalid',
      'resolveMutationPath Host service is required',
    );
  }
  const root = String(workspaceRoot || '');
  const target = String(targetPath || '');
  const observation = resolveMutationPath({
    workspaceRoot: root,
    targetPath: target,
    platform,
  });
  if (!observation || observation.withinWorkspace !== true) {
    throw mutationError(
      'mutation_outside_workspace',
      `target escapes workspace: ${target}`,
    );
  }
  const relative = canonicalPathIdentity(observation.relativePath, { platform });
  if (!relative || relative === '.') return '.';
  if (relative.startsWith('../')) {
    fail('mutation_outside_workspace', `target escapes workspace: ${target}`);
  }
  return relative;
};

// The workspace lock and its fencing credentials are the shared mutation
// authority. Ordinary Step mutations and owner Delivery materialization both
// enter through this primitive; the caller decides whether a Step/Capsule
// scope must be checked after the fence is held.
export const assertWorkspaceMutationFence = ({
  stateStore,
  workspaceRoot,
  runId,
  workspaceId = null,
  projectId = null,
  fencingToken = null,
  sessionToken = null,
  worktree = null,
  requireOwnerWorktree = false,
  mode = 'mutation',
}: {
  stateStore?: (MutationGuardStore | null) | undefined;
  workspaceRoot?: (string | null) | undefined;
  runId?: (string) | undefined;
  workspaceId?: string | null;
  projectId?: string | null;
  fencingToken?: unknown;
  sessionToken?: unknown;
  worktree?: Partial<KernelWorktreeIdentity> | null;
  requireOwnerWorktree?: boolean;
  mode?: MutationMode;
} = {}) => {
  if (!stateStore || !workspaceRoot) {
    throw mutationError(
      'mutation_guard_invalid',
      'stateStore and workspaceRoot are required',
    );
  }
  const activeStore: MutationGuardStore = stateStore;
  const activeRunId = String(runId || '');
  const run = activeStore.getRun(activeRunId);
  if (!run || run.status !== 'active') {
    throw mutationError(
      mode === 'delivery' ? 'delivery_run_inactive' : 'mutation_run_inactive',
      activeRunId,
    );
  }

  const effectiveWorkspaceId = workspaceId || (
    run.workspaceId ? String(run.workspaceId) : null
  );
  const registeredWorkspace = registeredWorkspaceFor({
    stateStore: activeStore,
    workspaceId: effectiveWorkspaceId,
    run,
  });
  if (
    registeredWorkspace
    && canonicalPathIdentity(workspaceRoot)
      !== canonicalPathIdentity(registeredWorkspace.canonicalRoot)
  ) {
    failForMode(
      mode,
      'mutation_workspace_mismatch',
      'delivery_workspace_mismatch',
      effectiveWorkspaceId || activeRunId,
    );
  }

  if (requireOwnerWorktree) {
    try {
      assertRunWorktreeMutationAuthority({
        stateStore: activeStore,
        run,
        worktree: worktree || {
          projectId: String(projectId || run.projectId || ''),
          worktreeId: String(run.worktreeId || ''),
          ...(effectiveWorkspaceId ? { workspaceId: effectiveWorkspaceId } : {}),
        },
      });
    } catch (error: unknown) {
      failForMode(
        mode,
        errorCode(error, 'mutation_worktree_authority_lost'),
        'delivery_worktree_authority_lost',
        errorMessage(error),
      );
    }
  }

  if (!effectiveWorkspaceId) {
    throw mutationError(
      mode === 'delivery' ? 'delivery_workspace_mismatch' : 'mutation_workspace_mismatch',
      activeRunId,
    );
  }
  const lock = activeStore.getWorkspaceMutationLockV2(effectiveWorkspaceId);
  if (!lock) {
    throw mutationError(
      mode === 'delivery' ? 'delivery_mutation_fence_lost' : 'workspace_mutation_lock_missing',
      run.projectId,
    );
  }
  if (fencingToken === null || fencingToken === undefined || !sessionToken) {
    failForMode(
      mode,
      'mutation_fence_credentials_missing',
      'delivery_mutation_fence_lost',
      run.projectId,
    );
  }
  if (
    lock.holderRunId !== activeRunId
    || lock.fencingToken !== fencingToken
    || lock.sessionToken !== sessionToken
  ) {
    failForMode(
      mode,
      'workspace_mutation_fence_mismatch',
      'delivery_mutation_fence_lost',
      run.projectId,
    );
  }

  return {
    allowed: true,
    run,
    workspaceId: effectiveWorkspaceId,
    workspace: registeredWorkspace,
    lock,
    fencingToken: lock.fencingToken,
    sessionToken: lock.sessionToken,
  };
};

// Delivery CAS adds the owner Run/worktree snapshot and the native workspace
// checks to the shared fence. `phase=pre` is used immediately before git
// apply; `phase=post` deliberately permits the expected dirty state while
// still requiring the Run/revision/HEAD/fence to be unchanged.
export const assertOwnerWorkspaceMutationCAS = ({
  stateStore,
  workspaceRoot,
  runId,
  workspaceId = null,
  projectId = null,
  worktree = null,
  fencingToken = null,
  sessionToken = null,
  expectedMutationRevision = null,
  expectedWorkspaceIdentity = null,
  expectedHeadCommitSha = null,
  expectedWorkspaceId = null,
  expectedWorktreeId = null,
  expectedProjectId = null,
  actualWorkspaceIdentity = null,
  headCommitSha = null,
  workspaceStatus = null,
  phase = 'pre',
}: {
  stateStore?: MutationGuardStore | null;
  workspaceRoot?: string | null;
  runId?: string;
  workspaceId?: string | null;
  projectId?: string | null;
  worktree?: Partial<KernelWorktreeIdentity> | null;
  fencingToken?: (unknown) | undefined;
  sessionToken?: unknown;
  expectedMutationRevision?: (unknown) | undefined;
  expectedWorkspaceIdentity?: (string | null) | undefined;
  expectedHeadCommitSha?: (string | null) | undefined;
  expectedWorkspaceId?: string | null;
  expectedWorktreeId?: string | null;
  expectedProjectId?: string | null;
  actualWorkspaceIdentity?: string | null;
  headCommitSha?: string | null;
  workspaceStatus?: string | null;
  phase?: DeliveryPhase;
} = {}) => {
  const fence = assertWorkspaceMutationFence({
    stateStore,
    workspaceRoot,
    runId,
    workspaceId,
    projectId,
    fencingToken,
    sessionToken,
    worktree,
    requireOwnerWorktree: true,
    mode: 'delivery',
  });
  const run = fence.run;
  if (expectedWorkspaceId && run.workspaceId !== expectedWorkspaceId) {
    fail(
      'delivery_worktree_authority_lost',
      `Run workspace ${String(run.workspaceId || '<missing>')} does not match expected workspace ${expectedWorkspaceId}`,
    );
  }
  if (expectedProjectId && run.projectId !== expectedProjectId) {
    fail(
      'delivery_worktree_authority_lost',
      `Run project ${String(run.projectId)} does not match expected project ${expectedProjectId}`,
    );
  }
  if (expectedWorktreeId && run.worktreeId !== expectedWorktreeId) {
    fail(
      'delivery_worktree_authority_lost',
      `Run worktree ${String(run.worktreeId || '<missing>')} does not match expected worktree ${expectedWorktreeId}`,
    );
  }
  if (
    expectedMutationRevision !== null
    && expectedMutationRevision !== undefined
    && Number(run.mutationRevision) !== Number(expectedMutationRevision)
  ) {
    fail(
      'delivery_mutation_revision_stale',
      `Run mutation revision ${String(run.mutationRevision)} does not match expected ${String(expectedMutationRevision)}`,
    );
  }
  if (
    expectedWorkspaceIdentity
    && run.currentWorkspaceIdentity !== expectedWorkspaceIdentity
  ) {
    fail(
      'delivery_workspace_drift',
      'Run workspace identity no longer matches the Delivery CAS snapshot',
    );
  }

  if (!headCommitSha) fail('delivery_head_changed', 'Delivery HEAD is unavailable');
  if (expectedHeadCommitSha && headCommitSha !== expectedHeadCommitSha) {
    fail(
      'delivery_head_changed',
      `Delivery HEAD ${headCommitSha} does not match expected ${expectedHeadCommitSha}`,
    );
  }

  const observedIdentity = actualWorkspaceIdentity || null;
  if (phase === 'pre' || phase === 'post-commit') {
    if (expectedWorkspaceIdentity && !observedIdentity) {
      fail(
        'delivery_workspace_observation_missing',
        'Delivery CAS requires a Host-observed workspace identity',
      );
    }
    if (
      expectedWorkspaceIdentity
      && observedIdentity !== expectedWorkspaceIdentity
    ) {
      fail(
        'delivery_workspace_drift',
        'Delivery workspace identity no longer matches the CAS snapshot',
      );
    }
  }
  if (phase === 'pre') {
    if (workspaceStatus === null) {
      fail('delivery_workspace_drift', 'Delivery workspace status is unavailable');
    }
    if (workspaceStatus) {
      fail('delivery_workspace_drift', 'Delivery workspace is dirty before materialization');
    }
  }

  return {
    ...fence,
    run,
    headCommitSha,
    workspaceIdentity: observedIdentity,
    phase,
  };
};

export const assertMutationAllowed = ({
  stateStore,
  workspaceRoot,
  runId,
  stepId,
  capsuleId,
  operation,
  targetPaths = [],
  fencingToken = null,
  sessionToken = null,
  resolveMutationPath = null,
}: {
  stateStore?: MutationGuardStore | null;
  workspaceRoot?: string | null;
  runId?: string;
  stepId?: string;
  capsuleId?: string;
  operation?: MutationOperation | string;
  targetPaths?: string[];
  fencingToken?: unknown;
  sessionToken?: unknown;
  resolveMutationPath?: MutationPathResolver | null;
} = {}) => {
  if (!stateStore || !workspaceRoot) {
    throw mutationError(
      'mutation_guard_invalid',
      'stateStore and workspaceRoot are required',
    );
  }
  const activeStore: MutationGuardStore = stateStore;
  const activeRunId = String(runId || '');
  const activeStepId = String(stepId || '');
  const activeCapsuleId = String(capsuleId || '');
  const requestedOperation = String(operation || '');

  if (!(MUTATION_OPERATIONS as readonly string[]).includes(requestedOperation)) {
    fail('mutation_operation_unknown', requestedOperation);
  }
  const run = activeStore.getRun(activeRunId);
  if (!run || run.status !== 'active') {
    throw mutationError('mutation_run_inactive', activeRunId);
  }
  const step = activeStore.getRunStep(activeRunId, activeStepId);
  if (!step || !['ready', 'running', 'active'].includes(String(step.state))) {
    throw mutationError('mutation_step_inactive', activeStepId);
  }
  const capsule = activeStore.getExecutionCapsule(activeCapsuleId, {
    runId: activeRunId,
  });
  if (
    !capsule
    || capsule.stepId !== activeStepId
    || capsule.role !== 'implementer'
  ) {
    throw mutationError('mutation_capsule_invalid', activeCapsuleId);
  }
  const capsuleRun: RunLike = step.baseWorkspaceIdentity
    ? { ...run, currentWorkspaceIdentity: step.baseWorkspaceIdentity }
    : run;
  const stale = capsuleStaleness({ capsule, run: capsuleRun });
  if (stale.stale) {
    fail('mutation_capsule_stale', (stale.reasons || []).join(', '));
  }
  if (
    capsule.expiresAt
    && Date.parse(String(capsule.expiresAt)) <= Date.now()
  ) {
    fail('mutation_capsule_expired', activeCapsuleId);
  }
  if (['git_reset', 'destructive_command'].includes(requestedOperation)) {
    fail('mutation_operation_forbidden', requestedOperation);
  }
  if (
    requestedOperation === 'git_commit'
    && capsule.permissions?.canCommit !== true
  ) {
    fail('mutation_operation_forbidden', requestedOperation);
  }

  const effectiveWorkspaceId = step.executionWorkspaceId
    ? String(step.executionWorkspaceId)
    : run.workspaceId
      ? String(run.workspaceId)
      : null;
  const fence = assertWorkspaceMutationFence({
    stateStore: activeStore,
    workspaceRoot,
    runId: activeRunId,
    workspaceId: effectiveWorkspaceId,
    fencingToken,
    sessionToken,
  });

  const relativePaths = targetPaths.map((targetPath) => canonicalMutationPath({
    workspaceRoot,
    targetPath,
    resolveMutationPath,
  }));
  const violations = findScopeViolations({
    changedPaths: relativePaths,
    allowedPaths: capsule.workUnit?.allowedPaths || [],
    forbiddenPaths: capsule.workUnit?.forbiddenPaths || [],
  });
  if (violations.length) {
    fail(
      'mutation_path_forbidden',
      violations.map((item) => item.path).join(', '),
    );
  }
  return {
    allowed: true,
    runId: activeRunId,
    stepId: activeStepId,
    workspaceId: effectiveWorkspaceId,
    capsuleId: activeCapsuleId,
    operation: requestedOperation,
    targetPaths: relativePaths,
    fencingToken: fence.fencingToken,
  };
};
