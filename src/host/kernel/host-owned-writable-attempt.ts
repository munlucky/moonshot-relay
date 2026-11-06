// Explicit Host-owned Native Writable Attempt runner.
// This joins existing Kernel identity, physical Worktree isolation and the
// App Server admission boundary. Model claims are bound to measured Git and
// canonical identity; Turn completion is not Kernel Report, Delivery or OS exit.

import path from 'node:path';
import { realpath } from 'node:fs/promises';
import type { createKernelControlPlane } from './control-plane-runtime.js';
import {
  createCodexAppServerTransport,
  type CodexAppServerTransport,
  type CodexAppServerInterruptResult,
  type CodexAppServerTurnObservation,
  type CodexAppServerTransportOptions,
  type CodexAppServerTurnResult,
} from './codex-app-server-transport.js';
import type { NativeExecutionObservation, NativeExecutionObserver } from './adapter-dispatch.js';
import { prepareHostWriterAttemptWorktree, snapshotHostWorkerPatch } from './workspace/physical-worktree.js';
import { runGit } from '../../shared/git-safe.js';
import { matchPathScope } from '../../shared/path-scope.js';
import { Ajv } from 'ajv';
import { CODEX_WORKER_OUTPUT_SCHEMA } from './adapters/codex.js';
import { sanitizePersistentPayload, sanitizePersistentText } from '../../shared/persistent-sanitizer.js';
import { observeWorkspaceIdentity } from './workspace/workspace-identity.js';

type KernelControlPlane = Awaited<ReturnType<typeof createKernelControlPlane>>;
type KernelWriterAuthority = Pick<
  KernelControlPlane,
  'projectRoot' | 'getRun' | 'getRunSteps' | 'getRunObligations' | 'discoverProjectCommands'
  | 'getAttemptById' | 'registerExecutionWorkspace' | 'updateStepAttempt' | 'recordStepResult'
>;
const validateWorkerOutput = new Ajv({ strict: false }).compile<Record<string, unknown>>(CODEX_WORKER_OUTPUT_SCHEMA);

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
  // Host-only, process-local control while this exact Attempt is running.
  // The handle is not durable and cannot prove OS Writer termination.
  onHostControl?: (control: Pick<CodexAppServerTransport, 'observeTurn' | 'interruptActiveTurn'>) => void;
}

