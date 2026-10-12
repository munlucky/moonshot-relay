import { createHash } from 'node:crypto';

export interface WorktreeIdentityInput {
  projectId?: unknown;
  canonicalWorktreeRoot?: unknown;
  canonicalGitDir?: unknown;
}

export interface WorkspaceIdentityLike {
  projectId?: unknown;
  canonicalRoot?: unknown;
  gitWorktreeDir?: unknown;
  gitCommonDir?: unknown;
}

export interface RegisteredWorkspaceLike {
  workspaceId?: unknown;
  projectId?: unknown;
  canonicalRoot?: unknown;
  gitWorktreeDir?: unknown;
  gitCommonDir?: unknown;
  identity?: WorkspaceIdentityLike | null;
}

export interface KernelWorktreeIdentity {
  schemaVersion: 1;
  projectId: string;
  worktreeId: string;
  workspaceId: string;
  canonicalWorktreeRoot: string;
  canonicalGitDir: string | null;
  gitCommonDir: string | null;
}

export interface RunWorktreeLike {
  runId?: unknown;
  projectId?: unknown;
  worktreeId?: unknown;
  workspaceId?: unknown;
  status?: unknown;
}

export interface WorktreeMutationLease {
  worktreeId?: unknown;
  projectId?: unknown;
  holderRunId?: unknown;
}

export interface WorktreeLeaseStore {
  getWorktreeMutationLease(worktreeId: string): WorktreeMutationLease | null | undefined;
}

export class KernelWorktreeBindingError extends Error {
  readonly code: string;
  readonly errorCode: string;
  readonly details: Record<string, unknown>;

  constructor(code: string, details: Record<string, unknown> = {}) {
    super(code);
    this.name = 'KernelWorktreeBindingError';
    this.code = code;
    this.errorCode = code;
    this.details = details;
  }
}

const fail = (code: string, details: Record<string, unknown> = {}): never => {
  throw new KernelWorktreeBindingError(code, details);
};

const requiredString = (value: unknown, code: string): string => {
  const normalized = String(value || '').trim();
  if (!normalized) fail(code);
  return normalized;
};

const optionalString = (value: unknown): string | null => {
  if (value === null || value === undefined || value === '') return null;
  return String(value);
};

const stableHash = (value: unknown): string => (
  createHash('sha256').update(String(value)).digest('hex')
);

export const deriveKernelWorktreeId = ({
  projectId,
  canonicalWorktreeRoot,
  canonicalGitDir = null,
}: WorktreeIdentityInput = {}): string => {
  const identity = [
    requiredString(projectId, 'worktree_project_identity_invalid'),
    requiredString(canonicalWorktreeRoot, 'worktree_root_identity_invalid'),
    optionalString(canonicalGitDir),
  ];
  return `worktree-${stableHash(JSON.stringify(identity))}`;
};

export const worktreeIdentityFromWorkspace = (
  workspace: RegisteredWorkspaceLike = {},
): KernelWorktreeIdentity => {
  const identity = workspace.identity || {};
  const projectId = requiredString(
    identity.projectId || workspace.projectId,
    'worktree_project_identity_invalid',
  );
  const canonicalWorktreeRoot = requiredString(
    identity.canonicalRoot || workspace.canonicalRoot,
    'worktree_root_identity_invalid',
  );
  const canonicalGitDir = optionalString(identity.gitWorktreeDir ?? workspace.gitWorktreeDir);
  const gitCommonDir = optionalString(identity.gitCommonDir ?? workspace.gitCommonDir);
  const workspaceId = requiredString(workspace.workspaceId, 'workspace_identity_invalid');
  const worktreeId = deriveKernelWorktreeId({ projectId, canonicalWorktreeRoot, canonicalGitDir });

  return {
    schemaVersion: 1,
    projectId,
    worktreeId,
    workspaceId,
    canonicalWorktreeRoot,
    canonicalGitDir,
    gitCommonDir,
  };
};

export interface AssertRunWorktreeBindingInput {
  run?: (RunWorktreeLike | null) | undefined;
  worktree?: Partial<KernelWorktreeIdentity> | null;
  projectId?: unknown;
  worktreeId?: unknown;
  workspaceId?: unknown;
}

