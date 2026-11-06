// Process-local Host control shared by local and MCP callers.
// Canonical Run/Step/Attempt, not this map, retain work and completion authority.
import path from 'node:path';
import { mkdir, realpath } from 'node:fs/promises';
import { createKernelControlPlane } from './control-plane-runtime.js';
import { startHostOwnedWritableAttempt, type HostOwnedWritableAttemptHandle } from './host-owned-writable-attempt.js';
import { reserveHostWorkspaceWriter } from './workspace-writer-reservation.js';
import { buildModelVisiblePromptMessage, buildModelVisiblePromptView } from './model-capsule-view.js';
import { runGit } from '../../shared/git-safe.js';
import { verifyHostOwnedWorkerCandidate, settleHostOwnedWorkerCandidate, type WithHostWorkerExcluded } from './parallel-dispatcher.js';
import type { CodexAppServerTransportOptions } from './codex-app-server-transport.js';

type RecordValue = Record<string, unknown>;
interface Job {
  runId: string;
  stepId: string;
  attemptId: string;
  model: string;
  effort: string;
  handle: HostOwnedWritableAttemptHandle;
  completedTurn: { threadId: string; turnId: string; workspaceId: string; turnStatus: 'completed' | 'failed' | 'interrupted' | 'unknown' } | null;
  resultCandidate: Awaited<HostOwnedWritableAttemptHandle['result']>['resultCandidate'];
  resultCaptureStatus: 'not-attempted' | 'captured' | 'inconsistent';
  resultHandoff: Awaited<HostOwnedWritableAttemptHandle['result']>['resultHandoff'] | null;
  preflight: { status: string; failureCode: string | null; patchDigest: string | null } | null;
  settlement: RecordValue | null;
  continuationFailure?: string;
  turnStatus: 'pending' | 'completed' | 'failed' | 'interrupted' | 'unknown';
}
export interface HostWorkerStartInput {
  projectRoot: string;
  runtimeHome: string;
  runId: string;
  model: string;
  effort: string;
  modelInput: RecordValue;
}
export type LocalHostWorkerStartInput = Omit<HostWorkerStartInput, 'modelInput'>;
const deny = (code: string): Error & { code: string } => Object.assign(new Error(code), { code });
const record = (value: unknown): RecordValue => value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
const within = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
};

