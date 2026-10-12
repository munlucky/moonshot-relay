import path from 'node:path';
import { mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  runGit,
  type GitCommandResult,
} from '../../../shared/git-safe.js';
import { stageSelectedPaths } from '../git/staging.js';
import { observeWorkspaceIdentity } from './workspace-identity.js';

interface WorktreeCommandError extends Error {
  code: string;
  gitStatus: number | null;
}

interface WorktreeCoordinates {
  runtimeHome?: (string | null) | undefined;
  projectId?: string;
  runId?: string;
}

interface PrepareWorktreeInput extends WorktreeCoordinates {
  repoRoot?: string;
  baseCommit?: string;
  stepId?: string;
}

interface StepLike {
  stepId: string;
}

interface PrepareExecutionWorkspacesInput extends WorktreeCoordinates {
  repoRoot?: string;
  baseCommit?: string;
  steps?: StepLike[];
}

interface CreateStepResultCommitInput {
  workspaceRoot?: string;
  runId?: string;
  stepId?: string;
  attemptNumber?: number;
  changedPaths?: string[];
}

interface CleanupExecutionWorkspacesInput extends WorktreeCoordinates {
  repoRoot?: string | null;
  retain?: boolean;
  paths?: string[] | null;
}

interface WorktreePrepared {
  target: string;
  reused: boolean;
}

export interface PreparedExecutionWorkspace {
  kind: 'step' | 'integration';
  stepId?: string;
  workspaceRoot: string;
  reused: boolean;
  baseCommitSha: string;
  baseWorkspaceIdentity: string;
}

export interface GitWorkspaceInspection {
  ready: boolean;
  reason?: string;
  headCommitSha?: string;
  gitCommonDir?: string;
}

const shortExecutionToken = (
  value: unknown,
  length = 8,
): string => createHash('sha256')
  .update(String(value))
  .digest('hex')
  .slice(0, length);

const commandError = (
  operation: string,
  result: Pick<GitCommandResult, 'stderr' | 'status'>,
): WorktreeCommandError => Object.assign(
  new Error(
    `${operation}: ${String(result.stderr || '').trim() || 'git command failed'}`,
  ),
  {
    code: `WORKTREE_${operation.toUpperCase().replaceAll('-', '_')}_FAILED`,
    gitStatus: result.status ?? null,
  },
);

const assertInside = (root: string, target: string): void => {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw Object.assign(
      new Error('worktree path escaped runtime worktree root'),
      { code: 'WORKTREE_PATH_ESCAPE' },
    );
  }
};

export const executionRoot = ({
  runtimeHome = null,
  projectId,
  runId,
}: WorktreeCoordinates = {}): string => {
  if (!runtimeHome) {
    throw new Error('runtimeHome is required for execution workspaces');
  }
  if (!projectId || !runId) {
    throw new Error('projectId and runId are required for execution workspaces');
  }
  return path.join(
    runtimeHome,
    'worktrees',
    `p-${shortExecutionToken(projectId, 8)}`,
    `r-${shortExecutionToken(runId, 8)}`,
  );
};

