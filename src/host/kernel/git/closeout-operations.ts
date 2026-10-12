import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { rm } from 'node:fs/promises';
import { gitCurrentBranch, runGit } from '../../../shared/git-safe.js';
import { stageSelectedPaths } from './staging.js';
import { verifyRemoteParity } from './remote-parity.js';

type ErrorDetails = Record<string, unknown>;

const hostGitError = (
  code: string,
  message: string,
  details: ErrorDetails = {},
) => Object.assign(new Error(message), { code, details });

export interface GitCloseoutWorkspaceObservation {
  branch: string;
  headSha: string;
  clean: boolean;
  stagedChanges: boolean;
  changedPaths: string[] | null;
  authorizedCommit: boolean;
}

export const inspectGitCloseoutWorkspace = ({
  repoRoot = process.cwd(),
  commitSha = null,
}: {
  repoRoot?: string;
  commitSha?: string | null;
} = {}): GitCloseoutWorkspaceObservation => {
  const head = runGit(repoRoot, ['rev-parse', 'HEAD']);
  const status = runGit(repoRoot, ['status', '--porcelain']);
  const staged = runGit(repoRoot, ['diff', '--cached', '--quiet']);
  const branch = gitCurrentBranch(repoRoot);
  const headSha = head.status === 0 ? String(head.stdout || '').trim() : '';
  const statusText = status.status === 0 ? String(status.stdout || '') : null;
  const changedPaths = statusText === null
    ? null
    : statusText
      .split(/\r?\n/)
      .map((line) => line.slice(3).trim())
      .filter(Boolean);

  return {
    branch,
    headSha,
    clean: status.status === 0 && statusText?.trim() === '',
    stagedChanges: staged.status !== 0,
    changedPaths,
    authorizedCommit: Boolean(
      commitSha
      && head.status === 0
      && status.status === 0
      && headSha === commitSha
      && statusText?.trim() === '',
    ),
  };
};

export const isAuthorizedKernelGitCloseoutWorkspace = ({
  repoRoot = process.cwd(),
  commitSha = null,
}: {
  repoRoot?: string;
  commitSha?: string | null;
} = {}): boolean => (
  inspectGitCloseoutWorkspace({ repoRoot, commitSha }).authorizedCommit
);

export interface GitCloseoutCommitResult {
  commitSha: string;
  beforeHeadSha: string;
  branch: string;
}

export async function createGitCloseoutCommit({
  repoRoot = process.cwd(),
  operationId = 'closeout',
  selectedPaths = [],
  commitMessage,
  branch,
  expectedHeadSha = '',
}: {
  repoRoot?: string;
  operationId?: string;
  selectedPaths?: readonly string[];
  commitMessage?: string | null;
  branch?: string | null;
  expectedHeadSha?: string;
} = {}): Promise<GitCloseoutCommitResult> {
  if (!branch) {
    throw hostGitError(
      'DETACHED_HEAD',
      'Git closeout requires an active branch, found detached HEAD',
    );
  }

  const operationDigest = createHash('sha256')
    .update(String(operationId))
    .digest('hex')
    .slice(0, 16);
  const tempIndexFile = path.join(
    os.tmpdir(),
    `kernel-git-index-${operationDigest}-${process.pid}-${Date.now()}.idx`,
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_INDEX_FILE: tempIndexFile,
  };

  try {
    if (expectedHeadSha) {
      const readTree = runGit(
        repoRoot,
        ['read-tree', expectedHeadSha],
        { env },
      );
      if (readTree.status !== 0) {
        throw hostGitError(
          'GIT_READ_TREE_FAILED',
          `Git read-tree failed: ${String(readTree.stderr || '').trim()}`,
        );
      }
    }

    stageSelectedPaths({
      repoRoot,
      paths: selectedPaths,
      git: runGit,
      env,
    });

    const writeTree = runGit(repoRoot, ['write-tree'], { env });
    if (writeTree.status !== 0) {
      throw hostGitError(
        'GIT_WRITE_TREE_FAILED',
        `Git write-tree failed: ${String(writeTree.stderr || '').trim()}`,
      );
    }
    const treeSha = String(writeTree.stdout || '').trim();

    const commitArgs = ['commit-tree', treeSha, '-m', String(commitMessage || '')];
    if (expectedHeadSha) commitArgs.push('-p', expectedHeadSha);
    const commitTree = runGit(repoRoot, commitArgs, { env });
    if (commitTree.status !== 0) {
      throw hostGitError(
        'GIT_COMMIT_FAILED',
        `Git commit-tree failed: ${String(commitTree.stderr || '').trim()}`,
      );
    }
    const commitSha = String(commitTree.stdout || '').trim();
    if (!commitSha || commitSha === expectedHeadSha) {
      throw hostGitError(
        'GIT_COMMIT_NOT_CREATED',
        'Git commit was not created (HEAD did not advance)',
      );
    }

    const updateRefArgs = ['update-ref', `refs/heads/${branch}`, commitSha];
    if (expectedHeadSha) updateRefArgs.push(expectedHeadSha);
    const updateRef = runGit(repoRoot, updateRefArgs);
    if (updateRef.status !== 0) {
      throw hostGitError(
        'GIT_REF_CONFLICT',
        `Git update-ref CAS conflict on branch ${branch}: ${String(
          updateRef.stderr || '',
        ).trim()}`,
      );
    }

    const refreshIndex = runGit(repoRoot, ['read-tree', 'HEAD']);
    if (refreshIndex.status !== 0) {
      throw hostGitError(
        'GIT_INDEX_REFRESH_FAILED',
        `Git index refresh failed: ${String(
          refreshIndex.stderr || '',
        ).trim()}`,
      );
    }

    return {
      commitSha,
      beforeHeadSha: expectedHeadSha,
      branch,
    };
  } finally {
    try {
      await rm(tempIndexFile, { force: true });
    } catch {
      // Temporary index cleanup must not hide the Git result.
    }
  }
}

