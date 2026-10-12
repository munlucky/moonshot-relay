import { resolveKernelProjectIdentity } from '../../../kernel/project-identity.js';
import {
  KernelWorktreeBindingError,
  worktreeIdentityFromWorkspace,
  type KernelWorktreeIdentity,
} from '../../../contracts/worktree-authority.js';
import { resolveStableWorkspaceIdentity } from './stable-workspace.js';

export interface ResolveKernelWorktreeIdentityInput {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  projectIdentity?: {
    projectId?: unknown;
    projectRoot?: unknown;
    canonicalRoot?: unknown;
    [key: string]: unknown;
  } | null;
  workspaceRoot?: string | null;
  platform?: NodeJS.Platform;
}

export interface ResolvedKernelWorktreeIdentity extends KernelWorktreeIdentity {
  workspaceRoot: string;
  projectIdentity: Record<string, unknown>;
  workspaceObservation: ReturnType<typeof resolveStableWorkspaceIdentity>;
  workspaceIdentity: {
    projectId: string;
    canonicalRoot: string;
    gitCommonDir: string | null;
    gitWorktreeDir: string | null;
  };
}

export const resolveKernelWorktreeIdentity = ({
  cwd = process.cwd(),
  env = process.env,
  projectIdentity = null,
  workspaceRoot = null,
  platform = process.platform,
}: ResolveKernelWorktreeIdentityInput = {}): ResolvedKernelWorktreeIdentity => {
  const project = projectIdentity || resolveKernelProjectIdentity({ cwd, env });
  const resolvedWorkspaceRoot = String(workspaceRoot || project.projectRoot || project.canonicalRoot || '');
  if (!project?.projectId || !resolvedWorkspaceRoot) {
    throw new KernelWorktreeBindingError('worktree_binding_invalid');
  }

  const workspace = resolveStableWorkspaceIdentity({
    projectId: String(project.projectId),
    workspaceRoot: resolvedWorkspaceRoot,
    platform,
  });
  const worktree = worktreeIdentityFromWorkspace(workspace);

  return {
    ...worktree,
    workspaceRoot: resolvedWorkspaceRoot,
    projectIdentity: project as Record<string, unknown>,
    workspaceObservation: workspace,
    workspaceIdentity: workspace.identity,
  };
};

export const resolveKernelWorktreeBinding = resolveKernelWorktreeIdentity;
