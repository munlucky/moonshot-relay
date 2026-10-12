export interface GitWorkspaceObservation {
  branch: string;
  headSha: string;
  stagedChanges: boolean;
  changedPaths: string[] | null;
  authorizedCommit: boolean;
}

export interface GitCommitResult {
  commitSha: string;
}

export interface GitPushResult {
  status: string;
  stderr?: string;
}

export interface GitParityResult {
  parity: string;
  remoteHeadSha: string;
}

export interface GitCloseoutHost {
  inspectWorkspace: (input: { repoRoot: string; commitSha?: string | null }) => GitWorkspaceObservation;
  isAuthorizedCloseoutWorkspace: (input: { repoRoot: string; commitSha?: string | null }) => boolean;
  createCommit: (input: {
    repoRoot: string;
    operationId: string;
    selectedPaths: readonly string[];
    commitMessage: string;
    branch: string;
    expectedHeadSha: string;
  }) => GitCommitResult | Promise<GitCommitResult>;
  pushCommit: (input: {
    repoRoot: string;
    commitSha: string;
    branch: string;
    remote: string;
  }) => GitPushResult;
  verifyRemoteParity: (
    repoRoot: string,
    input: { branch: string; remote: string },
  ) => GitParityResult;
}
