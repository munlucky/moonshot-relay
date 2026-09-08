import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createKernelControlPlane } from '../scripts/kernel/control-plane.mjs';
import { resolveBoundInvocation } from '../scripts/kernel/run/invocation-resolver.mjs';
import { openKernelStateStore } from '../scripts/kernel/state-store.mjs';
import { normalizeTaskContract } from '../scripts/kernel/task/task-contract.mjs';

const kernelCli = path.join(process.cwd(), 'bin', 'moon-relay-kernel.mjs');
const parseCliJson = (result) => {
  const line = `${result.stdout}\n${result.stderr}`.split(/\r?\n/).find((entry) => entry.trim().startsWith('{'));
  assert.ok(line, result.stderr || result.stdout);
  return JSON.parse(line);
};

test('contract-first invocation resolver deterministically selects every lifecycle mode', () => {
  const projectId = 'resolver-project';
  const sessionId = 'codex:resolver-session';
  const workspaceId = 'resolver-workspace';
  const contractA = normalizeTaskContract({
    objective: 'contract A',
    acceptance: ['A is complete'],
  }, { objective: 'contract A' });
  const contractB = {
    objective: 'contract B',
    acceptance: ['B is complete'],
  };
  let binding = null;
  let run = null;
  const stateStore = {
    getActiveOwnerBinding: () => binding,
    getRun: (runId) => run?.runId === runId ? run : null,
    getProjectWorkspace: (candidateWorkspaceId) => candidateWorkspaceId === 'workspace-next'
      ? { workspaceId: candidateWorkspaceId, projectId }
      : null,
  };
  const resolve = (taskContract = null, extra = {}) => resolveBoundInvocation({
    stateStore,
    projectId,
    provider: 'codex',
    sessionId,
    workspaceId,
    taskContract,
    ...extra,
  });

  assert.equal(resolve(contractA).mode, 'create');

  binding = {
    bindingId: 'binding-a',
    runId: 'run-a',
    projectId,
    sessionId,
    workspaceId,
  };
  run = {
    runId: 'run-a',
    projectId,
    workspaceId,
    status: 'active',
    finalizationStatus: 'pending',
    taskContract: contractA,
  };
  assert.equal(resolve(contractA).mode, 'resume');
  assert.equal(resolve(contractA, { explicitRunId: 'run-a' }).mode, 'resume');
  assert.equal(resolve(contractB).mode, 'revise');

  run = { ...run, status: 'completed', finalizationStatus: 'partial' };
  assert.equal(resolve(contractB).mode, 'finalization-retry');

  run = { ...run, finalizationStatus: 'completed' };
  assert.equal(resolve().mode, 'done');
  assert.equal(resolve(contractA).mode, 'done');
  assert.equal(resolve({ ...contractA, invocationIntent: 'new-task' }).mode, 'successor');
  const successor = resolve(contractB);
  assert.equal(successor.mode, 'successor');
  assert.equal(successor.predecessorRunId, 'run-a');
  assert.match(successor.runId, /^run-[0-9a-f-]{36}$/i);
  assert.equal(resolve(contractB, { workspaceId: 'workspace-next' }).mode, 'create');
});

test('explicit new-task intent fails closed instead of revising an active worktree Run and preserves its holder', () => {
  const projectId = 'new-task-project';
  const worktreeId = 'worktree-new-task';
  const workspaceId = 'workspace-new-task';
  const contract = normalizeTaskContract({
    objective: 'existing task',
    acceptance: ['existing task is complete'],
  });
  const holderRun = {
    runId: 'run-holder',
    projectId,
    workspaceId,
    worktreeId,
    status: 'active',
    taskContract: contract,
  };
  const stateStore = {
    getActiveOwnerBinding: () => ({
      bindingId: 'binding-holder',
      runId: holderRun.runId,
      projectId,
      sessionId: 'codex:new-task-session',
      workspaceId,
    }),
    getRun: (runId) => runId === holderRun.runId ? holderRun : null,
    listRuns: () => [holderRun],
    getWorktreeMutationLease: () => null,
  };

  assert.throws(
    () => resolveBoundInvocation({
      stateStore,
      projectId,
      provider: 'codex',
      sessionId: 'codex:new-task-session',
      workspaceId,
      worktreeId,
      taskContract: {
        objective: 'independent task',
        acceptance: ['independent task is complete'],
        invocationIntent: 'new-task',
      },
    }),
    (error) => {
      assert.equal(error.code, 'worktree_run_conflict');
      assert.equal(error.nextAction, 'resume-the-worktree-bound-run');
      assert.equal(error.details.reason, 'new-task-cannot-revise-mutable-run');
      assert.equal(error.details.holderRunId, holderRun.runId);
      assert.deepEqual(error.details.holder, {
        runId: holderRun.runId,
        projectId,
        workspaceId,
        worktreeId,
        status: 'active',
        blockedReason: null,
      });
      assert.deepEqual(error.details.holders, [error.details.holder]);
      return true;
    },
  );
  assert.equal(holderRun.taskContract.digest, contract.digest);
});

