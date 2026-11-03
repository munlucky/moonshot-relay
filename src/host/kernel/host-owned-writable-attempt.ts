// Explicit Host-owned Native Writable Attempt runner.
// This joins existing Kernel identity, physical Worktree isolation and the
// App Server admission boundary. It observes command identities ONLY; model
// Turn completion is not a Worker Outcome, Kernel Report, Delivery or OS exit.

import path from 'node:path';
import { realpath } from 'node:fs/promises';
import type { createKernelControlPlane } from './control-plane-runtime.js';
import {
  createCodexAppServerTransport,
  type CodexAppServerTransportOptions,
  type CodexAppServerTurnResult,
} from './codex-app-server-transport.js';
import type { NativeExecutionObservation, NativeExecutionObserver } from './adapter-dispatch.js';
import { prepareHostWriterAttemptWorktree } from './workspace/physical-worktree.js';

type KernelControlPlane = Awaited<ReturnType<typeof createKernelControlPlane>>;
type KernelWriterAuthority = Pick<
  KernelControlPlane,
  'projectRoot' | 'getRun' | 'getAttemptById' | 'registerExecutionWorkspace' | 'updateStepAttempt'
>;

export interface HostOwnedWritableAttemptInput {
  controlPlane: KernelWriterAuthority;
  repoRoot: string;
  runtimeHome: string;
  reservationRoot: string;
  baseCommit: string;
  runId: string;
  stepId: string;
  attemptId: string;
  prompt: string;
  model: string;
  effort: string;
  turnTimeoutMs?: number;
  onNativeExecution?: NativeExecutionObserver;
  transportOptions?: CodexAppServerTransportOptions;
}

export interface HostOwnedWritableAttemptObservation {
  attemptId: string;
  stepId: string;
  workspaceId: string;
  workspaceRoot: string;
  baseWorkspaceIdentity: string;
  nativeTurn: CodexAppServerTurnResult;
  commandEvents: NativeExecutionObservation[];
  // The only sources of completion/review/Delivery authority are the
  // existing Kernel report, proof verification and Owner CAS paths.
  writerExitVerified: false;
  reportAuthority: 'none';
}

const deny = (code: string): Error & { code: string } => (
  Object.assign(new Error(code), { code })
);
const required = (value: unknown): value is string => (
  typeof value === 'string' && value.trim().length > 0
);
const inside = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return relative === '' || (
    relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)
  );
};

export async function runHostOwnedWritableAttempt({
  controlPlane,
  repoRoot,
  runtimeHome,
  reservationRoot,
  baseCommit,
  runId,
  stepId,
  attemptId,
  prompt,
  model,
  effort,
  turnTimeoutMs,
  onNativeExecution = undefined,
  transportOptions = undefined,
}: HostOwnedWritableAttemptInput): Promise<HostOwnedWritableAttemptObservation> {
  if (![repoRoot, runtimeHome, reservationRoot, baseCommit, runId, stepId, attemptId, prompt, model, effort].every(required)) {
    throw deny('host_writable_attempt_input_missing');
  }
  // The caller cannot redirect this Host to a different Owner repository or
  // put its reservation markers into the Owner's mutable Git tree.
  const ownerRoot = await realpath(repoRoot);
  if (ownerRoot !== await realpath(controlPlane.projectRoot)) {
    throw deny('host_writable_attempt_owner_mismatch');
  }
  if (inside(ownerRoot, await realpath(reservationRoot))) {
    throw deny('host_writable_attempt_reservation_owner_overlap');
  }
  const run = await controlPlane.getRun(runId);
  const attempt = controlPlane.getAttemptById(runId, attemptId);
  if (run?.status !== 'active' || !required(run.projectId)
    || !attempt || attempt.status !== 'started'
    || attempt.runId !== runId || attempt.stepId !== stepId || attempt.attemptId !== attemptId) {
    throw deny('host_writable_attempt_canonical_owner_missing');
  }
  if (run.baseCommitSha && run.baseCommitSha !== baseCommit) {
    throw deny('host_writable_attempt_base_commit_mismatch');
  }
  const prepared = await prepareHostWriterAttemptWorktree({
    repoRoot: ownerRoot,
    runtimeHome,
    baseCommit,
    projectId: run.projectId,
    runId,
    stepId,
    attemptId,
  });
  const registered = controlPlane.registerExecutionWorkspace(runId, prepared.workspaceRoot);
  if (!required(registered.workspaceId)
    || (attempt.workspaceId && attempt.workspaceId !== registered.workspaceId)) {
    throw deny('host_writable_attempt_workspace_mismatch');
  }
  const attached = await controlPlane.updateStepAttempt(String(attempt.id), {
    workspaceId: registered.workspaceId,
    baseWorkspaceIdentity: prepared.baseWorkspaceIdentity,
  });
  const persisted = controlPlane.getAttemptById(runId, attemptId);
  if (attached?.attemptId !== attemptId || persisted?.status !== 'started'
    || persisted.workspaceId !== registered.workspaceId
    || persisted.baseWorkspaceIdentity !== prepared.baseWorkspaceIdentity) {
    throw deny('host_writable_attempt_binding_unverified');
  }

  const commandEvents: NativeExecutionObservation[] = [];
  const transport = await createCodexAppServerTransport({
    ...transportOptions,
    cwd: prepared.workspaceRoot,
  });
  try {
    const currentRun = await controlPlane.getRun(runId);
    const currentAttempt = controlPlane.getAttemptById(runId, attemptId);
    if (currentRun?.status !== 'active'
      || currentAttempt?.status !== 'started'
      || currentAttempt.workspaceId !== registered.workspaceId
      || currentAttempt.baseWorkspaceIdentity !== prepared.baseWorkspaceIdentity) {
      throw deny('host_writable_attempt_authority_changed');
    }
    const nativeTurn = await transport.runTurn({
      cwd: prepared.workspaceRoot,
      prompt,
      model,
      effort,
      ...(turnTimeoutMs === undefined ? {} : { timeoutMs: turnTimeoutMs }),
      executionOwner: { runId, stepId, attemptId, workspaceId: registered.workspaceId },
      onNativeExecution: (observation) => {
        commandEvents.push(observation);
        onNativeExecution?.(observation);
      },
      writableWorker: { reservationRoot },
    });
    return {
      attemptId,
      stepId,
      workspaceId: registered.workspaceId,
      workspaceRoot: prepared.workspaceRoot,
      baseWorkspaceIdentity: prepared.baseWorkspaceIdentity,
      nativeTurn,
      commandEvents,
      writerExitVerified: false,
      reportAuthority: 'none',
    };
  } finally {
    // App Server process exit is not evidence that OS Writer descendants exited.
    await transport.close();
  }
}
