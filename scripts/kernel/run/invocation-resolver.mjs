import { canonicalizeHostSessionId } from './host-session.mjs';
import { createOpaqueRunId } from './run-identity.mjs';
import { normalizeTaskContract } from '../task/task-contract.mjs';
import { classifyContractChange } from '../change-contract.mjs';

export const NEW_TASK_INVOCATION_INTENT = 'new-task';

const codedError = (code, nextAction, details = {}) => Object.assign(new Error(code), {
  code,
  errorCode: code,
  nextAction,
  ...(Object.keys(details).length > 0 ? { details } : {}),
});

const resolveInvocationIntent = ({ taskContract, invocationIntent, intent }) => {
  const requested = invocationIntent || intent || taskContract?.invocationIntent || taskContract?.intent || null;
  if (!requested) return null;
  if (requested === NEW_TASK_INVOCATION_INTENT) return requested;
  throw codedError('invocation_intent_invalid', 'use-supported-invocation-intent', {
    invocationIntent: requested,
    supported: [NEW_TASK_INVOCATION_INTENT],
  });
};

const runHolder = (run) => run ? {
  runId: run.runId,
  projectId: run.projectId || null,
  workspaceId: run.workspaceId || null,
  worktreeId: run.worktreeId || null,
  status: run.status || null,
  blockedReason: run.blockedReason || null,
} : null;

const worktreeConflictDetails = ({ projectId, worktreeId, mutableRuns, worktreeLease, reason }) => ({
  projectId,
  worktreeId: worktreeId || null,
  holderRunId: mutableRuns[0]?.runId || worktreeLease?.holderRunId || null,
  holder: runHolder(mutableRuns[0]),
  holders: mutableRuns.map(runHolder),
  lease: worktreeLease ? {
    worktreeId: worktreeLease.worktreeId || worktreeId || null,
    projectId: worktreeLease.projectId || projectId,
    holderRunId: worktreeLease.holderRunId || null,
    acquiredAt: worktreeLease.acquiredAt || null,
  } : null,
  reason,
});

const normalizedContract = (taskContract) => {
  if (!taskContract || Object.keys(taskContract).length === 0) return null;
  if (taskContract.schemaVersion === 1 && taskContract.digest) return taskContract;
  return normalizeTaskContract(taskContract, {
    objective: taskContract.objective || 'Kernel execution task',
  });
};

const normalizeObjective = (value) => String(value || '')
  .toLowerCase()
  .trim()
  .replace(/\s+/g, ' ');

const isSameGoalIdentity = ({ existingRun, contract, binding, requestedRunId }) => {
  if (!existingRun) return false;
  if (requestedRunId && requestedRunId === existingRun.runId) return true;
  if (contract?.predecessorRunId && contract.predecessorRunId === existingRun.runId) return true;
  if (contract?.seedProvenance?.predecessorRunId && contract.seedProvenance.predecessorRunId === existingRun.runId) return true;
  // A missing objective is not evidence of continuity. Treating it as a
  // wildcard silently absorbs a stale Run when a new task arrives with a
  // legacy/incomplete contract; only an explicit Run ID or predecessor link
  // may bypass this identity check.
  if (!contract?.objective) return false;

  const existingNorm = normalizeObjective(existingRun.objective);
  const nextNorm = normalizeObjective(contract.objective);
  if (existingNorm && nextNorm && existingNorm === nextNorm) return true;

  if (existingRun.taskContract?.seedProvenance?.seedId && contract.seedProvenance?.seedId
    && existingRun.taskContract.seedProvenance.seedId === contract.seedProvenance.seedId) {
    return true;
  }

  return false;
};

