import path from 'node:path';
import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import type {
  ResolveStableWorkspaceIdentity,
  StableWorkspaceObservation,
} from '../../../contracts/workspace-observation.js';

const gitPath = (cwd: string, arg: string): string | null => {
  const result = spawnSync('git', ['rev-parse', arg], { cwd, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
};

const normalizePath = (value: string, platform: NodeJS.Platform = process.platform): string => {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const normalized = pathApi.normalize(value);
  return platform === 'win32'
    ? normalized.replaceAll('\\', '/').toLowerCase()
    : normalized;
};

export const resolveStableWorkspaceIdentity: ResolveStableWorkspaceIdentity = ({
  projectId,
  workspaceRoot,
  platform = process.platform,
}): StableWorkspaceObservation => {
  if (!projectId || !workspaceRoot) throw new Error('workspace_registration_invalid');
  const resolvedRoot = path.resolve(workspaceRoot);

  // Greenfield runs can bind a workspace before the directory exists. Existing
  // workspaces use realpath so aliases and junctions collapse to one identity.
  const canonicalRoot = existsSync(resolvedRoot) ? realpathSync(resolvedRoot) : resolvedRoot;
  const gitCommonRaw = gitPath(canonicalRoot, '--git-common-dir');
  const gitDirRaw = gitPath(canonicalRoot, '--git-dir');
  const resolveGitPath = (value: string | null): string | null => (
    value ? realpathSync.native(path.resolve(canonicalRoot, value)) : null
  );
  const gitCommonDir = resolveGitPath(gitCommonRaw);
  const gitWorktreeDir = resolveGitPath(gitDirRaw);
  const identity = {
    projectId: String(projectId),
    canonicalRoot: normalizePath(canonicalRoot, platform),
    gitCommonDir: gitCommonDir ? normalizePath(gitCommonDir, platform) : null,
    gitWorktreeDir: gitWorktreeDir ? normalizePath(gitWorktreeDir, platform) : null,
  };
  const workspaceId = `workspace-${createHash('sha256')
    .update(JSON.stringify(identity))
    .digest('hex')}`;

  return {
    workspaceId,
    canonicalRoot,
    gitCommonDir,
    gitWorktreeDir,
    identity,
  };
};