export interface ValidRunWorktreeBinding {
  valid: true;
  runId: string;
  projectId: string;
  worktreeId: string;
  workspaceId: string | null;
  bindingAuthority: 'worktreeId' | 'workspaceId';
}

export const assertRunWorktreeBinding = ({
  run,
  worktree = null,
  projectId = null,
  worktreeId = null,
  workspaceId = null,
}: AssertRunWorktreeBindingInput = {}): ValidRunWorktreeBinding => {
  const resolvedWorktree = worktree || { projectId, worktreeId, workspaceId };
  if (!run || !run.runId) throw new KernelWorktreeBindingError('active_run_not_found');
  if (!resolvedWorktree?.projectId || !resolvedWorktree?.worktreeId) {
    throw new KernelWorktreeBindingError('worktree_binding_invalid');
  }
  const activeRun = run;

  const runProjectId = optionalString(activeRun.projectId);
  const runWorktreeId = optionalString(activeRun.worktreeId);
  const runWorkspaceId = optionalString(activeRun.workspaceId);
  if (!runProjectId || runProjectId !== String(resolvedWorktree.projectId)) {
    fail('run_project_mismatch', { runId: String(activeRun.runId) });
  }
  if (!runWorktreeId && !runWorkspaceId) {
    fail('run_worktree_unbound', { runId: String(activeRun.runId) });
  }
  if (runWorktreeId) {
    if (runWorktreeId !== String(resolvedWorktree.worktreeId)) {
      fail('run_worktree_mismatch', { runId: String(activeRun.runId) });
    }
  } else if (runWorkspaceId !== optionalString(resolvedWorktree.workspaceId)) {
    fail('run_workspace_mismatch', { runId: String(activeRun.runId) });
  }

  return {
    valid: true,
    runId: String(activeRun.runId),
    projectId: String(resolvedWorktree.projectId),
    worktreeId: String(resolvedWorktree.worktreeId),
    workspaceId: optionalString(resolvedWorktree.workspaceId),
    bindingAuthority: runWorktreeId ? 'worktreeId' : 'workspaceId',
  };
};

export const assertRunWorktreeMutationAuthority = ({
  stateStore,
  run,
  worktree = null,
  ...binding
}: AssertRunWorktreeBindingInput & {
  stateStore?: WorktreeLeaseStore | null;
} = {}): ValidRunWorktreeBinding & { lease: WorktreeMutationLease | null } => {
  const validated = assertRunWorktreeBinding({ run, worktree, ...binding });
  if (!run || !['active', 'blocked'].includes(String(run.status))) {
    return { ...validated, lease: null };
  }
  if (!stateStore || typeof stateStore.getWorktreeMutationLease !== 'function') {
    throw new KernelWorktreeBindingError('worktree_mutation_lease_unavailable', {
      runId: validated.runId,
    });
  }
  const leaseStore = stateStore;

  const observedLease = leaseStore.getWorktreeMutationLease(validated.worktreeId);
  if (!observedLease) {
    throw new KernelWorktreeBindingError('worktree_mutation_lease_missing', {
      runId: validated.runId,
    });
  }
  const lease = observedLease;
  if (
    String(lease.worktreeId || '') !== validated.worktreeId
    || String(lease.projectId || '') !== validated.projectId
    || String(lease.holderRunId || '') !== validated.runId
  ) {
    fail('worktree_mutation_lease_conflict', {
      runId: validated.runId,
      holderRunId: lease.holderRunId || null,
    });
  }

  return { ...validated, lease };
};

export type RunWorktreeBindingValidation = ValidRunWorktreeBinding | {
  valid: false;
  runId: string | null;
  errorCode: string;
};

export const validateRunWorktreeBinding = (
  input: AssertRunWorktreeBindingInput = {},
): RunWorktreeBindingValidation => {
  try {
    return assertRunWorktreeBinding(input);
  } catch (error) {
    if (!(error instanceof KernelWorktreeBindingError)) throw error;
    return {
      valid: false,
      runId: input.run?.runId ? String(input.run.runId) : null,
      errorCode: error.code,
    };
  }
};
