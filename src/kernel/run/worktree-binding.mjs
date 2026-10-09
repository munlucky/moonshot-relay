import { resolveKernelProjectIdentity, stableHash } from '../project-identity.mjs';
import { registerWorkspace, resolveStableWorkspaceIdentity } from './workspace-registration.mjs';

export class KernelWorktreeBindingError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = 'KernelWorktreeBindingError';
    this.code = code;
    this.errorCode = code;
    this.details = details;
  }
}

const fail = (code, details = {}) => { throw new KernelWorktreeBindingError(code, details); };

const requiredString = (value, code) => {
  const normalized = String(value || '').trim();
  if (!normalized) fail(code);
  return normalized;
};

const optionalString = (value) => {
  if (value === null || value === undefined || value === '') return null;
  return String(value);
};

export const deriveKernelWorktreeId = ({
  projectId,
  canonicalWorktreeRoot,
  canonicalGitDir = null,
} = {}) => {
  const identity = [
    requiredString(projectId, 'worktree_project_identity_invalid'),
    requiredString(canonicalWorktreeRoot, 'worktree_root_identity_invalid'),
    optionalString(canonicalGitDir),
  ];
  return `worktree-${stableHash(JSON.stringify(identity))}`;
};

const worktreeIdentityFromWorkspace = (workspace = {}) => {
  const identity = workspace.identity || {};
  const projectId = requiredString(identity.projectId || workspace.projectId, 'worktree_project_identity_invalid');
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

export const resolveKernelWorktreeIdentity = ({
  cwd = process.cwd(),
  env = process.env,
  projectIdentity = null,
  workspaceRoot = null,
  platform = process.platform,
} = {}) => {
  const project = projectIdentity || resolveKernelProjectIdentity({ cwd, env });
  const resolvedWorkspaceRoot = workspaceRoot || project.projectRoot || project.canonicalRoot;
  if (!project?.projectId || !resolvedWorkspaceRoot) fail('worktree_binding_invalid');

  const workspace = resolveStableWorkspaceIdentity({
    projectId: project.projectId,
    workspaceRoot: resolvedWorkspaceRoot,
    platform,
  });
  const worktree = worktreeIdentityFromWorkspace(workspace);

  return {
    ...worktree,
    workspaceRoot: resolvedWorkspaceRoot,
    projectIdentity: project,
    workspaceIdentity: workspace.identity,
  };
};

export const resolveKernelWorktreeBinding = resolveKernelWorktreeIdentity;

export const registerKernelWorktreeBinding = ({ stateStore, ...options } = {}) => {
  if (!stateStore || typeof stateStore.registerProjectWorkspace !== 'function') {
    fail('worktree_registry_invalid');
  }
  const resolved = resolveKernelWorktreeIdentity(options);
  const registeredWorkspace = registerWorkspace({
    stateStore,
    projectId: resolved.projectId,
    workspaceRoot: resolved.workspaceRoot,
    worktreeId: resolved.worktreeId,
  });
  const registered = worktreeIdentityFromWorkspace(registeredWorkspace);
  if (registered.worktreeId !== resolved.worktreeId) {
    fail('worktree_registration_mismatch', {
      resolvedWorktreeId: resolved.worktreeId,
      registeredWorktreeId: registered.worktreeId,
    });
  }

  return {
    ...resolved,
    ...registered,
    registeredWorkspace,
  };
};

export const assertRunWorktreeBinding = ({
  run,
  worktree = null,
  projectId = null,
  worktreeId = null,
  workspaceId = null,
} = {}) => {
  const resolvedWorktree = worktree || { projectId, worktreeId, workspaceId };
  if (!run || !run.runId) fail('active_run_not_found');
  if (!resolvedWorktree?.projectId || !resolvedWorktree?.worktreeId) fail('worktree_binding_invalid');

  const runProjectId = optionalString(run.projectId);
  const runWorktreeId = optionalString(run.worktreeId);
  const runWorkspaceId = optionalString(run.workspaceId);
  if (!runProjectId || runProjectId !== String(resolvedWorktree.projectId)) {
    fail('run_project_mismatch', { runId: String(run.runId) });
  }
  if (!runWorktreeId && !runWorkspaceId) {
    fail('run_worktree_unbound', { runId: String(run.runId) });
  }
  if (runWorktreeId) {
    // worktreeId is the lifecycle authority. workspaceId remains a legacy
    // compatibility handle and may legitimately differ after registry alias
    // reconciliation, so never compare workspace-* directly with worktree-*.
    if (runWorktreeId !== String(resolvedWorktree.worktreeId)) {
      fail('run_worktree_mismatch', { runId: String(run.runId) });
    }
  } else if (runWorkspaceId !== optionalString(resolvedWorktree.workspaceId)) {
    fail('run_workspace_mismatch', { runId: String(run.runId) });
  }

  return {
    valid: true,
    runId: String(run.runId),
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
} = {}) => {
  const validated = assertRunWorktreeBinding({ run, worktree, ...binding });
  if (!['active', 'blocked'].includes(run.status)) return { ...validated, lease: null };
  if (!stateStore || typeof stateStore.getWorktreeMutationLease !== 'function') {
    fail('worktree_mutation_lease_unavailable', { runId: String(run.runId) });
  }
  const lease = stateStore.getWorktreeMutationLease(validated.worktreeId);
  if (!lease) fail('worktree_mutation_lease_missing', { runId: String(run.runId) });
  if (
    lease.worktreeId !== validated.worktreeId
    || lease.projectId !== validated.projectId
    || lease.holderRunId !== String(run.runId)
  ) {
    fail('worktree_mutation_lease_conflict', {
      runId: String(run.runId),
      holderRunId: lease.holderRunId || null,
    });
  }
  return { ...validated, lease };
};

export const validateRunWorktreeBinding = (input = {}) => {
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
