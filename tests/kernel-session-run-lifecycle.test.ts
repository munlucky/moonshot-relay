import { assertTestPresent, assertTestRecord, assertTestString } from './helpers/assert-value.js';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createKernelControlPlane } from '../src/host/kernel/control-plane-runtime.js';
import { resolveBoundInvocation } from '../src/kernel/run/invocation-resolver.js';
import { openKernelStateStore } from '../src/kernel/state-store.js';
import { normalizeTaskContract } from '../src/kernel/task/task-contract.js';

const kernelCli = path.join(process.cwd(), 'bin', 'moon-relay-kernel.mjs');
const parseCliJson = (result: { status: number | null; stdout: string; stderr: string }) => {
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
  let binding: unknown = null;
  let run: ResolverFixtureRun | null = null;
  const stateStore = {
    getActiveOwnerBinding: () => binding,
    getRun: (runId: string) => run?.runId === runId ? run : null,
    listRuns: ({ workspaceId: requestedWorkspaceId }: { workspaceId?: string | null } = {}) => (
      run && assertTestPresent(run).workspaceId === requestedWorkspaceId ? [run] : []
    ),
    getLatestRunForWorktree: ({ workspaceId: requestedWorkspaceId }: { workspaceId?: string | null } = {}) => (
      run && assertTestPresent(run).workspaceId === requestedWorkspaceId ? run : null
    ),
    getProjectWorkspace: (candidateWorkspaceId: string) => candidateWorkspaceId === 'workspace-next'
      ? { workspaceId: candidateWorkspaceId, projectId, worktreeId: null }
      : null,
  };
  const resolve = (taskContract: NonNullable<Parameters<typeof resolveBoundInvocation>[0]>["taskContract"] = null, extra: Partial<Parameters<typeof resolveBoundInvocation>[0]> = {}) => resolveBoundInvocation({
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

  run = { ...assertTestPresent(run), status: 'completed', finalizationStatus: 'partial' };
  assert.equal(resolve(contractB).mode, 'finalization-retry');

  run = { ...assertTestPresent(run), finalizationStatus: 'completed' };
  assert.equal(resolve().mode, 'done');
  assert.equal(resolve(contractA).mode, 'done');
  assert.equal(resolve({ ...contractA, invocationIntent: 'new-task' }).mode, 'successor');
  const successor = resolve(contractB);
  assert.equal(successor.mode, 'successor');
  assert.equal(successor.predecessorRunId, 'run-a');
  assert.match(successor.runId, /^run-[0-9a-f-]{36}$/i);
  assert.equal(resolve(contractB, { workspaceId: 'workspace-next' }).mode, 'create');
});

test('session binding is an access handle and never selects Task identity', () => {
  const projectId = 'session-independent-project';
  const workspaceId = 'session-independent-workspace';
  const run = {
    runId: 'run-session-independent',
    projectId,
    workspaceId,
    status: 'active',
    finalizationStatus: 'pending',
    taskContract: normalizeTaskContract({
      objective: 'preserve durable work across host restart',
      acceptance: ['work resumes from the same Run'],
    }),
  };
  const stateStore = {
    getActiveOwnerBinding: () => {
      throw new Error('session binding must not be consulted for Run selection');
    },
    getRun: (runId: string) => runId === run.runId ? run : null,
    listRuns: ({ workspaceId: requestedWorkspaceId }: { workspaceId?: string | null } = {}) => (
      requestedWorkspaceId === workspaceId ? [run] : []
    ),
    getLatestRunForWorktree: ({ workspaceId: requestedWorkspaceId }: { workspaceId?: string | null } = {}) => (
      requestedWorkspaceId === workspaceId ? run : null
    ),
  };

  const resolved = resolveBoundInvocation({
    stateStore,
    projectId,
    provider: 'codex',
    sessionId: 'codex:replacement-host-session',
    workspaceId,
    taskContract: run.taskContract,
  });

  assert.equal(resolved.mode, 'resume');
  assert.equal(resolved.runId, run.runId);
  assert.equal(resolved.binding, null);
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
    getRun: (runId: string) => runId === holderRun.runId ? holderRun : null,
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
      assert.equal(assertTestRecord(error).code, 'worktree_run_conflict');
      assert.equal(assertTestRecord(error).nextAction, 'resume-the-worktree-bound-run');
      assert.equal(assertTestRecord(assertTestRecord(error).details).reason, 'new-task-cannot-revise-mutable-run');
      assert.equal(assertTestRecord(assertTestRecord(error).details).holderRunId, holderRun.runId);
      assert.deepEqual(assertTestRecord(assertTestRecord(error).details).holder, {
        runId: holderRun.runId,
        projectId,
        workspaceId,
        worktreeId,
        status: 'active',
        blockedReason: null,
      });
      assert.deepEqual(assertTestRecord(assertTestRecord(error).details).holders, [assertTestRecord(assertTestRecord(error).details).holder]);
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
  let lease: { worktreeId: string; projectId: string; holderRunId: string } | null = {
    worktreeId,
    projectId,
    holderRunId: 'run-blocked-holder',
  };
  let abandonedReason: unknown = null;
  const stateStore = {
    getActiveOwnerBinding: () => null,
    getRun: (runId: string) => runId === holderRun.runId ? holderRun : null,
    listRuns: () => [holderRun],
    getWorktreeMutationLease: () => lease,
    getLatestRunForWorktree: () => holderRun,
    abandonRun: (runId: string, { reason }: { reason: string }) => {
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
  const activeRun = {
    runId: 'run-a',
    projectId: 'resolver-project',
    workspaceId: 'resolver-workspace',
    status: 'active',
    finalizationStatus: 'pending',
    taskContract: null,
  };
  const stateStore = {
    getActiveOwnerBinding: () => ({
      bindingId: 'binding-a',
      runId: activeRun.runId,
      projectId: activeRun.projectId,
      sessionId: 'codex:resolver-session',
      workspaceId: activeRun.workspaceId,
    }),
    getRun: (runId: string) => runId === activeRun.runId ? activeRun : null,
    listRuns: ({ workspaceId }: { workspaceId?: string | null } = {}) => workspaceId === activeRun.workspaceId ? [activeRun] : [],
    getLatestRunForWorktree: ({ workspaceId }: { workspaceId?: string | null } = {}) => workspaceId === activeRun.workspaceId ? activeRun : null,
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
    (error) => assertTestRecord(error).code === 'worktree_run_conflict',
  );
  assert.throws(
    () => resolveBoundInvocation({ ...base, provider: 'claude' }),
    (error) => assertTestRecord(error).code === 'provider_session_invalid',
  );
  assert.throws(
    () => resolveBoundInvocation({ ...base, workspaceId: 'workspace-other', explicitRunId: 'run-a' }),
    (error) => assertTestRecord(error).code === 'run_workspace_mismatch',
  );
});

const makeProject = async (prefix: string) => {
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

const startOwnedRun = async ({ projectRoot, runtimeHome, sessionId, runId, objective }: { projectRoot: string; runtimeHome: string; sessionId: string; runId: string; objective: string }) => {
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

const markTerminal = async ({ runtimeHome, runId, finalizationStatus }: { runtimeHome: string; runId: string; finalizationStatus: string }) => {
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

const invokeNext = ({ projectRoot, runtimeHome, sessionId, contractPath, invocationIntent = null }: { projectRoot: string; runtimeHome: string; sessionId: string; contractPath: string; invocationIntent?: string | null }) =>
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
      assert.equal(assertTestPresent(predecessor).status, 'completed');
      assert.equal(assertTestPresent(predecessor).objective, 'contract A');
      assert.equal(assertTestPresent(predecessor).finalizationStatus, 'completed');
      assert.equal(
        assertTestPresent(store.getActiveOwnerBinding({ projectId: assertTestString(assertTestPresent(predecessor).projectId), sessionId })).runId,
        payload.runId,
      );
      assert.equal(
        store.getActiveRunBinding({ projectId: assertTestString(assertTestPresent(predecessor).projectId), sessionId, runId: predecessorRunId }),
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
      assert.equal(assertTestPresent(holder).status, 'active');
      assert.equal(assertTestPresent(holder).objective, 'existing active task');
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
      assert.equal(store.getActiveOwnerBinding({ sessionId }), null);
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
        projectId: assertTestPresent(run).projectId,
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

      const journalBeforeRollback = store.getRunJournal(runId);
      const rollback = store.rollbackRunInitialization(runId, {
        projectId: assertTestPresent(run).projectId,
        sourceIdentity: assertTestPresent(run).sourceIdentity,
      });
      assert.equal(rollback.status, 'rolled-back');
      assert.equal(rollback.rolledBack, true);
      assert.equal(store.getRun(runId), null);
      assert.deepEqual(store.getRunJournal(runId), journalBeforeRollback);
    } finally {
      store.close();
    }
  } finally {
    await rm(fixture.projectRoot, { recursive: true, force: true });
    await rm(fixture.runtimeHome, { recursive: true, force: true });
  }
});

type TestControlPlane = Awaited<ReturnType<typeof import('../src/host/kernel/control-plane-runtime.js').createKernelControlPlane>>;
type TestStateStore = Awaited<ReturnType<typeof import('../src/kernel/state-store.js').openKernelStateStore>>;

type ResolverFixtureRun = NonNullable<ReturnType<NonNullable<NonNullable<Parameters<typeof resolveBoundInvocation>[0]>["stateStore"]>["getRun"]>>;

test('session-tagged Kernel CLI rejects a foreign report without completing or stealing an owned Run', async () => {
  const fixture = await makeProject('kernel-session-report-owner');
  const ownerSessionId = 'codex:w1-report-owner';
  const foreignSessionId = 'codex:w1-foreign-session';
  const contractPath = path.join(fixture.projectRoot, 'contract.json');
  const reportPath = path.join(fixture.projectRoot, 'report.json');
  try {
    await writeFile(path.join(fixture.projectRoot, 'app.mjs'), 'export const value = 1;\n');
    await writeFile(contractPath, JSON.stringify({
      objective: 'preserve the existing work owner',
      allowedPaths: ['app.mjs'],
      acceptance: ['verification succeeds'],
    }));
    await writeFile(reportPath, JSON.stringify({
      stepId: 'step-1-1',
      summary: 'verify without claiming a new work owner',
      changedPaths: [],
      verifications: [{
        obligationId: 'default',
        commandRef: 'test',
        acceptanceCoverage: ['AC-1'],
      }],
    }));
    const started = invokeNext({ ...fixture, sessionId: ownerSessionId, contractPath });
    assert.equal(started.status, 0, started.stderr || started.stdout);
    const runId = assertTestString(parseCliJson(started).runId);
    const report = (sessionId: string) => spawnSync(process.execPath, [
      kernelCli,
      'report',
      runId,
      '--report-json',
      reportPath,
      '--session-id',
      sessionId,
      '--provider',
      'codex',
      '--project-root',
      fixture.projectRoot,
      '--runtime-home',
      fixture.runtimeHome,
      '--json',
    ], {
      cwd: fixture.projectRoot,
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

    const denied = report(foreignSessionId);
    const rejected = parseCliJson(denied);
    assert.equal(rejected.errorCode, 'host_binding_missing');
    assert.equal(rejected.status, 'error');

    const store = await openKernelStateStore({ runtimeHome: fixture.runtimeHome });
    try {
      const run = assertTestPresent(store.getRun(runId));
      assert.equal(run.status, 'active');
      assert.equal(run.mutationRevision, 0);
      assert.equal(store.getVerifications(runId).length, 0);
      assert.equal(store.getCompletionDecision(runId), null);
      assert.equal(
        assertTestPresent(store.getActiveOwnerBinding({
          projectId: assertTestString(run.projectId),
          sessionId: ownerSessionId,
        })).runId,
        runId,
      );
      assert.equal(store.getActiveRunBinding({
        projectId: assertTestString(run.projectId),
        sessionId: foreignSessionId,
        runId,
      }), null);
    } finally {
      store.close();
    }

    const accepted = report(ownerSessionId);
    assert.equal(accepted.status, 0, accepted.stderr || accepted.stdout);
    assert.equal(parseCliJson(accepted).status, 'completed');
  } finally {
    await rm(fixture.projectRoot, { recursive: true, force: true });
    await rm(fixture.runtimeHome, { recursive: true, force: true });
  }
});
