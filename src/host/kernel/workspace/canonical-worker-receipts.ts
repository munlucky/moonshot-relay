import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { runGit } from '../../../shared/git-safe.js';
import { executionRoot, executionStepWorktreePath } from './physical-worktree.js';
import { observeWorkspaceIdentity } from './workspace-identity.js';
import type { createKernelControlPlane } from '../control-plane-runtime.js';

// Observes completed Worker result commits across multiple departed Hosts.
// This is NOT Writer retirement evidence and never grants Delivery authority.
// Read-only: does not claim a Step, spawn a Worker, acquire a fence, or write Git.
type ControlPlane = Awaited<ReturnType<typeof createKernelControlPlane>>;
type CanonicalAttempt = ReturnType<ControlPlane['stateStore']['getStepAttempts']>[number];

export interface CanonicalWorkerReceipt {
  stepId: string;
  attemptId: string;
  executionWorkspaceId: string;
  workspaceRoot: string;
  resultCommitSha: string;
  changedPaths: string[];
  patchDigest: string;
  resultWorkspaceIdentity: string;
  workerReport: NonNullable<CanonicalAttempt['workerReport']>;
}

type CanonicalReadback =
  | { status: 'ready'; receipts: CanonicalWorkerReceipt[]; writerExitVerified: false; deliveryAuthorized: false }
  | { status: 'blocked'; code: string; stepId?: string; writerExitVerified: false; deliveryAuthorized: false };

const blocked = (code: string, stepId?: string): CanonicalReadback => ({
  status: 'blocked', code, ...(stepId ? { stepId } : {}),
  writerExitVerified: false, deliveryAuthorized: false,
});

const git = (cwd: string, args: string[]): string | null => {
  const result = runGit(cwd, args, { maxBuffer: 64 * 1024 * 1024 });
  return result.error || result.status !== 0 ? null : String(result.stdout ?? '');
};
const digest = (value: string): string => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

export const readCanonicalParallelWorkerReceipts = ({
  controlPlane, runId, projectRoot, runtimeHome,
}: {
  controlPlane: ControlPlane;
  runId: string;
  projectRoot: string;
  runtimeHome: string;
}): CanonicalReadback => {
  const run = controlPlane.stateStore.getRun(runId);
  if (!run?.projectId || !Number.isSafeInteger(run.mutationRevision) || Number(run.mutationRevision) < 0
    || run.status === 'blocked' || run.status === 'completed') {
    return blocked('canonical_run_not_pre_delivery');
  }
  const steps = controlPlane.stateStore.getRunSteps(runId, { planRevision: run.planRevision });
  if (steps.length < 2 || controlPlane.getExecutableSteps(runId).steps.length !== 0) {
    return blocked('canonical_batch_not_fully_claimed');
  }
  const base = git(projectRoot, ['rev-parse', '--verify', 'HEAD'])?.trim();
  if (!base || (run.baseCommitSha && run.baseCommitSha !== base)
    || (run.currentWorkspaceIdentity && observeWorkspaceIdentity({ projectRoot }).identity !== run.currentWorkspaceIdentity)) {
    return blocked('canonical_owner_base_drift');
  }
  const root = executionRoot({ runtimeHome, projectId: run.projectId, runId });
  const canonicalRoot = (() => { try { return realpathSync(root); } catch { return null; } })();
  if (!canonicalRoot) return blocked('canonical_workspace_missing');
  const ownerGit = git(projectRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir'])?.trim();
  if (!ownerGit) return blocked('canonical_owner_git_missing');

  const receipts: CanonicalWorkerReceipt[] = [];
  for (const step of steps) {
    const attempts = controlPlane.stateStore.getStepAttempts(runId, { stepId: step.stepId });
    if (attempts.length !== 1) return blocked('canonical_attempt_ambiguous', step.stepId);
    const attempt = attempts[0];
    if (!attempt || attempt.status !== 'started' || attempt.provenanceKind !== 'routed'
      || Number(attempt.mutationRevision) !== Number(run.mutationRevision)
      || Number(attempt.planRevision) !== Number(run.planRevision)
      || !attempt.attemptId || !attempt.workspaceId
      || !attempt.resultCommitSha || !attempt.patchDigest || !attempt.resultWorkspaceIdentity
      || !Array.isArray(attempt.changedPaths) || attempt.changedPaths.length === 0
      || !isObject(attempt.workerReport) || !Array.isArray(attempt.workerReport.verifications)
      || attempt.workerReport.verifications.length === 0
      || step.executionWorkspaceId !== attempt.workspaceId
      || step.resultAttemptId !== attempt.attemptId
      || step.resultCommitSha !== attempt.resultCommitSha
      || step.resultWorkspaceIdentity !== attempt.resultWorkspaceIdentity) {
      return blocked('canonical_worker_receipt_incomplete', step.stepId);
    }
    const workspaceRoot = executionStepWorktreePath({ runtimeHome, projectId: run.projectId, runId, stepId: step.stepId });
    let actualRoot: string;
    let gitRoot: string;
    try {
      actualRoot = realpathSync(workspaceRoot);
      gitRoot = realpathSync(ownerGit);
    } catch { return blocked('canonical_workspace_missing', step.stepId); }
    const relative = path.relative(canonicalRoot, actualRoot);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      return blocked('canonical_workspace_escape', step.stepId);
    }
    const commonGit = git(workspaceRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir'])?.trim();
    const head = git(workspaceRoot, ['rev-parse', '--verify', 'HEAD'])?.trim();
    const dirty = git(workspaceRoot, ['status', '--porcelain=v1', '--untracked-files=all']);
    const parents = git(workspaceRoot, ['rev-list', '--parents', '-n', '1', attempt.resultCommitSha])?.trim().split(/\s+/u);
    const patch = git(workspaceRoot, ['show', '--format=', '--binary', attempt.resultCommitSha]);
    const changed = git(workspaceRoot, ['diff-tree', '--no-commit-id', '--name-only', '-z', '-r', attempt.resultCommitSha]);
    if (!commonGit || !head || dirty !== '' || !parents || parents.length !== 2 || parents[1] !== base
      || head !== attempt.resultCommitSha || patch === null || changed === null
      || digest(patch) !== attempt.patchDigest
      || JSON.stringify(changed.split('\0').filter(Boolean).sort()) !== JSON.stringify([...attempt.changedPaths].sort())) {
      return blocked('canonical_git_result_drift', step.stepId);
    }
    try {
      if (realpathSync(commonGit) !== gitRoot
        || observeWorkspaceIdentity({ projectRoot: workspaceRoot }).identity !== attempt.resultWorkspaceIdentity) {
        return blocked('canonical_workspace_identity_drift', step.stepId);
      }
    } catch { return blocked('canonical_workspace_identity_drift', step.stepId); }
    receipts.push({ stepId: step.stepId, attemptId: attempt.attemptId,
      executionWorkspaceId: attempt.workspaceId, workspaceRoot,
      resultCommitSha: attempt.resultCommitSha, changedPaths: attempt.changedPaths,
      patchDigest: attempt.patchDigest, resultWorkspaceIdentity: attempt.resultWorkspaceIdentity,
      workerReport: attempt.workerReport });
  }
  return { status: 'ready', receipts, writerExitVerified: false, deliveryAuthorized: false };
};