test('a blocked worktree run is automatically abandoned and lease reclaimed when a new task contract arrives', () => {
  const projectId = 'auto-abandon-project';
  const worktreeId = 'worktree-auto-abandon';
  const workspaceId = 'workspace-auto-abandon';
  const contractOld = normalizeTaskContract({
    objective: 'old blocked task',
    acceptance: ['old blocked task is complete'],
  });
  let holderRun = {
    runId: 'run-blocked-holder',
    projectId,
    workspaceId,
    worktreeId,
    status: 'blocked',
    blockedReason: 'question',
    taskContract: contractOld,
  };
  let lease = {
    worktreeId,
    projectId,
    holderRunId: 'run-blocked-holder',
  };
  let abandonedReason = null;
  const stateStore = {
    getActiveOwnerBinding: () => null,
    getRun: (runId) => runId === holderRun.runId ? holderRun : null,
    listRuns: () => [holderRun],
    getWorktreeMutationLease: () => lease,
    getLatestRunForWorktree: () => holderRun,
    abandonRun: (runId, { reason }) => {
      if (runId === holderRun.runId) {
        holderRun = { ...holderRun, status: 'abandoned' };
        lease = null;
        abandonedReason = reason;
      }
    },
  };

  const resolved = resolveBoundInvocation({
    stateStore,
    projectId,
    provider: 'codex',
    sessionId: 'codex:fresh-session',
    workspaceId,
    worktreeId,
    taskContract: {
      objective: 'new distinct task',
      acceptance: ['new distinct task completes'],
    },
  });

  assert.equal(resolved.mode, 'create');
  assert.equal(holderRun.status, 'abandoned');
  assert.equal(lease, null);
  assert.equal(abandonedReason, 'superseded-and-archived-for-new-task');
});

test('contract-first invocation resolver fails closed on explicit, provider, and workspace mismatches', () => {
  const stateStore = {
    getActiveOwnerBinding: () => ({
      bindingId: 'binding-a',
      runId: 'run-a',
      projectId: 'resolver-project',
      sessionId: 'codex:resolver-session',
      workspaceId: 'resolver-workspace',
    }),
    getRun: (runId) => runId === 'run-a' ? ({
        runId: 'run-a',
        projectId: 'resolver-project',
        workspaceId: 'resolver-workspace',
        status: 'active',
        finalizationStatus: 'pending',
        taskContract: null,
      }) : null,
  };
  const base = {
    stateStore,
    projectId: 'resolver-project',
    provider: 'codex',
    sessionId: 'codex:resolver-session',
    workspaceId: 'resolver-workspace',
  };
  assert.throws(
    () => resolveBoundInvocation({ ...base, explicitRunId: 'run-other' }),
    (error) => error.code === 'worktree_run_conflict',
  );
  assert.throws(
    () => resolveBoundInvocation({ ...base, provider: 'claude' }),
    (error) => error.code === 'provider_session_invalid',
  );
  assert.throws(
    () => resolveBoundInvocation({ ...base, workspaceId: 'workspace-other', explicitRunId: 'run-a' }),
    (error) => error.code === 'run_workspace_mismatch',
  );
});

const makeProject = async (prefix) => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), `${prefix}-project-`));
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), `${prefix}-state-`));
  await mkdir(path.join(projectRoot, '.moon-relay'), { recursive: true });
  await writeFile(
    path.join(projectRoot, '.moon-relay', 'track.yaml'),
    'schemaVersion: 1\ntrack: kernel\nproduct: moon-relay-kernel\n',
  );
  await writeFile(
    path.join(projectRoot, '.moon-relay', 'project.identity.yaml'),
    `projectId: ${prefix}\n`,
  );
  await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({
    name: prefix,
    version: '0.0.1',
    scripts: { test: 'node -e "process.exit(0)"' },
  }));
  return { projectRoot, runtimeHome };
};

const startOwnedRun = async ({ projectRoot, runtimeHome, sessionId, runId, objective }) => {
  const cp = await createKernelControlPlane({
    runtimeHome,
    projectRoot,
    requireHostBinding: true,
    env: {
      MOON_RELAY_KERNEL_SESSION_ID: sessionId,
      MOON_RELAY_KERNEL_PROVIDER: 'codex',
      MOON_RELAY_KERNEL_RUN_ID: runId,
    },
  });
  try {
    await cp.ensureRun({
      runId,
      objective,
      taskContract: { objective, acceptance: [`${objective} is complete`] },
    });
  } finally {
    await cp.close();
  }
};

