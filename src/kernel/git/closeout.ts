import crypto from 'node:crypto';
import { filterStagingSelection, validateGitCloseoutPath } from './staging-policy.js';
import { buildKernelCommitMessage } from './commit-message.js';
import { assertCompletionProvenance } from '../proof/completion-provenance.js';

type UnknownRecord = Record<string, unknown>;
type CommitMessageInput = Parameters<typeof buildKernelCommitMessage>[0];

interface GitCloseoutRequest extends UnknownRecord {
  requested?: boolean;
  approvalReceipt?: unknown;
  mode?: string | null;
  existingCommitSha?: string | null;
  message?: unknown;
  reportKey?: unknown;
  verifiedWorkspaceIdentity?: unknown;
}

interface KnowledgeCommitReceipt extends UnknownRecord {
  digest?: unknown;
}

interface GitCloseoutReceipt extends UnknownRecord {
  projectId?: string | null;
  mode?: string | null;
  commitSha?: string | null;
  branch?: string | null;
  status?: string;
  receiptJson?: UnknownRecord | null;
}

interface RunLike extends UnknownRecord {
  currentWorkspaceIdentity?: unknown;
}

interface WorkspaceIdentityObservation {
  identity: string;
}

import type { GitCloseoutHost } from '../../contracts/git-closeout.js';
interface GitCloseoutStateStore {
  getRun?: (runId: string) => RunLike | null;
  getCompletionDecision?: (runId: string) => UnknownRecord | null;
  getMutationProvenance?: (runId: string) => UnknownRecord | null;
  observeWorkspaceIdentity?: (runId: string, identity: string) => unknown;
  recordGitCloseoutReceipt?: (runId: string, receipt: UnknownRecord) => unknown;
  getGitCloseoutReceipt?: (runId: string) => GitCloseoutReceipt | null;
}

type ObserveWorkspaceIdentity = (input: { projectRoot: string }) => WorkspaceIdentityObservation;

interface ExecuteKernelGitCloseoutInput {
  runId: string;
  projectId: string;
  stateStore?: GitCloseoutStateStore | null;
  repoRoot?: string;
  gitCloseoutRequest?: GitCloseoutRequest | null;
  knowledgeCommitReceipt?: KnowledgeCommitReceipt | null;
  changedFiles?: unknown[];
  observeWorkspaceIdentity?: ObserveWorkspaceIdentity | null;
  gitCloseoutHost?: GitCloseoutHost | null;
}

interface RetryGitCloseoutOptions {
  stateStore?: GitCloseoutStateStore | null;
  repoRoot?: string;
  observeWorkspaceIdentity?: ObserveWorkspaceIdentity | null;
  gitCloseoutHost?: GitCloseoutHost | null;
}

const asRecord = (value: unknown): UnknownRecord => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : {}
);

const errorRecord = (value: unknown): UnknownRecord => asRecord(value);

export class KernelGitCloseoutError extends Error {
  readonly code: string;
  readonly details: UnknownRecord;

  constructor(code: string, message: string, details: UnknownRecord = {}) {
    super(message);
    this.name = 'KernelGitCloseoutError';
    this.code = code;
    this.details = details;
  }
}

const requireGitCloseoutHost = (gitCloseoutHost: GitCloseoutHost | null | undefined): GitCloseoutHost => {
  if (
    !gitCloseoutHost
    || typeof gitCloseoutHost.inspectWorkspace !== 'function'
    || typeof gitCloseoutHost.isAuthorizedCloseoutWorkspace !== 'function'
    || typeof gitCloseoutHost.createCommit !== 'function'
    || typeof gitCloseoutHost.pushCommit !== 'function'
    || typeof gitCloseoutHost.verifyRemoteParity !== 'function'
  ) {
    throw new KernelGitCloseoutError(
      'GIT_HOST_REQUIRED',
      'Git closeout requires Host Git services',
    );
  }
  return gitCloseoutHost;
};

