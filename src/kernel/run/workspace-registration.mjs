import path from 'node:path';
import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const gitPath = (cwd, arg) => {
  const result = spawnSync('git', ['rev-parse', arg], { cwd, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
};

const normalizePath = (value, platform = process.platform) => {
  const normalized = path.normalize(value).replaceAll('\\', '/');
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
};

export const resolveStableWorkspaceIdentity = ({ projectId, workspaceRoot, platform = process.platform } = {}) => {
  if (!projectId || !workspaceRoot) throw new Error('workspace_registration_invalid');
  const resolvedRoot = path.resolve(workspaceRoot);
  // Greenfield runs may bind a workspace before the project directory is
  // materialized. Preserve a stable lexical identity until the path exists;
  // existing workspaces still use realpath to collapse aliases and junctions.
  const canonicalRoot = existsSync(resolvedRoot) ? realpathSync(resolvedRoot) : resolvedRoot;
  const gitCommonRaw = gitPath(canonicalRoot, '--git-common-dir');
  const gitDirRaw = gitPath(canonicalRoot, '--git-dir');
  const resolveGitPath = (value) => value ? realpathSync(path.resolve(canonicalRoot, value)) : null;
  const gitCommonDir = resolveGitPath(gitCommonRaw);
  const gitWorktreeDir = resolveGitPath(gitDirRaw);
  const identity = {
    projectId: String(projectId),
    canonicalRoot: normalizePath(canonicalRoot, platform),
    gitCommonDir: gitCommonDir ? normalizePath(gitCommonDir, platform) : null,
    gitWorktreeDir: gitWorktreeDir ? normalizePath(gitWorktreeDir, platform) : null,
  };
  const workspaceId = `workspace-${createHash('sha256').update(JSON.stringify(identity)).digest('hex')}`;
  return { workspaceId, canonicalRoot, gitCommonDir, gitWorktreeDir, identity };
};

export const registerWorkspace = ({ stateStore, projectId, workspaceRoot, worktreeId = null }) => {
  const workspace = resolveStableWorkspaceIdentity({ projectId, workspaceRoot });
  return stateStore.registerProjectWorkspace({
    ...workspace,
    ...(worktreeId ? { worktreeId: String(worktreeId) } : {}),
  });
};