const gitOutput = (repoRoot: string, args: readonly string[]): string => {
  const result = runGit(repoRoot, args, {
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw commandError(args[0] || 'git', result);
  }
  return String(result.stdout || '').trim();
};

export const inspectGitWorkspace = (
  workspaceRoot: string,
): GitWorkspaceInspection => {
  const head = runGit(workspaceRoot, ['rev-parse', '--verify', 'HEAD']);
  const inside = runGit(
    workspaceRoot,
    ['rev-parse', '--is-inside-work-tree'],
  );
  if (
    head.error
    || head.status !== 0
    || String(inside.stdout || '').trim() !== 'true'
  ) {
    return { ready: false, reason: 'not-a-git-workspace' };
  }
  const status = runGit(
    workspaceRoot,
    ['status', '--porcelain=v1', '--untracked-files=all'],
  );
  if (status.error || status.status !== 0) {
    return { ready: false, reason: 'git-status-unavailable' };
  }
  const inProgress = [
    'MERGE_HEAD',
    'CHERRY_PICK_HEAD',
    'REVERT_HEAD',
    'rebase-merge',
    'rebase-apply',
  ];
  const gitDir = String(
    runGit(workspaceRoot, ['rev-parse', '--git-dir']).stdout || '',
  ).trim();
  const operationInProgress = inProgress.some(
    (entry) => existsSync(path.join(workspaceRoot, gitDir, entry)),
  );
  if (operationInProgress) {
    return { ready: false, reason: 'git-operation-in-progress' };
  }
  if (String(status.stdout || '').trim()) {
    return { ready: false, reason: 'dirty-working-tree' };
  }
  return {
    ready: true,
    headCommitSha: String(head.stdout || '').trim(),
    gitCommonDir: String(
      runGit(workspaceRoot, ['rev-parse', '--git-common-dir']).stdout || '',
    ).trim(),
  };
};

export const canUseExecutionWorkspace = (
  workspaceRoot: string,
): GitWorkspaceInspection => inspectGitWorkspace(workspaceRoot);

const addWorktree = async ({
  repoRoot,
  target,
  baseCommit,
  containmentRoot,
}: {
  repoRoot: string;
  target: string;
  baseCommit: string;
  containmentRoot?: (string | null) | undefined;
}): Promise<WorktreePrepared> => {
  await mkdir(path.dirname(target), { recursive: true });
  assertInside(containmentRoot || path.dirname(target), target);
  const result = runGit(
    repoRoot,
    ['worktree', 'add', '--detach', target, baseCommit],
    { maxBuffer: 32 * 1024 * 1024 },
  );
  if (result.error || result.status !== 0) {
    throw commandError('add', result);
  }
  return { target, reused: false };
};

const reuseWorktree = ({
  target,
  baseCommit,
}: {
  target: string;
  baseCommit: string;
}): WorktreePrepared => {
  const inspected = inspectGitWorkspace(target);
  if (!inspected.ready) {
    throw commandError('reuse', {
      stderr: `existing execution workspace is not reusable: ${inspected.reason}`,
      status: 1,
    });
  }
  if (inspected.headCommitSha !== baseCommit) {
    throw commandError('reuse', {
      stderr: `existing execution workspace is based on ${inspected.headCommitSha}, expected ${baseCommit}`,
      status: 1,
    });
  }
  return { target, reused: true };
};

const addOrReuseWorktree = async ({
  repoRoot,
  target,
  baseCommit,
  containmentRoot,
}: {
  repoRoot: string;
  target: string;
  baseCommit: string;
  containmentRoot?: string | null;
}): Promise<WorktreePrepared> => {
  assertInside(containmentRoot || path.dirname(target), target);
  return existsSync(target)
    ? reuseWorktree({ target, baseCommit })
    : addWorktree({ repoRoot, target, baseCommit, containmentRoot });
};

const requiredString = (value: string | undefined, label: string): string => {
  if (!value) throw new Error(`${label} is required`);
  return value;
};

export const prepareStepWorktree = async ({
  repoRoot,
  baseCommit,
  runId,
  stepId,
  projectId,
  runtimeHome = null,
}: PrepareWorktreeInput = {}): Promise<PreparedExecutionWorkspace> => {
  const activeRepoRoot = requiredString(repoRoot, 'repoRoot');
  const activeBaseCommit = requiredString(baseCommit, 'baseCommit');
  const activeRunId = requiredString(runId, 'runId');
  const activeStepId = requiredString(stepId, 'stepId');
  const activeProjectId = requiredString(projectId, 'projectId');
  const root = executionRoot({
    runtimeHome,
    projectId: activeProjectId,
    runId: activeRunId,
  });
  const target = path.join(
    root,
    `s-${shortExecutionToken(activeStepId, 4)}`,
  );
  const prepared = await addOrReuseWorktree({
    repoRoot: activeRepoRoot,
    target,
    baseCommit: activeBaseCommit,
    containmentRoot: root,
  });
  const identity = observeWorkspaceIdentity({ projectRoot: target });
  return {
    kind: 'step',
    stepId: activeStepId,
    workspaceRoot: target,
    reused: prepared.reused,
    baseCommitSha: activeBaseCommit,
    baseWorkspaceIdentity: identity.identity,
  };
};

export const prepareIntegrationWorktree = async ({
  repoRoot,
  baseCommit,
  runId,
  projectId,
  runtimeHome = null,
}: PrepareWorktreeInput = {}): Promise<PreparedExecutionWorkspace> => {
  const activeRepoRoot = requiredString(repoRoot, 'repoRoot');
  const activeBaseCommit = requiredString(baseCommit, 'baseCommit');
  const activeRunId = requiredString(runId, 'runId');
  const activeProjectId = requiredString(projectId, 'projectId');
  const root = executionRoot({
    runtimeHome,
    projectId: activeProjectId,
    runId: activeRunId,
  });
  const target = path.join(root, 'integration');
  const prepared = await addOrReuseWorktree({
    repoRoot: activeRepoRoot,
    target,
    baseCommit: activeBaseCommit,
    containmentRoot: root,
  });
  const identity = observeWorkspaceIdentity({ projectRoot: target });
  return {
    kind: 'integration',
    reused: prepared.reused,
    workspaceRoot: target,
    baseCommitSha: activeBaseCommit,
    baseWorkspaceIdentity: identity.identity,
  };
};

export const prepareExecutionWorkspaces = async ({
  repoRoot,
  baseCommit,
  runId,
  projectId,
  steps = [],
  runtimeHome,
}: PrepareExecutionWorkspacesInput = {}) => {
  const activeRepoRoot = requiredString(repoRoot, 'repoRoot');
  const activeBaseCommit = requiredString(baseCommit, 'baseCommit');
  const activeRunId = requiredString(runId, 'runId');
  const activeProjectId = requiredString(projectId, 'projectId');
  const integration = await prepareIntegrationWorktree({
    repoRoot: activeRepoRoot,
    baseCommit: activeBaseCommit,
    runId: activeRunId,
    projectId: activeProjectId,
    runtimeHome,
  });
  const createdPaths = integration.reused
    ? []
    : [integration.workspaceRoot];
  const stepWorkspaces: PreparedExecutionWorkspace[] = [];
  try {
    for (const step of steps) {
      const workspace = await prepareStepWorktree({
        repoRoot: activeRepoRoot,
        baseCommit: activeBaseCommit,
        runId: activeRunId,
        stepId: step.stepId,
        projectId: activeProjectId,
        runtimeHome,
      });
      stepWorkspaces.push(workspace);
      if (!workspace.reused) createdPaths.push(workspace.workspaceRoot);
    }
  } catch (error) {
    await cleanupExecutionWorkspaces({
      runtimeHome,
      projectId: activeProjectId,
      runId: activeRunId,
      repoRoot: activeRepoRoot,
      retain: false,
      paths: createdPaths,
    }).catch(() => {});
    throw error;
  }
  return { integration, steps: stepWorkspaces };
};

export const listChangedPaths = (workspaceRoot: string): string[] => {
  const result = runGit(
    workspaceRoot,
    ['status', '--porcelain=v1', '--untracked-files=all'],
  );
  if (result.error || result.status !== 0) {
    throw commandError('status', result);
  }
  return [...new Set(
    String(result.stdout || '')
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => line.slice(3).replaceAll('\\', '/')),
  )].sort();
};