const markTerminal = async ({ runtimeHome, runId, finalizationStatus }) => {
  const store = await openKernelStateStore({ runtimeHome });
  try {
    const run = store.getRun(runId);
    store.persistCompletionDecision(runId, {
      decision: 'accepted',
      digest: `sha256:${'a'.repeat(64)}`,
      run,
      decisionPayload: { decision: 'accepted' },
    });
    store.setFinalizationStatus(runId, finalizationStatus);
  } finally {
    store.close();
  }
};

const invokeNext = ({ projectRoot, runtimeHome, sessionId, contractPath, invocationIntent = null }) =>
  spawnSync(process.execPath, [
    kernelCli,
    'next',
    '--contract-json',
    contractPath,
    '--session-id',
    sessionId,
    '--project-root',
    projectRoot,
    '--runtime-home',
    runtimeHome,
    ...(invocationIntent ? ['--invocation-intent', invocationIntent] : []),
    '--json',
  ], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      MOON_RELAY_KERNEL_REEXEC: '1',
      MOON_RELAY_KERNEL_RUN_ID: '',
      MOON_RELAY_KERNEL_SESSION_ID: '',
      MOON_RELAY_KERNEL_PROJECT_ID: '',
      MOON_RELAY_KERNEL_WORKSPACE_ID: '',
      CODEX_THREAD_ID: '',
    },
  });

const successorAfterCompletedFinalization = async () => {
  const fixture = await makeProject('kernel-session-successor');
  const sessionId = 'codex:thread-a';
  const predecessorRunId = 'codex-thread-a';
  const contractPath = path.join(fixture.projectRoot, 'contract-b.json');
  try {
    // The contract is an invocation input, not a successor workspace
    // mutation. Create it before the predecessor baseline so continuity
    // compares the same workspace contents across the handoff.
    await writeFile(contractPath, JSON.stringify({
      objective: 'contract B',
      acceptance: ['contract B has an independent Run'],
    }));
    await startOwnedRun({
      ...fixture,
      sessionId,
      runId: predecessorRunId,
      objective: 'contract A',
    });
    await markTerminal({
      runtimeHome: fixture.runtimeHome,
      runId: predecessorRunId,
      finalizationStatus: 'completed',
    });
    const result = invokeNext({ ...fixture, sessionId, contractPath });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.match(payload.runId, /^run-[0-9a-f-]{36}$/i);
    assert.notEqual(payload.runId, predecessorRunId);

    const store = await openKernelStateStore({ runtimeHome: fixture.runtimeHome });
    try {
      const predecessor = store.getRun(predecessorRunId);
      assert.equal(predecessor.status, 'completed');
      assert.equal(predecessor.objective, 'contract A');
      assert.equal(predecessor.finalizationStatus, 'completed');
      assert.equal(
        store.getActiveOwnerBinding({ projectId: predecessor.projectId, sessionId }).runId,
        payload.runId,
      );
      assert.equal(
        store.getActiveRunBinding({ projectId: predecessor.projectId, sessionId, runId: predecessorRunId }),
        null,
      );
    } finally {
      store.close();
    }
  } finally {
    await rm(fixture.projectRoot, { recursive: true, force: true });
    await rm(fixture.runtimeHome, { recursive: true, force: true });
  }
};
test('a new contract after completed finalization creates an opaque successor and preserves its predecessor', successorAfterCompletedFinalization);

const explicitNewTaskAgainstActiveRun = async () => {
  const fixture = await makeProject('kernel-session-new-task');
  const sessionId = 'codex:thread-new-task';
  const holderRunId = 'codex-thread-holder';
  const contractPath = path.join(fixture.projectRoot, 'contract-new-task.json');
  try {
    await startOwnedRun({
      ...fixture,
      sessionId,
      runId: holderRunId,
      objective: 'existing active task',
    });
    await writeFile(contractPath, JSON.stringify({
      objective: 'independent task',
      acceptance: ['independent task has its own Run'],
    }));

    const result = invokeNext({ ...fixture, sessionId, contractPath, invocationIntent: 'new-task' });

    assert.equal(result.status, 0);
    const payload = parseCliJson(result);
    assert.equal(payload.status, 'read-only');
    assert.equal(payload.activeWriterRunId, holderRunId);

    const store = await openKernelStateStore({ runtimeHome: fixture.runtimeHome });
    try {
      const holder = store.getRun(holderRunId);
      assert.equal(holder.status, 'active');
      assert.equal(holder.objective, 'existing active task');
    } finally {
      store.close();
    }
  } finally {
    await rm(fixture.projectRoot, { recursive: true, force: true });
    await rm(fixture.runtimeHome, { recursive: true, force: true });
  }
};
test('the contract boundary carries explicit new-task intent through CLI resolution without mutating the active Run', explicitNewTaskAgainstActiveRun);