export const resolveBoundInvocation = ({
  stateStore,
  projectId,
  provider,
  sessionId,
  workspaceId,
  worktreeId = null,
  explicitRunId = null,
  envRunId = null,
  taskContract = null,
  invocationIntent = null,
  intent = null,
  observedWorkspaceIdentity = null,
} = {}) => {
  if (!stateStore || !projectId || (!worktreeId && !workspaceId)) {
    throw codedError('host_binding_missing', 'reopen-from-correct-worktree');
  }
  const canonicalSessionId = sessionId
    ? canonicalizeHostSessionId({ provider, sessionId })
    : null;
  if (sessionId && canonicalSessionId !== sessionId) {
    throw codedError('provider_session_invalid', 'reopen-from-correct-worktree');
  }
  const contract = normalizedContract(taskContract);
  const resolvedIntent = resolveInvocationIntent({ taskContract, invocationIntent, intent });
  const isNewTask = resolvedIntent === NEW_TASK_INVOCATION_INTENT;
  const requestedRunId = explicitRunId || envRunId || null;
  const registeredWorkspace = workspaceId
    ? stateStore.getProjectWorkspace?.(workspaceId) || null
    : null;
  const effectiveWorktreeId = worktreeId || registeredWorkspace?.worktreeId || null;
  const binding = canonicalSessionId
    ? stateStore.getActiveOwnerBinding({
        projectId,
        sessionId: canonicalSessionId,
        workspaceId,
      })
    : null;

  const assertRunBinding = (run) => {
    if (run.projectId !== projectId) {
      throw codedError('run_project_mismatch', 'relaunch-from-bound-project');
    }
    if (run.worktreeId) {
      if (!effectiveWorktreeId || run.worktreeId !== effectiveWorktreeId) {
        throw codedError('run_worktree_mismatch', 'return-to-bound-worktree');
      }
    } else if (run.workspaceId && run.workspaceId !== workspaceId) {
      // Legacy Runs remain addressable through workspaceId, but a workspace-*
      // compatibility id is never compared directly with a worktree-* id.
      throw codedError('run_workspace_mismatch', 'return-to-bound-workspace');
    }
    return run;
  };

  const candidateRuns = typeof stateStore.listRuns === 'function'
    ? stateStore.listRuns({
        projectId,
        ...(effectiveWorktreeId ? { worktreeId: effectiveWorktreeId } : { workspaceId }),
        statuses: ['active', 'blocked'],
      })
    : typeof stateStore.listActiveRuns === 'function'
      ? stateStore.listActiveRuns({
          projectId,
          ...(effectiveWorktreeId ? { worktreeId: effectiveWorktreeId } : { workspaceId }),
        })
      : [];
  let worktreeLease = effectiveWorktreeId && typeof stateStore.getWorktreeMutationLease === 'function'
    ? stateStore.getWorktreeMutationLease(effectiveWorktreeId)
    : null;
  let mutableRuns = candidateRuns.filter((run) => run.status === 'active'
    || (run.status === 'blocked'
      && worktreeLease?.projectId === projectId
      && worktreeLease?.holderRunId === run.runId));

  const shouldAbandonBlockedRuns = mutableRuns.length > 0
    && mutableRuns.every((run) => run.status === 'blocked')
    && (
      isNewTask
      || (contract && !requestedRunId && !binding?.runId && mutableRuns.every((run) => !isSameGoalIdentity({ existingRun: run, contract, binding, requestedRunId })))
    );

  if (shouldAbandonBlockedRuns) {
    for (const run of mutableRuns) {
      if (typeof stateStore.abandonRun === 'function') {
        stateStore.abandonRun(run.runId, { reason: 'superseded-and-archived-for-new-task' });
      }
    }
    mutableRuns = [];
    worktreeLease = effectiveWorktreeId && typeof stateStore.getWorktreeMutationLease === 'function'
      ? stateStore.getWorktreeMutationLease(effectiveWorktreeId)
      : null;
  }

  if (mutableRuns.length > 1) {
    throw codedError(
      'worktree_run_conflict',
      'resolve-conflicting-active-runs',
      worktreeConflictDetails({
        projectId,
        worktreeId: effectiveWorktreeId,
        mutableRuns,
        worktreeLease,
        reason: 'multiple-mutable-worktree-runs',
      }),
    );
  }
  let mutableRun = mutableRuns[0] || null;
  const requestedRun = requestedRunId ? stateStore.getRun(requestedRunId) : null;
  if (requestedRun) assertRunBinding(requestedRun);

  if (isNewTask && mutableRun) {
    throw codedError(
      'worktree_run_conflict',
      'resume-the-worktree-bound-run',
      worktreeConflictDetails({
        projectId,
        worktreeId: effectiveWorktreeId,
        mutableRuns,
        worktreeLease,
        reason: 'new-task-cannot-revise-mutable-run',
      }),
    );
  }

  if (requestedRunId && mutableRun && requestedRunId !== mutableRun.runId) {
    throw codedError(
      'worktree_run_conflict',
      'resume-the-worktree-bound-run',
      worktreeConflictDetails({
        projectId,
        worktreeId: effectiveWorktreeId,
        mutableRuns,
        worktreeLease,
        reason: 'requested-run-is-not-worktree-holder',
      }),
    );
  }

  const latestRun = typeof stateStore.getLatestRunForWorktree === 'function'
    ? stateStore.getLatestRunForWorktree({
        projectId,
        ...(effectiveWorktreeId ? { worktreeId: effectiveWorktreeId } : { workspaceId }),
      })
    : null;
  const boundRun = binding?.runId ? stateStore.getRun(binding.runId) : null;
  const compatibleBoundRun = boundRun
    ? (() => {
        try { return assertRunBinding(boundRun); } catch { return null; }
      })()
    : null;
  if (
    requestedRunId
    && !requestedRun
    && compatibleBoundRun?.status === 'active'
    && compatibleBoundRun.runId !== requestedRunId
  ) {
    throw codedError(
      'worktree_run_conflict',
      'resume-the-worktree-bound-run',
      worktreeConflictDetails({
        projectId,
        worktreeId: effectiveWorktreeId,
        mutableRuns,
        worktreeLease,
        reason: 'requested-run-is-not-session-holder',
      }),
    );
  }
  // A new task is allowed to start only after the mutable owner is absent.
  // Historical blocked Runs without a lease are not mutable owners and must
  // not become an implicit resume/revise cursor for the new task, while a
  // completed or abandoned cursor still carries the normal successor lineage.
  const newTaskCursor = isNewTask
    ? [latestRun, compatibleBoundRun].find((run) => run?.status === 'completed' || run?.status === 'abandoned') || null
    : latestRun || compatibleBoundRun;
  let cursorRun = requestedRun || mutableRun || newTaskCursor;

  if (cursorRun && !requestedRunId && !binding?.runId && contract) {
    if (!isSameGoalIdentity({ existingRun: cursorRun, contract, binding, requestedRunId })) {
      if (cursorRun.status === 'blocked') {
        if (typeof stateStore.abandonRun === 'function' && worktreeLease?.holderRunId === cursorRun.runId) {
          stateStore.abandonRun(cursorRun.runId, { reason: 'superseded-and-archived-for-new-task' });
          worktreeLease = null;
        }
        cursorRun = null;
      }
    }
  }

  if (!cursorRun) {
    if (!contract) throw codedError('host_binding_missing', 'supply-a-task-contract');
    return {
      mode: 'create',
      runId: requestedRunId || createOpaqueRunId(),
      predecessorRunId: null,
      binding: null,
      reason: 'no-worktree-cursor',
      taskContract: contract,
      changeClass: null,
    };
  }
  assertRunBinding(cursorRun);
  const cursorBinding = binding?.runId === cursorRun.runId ? binding : null;

  if (cursorRun.status === 'active' || cursorRun.status === 'blocked') {
    const revised = Boolean(contract && cursorRun.taskContract?.digest !== contract.digest);
    return {
      mode: revised ? 'revise' : 'resume',
      runId: cursorRun.runId,
      predecessorRunId: null,
      binding: cursorBinding,
      reason: revised
        ? 'worktree-run-contract-changed'
        : cursorRun.status === 'blocked' ? 'blocked-worktree-run' : 'active-worktree-run',
      taskContract: contract,
      changeClass: contract ? classifyContractChange({ previous: cursorRun.taskContract, next: contract }) : null,
    };
  }

  if (cursorRun.status === 'completed') {
    if (cursorRun.finalizationStatus !== 'completed') {
      return {
        mode: 'finalization-retry',
        runId: cursorRun.runId,
        predecessorRunId: null,
        binding: cursorBinding,
        reason: 'completed-run-finalization-incomplete',
        taskContract: contract,
        changeClass: contract ? classifyContractChange({ previous: cursorRun.taskContract, next: contract }) : null,
      };
    }
    // Explicit recovery starts a fresh proof baseline; never rewrite the
    // completed Run or claim continuity across an externally changed checkout.
    if (isNewTask && !requestedRunId && contract
      && observedWorkspaceIdentity
      && taskContract?.workspaceRecovery?.acknowledgedIdentity === observedWorkspaceIdentity
      && cursorRun.currentWorkspaceIdentity !== observedWorkspaceIdentity) {
      return {
        mode: 'create', runId: createOpaqueRunId(), predecessorRunId: null,
        binding: null, reason: 'user-acknowledged-new-workspace-baseline',
        taskContract: contract, changeClass: null,
      };
    }
    if (!isNewTask && (!contract || cursorRun.taskContract?.digest === contract.digest)) {
      return {
        mode: 'done',
        runId: cursorRun.runId,
        predecessorRunId: null,
        binding: cursorBinding,
        reason: contract ? 'same-contract-already-complete' : 'no-new-task-contract',
        taskContract: contract,
        changeClass: null,
      };
    }
    return {
      mode: 'successor',
      runId: createOpaqueRunId(),
      predecessorRunId: cursorRun.runId,
      binding: cursorBinding,
      reason: 'new-contract-after-completed-finalization',
      taskContract: contract,
      changeClass: classifyContractChange({ previous: cursorRun.taskContract, next: contract }),
    };
  }

  if (cursorRun.status === 'abandoned') {
    if (!contract) {
      throw codedError('no_active_run', 'supply-a-task-contract');
    }
    return {
      mode: 'create',
      runId: requestedRunId || createOpaqueRunId(),
      predecessorRunId: null,
      binding: null,
      reason: 'new-run-after-abandon',
      taskContract: contract,
      changeClass: null,
    };
  }

  throw codedError('run_access_denied', 'inspect-worktree-cursor');
};