export function createHostWorkerSessions({
  transportOptions = undefined,
  withWriterExcluded = undefined,
  env = process.env,
}: { transportOptions?: CodexAppServerTransportOptions; withWriterExcluded?: WithHostWorkerExcluded; env?: NodeJS.ProcessEnv } = {}) {
  const assertNativeStartAvailable = (): void => {
    if (!withWriterExcluded) throw deny('host_worker_native_isolation_unverified');
  };
  const jobs = new Map<string, Job>();
  const starting = new Map<string, { stepId: string; attemptId?: string; model: string; effort: string; result: Promise<{runId: string; attemptId: string; stepId: string}> }>();
  // A long-lived Host can serve multiple Kernel Runtime Homes. Never reuse a
  // live Attempt handle across distinct state stores sharing a Run ID.
  const key = (root: string, runtimeRoot: string, runId: string) => JSON.stringify([root, runtimeRoot, runId]);
  const view = (job: Job) => ({
    runId: job.runId,
    stepId: job.stepId,
    attemptId: job.attemptId,
    ...job.handle.observe(),
    turnStatus: job.turnStatus,
    completedTurn: job.completedTurn,
    resultCandidate: job.resultCandidate,
    resultCaptureStatus: job.resultCaptureStatus,
    resultHandoff: job.resultHandoff,
    preflight: job.preflight,
    // The Host consumes the Report continuation. Main can observe its status
    // without receiving another executable copy or internal Proof output.
    settlement: job.settlement ? {
      status: job.settlement.status,
      failureCode: job.settlement.failureCode || null,
    } : null,
    continuationFailure: job.continuationFailure || null,
    deliveryAuthorized: job.settlement?.status === 'settled',
  });
  const continueJob = async (input: LocalHostWorkerStartInput, job: Job): Promise<void> => {
    const settlement = job.settlement;
    const modelInput = record(settlement?.next);
    const nextType = record(modelInput.action).type;
    if ((settlement?.status !== 'settled' || nextType !== 'implement')
      && (settlement?.status !== 'candidate-rejected' || nextType !== 'fix')) return;
    delete job.continuationFailure;
    try {
      await start({ ...input, modelInput }, job);
    } catch (error: unknown) {
      job.continuationFailure = String(record(error).code || 'host_worker_continuation_failed');
    }
  };
  const start = async (
    { projectRoot, runtimeHome, runId, model, effort, modelInput }: HostWorkerStartInput,
    predecessor: Job | null = null,
  ): Promise<{ runId: string; attemptId: string; stepId: string }> => {
    if (!runId || !model || !effort) throw deny('host_worker_start_fields_missing');
    const ownerRoot = await realpath(projectRoot);
    const runtimeRoot = await realpath(runtimeHome);
    if (within(ownerRoot, runtimeRoot)) throw deny('host_worker_runtime_overlaps_owner');
    const jobKey = key(ownerRoot, runtimeRoot, runId);
    const existing = jobs.get(jobKey);
    const action = record(modelInput.action);
    const step = record(action.step);
    const stepId = typeof step.stepId === 'string' ? step.stepId : '';
    // The canonical next() no longer exposes an executable Step while the
    // Worker is unresolved. Only the owning Host may reattach to its exact
    // Attempt; a different Host cannot turn this block into a fresh start.
    const reconcilingAttemptId = modelInput.status === 'worker-reconciliation-required'
      ? String(modelInput.attemptId || '')
      : null;
    const matches = (session: { stepId: string; attemptId?: string; model: string; effort: string }) => (
      (reconcilingAttemptId
        ? reconcilingAttemptId === session.attemptId
        : stepId === session.stepId)
      && model === session.model && effort === session.effort
    );
    const pending = starting.get(jobKey);
    const previousSettlement = predecessor?.settlement;
    const repairing = previousSettlement?.status === 'candidate-rejected';
    if (predecessor && (existing !== predecessor || (!repairing && previousSettlement?.status !== 'settled')
      || previousSettlement?.next !== modelInput || modelInput.runId !== runId)) {
      throw deny('host_worker_continuation_stale');
    }
    if (existing && !predecessor) {
      if (!matches(existing)) throw deny('host_worker_start_conflict');
      // A retry may resume a stopped settlement on either side of CAS. The live
      // Worker and an in-flight settlement still use the existing handle.
      if (!reconcilingAttemptId || !withWriterExcluded || existing.settlement?.status !== 'blocked') {
        return view(existing);
      }
    }
    if (pending) {
      if (!matches(pending)) throw deny('host_worker_start_conflict');
      return pending.result;
    }
    if (reconcilingAttemptId && !withWriterExcluded) throw deny('host_worker_previous_attempt_unreconciled');
    const executable = repairing ? action.type === 'fix' : action.type === 'implement';
    if (!reconcilingAttemptId && (!executable || !stepId)) {
      throw deny('host_worker_not_implementation_step');
    }
    const launch = async () => {
      // Keep a separate Kernel connection for the Host's actual Worker life.
      // The caller's short-lived MCP control-plane connection may close.
      const cp = await createKernelControlPlane({ projectRoot: ownerRoot, runtimeHome: runtimeRoot, env });
      let owned = false;
      try {
        const run = await cp.getRun(runId);
        const recovery = reconcilingAttemptId ? cp.getPendingHostWorkerDelivery(runId, reconcilingAttemptId) : null;
        if (!run?.projectId || !run.workspaceId
          || (run.status !== 'active' && !(run.status === 'completed' && recovery?.reportCheckpointPending))) {
          throw deny('host_worker_run_not_active');
        }
        if (reconcilingAttemptId) {
          const attempt = cp.getAttemptById(runId, reconcilingAttemptId);
          const beforeCas = attempt?.status === 'started' && attempt.mutationRevision === run.mutationRevision;
          const workspace = attempt?.workspaceId ? cp.stateStore.getProjectWorkspace(attempt.workspaceId) : null;
          if ((!recovery && !beforeCas) || !attempt?.workspaceId || !attempt.resultCommitSha || !attempt.patchDigest
            || !attempt.baseWorkspaceIdentity || !attempt.resultWorkspaceIdentity || !workspace
            || !attempt.changedPaths?.length
            || workspace.projectId !== run.projectId || !within(runtimeRoot, workspace.canonicalRoot)) {
            throw deny('host_worker_previous_attempt_unreconciled');
          }
          const result = await settleHostOwnedWorkerCandidate({
            controlPlane: cp, projectRoot: ownerRoot, runtimeHome: runtimeRoot,
            runId, stepId: attempt.stepId, attemptId: reconcilingAttemptId,
            workspaceId: attempt.workspaceId, workspaceRoot: workspace.canonicalRoot,
            baseWorkspaceIdentity: attempt.baseWorkspaceIdentity,
            resultCommitSha: attempt.resultCommitSha, patchDigest: attempt.patchDigest,
            changedPaths: attempt.changedPaths, resultWorkspaceIdentity: attempt.resultWorkspaceIdentity,
          }, withWriterExcluded);
          if (existing) {
            existing.settlement = result;
            existing.preflight = { status: String(result.status || 'blocked'),
              failureCode: typeof result.failureCode === 'string' ? result.failureCode : null,
              patchDigest: attempt.patchDigest };
            return view(existing);
          }
          return {
            runId, stepId: attempt.stepId, attemptId: reconcilingAttemptId,
            settlement: { status: result.status, failureCode: result.failureCode || null },
          };
        }
        const promptView = buildModelVisiblePromptView({ modelInput });
        if (!promptView.objective || !promptView.currentWork) throw deny('host_worker_contract_missing');
        const prompt = buildModelVisiblePromptMessage({ prompt: promptView });
        if (cp.getCurrentStep(runId)?.stepId !== stepId) throw deny('host_worker_step_changed');
        const authority = record(modelInput.workAuthority);
        const task = record(authority.task);
        const directiveRun = record(authority.run);
        if (task.runId !== runId || directiveRun.runId !== runId
          || task.contractRevision !== run.contractRevision
          || directiveRun.planRevision !== run.planRevision || directiveRun.mutationRevision !== run.mutationRevision) {
          throw deny('host_worker_continuation_stale');
        }
        if (predecessor) {
          const prior = cp.getAttemptById(runId, predecessor.attemptId);
          const matchesRepair = repairing && action.type === 'fix' && prior?.status === 'failed'
            && action.retryAttemptId === prior.attemptId && prior.stepId === stepId
            && prior.failureCategory === 'host-worker-candidate-proof';
          const matchesReport = !repairing && prior?.status === 'passed'
            && JSON.stringify(record(prior.reportResult).next) === JSON.stringify(modelInput);
          if (!prior || (!matchesRepair && !matchesReport)
            || prior.planRevision !== run.planRevision || prior.mutationRevision === null
            || prior.mutationRevision + (repairing ? 0 : 1) !== run.mutationRevision) {
            throw deny('host_worker_continuation_stale');
          }
        } else if (cp.getHostRoutingSnapshot(runId).stepAttempts.length > 0) {
          // A different Host has no authority to reuse the reservation.
          throw deny('host_worker_previous_attempt_unreconciled');
        }
        const head = runGit(ownerRoot, ['rev-parse', 'HEAD']);
        const baseCommit = String(head.stdout || '').trim();
        if (head.error || head.status !== 0 || !/^[a-f\d]{40,64}$/i.test(baseCommit)) {
          throw deny('host_worker_git_head_unavailable');
        }
        if (run.baseCommitSha && run.baseCommitSha !== baseCommit) throw deny('host_worker_base_commit_changed');
        const reservationRoot = path.join(runtimeRoot, 'host-writer-reservations');
        await mkdir(reservationRoot, { recursive: true, mode: 0o700 });
        // The owning Host keeps its single-use Owner reservation across
        // the chain. Each Attempt still reserves a new physical Worktree.
        if (!predecessor) {
          await reserveHostWorkspaceWriter({
            workspaceRoot: ownerRoot, reservationRoot, runId,
            attemptId: 'owner-scope:' + runId, workspaceId: run.workspaceId,
          });
        }
        const attempt = cp.beginAttempt(runId, {
          stepId, provenanceKind: 'host-owned-worker',
          expectedContractRevision: run.contractRevision,
          planRevision: run.planRevision, mutationRevision: run.mutationRevision,
          ...(repairing && predecessor ? { parentAttemptId: predecessor.attemptId, retryReason: 'candidate-proof-failed' } : {}),
        });
        if (!attempt?.attemptId || attempt.stepId !== stepId) throw deny('host_worker_attempt_unavailable');
        const handle = startHostOwnedWritableAttempt({
          controlPlane: cp, repoRoot: ownerRoot, runtimeHome: runtimeRoot,
          reservationRoot, baseCommit, runId, stepId,
          attemptId: attempt.attemptId, prompt, model, effort,
          ...(transportOptions ? { transportOptions } : {}),
        });
        const job: Job = { runId, stepId, attemptId: attempt.attemptId, model, effort, handle, completedTurn: null, resultCandidate: null, resultCaptureStatus: 'not-attempted', resultHandoff: null, preflight: null, settlement: null, turnStatus: 'pending' };
        jobs.set(jobKey, job);
        owned = true;
        void handle.result.then(async (result) => {
          job.turnStatus = result.nativeTurn.turnStatus;
          job.resultCandidate = result.resultCandidate;
          job.resultCaptureStatus = result.resultCaptureStatus;
          job.resultHandoff = result.resultHandoff;
          job.completedTurn = {
            threadId: result.nativeTurn.threadId, turnId: result.nativeTurn.turnId,
            workspaceId: result.workspaceId, turnStatus: result.nativeTurn.turnStatus,
          };
          // A captured Git delta is only an observation. A failed,
          // interrupted or unknown Turn cannot become a verified candidate,
          // even if its final Worktree snapshot happens to apply cleanly.
          if (result.nativeTurn.turnStatus !== 'completed') {
            job.preflight = { status: 'blocked',
              failureCode: 'host_worker_turn_not_completed', patchDigest: null };
            return;
          }
          const candidate = result.resultCandidate;
          if (!candidate || result.resultCaptureStatus !== 'captured') {
            job.preflight = { status: 'blocked',
              failureCode: result.resultCaptureStatus === 'inconsistent'
                ? 'host_worker_snapshot_inconsistent' : 'host_worker_result_unavailable',
              patchDigest: null };
            return;
          }
          if (candidate.outsideStepScope.length > 0 || candidate.ownerApplyCheck !== 'passed') {
            job.preflight = { status: 'blocked', failureCode: 'host_worker_result_scope_or_apply_rejected',
              patchDigest: null };
            return;
          }
          if (result.resultHandoff.status !== 'recorded') {
            job.preflight = { status: 'blocked', failureCode: result.resultHandoff.failureCode, patchDigest: null };
            return;
          }
          job.preflight = { status: 'running', failureCode: null, patchDigest: null };
          const candidateInput = {
            controlPlane: cp, projectRoot: ownerRoot, runtimeHome: runtimeRoot,
            runId, stepId, attemptId: job.attemptId, workspaceId: result.workspaceId,
            workspaceRoot: result.workspaceRoot, baseWorkspaceIdentity: result.baseWorkspaceIdentity,
            resultCommitSha: candidate.resultCommitSha,
            patchDigest: candidate.patchDigest, changedPaths: candidate.changedPaths,
            resultWorkspaceIdentity: candidate.workspaceIdentity,
          };
          const proof = withWriterExcluded
            ? await settleHostOwnedWorkerCandidate(candidateInput, withWriterExcluded)
            : await verifyHostOwnedWorkerCandidate(candidateInput);
          job.preflight = {
            status: String(proof.status || 'blocked'),
            failureCode: typeof proof.failureCode === 'string' ? proof.failureCode : null,
            patchDigest: typeof record(proof.candidate).patchDigest === 'string'
              ? String(record(proof.candidate).patchDigest) : null,
          };
          if (withWriterExcluded) job.settlement = proof;
          await continueJob({ projectRoot: ownerRoot, runtimeHome: runtimeRoot, runId, model, effort }, job);
        }, () => {
          // A failed Host Turn never provides a usable result. Preserve the
          // canonical Attempt for reconciliation, and expose a definite
          // blocked preflight rather than leaving status pending forever.
          job.turnStatus = 'unknown';
          job.preflight = { status: 'blocked', failureCode: 'host_worker_turn_unknown', patchDigest: null };
        }).catch(() => {
          // Failure of the result verification pipeline is distinct from
          // Writer retirement. Neither outcome permits Owner Delivery.
          job.preflight = { status: 'blocked', failureCode: 'host_worker_preflight_unknown', patchDigest: null };
        }).finally(async () => { await cp.close(); }).catch(() => {
          // Closing the Host DB is not an OS Writer termination observation.
        });
        return view(job);
      } finally {
        if (!owned) await cp.close();
      }
    };
    // Install the single-flight entry before the first asynchronous Kernel
    // admission, so duplicate Main requests reuse one canonical Attempt.
    const result = launch();
    starting.set(jobKey, { stepId, model, effort, result,
      ...(reconcilingAttemptId ? { attemptId: reconcilingAttemptId } : {}),
    });
    let started;
    try { started = await result; } finally { starting.delete(jobKey); }
    // The original Host still owns the reservation. Release the recovery
    // single-flight entry before it consumes the recovered canonical next.
    if (reconcilingAttemptId && existing) {
      await continueJob({ projectRoot: ownerRoot, runtimeHome: runtimeRoot, runId, model, effort }, existing);
    }
    return started;
  };
  return {
    assertNativeStartAvailable,
    // The bound local Host owns the directive. A caller may read back an
    // existing Attempt without acquiring authority to launch another Writer.
    async startLocal(input: LocalHostWorkerStartInput) {
      if (![input.runId, input.model, input.effort].every(value => typeof value === 'string' && value.trim())) {
        throw deny('host_worker_start_fields_missing');
      }
      const [ownerRoot, runtimeRoot] = await Promise.all([realpath(input.projectRoot), realpath(input.runtimeHome)]);
      const jobKey = key(ownerRoot, runtimeRoot, input.runId);
      const pending = starting.get(jobKey);
      const existing = jobs.get(jobKey);
      const attached = pending || existing;
      if (attached && (attached.model !== input.model || attached.effort !== input.effort)) {
        throw deny('host_worker_start_conflict');
      }
      if (pending) return pending.result;
      // A repeated local start observes the owning Host. Only a stopped
      // settlement asks Kernel for reconciliation; the active chain uses
      // the next directive already saved in its canonical Report.
      if (existing && existing.settlement?.status !== 'blocked') {
        // A failed successor admission has not consumed the canonical next.
        // Retry that exact continuation, never obtain another directive.
        if (existing.continuationFailure) await continueJob(input, existing);
        return view(jobs.get(jobKey) || existing);
      }
      assertNativeStartAvailable();
      const cp = await createKernelControlPlane({
        projectRoot: ownerRoot, runtimeHome: runtimeRoot, env,
      });
      let modelInput: RecordValue = {};
      let recoveredReport = false;
      try {
        const prior = existing ? cp.getAttemptById(input.runId, existing.attemptId) : null;
        const report = record(prior?.reportResult);
        if (existing && prior?.provenanceKind === 'host-owned-worker' && prior.status === 'passed'
          && prior.stepId === existing.stepId && report.next && typeof report.next === 'object') {
          // The Host may lose the result after Kernel persisted the Report.
          // Recover the saved continuation without reapplying the candidate.
          existing.settlement = { status: 'settled', next: report.next };
          existing.preflight = { status: 'settled', failureCode: null, patchDigest: prior.patchDigest || null };
          recoveredReport = true;
        } else {
          modelInput = record(await cp.next(input.runId));
        }
      } finally {
        await cp.close();
      }
      if (recoveredReport && existing) {
        await continueJob(input, existing);
        return view(jobs.get(jobKey) || existing);
      }
      return start({ ...input, projectRoot: ownerRoot, runtimeHome: runtimeRoot, modelInput });
    },
    start: (input: HostWorkerStartInput) => start(input),
    async status(projectRoot: string, runtimeHome: string, runId: string) {
      const [ownerRoot, runtimeRoot] = await Promise.all([realpath(projectRoot), realpath(runtimeHome)]);
      const job = jobs.get(key(ownerRoot, runtimeRoot, runId));
      return job ? view(job) : null;
    },
    async interrupt(projectRoot: string, runtimeHome: string, runId: string, attemptId: string) {
      const [ownerRoot, runtimeRoot] = await Promise.all([realpath(projectRoot), realpath(runtimeHome)]);
      const job = jobs.get(key(ownerRoot, runtimeRoot, runId));
      if (!job || job.attemptId !== attemptId) {
        return { status: 'not-attached' as const, writerExitVerified: false as const };
      }
      return job.handle.interrupt();
    },
  };
}