const assertManagedCloseoutAuthority = ({
  stateStore,
  runId,
}: {
  stateStore?: GitCloseoutStateStore | null;
  runId: string;
}) => {
  if (!stateStore) return null;
  if (
    typeof stateStore.getRun !== 'function'
    || typeof stateStore.getCompletionDecision !== 'function'
    || typeof stateStore.getMutationProvenance !== 'function'
  ) {
    throw new KernelGitCloseoutError(
      'RUN_NOT_FINALIZED',
      'Kernel-managed Git closeout requires Run, completion, and mutation provenance authority',
    );
  }
  const run = stateStore.getRun(runId);
  try {
    return assertCompletionProvenance({
      run,
      completionDecision: stateStore.getCompletionDecision(runId),
      mutationProvenance: stateStore.getMutationProvenance(runId),
    });
  } catch (error: unknown) {
    const failure = errorRecord(error);
    return (() => {
      throw new KernelGitCloseoutError(
        String(failure.code || 'RUN_NOT_FINALIZED'),
        String(failure.message || 'Run completion provenance is not current'),
        { reasons: Array.isArray(failure.reasons) ? failure.reasons : [] },
      );
    })();
  }
};

const reconcileWorkspaceBeforeCloseout = ({
  runId,
  projectId,
  stateStore,
  repoRoot,
  gitCloseoutRequest,
  observeWorkspaceIdentity,
  gitCloseoutHost,
}: {
  runId: string;
  projectId: string;
  stateStore?: GitCloseoutStateStore | null;
  repoRoot: string;
  gitCloseoutRequest?: GitCloseoutRequest | null;
  observeWorkspaceIdentity?: ObserveWorkspaceIdentity | null;
  gitCloseoutHost: GitCloseoutHost;
}): WorkspaceIdentityObservation | null => {
  if (!stateStore || typeof stateStore.getRun !== 'function' || typeof stateStore.observeWorkspaceIdentity !== 'function') {
    return null;
  }

  const run = stateStore.getRun(runId);
  if (!run) throw new KernelGitCloseoutError('RUN_NOT_FOUND', `Run ${runId} not found`);
  if (typeof observeWorkspaceIdentity !== 'function') {
    throw new KernelGitCloseoutError('WORKSPACE_OBSERVER_REQUIRED', 'Git closeout requires a Host workspace observer');
  }
  const observation = observeWorkspaceIdentity({ projectRoot: repoRoot });
  const gitObservation = gitCloseoutHost.inspectWorkspace({
    repoRoot,
    commitSha: gitCloseoutRequest?.existingCommitSha || null,
  });
  const authorizedRetry = gitObservation.authorizedCommit === true;

  if (run.currentWorkspaceIdentity
    && observation.identity !== run.currentWorkspaceIdentity
    && !authorizedRetry) {
    stateStore.observeWorkspaceIdentity(runId, observation.identity);
    const branch = gitObservation.branch;
    const receiptJson = {
      schemaVersion: 1,
      runId,
      projectId,
      branch,
      status: 'stale_workspace',
      errorCode: 'WORKSPACE_IDENTITY_MISMATCH',
      expectedWorkspaceIdentity: run.currentWorkspaceIdentity,
      observedWorkspaceIdentity: observation.identity,
    };
    if (typeof stateStore.recordGitCloseoutReceipt === 'function') {
      stateStore.recordGitCloseoutReceipt(runId, {
        projectId,
        mode: gitCloseoutRequest?.mode || 'commit',
        commitSha: gitCloseoutRequest?.existingCommitSha || null,
        branch,
        pushStatus: 'not_started',
        parity: 'not_requested',
        status: 'stale_workspace',
        errorCode: 'WORKSPACE_IDENTITY_MISMATCH',
        errorMessage: 'Workspace identity changed outside the authorized Kernel Git closeout retry state',
        receiptJson,
      });
    }
    throw new KernelGitCloseoutError(
      'WORKSPACE_IDENTITY_MISMATCH',
      'Workspace identity changed outside the authorized Kernel Git closeout retry state',
      { expectedWorkspaceIdentity: run.currentWorkspaceIdentity, observedWorkspaceIdentity: observation.identity },
    );
  }

  if (!run.currentWorkspaceIdentity) stateStore.observeWorkspaceIdentity(runId, observation.identity);
  return observation;
};

