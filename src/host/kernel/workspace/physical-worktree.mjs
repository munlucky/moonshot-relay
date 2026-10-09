import path from 'node:path';
import { mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { runGit } from '../../../shared/git-safe.mjs';
import { stageSelectedPaths } from '../../../kernel/git/staging-policy.mjs';
import { resolveKernelRuntimeHome } from '../../../kernel/runtime-home.mjs';
import { observeWorkspaceIdentity } from '../../../kernel/run/workspace-identity.mjs';

const shortExecutionToken = (value, length = 8) => createHash('sha256').update(String(value)).digest('hex').slice(0, length);

const commandError = (operation, result) => Object.assign(new Error(`${operation}: ${String(result?.stderr || '').trim() || 'git command failed'}`), {
  code: `WORKTREE_${operation.toUpperCase().replaceAll('-', '_')}_FAILED`,
  gitStatus: result?.status ?? null,
});

const assertInside = (root, target) => {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw Object.assign(new Error('worktree path escaped runtime worktree root'), { code: 'WORKTREE_PATH_ESCAPE' });
  }
};
export const executionRoot = ({ runtimeHome = resolveKernelRuntimeHome(), projectId, runId } = {}) => {
  if (!projectId || !runId) throw new Error('projectId and runId are required for execution workspaces');
  return path.join(runtimeHome, 'worktrees', `p-${shortExecutionToken(projectId, 8)}`, `r-${shortExecutionToken(runId, 8)}`);
};

