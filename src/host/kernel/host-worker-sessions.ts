// Process-local Host control for the existing Kernel MCP surface.
// Canonical Run/Step/Attempt, not this map, retain work and completion authority.
import path from 'node:path';
import { mkdir, realpath } from 'node:fs/promises';
import { createKernelControlPlane } from './control-plane-runtime.js';
import { startHostOwnedWritableAttempt, type HostOwnedWritableAttemptHandle } from './host-owned-writable-attempt.js';
import { reserveHostWorkspaceWriter } from './workspace-writer-reservation.js';
import { buildModelVisiblePromptMessage, buildModelVisiblePromptView } from './model-capsule-view.js';
import { runGit } from '../../shared/git-safe.js';
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
const deny = (code: string): Error & { code: string } => Object.assign(new Error(code), { code });
const record = (value: unknown): RecordValue => value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
const within = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
};

export function createHostWorkerSessions({
  transportOptions = undefined,
}: { transportOptions?: CodexAppServerTransportOptions } = {}) {
  const jobs = new Map<string, Job>();
  const starting = new Map<string, { stepId: string; model: string; effort: string; result: Promise<{runId: string; attemptId: string; stepId: string}> }>();
  const key = (root: string, runId: string) => JSON.stringify([root, runId]);
  const view = (job: Job) => ({
    runId: job.runId,
    stepId: job.stepId,
    attemptId: job.attemptId,
    state: job.handle.observe().state,
    nativeTurn: job.handle.observe().nativeTurn,
    turnStatus: job.turnStatus,
    completedTurn: job.completedTurn,
    writerExitVerified: false as const,
    deliveryAuthorized: false as const,
  });
  return {
    async start({ projectRoot, runtimeHome, runId, model, effort, modelInput }: HostWorkerStartInput) {
      if (!runId || !model || !effort) throw deny('host_worker_start_fields_missing');
      const ownerRoot = await realpath(projectRoot);
      const runtimeRoot = await realpath(runtimeHome);
      if (within(ownerRoot, runtimeRoot)) throw deny('host_worker_runtime_overlaps_owner');
      const jobKey = key(ownerRoot, runId);
      const existing = jobs.get(jobKey);
      const action = record(modelInput.action);
      const step = record(action.step);
      const stepId = typeof step.stepId === 'string' ? step.stepId : '';
      const pending = starting.get(jobKey);
      if (pending) {
        if (stepId !== pending.stepId || model !== pending.model || effort !== pending.effort) {
          throw deny('host_worker_start_conflict');
        }
        return pending.result;
      }
      if (existing) {
        if (stepId !== existing.stepId || model !== existing.model || effort !== existing.effort) {
          throw deny('host_worker_start_conflict');
        }
        return view(existing);
      }
      if (action.type !== 'implement' || !stepId) {
        throw deny('host_worker_not_implementation_step');
      }
      const launch = async () => {
        const promptView = buildModelVisiblePromptView({ modelInput });
        if (!promptView.objective || !promptView.currentWork) throw deny('host_worker_contract_missing');
        const prompt = buildModelVisiblePromptMessage({ prompt: promptView });
        // Keep a separate Kernel connection for the Host's actual Worker life.
        // The caller's short-lived MCP control-plane connection may close.
        const cp = await createKernelControlPlane({ projectRoot: ownerRoot, runtimeHome: runtimeRoot });
        let owned = false;
        try {
          const run = await cp.getRun(runId);
          if (run?.status !== 'active' || !run.projectId || !run.workspaceId) throw deny('host_worker_run_not_active');
          if (cp.getCurrentStep(runId)?.stepId !== stepId) throw deny('host_worker_step_changed');
          // Even a terminal DB Attempt might have a live detached OS Writer.
          // Until physical exclusion is proven, no automatic second Attempt.
          if (cp.getHostRoutingSnapshot(runId).stepAttempts.length > 0) {
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
          // Reserve the Owner mutation scope BEFORE opening the Attempt. Shared
          // Host instances using this Runtime Home cannot start a second Writer.
          await reserveHostWorkspaceWriter({
            workspaceRoot: ownerRoot, reservationRoot, runId,
            attemptId: 'owner-scope:' + runId, workspaceId: run.workspaceId,
          });
          const attempt = cp.beginAttempt(runId, { stepId, provenanceKind: 'host-owned-worker' });
          if (!attempt?.attemptId || attempt.stepId !== stepId) throw deny('host_worker_attempt_unavailable');
          const handle = startHostOwnedWritableAttempt({
            controlPlane: cp, repoRoot: ownerRoot, runtimeHome: runtimeRoot,
            reservationRoot, baseCommit, runId, stepId,
            attemptId: attempt.attemptId, prompt, model, effort,
            ...(transportOptions ? { transportOptions } : {}),
          });
          const job: Job = { runId, stepId, attemptId: attempt.attemptId, model, effort, handle, completedTurn: null, turnStatus: 'pending' };
          jobs.set(jobKey, job);
          owned = true;
          void handle.result.then((result) => {
            job.turnStatus = result.nativeTurn.turnStatus;
            job.completedTurn = {
              threadId: result.nativeTurn.threadId, turnId: result.nativeTurn.turnId,
              workspaceId: result.workspaceId, turnStatus: result.nativeTurn.turnStatus,
            };
          }, () => {
            job.turnStatus = 'unknown';
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
      starting.set(jobKey, { stepId, model, effort, result });
      try { return await result; } finally { starting.delete(jobKey); }
    },
    async status(projectRoot: string, runId: string) {
      const job = jobs.get(key(await realpath(projectRoot), runId));
      return job ? view(job) : null;
    },
    async interrupt(projectRoot: string, runId: string, attemptId: string) {
      const job = jobs.get(key(await realpath(projectRoot), runId));
      if (!job || job.attemptId !== attemptId) {
        return { status: 'not-attached' as const, writerExitVerified: false as const };
      }
      return job.handle.interrupt();
    },
  };
}