export async function executeKernelGitCloseout({
  runId,
  projectId,
  stateStore = null,
  repoRoot = process.cwd(),
  gitCloseoutRequest = null,
  knowledgeCommitReceipt = null,
  changedFiles = [],
  observeWorkspaceIdentity = null,
  gitCloseoutHost = null,
}: ExecuteKernelGitCloseoutInput): Promise<UnknownRecord> {
  // If not explicitly requested, return skipped receipt
  if (!gitCloseoutRequest || !gitCloseoutRequest.requested) {
    const skippedReceipt = {
      schemaVersion: 1,
      runId,
      projectId,
      requestedMode: 'none',
      status: 'skipped',
      digest: crypto.createHash('sha256').update(`${runId}:skipped`).digest('hex'),
    };
    if (stateStore && typeof stateStore.recordGitCloseoutReceipt === 'function') {
      stateStore.recordGitCloseoutReceipt(runId, {
        projectId,
        mode: 'none',
        pushStatus: 'skipped',
        parity: 'not_requested',
        status: 'skipped',
        receiptJson: skippedReceipt,
      });
    }
    return skippedReceipt;
  }

  if (!gitCloseoutRequest.approvalReceipt) {
    throw new KernelGitCloseoutError('APPROVAL_REQUIRED', 'Explicit Git closeout requires valid approvalReceipt');
  }

  const gitHost = requireGitCloseoutHost(gitCloseoutHost);
  assertManagedCloseoutAuthority({ stateStore, runId });

  reconcileWorkspaceBeforeCloseout({
    runId,
    projectId,
    stateStore,
    repoRoot,
    gitCloseoutRequest,
    observeWorkspaceIdentity,
    gitCloseoutHost: gitHost,
  });

  const requestedMode = gitCloseoutRequest.mode || 'commit';
  const ALLOWED_MODES = new Set(['commit', 'commit_and_push', 'push', 'soft', 'none']);
  if (!ALLOWED_MODES.has(requestedMode)) {
    throw new KernelGitCloseoutError('INVALID_GIT_CLOSEOUT_MODE', `Unsupported git closeout mode: ${requestedMode}`);
  }

  const gitObservation = gitHost.inspectWorkspace({ repoRoot });
  if (gitObservation.stagedChanges) {
    throw new KernelGitCloseoutError(
      'GIT_PREEXISTING_STAGED_CHANGES',
      'Pre-existing staged changes present in working tree',
    );
  }

  const currentBranch = gitObservation.branch;
  if (!currentBranch) {
    throw new KernelGitCloseoutError(
      'DETACHED_HEAD',
      'Git closeout requires an active branch, found detached HEAD',
    );
  }
  const gitChangedPaths = gitObservation.changedPaths;

  // Validate path containment and safety (Section 14)
  for (const file of changedFiles) {
    try {
      validateGitCloseoutPath(repoRoot, file, { changedPathsInGit: gitChangedPaths });
    } catch (pathErr: unknown) {
      const failure = errorRecord(pathErr);
      throw new KernelGitCloseoutError('INVALID_GIT_PATH', String(failure.message || 'Invalid Git closeout path'), { originalError: failure });
    }
  }

  const { selectedPaths, excludedPaths } = filterStagingSelection(changedFiles);

  // Empty selection check: do not make empty commits
  if (selectedPaths.length === 0 && !gitCloseoutRequest.existingCommitSha) {
    const skippedReceipt = {
      schemaVersion: 1,
      runId,
      projectId,
      requestedMode: gitCloseoutRequest.mode || 'soft',
      status: 'skipped',
      reason: 'no_selected_changes',
      digest: crypto.createHash('sha256').update(`${runId}:no_selected_changes`).digest('hex'),
    };
    if (stateStore && typeof stateStore.recordGitCloseoutReceipt === 'function') {
      stateStore.recordGitCloseoutReceipt(runId, {
        projectId,
        mode: gitCloseoutRequest.mode || 'soft',
        pushStatus: 'skipped',
        parity: 'not_requested',
        status: 'skipped',
        selectedPaths: [],
        receiptJson: skippedReceipt,
      });
    }
    return skippedReceipt;
  }

  const run = stateStore && typeof stateStore.getRun === 'function'
    ? stateStore.getRun(runId)
    : { runId, projectId };
  const completion = stateStore && typeof stateStore.getCompletionDecision === 'function'
    ? stateStore.getCompletionDecision(runId)
    : null;
  const commitMessage = buildKernelCommitMessage({
    message: gitCloseoutRequest.message || null,
    run,
    completion,
    projectId,
    selectedPaths,
    excludedPaths,
    knowledgeCommitReceipt,
    closeoutMode: requestedMode,
  });
  const commitSubject = commitMessage.split('\n', 1)[0];

  const beforeHeadSha = gitObservation.headSha || '';

  let commitSha = gitCloseoutRequest.existingCommitSha || beforeHeadSha;

  // If retry with existing commitSha, skip creating new commit.
  if (!gitCloseoutRequest.existingCommitSha) {
    try {
      const created = await gitHost.createCommit({
        repoRoot,
        operationId: runId,
        selectedPaths,
        commitMessage,
        branch: currentBranch,
        expectedHeadSha: beforeHeadSha,
      });
      commitSha = created.commitSha;
    } catch (error: unknown) {
      const failure = errorRecord(error);
      throw new KernelGitCloseoutError(
        String(failure.code || 'GIT_COMMIT_FAILED'),
        String(failure.message || 'Git commit failed'),
        { originalError: failure },
      );
    }

    // Record commit_created receipt BEFORE attempting push (Section 13.3).
    if (stateStore && typeof stateStore.recordGitCloseoutReceipt === 'function') {
      stateStore.recordGitCloseoutReceipt(runId, {
        projectId,
        mode: gitCloseoutRequest.mode || 'soft',
        commitSha,
        branch: currentBranch,
        pushStatus: 'skipped',
        parity: 'not_requested',
        status: 'commit_created',
        beforeHeadSha,
        selectedPaths,
        receiptJson: {
          runId,
          projectId,
          commitSha,
          branch: currentBranch,
          commitSubject,
          commitMessage,
          reportKey: gitCloseoutRequest.reportKey || null,
          verifiedWorkspaceIdentity: gitCloseoutRequest.verifiedWorkspaceIdentity || null,
          mutationAdmission: gitCloseoutRequest.mutationAdmission || null,
          status: 'commit_created',
        },
      });
    }
  }

  let pushStatus = 'skipped';
  let parity = 'not_requested';
  let remoteHeadSha = '';

  if (gitCloseoutRequest.mode === 'commit_and_push') {
    const pushResult = gitHost.pushCommit({
      repoRoot,
      commitSha,
      branch: currentBranch,
      remote: 'origin',
    });
    if (pushResult.status === 'completed') {
      pushStatus = 'completed';
      const parityCheck = gitHost.verifyRemoteParity(
        repoRoot,
        { branch: currentBranch, remote: 'origin' },
      );
      parity = parityCheck.parity;
      remoteHeadSha = parityCheck.remoteHeadSha;

      if (parityCheck.parity !== 'matched') {
        if (stateStore && typeof stateStore.recordGitCloseoutReceipt === 'function') {
          stateStore.recordGitCloseoutReceipt(runId, {
            projectId,
            mode: gitCloseoutRequest.mode,
            commitSha,
            branch: currentBranch,
            pushStatus: 'completed',
            parity: parityCheck.parity,
            status: 'parity_failed',
            beforeHeadSha,
            selectedPaths,
            errorCode: 'REMOTE_PARITY_MISMATCH',
            errorMessage: `Remote parity mismatch: local ${commitSha} != remote ${remoteHeadSha}`,
            receiptJson: {
              runId,
              projectId,
              commitSha,
              branch: currentBranch,
              commitSubject,
              commitMessage,
              reportKey: gitCloseoutRequest.reportKey || null,
              verifiedWorkspaceIdentity: gitCloseoutRequest.verifiedWorkspaceIdentity || null,
              mutationAdmission: gitCloseoutRequest.mutationAdmission || null,
              status: 'parity_failed',
            },
          });
        }
        throw new KernelGitCloseoutError(
          'REMOTE_PARITY_MISMATCH',
          `Remote parity mismatch on branch ${currentBranch}: local ${commitSha} != remote ${remoteHeadSha}`,
        );
      }
    } else {
      pushStatus = 'failed';
      if (stateStore && typeof stateStore.recordGitCloseoutReceipt === 'function') {
        stateStore.recordGitCloseoutReceipt(runId, {
          projectId,
          mode: gitCloseoutRequest.mode,
          commitSha,
          branch: currentBranch,
          pushStatus: 'failed',
          parity: 'failed',
          status: 'push_failed',
          beforeHeadSha,
          selectedPaths,
          errorCode: 'GIT_PUSH_FAILED',
          errorMessage: pushResult.stderr,
          receiptJson: {
            runId,
            projectId,
            commitSha,
            branch: currentBranch,
            commitSubject,
            commitMessage,
            reportKey: gitCloseoutRequest.reportKey || null,
            verifiedWorkspaceIdentity: gitCloseoutRequest.verifiedWorkspaceIdentity || null,
            mutationAdmission: gitCloseoutRequest.mutationAdmission || null,
            status: 'push_failed',
          },
        });
      }
      throw new KernelGitCloseoutError(
        'GIT_PUSH_FAILED',
        `Git push failed: ${pushResult.stderr}`,
      );
    }
  }

  const payload: UnknownRecord = {
    schemaVersion: 1,
    runId,
    projectId,
    requestedMode: gitCloseoutRequest.mode,
    knowledgeCommitReceiptRef: knowledgeCommitReceipt?.digest || '',
    commitSubject,
    commitMessage,
    selectedPaths,
    excludedPaths,
    commitSha,
    branch: currentBranch,
    pushStatus,
    remoteHeadSha,
    parity,
    approvalReceipt: gitCloseoutRequest.approvalReceipt,
    reportKey: gitCloseoutRequest.reportKey || null,
    verifiedWorkspaceIdentity: gitCloseoutRequest.verifiedWorkspaceIdentity || null,
    mutationAdmission: gitCloseoutRequest.mutationAdmission || null,
    status: 'completed',
  };

  const digest = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  payload.digest = digest;

  if (stateStore && typeof stateStore.recordGitCloseoutReceipt === 'function') {
    stateStore.recordGitCloseoutReceipt(runId, {
      projectId,
      mode: gitCloseoutRequest.mode,
      commitSha,
      branch: currentBranch,
      pushStatus,
      parity,
      status: 'completed',
      beforeHeadSha,
      selectedPaths,
      receiptJson: payload,
    });
  }

  return payload;
}