const gitOutput = (repoRoot, args) => {
  const result = runGit(repoRoot, args, { maxBuffer: 32 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw commandError(args[0] || 'git', result);
  return String(result.stdout || '').trim();
};

export const inspectGitWorkspace = (workspaceRoot) => {
  const head = runGit(workspaceRoot, ['rev-parse', '--verify', 'HEAD']);
  const inside = runGit(workspaceRoot, ['rev-parse', '--is-inside-work-tree']);
  if (head.error || head.status !== 0 || String(inside.stdout || '').trim() !== 'true') {
    return { ready: false, reason: 'not-a-git-workspace' };
  }
  const status = runGit(workspaceRoot, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (status.error || status.status !== 0) return { ready: false, reason: 'git-status-unavailable' };
  const inProgress = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply'];
  const gitDir = String(runGit(workspaceRoot, ['rev-parse', '--git-dir']).stdout || '').trim();
  const operationInProgress = inProgress.some((entry) => existsSync(path.join(workspaceRoot, gitDir, entry)));
  if (operationInProgress) return { ready: false, reason: 'git-operation-in-progress' };
  if (String(status.stdout || '').trim()) return { ready: false, reason: 'dirty-working-tree' };
  return {
    ready: true,
    headCommitSha: String(head.stdout || '').trim(),
    gitCommonDir: String(runGit(workspaceRoot, ['rev-parse', '--git-common-dir']).stdout || '').trim(),
  };
};

export const canUseExecutionWorkspace = (workspaceRoot) => inspectGitWorkspace(workspaceRoot);

const addWorktree = async ({ repoRoot, target, baseCommit, containmentRoot }) => {
  await mkdir(path.dirname(target), { recursive: true });
  assertInside(containmentRoot || path.dirname(target), target);
  const result = runGit(repoRoot, ['worktree', 'add', '--detach', target, baseCommit], { maxBuffer: 32 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw commandError('add', result);
  return { target, reused: false };
};

const reuseWorktree = ({ target, baseCommit }) => {
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

const addOrReuseWorktree = async ({ repoRoot, target, baseCommit, containmentRoot }) => {
  assertInside(containmentRoot || path.dirname(target), target);
  return existsSync(target)
    ? reuseWorktree({ target, baseCommit })
    : addWorktree({ repoRoot, target, baseCommit, containmentRoot });
};

export const prepareStepWorktree = async ({
  repoRoot,
  baseCommit,
  runId,
  stepId,
  projectId,
  runtimeHome = resolveKernelRuntimeHome(),
} = {}) => {
  const root = executionRoot({ runtimeHome, projectId, runId });
  const target = path.join(root, `s-${shortExecutionToken(stepId, 4)}`);
  const prepared = await addOrReuseWorktree({ repoRoot, target, baseCommit, containmentRoot: root });
  const identity = observeWorkspaceIdentity({ projectRoot: target });
  return {
    kind: 'step',
    stepId,
    workspaceRoot: target,
    reused: prepared.reused,
    baseCommitSha: baseCommit,
    baseWorkspaceIdentity: identity.identity,
  };
};

export const prepareIntegrationWorktree = async ({
  repoRoot,
  baseCommit,
  runId,
  projectId,
  runtimeHome = resolveKernelRuntimeHome(),
} = {}) => {
  const root = executionRoot({ runtimeHome, projectId, runId });
  const target = path.join(root, 'integration');
  const prepared = await addOrReuseWorktree({ repoRoot, target, baseCommit, containmentRoot: root });
  const identity = observeWorkspaceIdentity({ projectRoot: target });
  return {
    kind: 'integration',
    reused: prepared.reused,
    workspaceRoot: target,
    baseCommitSha: baseCommit,
    baseWorkspaceIdentity: identity.identity,
  };
};

export const prepareExecutionWorkspaces = async ({ repoRoot, baseCommit, runId, projectId, steps = [], runtimeHome } = {}) => {
  const integration = await prepareIntegrationWorktree({ repoRoot, baseCommit, runId, projectId, runtimeHome });
  const createdPaths = integration.reused ? [] : [integration.workspaceRoot];
  const stepWorkspaces = [];
  try {
    for (const step of steps) {
      const workspace = await prepareStepWorktree({ repoRoot, baseCommit, runId, stepId: step.stepId, projectId, runtimeHome });
      stepWorkspaces.push(workspace);
      if (!workspace.reused) createdPaths.push(workspace.workspaceRoot);
    }
  } catch (error) {
    // Only worktrees created by this preparation attempt are cleaned here. A
    // reusable workspace from an interrupted run is evidence for recovery and
    // must never be deleted as a side effect of a later preparation failure.
    await cleanupExecutionWorkspaces({ runtimeHome, projectId, runId, repoRoot, retain: false, paths: createdPaths }).catch(() => {});
    throw error;
  }
  return { integration, steps: stepWorkspaces };
};

export const listChangedPaths = (workspaceRoot) => {
  const result = runGit(workspaceRoot, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (result.error || result.status !== 0) throw commandError('status', result);
  return [...new Set(String(result.stdout || '').split(/\r?\n/u).filter(Boolean).map((line) => line.slice(3).replaceAll('\\', '/')))].sort();
};

export const createStepResultCommit = ({ workspaceRoot, runId, stepId, attemptNumber = 1, changedPaths = [] } = {}) => {
  const measured = listChangedPaths(workspaceRoot);
  const selected = changedPaths.length > 0 ? changedPaths : measured;
  if (measured.length === 0) return { commitSha: null, changedPaths: [], patch: '' };
  try {
    stageSelectedPaths({ repoRoot: workspaceRoot, paths: selected, git: runGit });
  } catch (error) {
    throw commandError('stage-step-result', { stderr: error.message, status: 1 });
  }
  const commit = runGit(workspaceRoot, ['commit', '--no-verify', '-m', `kernel-step ${shortExecutionToken(runId, 8)}/${stepId}/${attemptNumber}`]);
  if (commit.error || commit.status !== 0) throw commandError('commit-step-result', commit);
  const commitSha = gitOutput(workspaceRoot, ['rev-parse', 'HEAD']);
  const patch = String(runGit(workspaceRoot, ['show', '--format=', '--binary', commitSha]).stdout || '');
  return { commitSha, changedPaths: measured, patch };
};

export const cleanupExecutionWorkspaces = async ({ runtimeHome = resolveKernelRuntimeHome(), projectId, runId, repoRoot = null, retain = true, paths = null } = {}) => {
  const root = executionRoot({ runtimeHome, projectId, runId });
  if (retain) return { retained: true, root };
  if (repoRoot && paths === null) {
    const listed = runGit(repoRoot, ['worktree', 'list', '--porcelain']);
    if (listed.error || listed.status !== 0) throw commandError('list-worktrees', listed);
    const paths = String(listed.stdout || '').split(/\r?\n/u).filter((line) => line.startsWith('worktree ')).map((line) => line.slice(9));
    for (const candidate of paths.filter((candidate) => {
      const relative = path.relative(path.resolve(root), path.resolve(candidate));
      return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
    })) {
      assertInside(root, candidate);
      const result = runGit(repoRoot, ['worktree', 'remove', '--force', candidate]);
      if (result.error || result.status !== 0) throw commandError('remove-worktree', result);
    }
    runGit(repoRoot, ['worktree', 'prune']);
  } else if (repoRoot && Array.isArray(paths)) {
    for (const candidate of [...new Set(paths.map((entry) => path.resolve(entry)))]) {
      assertInside(root, candidate);
      const result = runGit(repoRoot, ['worktree', 'remove', '--force', candidate]);
      if (result.error || result.status !== 0) throw commandError('remove-worktree', result);
    }
    runGit(repoRoot, ['worktree', 'prune']);
  }
  if (paths === null) await rm(root, { recursive: true, force: true });
  else for (const candidate of [...new Set(paths.map((entry) => path.resolve(entry)))]) {
    assertInside(root, candidate);
    await rm(candidate, { recursive: true, force: true });
  }
  return { retained: false, root };
};