export const createStepResultCommit = ({
  workspaceRoot,
  runId,
  stepId,
  attemptNumber = 1,
  changedPaths = [],
}: CreateStepResultCommitInput = {}) => {
  const activeWorkspaceRoot = requiredString(workspaceRoot, 'workspaceRoot');
  const activeRunId = requiredString(runId, 'runId');
  const activeStepId = requiredString(stepId, 'stepId');
  const measured = listChangedPaths(activeWorkspaceRoot);
  const selected = changedPaths.length > 0 ? changedPaths : measured;
  if (measured.length === 0) {
    return { commitSha: null, changedPaths: [], patch: '' };
  }
  try {
    stageSelectedPaths({
      repoRoot: activeWorkspaceRoot,
      paths: selected,
      git: runGit,
    });
  } catch (error: unknown) {
    throw commandError('stage-step-result', {
      stderr: error instanceof Error ? error.message : String(error),
      status: 1,
    });
  }
  const commit = runGit(
    activeWorkspaceRoot,
    [
      'commit',
      '--no-verify',
      '-m',
      `kernel-step ${shortExecutionToken(activeRunId, 8)}/${activeStepId}/${attemptNumber}`,
    ],
  );
  if (commit.error || commit.status !== 0) {
    throw commandError('commit-step-result', commit);
  }
  const commitSha = gitOutput(
    activeWorkspaceRoot,
    ['rev-parse', 'HEAD'],
  );
  const patch = String(
    runGit(
      activeWorkspaceRoot,
      ['show', '--format=', '--binary', commitSha],
    ).stdout || '',
  );
  return { commitSha, changedPaths: measured, patch };
};

export const cleanupExecutionWorkspaces = async ({
  runtimeHome = null,
  projectId,
  runId,
  repoRoot = null,
  retain = true,
  paths = null,
}: CleanupExecutionWorkspacesInput = {}) => {
  const activeProjectId = requiredString(projectId, 'projectId');
  const activeRunId = requiredString(runId, 'runId');
  const root = executionRoot({
    runtimeHome,
    projectId: activeProjectId,
    runId: activeRunId,
  });
  if (retain) return { retained: true, root };

  if (repoRoot && paths === null) {
    const listed = runGit(repoRoot, ['worktree', 'list', '--porcelain']);
    if (listed.error || listed.status !== 0) {
      throw commandError('list-worktrees', listed);
    }
    const listedPaths = String(listed.stdout || '')
      .split(/\r?\n/u)
      .filter((line) => line.startsWith('worktree '))
      .map((line) => line.slice(9));
    for (const candidate of listedPaths.filter((candidate) => {
      const relative = path.relative(
        path.resolve(root),
        path.resolve(candidate),
      );
      return relative === ''
        || (!relative.startsWith('..') && !path.isAbsolute(relative));
    })) {
      assertInside(root, candidate);
      const result = runGit(
        repoRoot,
        ['worktree', 'remove', '--force', candidate],
      );
      if (result.error || result.status !== 0) {
        throw commandError('remove-worktree', result);
      }
    }
    runGit(repoRoot, ['worktree', 'prune']);
  } else if (repoRoot && Array.isArray(paths)) {
    for (const candidate of [
      ...new Set(paths.map((entry) => path.resolve(entry))),
    ]) {
      assertInside(root, candidate);
      const result = runGit(
        repoRoot,
        ['worktree', 'remove', '--force', candidate],
      );
      if (result.error || result.status !== 0) {
        throw commandError('remove-worktree', result);
      }
    }
    runGit(repoRoot, ['worktree', 'prune']);
  }

  if (paths === null) {
    await rm(root, { recursive: true, force: true });
  } else {
    for (const candidate of [
      ...new Set(paths.map((entry) => path.resolve(entry))),
    ]) {
      assertInside(root, candidate);
      await rm(candidate, { recursive: true, force: true });
    }
  }
  return { retained: false, root };
};