export async function retryGitCloseout(
  runId: string,
  {
    stateStore = null,
    repoRoot = process.cwd(),
    observeWorkspaceIdentity = null,
    gitCloseoutHost = null,
  }: RetryGitCloseoutOptions = {},
): Promise<UnknownRecord> {
  if (
    !stateStore
    || typeof stateStore.getGitCloseoutReceipt !== 'function'
    || typeof stateStore.recordGitCloseoutReceipt !== 'function'
  ) {
    throw new KernelGitCloseoutError(
      'GIT_CLOSEOUT_RECEIPT_REQUIRED',
      'stateStore is required for retry',
    );
  }

  const recordGitCloseoutReceipt = stateStore.recordGitCloseoutReceipt;
  const receipt = stateStore.getGitCloseoutReceipt(runId);
  if (!receipt) {
    throw new KernelGitCloseoutError(
      'GIT_CLOSEOUT_RECEIPT_REQUIRED',
      `No git closeout receipt found for run ${runId}`,
    );
  }

  assertManagedCloseoutAuthority({ stateStore, runId });

  if (receipt.status === 'completed' || receipt.receiptJson?.status === 'completed') {
    return receipt.receiptJson || receipt;
  }

  const receiptStatus = receipt.status || '';
  if (!['commit_created', 'push_failed', 'parity_failed'].includes(receiptStatus)) {
    throw new KernelGitCloseoutError(
      'GIT_CLOSEOUT_NOT_RETRYABLE',
      `Git closeout status ${receiptStatus} is not retryable`,
    );
  }

  const gitHost = requireGitCloseoutHost(gitCloseoutHost);
  const commitSha = receipt.commitSha;
  if (!commitSha) {
    throw new KernelGitCloseoutError('GIT_CLOSEOUT_RECEIPT_INVALID', `Git closeout receipt for run ${runId} has no commit SHA`);
  }
  const workspace = gitHost.inspectWorkspace({ repoRoot, commitSha });
  const branch = receipt.branch || workspace.branch;

  const receiptJson = asRecord(receipt.receiptJson);
  const priorRequest = asRecord(receiptJson.gitCloseoutRequest);
  const reqMode = receipt.mode
    || (typeof priorRequest.mode === 'string' ? priorRequest.mode : null)
    || 'commit';
  if (reqMode === 'commit' || reqMode === 'soft' || reqMode === 'none') {
    return receipt.receiptJson || receipt;
  }

  const projectId = receipt.projectId || '';
  reconcileWorkspaceBeforeCloseout({
    runId,
    projectId,
    stateStore,
    repoRoot,
    gitCloseoutRequest: {
      requested: true,
      mode: reqMode,
      existingCommitSha: commitSha,
    },
    observeWorkspaceIdentity,
    gitCloseoutHost: gitHost,
  });

  const pushResult = gitHost.pushCommit({
    repoRoot,
    commitSha,
    branch,
    remote: 'origin',
  });
  if (pushResult.status !== 'completed') {
    recordGitCloseoutReceipt(runId, {
      projectId,
      mode: receipt.mode || 'commit_and_push',
      commitSha,
      branch,
      pushStatus: 'failed',
      parity: 'failed',
      status: 'push_failed',
      errorCode: 'GIT_PUSH_FAILED',
      errorMessage: pushResult.stderr,
    });
    throw new KernelGitCloseoutError(
      'GIT_PUSH_FAILED',
      `Git push failed during retry: ${pushResult.stderr}`,
    );
  }

  const parityCheck = gitHost.verifyRemoteParity(
    repoRoot,
    { branch, remote: 'origin' },
  );
  if (parityCheck.parity !== 'matched') {
    recordGitCloseoutReceipt(runId, {
      projectId,
      mode: receipt.mode || 'commit_and_push',
      commitSha,
      branch,
      pushStatus: 'completed',
      parity: parityCheck.parity,
      status: 'parity_failed',
      errorCode: 'REMOTE_PARITY_MISMATCH',
      errorMessage: `Parity mismatch: local ${commitSha} != remote ${parityCheck.remoteHeadSha}`,
    });
    throw new KernelGitCloseoutError(
      'REMOTE_PARITY_MISMATCH',
      `Parity mismatch during retry on branch ${branch}`,
    );
  }

  const updatedReceipt = {
    ...(receipt.receiptJson || {}),
    runId,
    projectId,
    commitSha,
    branch,
    pushStatus: 'completed',
    parity: parityCheck.parity,
    status: 'completed',
  };

  recordGitCloseoutReceipt(runId, {
    projectId,
    mode: receipt.mode || 'commit_and_push',
    commitSha,
    branch,
    pushStatus: 'completed',
    parity: parityCheck.parity,
    status: 'completed',
    receiptJson: updatedReceipt,
  });

  return updatedReceipt;
}
