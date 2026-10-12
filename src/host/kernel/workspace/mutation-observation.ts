import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { canonicalPathIdentity } from '../../../shared/path-identity.js';
import { runGit } from '../../../shared/git-safe.js';

import type { MutationPathObservation, MutationWorkspaceObservation } from '../../../contracts/workspace-observation.js';
export type { MutationPathObservation, MutationWorkspaceObservation } from '../../../contracts/workspace-observation.js';

export const resolveMutationPath = ({
  workspaceRoot,
  targetPath,
  platform = process.platform,
}: {
  workspaceRoot: string;
  targetPath: unknown;
  platform?: NodeJS.Platform;
}): MutationPathObservation => {
  const root = realpathSync(path.resolve(workspaceRoot));
  const portableTarget = String(targetPath || '').replaceAll('\\', '/');
  const requested = path.isAbsolute(portableTarget)
    ? path.resolve(portableTarget)
    : path.resolve(root, portableTarget);

  let cursor = requested;
  while (!existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }

  const resolvedBase = realpathSync(cursor);
  const resolved = path.resolve(resolvedBase, path.relative(cursor, requested));
  const comparableRoot = canonicalPathIdentity(root, { platform });
  const comparable = canonicalPathIdentity(resolved, { platform });
  const rootPrefix = comparableRoot.endsWith('/') ? comparableRoot : `${comparableRoot}/`;
  const withinWorkspace = comparable === comparableRoot || comparable.startsWith(rootPrefix);
  const relativePath = canonicalPathIdentity(path.relative(root, resolved), { platform });

  return {
    relativePath,
    withinWorkspace: withinWorkspace
      && Boolean(relativePath)
      && (relativePath === '.' || (!relativePath.startsWith('../') && !path.isAbsolute(relativePath))),
  };
};

export const inspectMutationWorkspace = ({
  workspaceRoot,
}: {
  workspaceRoot: string;
}): MutationWorkspaceObservation => {
  const head = runGit(workspaceRoot, ['rev-parse', '--verify', 'HEAD']);
  const status = runGit(workspaceRoot, ['status', '--porcelain=v1', '--untracked-files=all']);
  return {
    headCommitSha: head.error || head.status !== 0
      ? null
      : String(head.stdout || '').trim() || null,
    workspaceStatus: status.error || status.status !== 0
      ? null
      : String(status.stdout || '').trim(),
  };
};