export interface GitPushResult {
  status: 'completed' | 'failed';
  stderr: string;
}

export const pushGitCloseoutCommit = ({
  repoRoot = process.cwd(),
  commitSha,
  branch,
  remote = 'origin',
}: {
  repoRoot?: string;
  commitSha?: string | null;
  branch?: string | null;
  remote?: string;
} = {}): GitPushResult => {
  const result = runGit(
    repoRoot,
    ['push', remote, `${String(commitSha || '')}:refs/heads/${String(branch || '')}`],
  );
  return {
    status: result.status === 0 ? 'completed' : 'failed',
    stderr: String(result.stderr || ''),
  };
};

export interface GitStatusEntry {
  status: string;
  path: string;
}

const runGitChecked = (
  repoRoot: string,
  args: string[],
) => {
  const result = runGit(repoRoot, args, { maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    throw new Error(
      `git_failed: ${args.join(' ')}: ${String(
        result.stderr || result.error?.message || '',
      ).trim()}`,
    );
  }
  return result;
};

export const parseGitStatusOutput = (
  output = '',
): GitStatusEntry[] => String(output)
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => {
    const status = line.slice(0, 2);
    let file = line.slice(3);
    if (file.includes(' -> ')) file = file.split(' -> ').pop() || file;
    if (
      (file.startsWith('"') && file.endsWith('"'))
      || (file.startsWith("'") && file.endsWith("'"))
    ) {
      file = file.slice(1, -1);
    }
    return { status, path: file.replaceAll('\\\\', '/') };
  });

export const readGitStatusEntries = (
  repoRoot: string,
): GitStatusEntry[] => {
  const result = runGitChecked(repoRoot, ['status', '--porcelain=v1']);
  return parseGitStatusOutput(String(result.stdout || ''));
};

export interface WorkingTreeCommitResult {
  beforeHeadSha: string;
  commitSha: string;
  branch: string;
  treeDigest: string;
}

export const createWorkingTreeCommit = ({
  repoRoot,
  selectedPaths,
  commitMessage,
}: {
  repoRoot: string;
  selectedPaths: readonly string[];
  commitMessage: string;
}): WorkingTreeCommitResult => {
  const beforeHeadSha = String(
    runGitChecked(repoRoot, ['rev-parse', 'HEAD']).stdout || '',
  ).trim();
  stageSelectedPaths({
    repoRoot,
    paths: selectedPaths,
    git: runGit,
  });
  runGitChecked(repoRoot, ['commit', '-m', commitMessage]);
  const commitSha = String(
    runGitChecked(repoRoot, ['rev-parse', 'HEAD']).stdout || '',
  ).trim();
  const branch = gitCurrentBranch(repoRoot);
  const treeDigest = String(
    runGitChecked(repoRoot, ['rev-parse', 'HEAD^{tree}']).stdout || '',
  ).trim();
  return {
    beforeHeadSha,
    commitSha,
    branch,
    treeDigest,
  };
};

export interface WorkingTreePushResult {
  status: 'completed' | 'failed';
  stderr: string;
  parity: 'matched' | 'mismatched' | 'not_checked';
  remoteHeadSha: string | null;
}

export const pushWorkingTreeCommit = ({
  repoRoot,
  commitSha,
  branch,
  remote = 'origin',
}: {
  repoRoot: string;
  commitSha: string;
  branch: string;
  remote?: string;
}): WorkingTreePushResult => {
  const push = runGit(repoRoot, ['push']);
  if (push.error || push.status !== 0) {
    return {
      status: 'failed',
      stderr: String(push.stderr || push.error?.message || ''),
      parity: 'not_checked',
      remoteHeadSha: null,
    };
  }

  const parity = verifyRemoteParity(repoRoot, { branch, remote });
  return {
    status: parity.parity === 'matched' ? 'completed' : 'failed',
    stderr: parity.reason || '',
    parity: parity.parity,
    remoteHeadSha: parity.remoteHeadSha || null,
  };
};

export const createGitCloseoutHost = () => Object.freeze({
  inspectWorkspace: inspectGitCloseoutWorkspace,
  isAuthorizedCloseoutWorkspace: isAuthorizedKernelGitCloseoutWorkspace,
  createCommit: createGitCloseoutCommit,
  pushCommit: pushGitCloseoutCommit,
  verifyRemoteParity,
});