const incompleteFinalizationBlocksSuccessor = async () => {
  const fixture = await makeProject('kernel-session-finalization');
  const sessionId = 'codex:thread-partial';
  const predecessorRunId = 'codex-thread-partial';
  const contractPath = path.join(fixture.projectRoot, 'contract-b.json');
  try {
    await startOwnedRun({
      ...fixture,
      sessionId,
      runId: predecessorRunId,
      objective: 'contract A',
    });
    await markTerminal({
      runtimeHome: fixture.runtimeHome,
      runId: predecessorRunId,
      finalizationStatus: 'partial',
    });
    await writeFile(contractPath, JSON.stringify({
      objective: 'contract B',
      acceptance: ['contract B waits for predecessor finalization'],
    }));

    const result = invokeNext({ ...fixture, sessionId, contractPath });

    assert.notEqual(result.status, 0);
    const payload = parseCliJson(result);
    assert.equal(payload.errorCode, 'finalization_incomplete');
    assert.equal(payload.nextAction, 'retry-finalization');
    assert.equal(payload.runId, predecessorRunId);
  } finally {
    await rm(fixture.projectRoot, { recursive: true, force: true });
    await rm(fixture.runtimeHome, { recursive: true, force: true });
  }
};
test('a completed Run with incomplete finalization blocks successor creation with a stable recovery action', incompleteFinalizationBlocksSuccessor);

test('declared multi-step task contract without work-unit scope is rejected by preflight before Run creation', async () => {
  const fixture = await makeProject('kernel-multi-step-preflight');
  const sessionId = 'codex:thread-multi-step';
  const contractPath = path.join(fixture.projectRoot, 'contract-multi-step.json');
  try {
    await writeFile(contractPath, JSON.stringify({
      objective: 'multi-step feature implementation',
      taskClass: 'feature',
      steps: [
        { stepId: 'step-1', objective: 'first step without scope' },
      ],
      acceptance: ['feature is implemented'],
    }));

    const result = invokeNext({ ...fixture, sessionId, contractPath });
    assert.notEqual(result.status, 0);
    const payload = parseCliJson(result);
    assert.equal(payload.errorCode, 'work-unit-scope-missing');
    assert.equal(payload.nextAction, 'revise-task-contract-with-scoped-allowedPaths');

    const store = await openKernelStateStore({ runtimeHome: fixture.runtimeHome });
    try {
      assert.equal(store.getRun('run-multi-step'), null);
      assert.equal(store.getActiveOwnerBinding({ projectId: fixture.projectId, sessionId }), null);
    } finally {
      store.close();
    }
  } finally {
    await rm(fixture.projectRoot, { recursive: true, force: true });
    await rm(fixture.runtimeHome, { recursive: true, force: true });
  }
});

test('rollbackRunInitialization deletes child tables first and succeeds with nested foreign key data', async () => {
  const fixture = await makeProject('kernel-fk-rollback');
  const sessionId = 'codex:thread-fk-rollback';
  const runId = 'run-fk-test';
  try {
    await startOwnedRun({
      ...fixture,
      sessionId,
      runId,
      objective: 'fk test',
    });
    const store = await openKernelStateStore({ runtimeHome: fixture.runtimeHome });
    try {
      const run = store.getRun(runId);
      store.recordKnowledgeCandidate('cand-fk-test', runId, {
        projectId: run.projectId,
        proposedType: 'semantic_fact',
        status: 'pending',
        candidateJson: { statement: 'fact statement' },
      });
      store.recordCandidateEvidenceBinding({
        candidateId: 'cand-fk-test',
        runId,
        evidenceDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        obligationId: 'default',
        sourceIdentity: sessionId,
        mutationRevision: 0,
        bindingType: 'verification',
      });

      const rollback = store.rollbackRunInitialization(runId, {
        projectId: run.projectId,
        sourceIdentity: run.sourceIdentity,
      });
      assert.equal(rollback.status, 'rolled-back');
      assert.equal(rollback.rolledBack, true);
      assert.equal(store.getRun(runId), null);
    } finally {
      store.close();
    }
  } finally {
    await rm(fixture.projectRoot, { recursive: true, force: true });
    await rm(fixture.runtimeHome, { recursive: true, force: true });
  }
});