export interface HostOwnedWritableAttemptObservation {
  attemptId: string;
  stepId: string;
  workspaceId: string;
  workspaceRoot: string;
  baseWorkspaceIdentity: string;
  nativeTurn: CodexAppServerTurnResult;
  commandEvents: NativeExecutionObservation[];
  // A read-only snapshot of Worktree changes. This is not a Delivery receipt:
  // an unretired OS descendant may continue writing afterwards.
  resultCandidate: {
    changedPaths: string[];
    outsideStepScope: string[];
    workspaceIdentity: string;
    patchDigest: string;
    resultCommitSha: string;
    ownerApplyCheck: 'passed' | 'failed';
    writerExitVerified: false;
    deliveryAuthorized: false;
  } | null;
  resultCaptureStatus: 'not-attempted' | 'captured' | 'inconsistent';
  // Durable observation of this exact candidate and model claim. The Attempt
  // stays started and no Owner mutation provenance or proof is created.
  resultHandoff: { status: 'recorded' | 'blocked'; failureCode: string | null };
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

export function runHostOwnedWritableAttempt(input: HostOwnedWritableAttemptInput): Promise<HostOwnedWritableAttemptObservation> {
  return executeHostOwnedWritableAttempt(input, []);
}

async function executeHostOwnedWritableAttempt({
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
  onHostControl = undefined,
}: HostOwnedWritableAttemptInput, commandEvents: NativeExecutionObservation[]): Promise<HostOwnedWritableAttemptObservation> {
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
  const ownerSnapshot = await snapshotHostWorkerPatch({ workspaceRoot: ownerRoot, runtimeHome });
  if (ownerSnapshot.workspaceIdentity !== run.currentWorkspaceIdentity) {
    throw deny('host_writable_attempt_owner_baseline_changed');
  }
  const resultBaseCommit = ownerSnapshot.resultCommitSha || baseCommit;
  const prepared = await prepareHostWriterAttemptWorktree({
    repoRoot: ownerRoot,
    runtimeHome,
    baseCommit,
    projectId: run.projectId,
    runId,
    stepId,
    attemptId,
    ownerSnapshot,
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
      // Bind cancellation after the transport marks this exact Turn active.
      // An early Main signal is queued until turn/start yields its identity.
      onReady: () => onHostControl?.({
        observeTurn: () => transport.observeTurn(),
        interruptActiveTurn: () => transport.interruptActiveTurn(),
      }),
      cwd: prepared.workspaceRoot,
      prompt,
      model,
      effort,
      outputSchema: CODEX_WORKER_OUTPUT_SCHEMA,
      ...(turnTimeoutMs === undefined ? {} : { timeoutMs: turnTimeoutMs }),
      executionOwner: { runId, stepId, attemptId, workspaceId: registered.workspaceId },
      onNativeExecution: (observation) => {
        commandEvents.push(observation);
        onNativeExecution?.(observation);
      },
      writableWorker: { reservationRoot },
    });
    // Inspect actual Git changes rather than trusting the model Turn text.
    // This is a candidate only: even a completed Turn does not prove a
    // detached command or grandchild can no longer mutate this Worktree.
    const step = controlPlane.getRunSteps(runId).find((item) => item.stepId === stepId);
    let snapshot: Awaited<ReturnType<typeof snapshotHostWorkerPatch>> | null = null;
    let resultCaptureStatus: HostOwnedWritableAttemptObservation['resultCaptureStatus'] = 'not-attempted';
    if (nativeTurn.turnStatus === 'completed') {
      try {
        snapshot = await snapshotHostWorkerPatch({
          workspaceRoot: prepared.workspaceRoot, runtimeHome, baseCommit: resultBaseCommit,
        });
        resultCaptureStatus = 'captured';
      } catch (error) {
        // The old OS Writer can outlive a completed model Turn. A racing
        // snapshot is not an execution failure or a verified result: leave
        // the Attempt started and explicitly mark its readback inconsistent.
        if ((error as { code?: string }).code !== 'host_worker_snapshot_workspace_changed') throw error;
        resultCaptureStatus = 'inconsistent';
      }
    }
    const changedPaths = snapshot?.changedPaths || [];
    const allowedPaths = step?.allowedPaths || [];
    const forbiddenPaths = step?.forbiddenPaths || [];
    const patch = snapshot?.patch || null;
    const check = patch ? runGit(ownerRoot, ['apply', '--check', '--binary', '-'], {
      input: patch, maxBuffer: 64 * 1024 * 1024,
    }) : null;
    const resultCandidate = snapshot && changedPaths.length > 0
      ? {
          changedPaths,
          outsideStepScope: changedPaths.filter((file) => (
            !matchPathScope(file, allowedPaths) || (forbiddenPaths.length > 0 && matchPathScope(file, forbiddenPaths))
          )),
          workspaceIdentity: snapshot.workspaceIdentity,
          patchDigest: snapshot.patchDigest,
          resultCommitSha: snapshot.resultCommitSha!,
          ownerApplyCheck: check?.status === 0 && !check.error ? 'passed' as const : 'failed' as const,
          writerExitVerified: false as const,
          deliveryAuthorized: false as const,
        }
      : null;
    let resultHandoff: HostOwnedWritableAttemptObservation['resultHandoff'] = {
      status: 'blocked', failureCode: 'host_worker_turn_not_completed',
    };
    if (nativeTurn.turnStatus === 'completed') {
      try {
        if (!resultCandidate || resultCandidate.outsideStepScope.length > 0
          || resultCandidate.ownerApplyCheck !== 'passed') throw deny('host_worker_result_scope_or_apply_rejected');
        if (!nativeTurn.finalMessage) throw deny('host_worker_report_missing');
        let output: unknown;
        try { output = JSON.parse(nativeTurn.finalMessage); }
        catch { throw deny('host_worker_report_invalid'); }
        if (!validateWorkerOutput(output)) throw deny('host_worker_report_invalid');
        if (output.status !== 'completed' || output.blocker !== null || !String(output.summary).trim()) {
          throw deny('host_worker_report_not_completed');
        }
        // Use the established schema, but compare paths and command bindings
        // with observed Git and Kernel authority before persisting the claim.
        const reportedPaths = output.changedPaths as string[];
        if (new Set(reportedPaths).size !== reportedPaths.length
          || JSON.stringify([...reportedPaths].sort()) !== JSON.stringify(changedPaths)) {
          throw deny('host_worker_report_paths_mismatch');
        }
        const obligations = controlPlane.getRunObligations(runId);
        const manifest = new Set(controlPlane.discoverProjectCommands().map(item => item.commandRef));
        const verifications = output.verifications as Array<Record<string, unknown>>;
        if (verifications.length === 0 || verifications.some(request => {
          const obligation = obligations.find(item => item.obligationId === request.obligationId);
          return !obligation || obligation.evidenceClass !== 'hard'
            || !(step?.obligationIds || []).includes(obligation.obligationId)
            || !obligation.allowedCommandRefs.includes(String(request.commandRef))
            || !manifest.has(String(request.commandRef))
            || (request.acceptanceCoverage as string[]).some(id => !obligation.acceptanceIds.includes(id));
        })) throw deny('host_worker_report_verification_unbound');
        const currentRun = await controlPlane.getRun(runId);
        const currentAttempt = controlPlane.getAttemptById(runId, attemptId);
        const currentStep = controlPlane.getRunSteps(runId).find(item => item.stepId === stepId);
        if (!currentRun || currentRun.status !== 'active'
          || currentRun.contractRevision !== run.contractRevision || currentRun.planRevision !== run.planRevision
          || currentRun.mutationRevision !== run.mutationRevision
          || currentRun.currentWorkspaceIdentity !== run.currentWorkspaceIdentity
          || !currentStep || currentStep.planRevision !== run.planRevision || currentStep.state !== 'running'
          || !currentAttempt || currentAttempt.status !== 'started' || currentAttempt.provenanceKind !== 'host-owned-worker'
          || currentAttempt.planRevision !== run.planRevision || currentAttempt.mutationRevision !== run.mutationRevision
          || currentAttempt.workspaceId !== registered.workspaceId
          || currentAttempt.baseWorkspaceIdentity !== prepared.baseWorkspaceIdentity
          || observeWorkspaceIdentity({ projectRoot: ownerRoot }).identity !== run.currentWorkspaceIdentity
          || observeWorkspaceIdentity({ projectRoot: prepared.workspaceRoot }).identity !== resultCandidate.workspaceIdentity) {
          throw deny('host_worker_result_lineage_changed');
        }
        const workerReport = sanitizePersistentPayload({
          summary: output.summary, changedPaths, risks: output.risks, verifications,
          judgments: output.judgments, knowledgeObservations: output.knowledgeObservations,
          stepId, attemptId, planRevision: run.planRevision, contractRevision: run.contractRevision,
          workspaceId: registered.workspaceId,
          bindingId: currentAttempt.bindingId, capsuleId: currentAttempt.capsuleId,
          actorSessionId: currentAttempt.actorSessionId,
          baseResultCommitSha: resultBaseCommit,
          baseOwnerIndexDigest: ownerSnapshot.indexDigest,
        });
        controlPlane.recordStepResult(runId, stepId, {
          attemptId, executionWorkspaceId: registered.workspaceId,
          expectedContractRevision: run.contractRevision,
          mutationRevision: run.mutationRevision,
          resultWorkspaceIdentity: resultCandidate.workspaceIdentity,
          resultCommitSha: resultCandidate.resultCommitSha, patchDigest: resultCandidate.patchDigest,
          changedPaths, workerReport, recordMutationProvenance: false,
        });
        const receipt = controlPlane.getAttemptById(runId, attemptId);
        if (receipt?.resultCommitSha !== resultCandidate.resultCommitSha
          || receipt.patchDigest !== resultCandidate.patchDigest
          || receipt.resultWorkspaceIdentity !== resultCandidate.workspaceIdentity
          || JSON.stringify(receipt.changedPaths) !== JSON.stringify(changedPaths)
          || JSON.stringify(receipt.workerReport) !== JSON.stringify(workerReport)) {
          throw deny('host_worker_result_persistence_failed');
        }
        resultHandoff = { status: 'recorded', failureCode: null };
      } catch (error) {
        resultHandoff = { status: 'blocked', failureCode: (error as { code?: string }).code || 'host_worker_result_handoff_failed' };
      }
    }
    return {
      attemptId,
      stepId,
      workspaceId: registered.workspaceId,
      workspaceRoot: prepared.workspaceRoot,
      baseWorkspaceIdentity: prepared.baseWorkspaceIdentity,
      nativeTurn,
      commandEvents,
      resultCandidate,
      resultCaptureStatus,
      resultHandoff,
      writerExitVerified: false,
      reportAuthority: 'none',
    };
  } finally {
    // App Server process exit is not evidence that OS Writer descendants exited.
    await transport.close();
  }
}

