import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { rm } from 'node:fs/promises';
import { runGit, gitCurrentBranch } from '../../shared/git-safe.mjs';
import { filterStagingSelection, stageSelectedPaths, validateGitCloseoutPath } from './staging-policy.mjs';
import { buildKernelCommitMessage } from './commit-message.mjs';
import { observeWorkspaceIdentity } from '../run/workspace-identity.mjs';

export class KernelGitCloseoutError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'KernelGitCloseoutError';
    this.code = code;
    this.details = details;
  }
}

// A failed push leaves a Kernel-created commit in HEAD while the persisted
// workspace identity still describes the pre-closeout dirty tree.  That exact
// state is safe to retry; any other HEAD/status change is an external Git or
// workspace mutation and must invalidate the evidence before closeout.
export const isAuthorizedKernelGitCloseoutWorkspace = ({ repoRoot = process.cwd(), commitSha = null } = {}) => {
  if (!commitSha) return false;
  const head = runGit(repoRoot, ['rev-parse', 'HEAD']);
  const status = runGit(repoRoot, ['status', '--porcelain']);
  return head?.status === 0
    && status?.status === 0
    && String(head.stdout || '').trim() === String(commitSha)
    && String(status.stdout || '').trim() === '';
};

const reconcileWorkspaceBeforeCloseout = ({
  runId,
  projectId,
  stateStore,
  repoRoot,
  gitCloseoutRequest,
}) => {
  if (!stateStore || typeof stateStore.getRun !== 'function' || typeof stateStore.observeWorkspaceIdentity !== 'function') {
    return null;
  }

  const run = stateStore.getRun(runId);
  if (!run) throw new KernelGitCloseoutError('RUN_NOT_FOUND', `Run ${runId} not found`);
  const observation = observeWorkspaceIdentity({ projectRoot: repoRoot });
  const authorizedRetry = isAuthorizedKernelGitCloseoutWorkspace({
    repoRoot,
    commitSha: gitCloseoutRequest?.existingCommitSha || null,
  });

  if (run.currentWorkspaceIdentity
    && observation.identity !== run.currentWorkspaceIdentity
    && !authorizedRetry) {
    stateStore.observeWorkspaceIdentity(runId, observation.identity);
    const branch = gitCurrentBranch(repoRoot);
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
}) {
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

  reconcileWorkspaceBeforeCloseout({
    runId,
    projectId,
    stateStore,
    repoRoot,
    gitCloseoutRequest,
  });

  const requestedMode = gitCloseoutRequest.mode || 'commit';
  const ALLOWED_MODES = new Set(['commit', 'commit_and_push', 'push', 'soft', 'none']);
  if (!ALLOWED_MODES.has(requestedMode)) {
    throw new KernelGitCloseoutError('INVALID_GIT_CLOSEOUT_MODE', `Unsupported git closeout mode: ${requestedMode}`);
  }

  // Pre-existing staged changes check (Section 1.4, 13.2)
  const stagedDiffRes = runGit(repoRoot, ['diff', '--cached', '--quiet']);
  if (stagedDiffRes.status !== 0) {
    throw new KernelGitCloseoutError('GIT_PREEXISTING_STAGED_CHANGES', 'Pre-existing staged changes present in working tree');
  }

  const currentBranch = gitCurrentBranch(repoRoot);
  if (!currentBranch) {
    throw new KernelGitCloseoutError('DETACHED_HEAD', 'Git closeout requires an active branch, found detached HEAD');
  }

  const gitStatusRes = runGit(repoRoot, ['status', '--porcelain']);
  const gitChangedPaths = gitStatusRes.status === 0
    ? gitStatusRes.stdout.split(/\r?\n/).map((l) => l.slice(3).trim()).filter(Boolean)
    : null;

  // Validate path containment and safety (Section 14)
  for (const file of changedFiles) {
    try {
      validateGitCloseoutPath(repoRoot, file, { changedPathsInGit: gitChangedPaths });
    } catch (pathErr) {
      throw new KernelGitCloseoutError('INVALID_GIT_PATH', pathErr.message, { originalError: pathErr });
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

  const beforeHeadRes = runGit(repoRoot, ['rev-parse', 'HEAD']);
  const beforeHeadSha = beforeHeadRes.status === 0 ? String(beforeHeadRes.stdout || '').trim() : '';

  let commitSha = gitCloseoutRequest.existingCommitSha || beforeHeadSha;

  // If retry with existing commitSha, skip creating new commit
  if (!gitCloseoutRequest.existingCommitSha) {
    const tempIndexFile = path.join(os.tmpdir(), `kernel-git-index-${runId}-${Date.now()}-${Math.random().toString(36).slice(2)}.idx`);
    const tempGitEnv = { ...process.env, GIT_INDEX_FILE: tempIndexFile };

    try {
      if (beforeHeadSha) {
        runGit(repoRoot, ['read-tree', 'HEAD'], { env: tempGitEnv });
      }

      try {
        stageSelectedPaths({ repoRoot, paths: selectedPaths, git: runGit, env: tempGitEnv });
      } catch (error) {
        throw new KernelGitCloseoutError('GIT_ADD_FAILED', `Git add failed: ${error.message}`);
      }

      const writeTreeRes = runGit(repoRoot, ['write-tree'], { env: tempGitEnv });
      if (writeTreeRes.status !== 0) {
        throw new KernelGitCloseoutError('GIT_WRITE_TREE_FAILED', `Git write-tree failed: ${writeTreeRes.stderr}`);
      }
      const treeSha = String(writeTreeRes.stdout || '').trim();

      const commitArgs = ['commit-tree', treeSha, '-m', commitMessage];
      if (beforeHeadSha) {
        commitArgs.push('-p', beforeHeadSha);
      }

      const commitTreeRes = runGit(repoRoot, commitArgs, { env: tempGitEnv });
      if (commitTreeRes.status !== 0) {
        throw new KernelGitCloseoutError('GIT_COMMIT_FAILED', `Git commit-tree failed: ${commitTreeRes.stderr}`);
      }
      commitSha = String(commitTreeRes.stdout || '').trim();

      if (!commitSha || commitSha === beforeHeadSha) {
        throw new KernelGitCloseoutError('GIT_COMMIT_NOT_CREATED', 'Git commit was not created (HEAD did not advance)');
      }

      // Branch ref CAS update (with beforeHeadSha)
      const updateRefArgs = ['update-ref', `refs/heads/${currentBranch}`, commitSha];
      if (beforeHeadSha) {
        updateRefArgs.push(beforeHeadSha);
      }
      const updateRefRes = runGit(repoRoot, updateRefArgs);
      if (updateRefRes.status !== 0) {
        throw new KernelGitCloseoutError('GIT_REF_CONFLICT', `Git update-ref CAS conflict on branch ${currentBranch}: ${updateRefRes.stderr}`);
      }

      // Reset main working tree index against advanced HEAD commit
      runGit(repoRoot, ['read-tree', 'HEAD']);

      // Record commit_created receipt BEFORE attempting push (Section 13.3)
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
          receiptJson: { runId, projectId, commitSha, branch: currentBranch, commitSubject, commitMessage, reportKey: gitCloseoutRequest.reportKey || null, verifiedWorkspaceIdentity: gitCloseoutRequest.verifiedWorkspaceIdentity || null, status: 'commit_created' },
        });
      }
    } finally {
      try { await rm(tempIndexFile, { force: true }); } catch {}
    }
  }

  let pushStatus = 'skipped';
  let parity = 'not_requested';
  let remoteHeadSha = '';

  if (gitCloseoutRequest.mode === 'commit_and_push') {
    // Explicit SHA Push (Section 13.4)
    const pushRes = runGit(repoRoot, ['push', 'origin', `${commitSha}:refs/heads/${currentBranch}`]);
    if (pushRes.status === 0) {
      pushStatus = 'completed';
      const { verifyRemoteParity } = await import('./remote-parity.mjs');
      const parityCheck = verifyRemoteParity(repoRoot, { branch: currentBranch, remote: 'origin' });
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
            errorCode: 'REMOTE_PARITY_MISMATCH',
            errorMessage: `Remote parity mismatch: local ${commitSha} != remote ${remoteHeadSha}`,
            receiptJson: { runId, projectId, commitSha, branch: currentBranch, commitSubject, commitMessage, reportKey: gitCloseoutRequest.reportKey || null, verifiedWorkspaceIdentity: gitCloseoutRequest.verifiedWorkspaceIdentity || null, status: 'parity_failed' },
          });
        }
        throw new KernelGitCloseoutError('REMOTE_PARITY_MISMATCH', `Remote parity mismatch on branch ${currentBranch}: local ${commitSha} != remote ${remoteHeadSha}`);
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
          errorCode: 'GIT_PUSH_FAILED',
          errorMessage: pushRes.stderr,
          receiptJson: { runId, projectId, commitSha, branch: currentBranch, commitSubject, commitMessage, reportKey: gitCloseoutRequest.reportKey || null, verifiedWorkspaceIdentity: gitCloseoutRequest.verifiedWorkspaceIdentity || null, status: 'push_failed' },
        });
      }
      throw new KernelGitCloseoutError('GIT_PUSH_FAILED', `Git push failed: ${pushRes.stderr}`);
    }
  }

  const payload = {
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

export async function retryGitCloseout(runId, { stateStore, repoRoot = process.cwd() } = {}) {
  if (!stateStore || typeof stateStore.getGitCloseoutReceipt !== 'function') {
    throw new KernelGitCloseoutError('GIT_CLOSEOUT_RECEIPT_REQUIRED', 'stateStore is required for retry');
  }

  const receipt = stateStore.getGitCloseoutReceipt(runId);
  if (!receipt) {
    throw new KernelGitCloseoutError('GIT_CLOSEOUT_RECEIPT_REQUIRED', `No git closeout receipt found for run ${runId}`);
  }

  if (receipt.status === 'completed' || receipt.receiptJson?.status === 'completed') {
    return receipt.receiptJson || receipt;
  }

  if (!['commit_created', 'push_failed', 'parity_failed'].includes(receipt.status)) {
    throw new KernelGitCloseoutError('GIT_CLOSEOUT_NOT_RETRYABLE', `Git closeout status ${receipt.status} is not retryable`);
  }

  const commitSha = receipt.commitSha;
  const branch = receipt.branch || gitCurrentBranch(repoRoot);

  const reqMode = receipt.mode || receipt.receiptJson?.gitCloseoutRequest?.mode || 'commit';
  if (reqMode === 'commit' || reqMode === 'soft' || reqMode === 'none') {
    return receipt.receiptJson || receipt;
  }

  // A retry is authorized only for the exact Kernel-created commit in a clean
  // workspace. Reconcile before the push so a user edit/commit after the
  // original push failure cannot be smuggled through the stale receipt.
  reconcileWorkspaceBeforeCloseout({
    runId,
    projectId: receipt.projectId,
    stateStore,
    repoRoot,
    gitCloseoutRequest: { requested: true, mode: reqMode, existingCommitSha: commitSha },
  });

  const pushRes = runGit(repoRoot, ['push', 'origin', `${commitSha}:refs/heads/${branch}`]);
  if (pushRes.status !== 0) {
    stateStore.recordGitCloseoutReceipt(runId, {
      projectId: receipt.projectId,
      mode: receipt.mode || 'commit_and_push',
      commitSha,
      branch,
      pushStatus: 'failed',
      parity: 'failed',
      status: 'push_failed',
      errorCode: 'GIT_PUSH_FAILED',
      errorMessage: pushRes.stderr,
    });
    throw new KernelGitCloseoutError('GIT_PUSH_FAILED', `Git push failed during retry: ${pushRes.stderr}`);
  }

  const { verifyRemoteParity } = await import('./remote-parity.mjs');
  const parityCheck = verifyRemoteParity(repoRoot, { branch, remote: 'origin' });
  if (parityCheck.parity !== 'matched') {
    stateStore.recordGitCloseoutReceipt(runId, {
      projectId: receipt.projectId,
      mode: receipt.mode || 'commit_and_push',
      commitSha,
      branch,
      pushStatus: 'completed',
      parity: parityCheck.parity,
      status: 'parity_failed',
      errorCode: 'REMOTE_PARITY_MISMATCH',
      errorMessage: `Parity mismatch: local ${commitSha} != remote ${parityCheck.remoteHeadSha}`,
    });
    throw new KernelGitCloseoutError('REMOTE_PARITY_MISMATCH', `Parity mismatch during retry on branch ${branch}`);
  }

  const updatedReceipt = {
    ...(receipt.receiptJson || {}),
    runId,
    projectId: receipt.projectId,
    commitSha,
    branch,
    pushStatus: 'completed',
    parity: parityCheck.parity,
    status: 'completed',
  };

  stateStore.recordGitCloseoutReceipt(runId, {
    projectId: receipt.projectId,
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
