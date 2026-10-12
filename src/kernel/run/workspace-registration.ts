import type { StableWorkspaceObservation } from '../../contracts/workspace-observation.js';
import {
  worktreeIdentityFromWorkspace,
  type KernelWorktreeIdentity,
} from '../../contracts/worktree-authority.js';

export interface RegisteredWorkspace {
  workspaceId: string;
  projectId?: string | null;
  canonicalRoot: string;
  gitCommonDir?: string | null;
  gitWorktreeDir?: string | null;
  worktreeId?: string | null;
  identity?: {
    projectId?: string | null;
    canonicalRoot?: string | null;
    gitCommonDir?: string | null;
    gitWorktreeDir?: string | null;
  } | null;
}

export interface WorkspaceRegistryStore<T extends RegisteredWorkspace = RegisteredWorkspace> {
  registerProjectWorkspace(workspace: StableWorkspaceObservation & { worktreeId?: string }): T;
}

export interface RegisterWorkspaceInput<T extends RegisteredWorkspace = RegisteredWorkspace> {
  stateStore: WorkspaceRegistryStore<T>;
  workspace: StableWorkspaceObservation;
  projectId?: (string) | undefined;
  worktreeId?: string | null;
}

export interface RegisteredWorktreeBinding extends KernelWorktreeIdentity {
  registeredWorkspace: RegisteredWorkspace;
  workspaceIdentity: StableWorkspaceObservation['identity'];
}

export const registerWorkspace = <T extends RegisteredWorkspace>({
  stateStore,
  workspace,
  projectId,
  worktreeId = null,
}: RegisterWorkspaceInput<T>): T => {
  if (!stateStore || typeof stateStore.registerProjectWorkspace !== 'function') {
    throw new Error('workspace_registry_invalid');
  }
  if (!workspace?.workspaceId || !workspace.identity?.projectId) {
    throw new Error('workspace_observation_invalid');
  }
  if (projectId && workspace.identity.projectId !== String(projectId)) {
    throw new Error('workspace_project_identity_mismatch');
  }
  return stateStore.registerProjectWorkspace({
    ...workspace,
    ...(worktreeId ? { worktreeId: String(worktreeId) } : {}),
  });
};

export const registerWorktreeObservation = ({
  stateStore,
  workspace,
  projectId,
}: {
  stateStore: WorkspaceRegistryStore;
  workspace: StableWorkspaceObservation;
  projectId?: string;
}): RegisteredWorktreeBinding => {
  const observedWorktree = worktreeIdentityFromWorkspace(workspace);
  const registeredWorkspace = registerWorkspace({
    stateStore,
    workspace,
    projectId,
    worktreeId: observedWorktree.worktreeId,
  });
  const registeredWorktree = worktreeIdentityFromWorkspace(registeredWorkspace);

  if (registeredWorktree.worktreeId !== observedWorktree.worktreeId) {
    throw new Error('worktree_registration_mismatch');
  }

  return {
    ...registeredWorktree,
    workspaceIdentity: workspace.identity,
    registeredWorkspace,
  };
};