export interface HostOwnedWritableAttemptHandle {
  runId: string;
  attemptId: string;
  // Settling this Promise proves only the result of the model Turn, not Delivery.
  result: Promise<HostOwnedWritableAttemptObservation>;
  observe(): {
    state: 'starting' | 'turn-running' | 'turn-settled' | 'unknown';
    nativeTurn: CodexAppServerTurnObservation | null;
    commandEventReadback: {
      scope: 'current-host-attempt';
      observedCount: number;
      omittedCount: number;
      events: NativeExecutionObservation[];
    };
    writerExitVerified: false;
  };
  interrupt(): Promise<CodexAppServerInterruptResult>;
}

/**
 * Start an existing Kernel Attempt without tying its lifetime to the calling
 * Main request. This handle lives only in the owning Host process. After a
 * Host crash the Canonical Attempt remains authoritative and unobserved;
 * the caller must never infer a safe retry from the lost in-memory handle.
 */
export function startHostOwnedWritableAttempt(
  input: HostOwnedWritableAttemptInput,
): HostOwnedWritableAttemptHandle {
  let nativeControl: Pick<CodexAppServerTransport, 'observeTurn' | 'interruptActiveTurn'> | null = null;
  let cancelQueued = false;
  let state: 'starting' | 'turn-running' | 'turn-settled' | 'unknown' = 'starting';
  const commandEvents: NativeExecutionObservation[] = [];
  const result = executeHostOwnedWritableAttempt({
    ...input,
    onHostControl: (control) => {
      nativeControl = control;
      state = 'turn-running';
      if (cancelQueued) void control.interruptActiveTurn();
      input.onHostControl?.(control);
    },
  }, commandEvents).then((value) => {
    state = 'turn-settled';
    return value;
  }, (error: unknown) => {
    state = 'unknown';
    throw error;
  });
  // A Main may disconnect without awaiting result. Keep the rejection handled
  // while leaving the original Promise for an attached Host to inspect.
  void result.catch(() => undefined);
  return {
    runId: input.runId,
    attemptId: input.attemptId,
    result,
    observe: () => {
      // This is a bounded projection of observed command identities from the
      // current Attempt. Provider output and the full transcript stay outside it.
      const events = commandEvents.slice(-32).map(event => ({
        ...event,
        threadId: sanitizePersistentText(event.threadId),
        turnId: sanitizePersistentText(event.turnId),
        itemId: sanitizePersistentText(event.itemId),
        processId: event.processId === null ? null : sanitizePersistentText(event.processId),
      }));
      return {
        state,
        nativeTurn: nativeControl?.observeTurn() || null,
        commandEventReadback: {
          scope: 'current-host-attempt',
          observedCount: commandEvents.length,
          omittedCount: commandEvents.length - events.length,
          events,
        },
        writerExitVerified: false,
      };
    },
    interrupt: () => {
      if (state === 'starting') {
        cancelQueued = true;
        return Promise.resolve({ status: 'queued' as const, writerExitVerified: false as const });
      }
      return nativeControl?.interruptActiveTurn()
        || Promise.resolve({ status: 'not-addressable' as const, writerExitVerified: false as const });
    },
  };
}
