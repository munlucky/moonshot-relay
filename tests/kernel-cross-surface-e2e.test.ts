import { assertTestArray, assertTestPresent, assertTestRecord, assertTestString } from './helpers/assert-value.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createKernelControlPlane } from '../src/host/kernel/control-plane-runtime.js';
import { createMcpBridgeHandler } from '../src/kernel/bridge/mcp.js';
import { resolveKernelWorktreeIdentity } from '../src/host/kernel/workspace/worktree-resolution.js';

const safeClean = async (dirs: string[]) => {
  for (const dir of dirs) {
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {}
  }
};

const setupGitRepoWithWorktrees = async () => {
  const mainRoot = await mkdtemp(path.join(os.tmpdir(), 'cross-surface-main-'));

  spawnSync('git', ['init', '--quiet'], { cwd: mainRoot, encoding: 'utf8' });
  spawnSync('git', ['config', 'user.name', 'Cross Surface'], { cwd: mainRoot, encoding: 'utf8' });
  spawnSync('git', ['config', 'user.email', 'cross@example.invalid'], { cwd: mainRoot, encoding: 'utf8' });
  await writeFile(path.join(mainRoot, 'package.json'), JSON.stringify({ name: 'cross-surface-fixture', scripts: { test: 'node --version' } }));
  await writeFile(path.join(mainRoot, 'README.md'), '# Main Worktree\n');
  spawnSync('git', ['add', '.'], { cwd: mainRoot, encoding: 'utf8' });
  spawnSync('git', ['commit', '-m', 'initial commit', '--quiet'], { cwd: mainRoot, encoding: 'utf8' });

  // Create a second linked git worktree
  const worktreeB = await mkdtemp(path.join(os.tmpdir(), 'cross-surface-wtB-'));
  spawnSync('git', ['worktree', 'add', '-b', 'feature-b', worktreeB, 'HEAD'], { cwd: mainRoot, encoding: 'utf8' });

  return { mainRoot, worktreeB };
};

test('Scenario 1 & 3: Cross-surface resume on same worktree preserves Run identity and completes', async (t) => {
  const { mainRoot, worktreeB } = await setupGitRepoWithWorktrees();
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'cross-surface-runtime-'));

  t.after(async () => {
    await safeClean([mainRoot, worktreeB, runtimeHome]);
  });

  // Surface 1: Codex App starts run via MCP Bridge
  const mcpHandler = createMcpBridgeHandler({ runtimeHome });

  const taskContract = {
    objective: 'Implement cross-surface feature',
    acceptance: [{
      acceptance: 'feature implemented and verified',
      evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test'], obligationId: 'default' },
    }],
    allowedPaths: ['README.md'],
    nonGoals: ['no out of scope changes'],
    constraints: ['keep minimal'],
  };

  const startRes = await mcpHandler({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'kernel_next',
      arguments: {
        workspaceRoot: mainRoot,
        contractJson: taskContract,
        surface: 'codex_app',
      },
    },
  });

  assert.equal(assertTestPresent(assertTestPresent(startRes).result).isError, false);
  const startPayload = JSON.parse(assertTestPresent(assertTestPresent(assertTestPresent(startRes).result).content)[0].text);
  const runId = startPayload.runId;
  assert.ok(runId);
  assert.equal(startPayload.action.type, 'implement');

  // Detach surface 1
  const detachRes = await mcpHandler({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'kernel_detach',
      arguments: {
        workspaceRoot: mainRoot,
        runId,
        surface: 'codex_app',
      },
    },
  });
  assert.equal(assertTestPresent(assertTestPresent(detachRes).result).isError, false);

  // Surface 2: Claude CLI resumes the same Run on the same worktree via Control Plane
  const cpClaude = await createKernelControlPlane({
    runtimeHome,
    projectRoot: mainRoot,
    env: {
      MOON_RELAY_KERNEL_SURFACE: 'claude_cli',
      MOON_RELAY_KERNEL_RUN_ID: runId,
    },
    requireHostBinding: false,
  });

  const resumeInvocation = cpClaude.resolveBoundInvocation({
    explicitRunId: runId,
    taskContract,
  });

  assert.equal(resumeInvocation.runId, runId);
  assert.equal(resumeInvocation.mode, 'resume');

  const claudeNext = await cpClaude.next(runId);
  assert.equal(assertTestRecord(claudeNext).runId, runId);
  assert.equal(assertTestRecord(assertTestRecord(claudeNext).action).type, 'implement');

  // Claude mutates file and reports
  await writeFile(path.join(mainRoot, 'README.md'), '# Main Worktree (Updated by Claude)\n');

  const reportRes = await cpClaude.report(runId, {
    stepId: assertTestString(assertTestRecord(assertTestRecord(assertTestRecord(claudeNext).action).step).stepId),
    summary: 'feature implemented on the resumed worktree',
    changedPaths: ['README.md'],
    verifications: [{
      obligationId: 'default',
      commandRef: 'test',
      acceptanceCoverage: ['AC-1'],
    }],
  });

  assert.equal(assertTestPresent(reportRes).status, 'completed', JSON.stringify(assertTestRecord(assertTestPresent(reportRes)).failures));
  assert.equal(assertTestRecord(assertTestArray(assertTestRecord(assertTestPresent(reportRes)).executed)[0]).status, 'passed');
  const finalNext = await cpClaude.next(runId);
  assert.equal(assertTestRecord(assertTestRecord(finalNext).action).type, 'done');
  const persistedRun = await cpClaude.getRun(runId);
  const identity = resolveKernelWorktreeIdentity({ cwd: mainRoot, workspaceRoot: mainRoot });
  assert.equal(assertTestPresent(persistedRun).projectId, identity.projectId);
  assert.equal(assertTestPresent(persistedRun).worktreeId, identity.worktreeId);
  await cpClaude.close();
});

test('Scenario 4: Different linked worktrees run independent concurrent Runs in the same Project', async (t) => {
  const { mainRoot, worktreeB } = await setupGitRepoWithWorktrees();
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'concurrent-wt-runtime-'));

  t.after(async () => {
    await safeClean([mainRoot, worktreeB, runtimeHome]);
  });

  // Worktree A: Codex App run
  const mcpHandler = createMcpBridgeHandler({ runtimeHome });
  const resA = await mcpHandler({
    jsonrpc: '2.0',
    id: 10,
    method: 'tools/call',
    params: {
      name: 'kernel_next',
      arguments: {
        workspaceRoot: mainRoot,
        contractJson: { objective: 'Task in Worktree A', acceptance: ['done A'] },
        surface: 'codex_app',
      },
    },
  });
  assert.equal(assertTestPresent(assertTestPresent(resA).result).isError, false);
  const payloadA = JSON.parse(assertTestPresent(assertTestPresent(assertTestPresent(resA).result).content)[0].text);
  const runIdA = payloadA.runId;

  // Worktree B: Qwen Code CLI run
  const resB = await mcpHandler({
    jsonrpc: '2.0',
    id: 11,
    method: 'tools/call',
    params: {
      name: 'kernel_next',
      arguments: {
        workspaceRoot: worktreeB,
        contractJson: { objective: 'Task in Worktree B', acceptance: ['done B'] },
        surface: 'qwen_code_cli',
      },
    },
  });
  assert.equal(assertTestPresent(assertTestPresent(resB).result).isError, false);
  const payloadB = JSON.parse(assertTestPresent(assertTestPresent(assertTestPresent(resB).result).content)[0].text);
  const runIdB = payloadB.runId;

  // Independent Run IDs
  assert.notEqual(runIdA, runIdB);

  // Verify Worktree Identities
  const identA = resolveKernelWorktreeIdentity({ cwd: mainRoot, workspaceRoot: mainRoot });
  const identB = resolveKernelWorktreeIdentity({ cwd: worktreeB, workspaceRoot: worktreeB });

  assert.equal(identA.projectId, identB.projectId);
  assert.notEqual(identA.worktreeId, identB.worktreeId);
});

test('Scenario 5: Second mutable Run on the same worktree is rejected by MutationLease', async (t) => {
  const { mainRoot, worktreeB } = await setupGitRepoWithWorktrees();
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'lease-conflict-runtime-'));

  t.after(async () => {
    await safeClean([mainRoot, worktreeB, runtimeHome]);
  });

  const mcpHandler = createMcpBridgeHandler({ runtimeHome });

  // Start first run
  const res1 = await mcpHandler({
    jsonrpc: '2.0',
    id: 20,
    method: 'tools/call',
    params: {
      name: 'kernel_next',
      arguments: {
        workspaceRoot: mainRoot,
        contractJson: { objective: 'First Active Run', acceptance: ['done 1'] },
        surface: 'codex_app',
      },
    },
  });
  assert.equal(assertTestPresent(assertTestPresent(res1).result).isError, false);
  const payload1 = JSON.parse(assertTestPresent(assertTestPresent(assertTestPresent(res1).result).content)[0].text);
  assert.ok(payload1.runId);

  // Attempt to start second distinct mutable run on the same worktree via Control Plane directly
  const cp2 = await createKernelControlPlane({
    runtimeHome,
    projectRoot: mainRoot,
    requireHostBinding: false,
  });

  try {
    await assert.rejects(
      async () => {
        await cp2.startRun({
          runId: 'conflicting-second-run',
          objective: 'Second Run on same worktree',
          taskContract: { objective: 'Second Run on same worktree', acceptance: ['done 2'] },
        });
      },
      (err) => {
        return assertTestRecord(err).code === 'worktree_mutation_lease_held' || assertTestRecord(err).code === 'worktree_run_conflict' || assertTestString(assertTestRecord(err).message).includes('lease');
      },
    );
  } finally {
    await cp2.close();
  }
});

test('Scenario 2: Abandoning an active Run releases the MutationLease for a new Run', async (t) => {
  const { mainRoot } = await setupGitRepoWithWorktrees();
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'abandon-scenario-runtime-'));

  t.after(async () => {
    await safeClean([mainRoot, runtimeHome]);
  });

  const cp = await createKernelControlPlane({
    runtimeHome,
    projectRoot: mainRoot,
    requireHostBinding: false,
  });

  try {
    const run1 = await cp.ensureRun({
      runId: 'run-to-abandon',
      objective: 'Run to be abandoned',
      taskContract: { acceptance: ['will not finish'] },
    });
    assert.equal(run1.status, 'created');

    const abandonResult = await cp.abandon('run-to-abandon', { reason: 'operator_cancel' });
    assert.equal(abandonResult.status, 'abandoned');

    // New run on the same worktree can now start
    const run2 = await cp.ensureRun({
      runId: 'run-fresh-after-abandon',
      objective: 'Fresh run on worktree',
      taskContract: { acceptance: ['fresh finish'] },
    });
    assert.equal(run2.status, 'created');
  } finally {
    await cp.close();
  }
});

test('Scenario 6: Cross-surface complete Run with finalize and git closeout', async (t) => {
  const { mainRoot } = await setupGitRepoWithWorktrees();
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'finalize-scenario-runtime-'));

  t.after(async () => {
    await safeClean([mainRoot, runtimeHome]);
  });

  const cp = await createKernelControlPlane({
    runtimeHome,
    projectRoot: mainRoot,
    requireHostBinding: false,
  });

  try {
    const run = await cp.ensureRun({
      runId: 'run-to-finalize',
      objective: 'Complete full task lifecycle',
      taskContract: {
        acceptance: [{
          acceptance: 'docs updated',
          evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test'], obligationId: 'default' },
        }],
      },
    });
    assert.equal(run.status, 'created');

    await writeFile(path.join(mainRoot, 'README.md'), '# Updated Docs\n');

    const compatibilityInput2 = {
      status: 'completed',
      summary: 'docs updated and tested',
      changedPaths: ['README.md'],
      verifications: [{ obligationId: 'default', commandRef: 'test', acceptanceCoverage: ['docs updated'] }],
    };
    const reportRes = await cp.report('run-to-finalize', compatibilityInput2);
    assert.equal(assertTestPresent(reportRes).status, 'completed');
    assert.equal(assertTestRecord(assertTestRecord(assertTestPresent(reportRes)).finalization).completionStatus, 'accepted');
  } finally {
    await cp.close();
  }
});

type TestControlPlane = Awaited<ReturnType<typeof import('../src/host/kernel/control-plane-runtime.js').createKernelControlPlane>>;
type TestStateStore = Awaited<ReturnType<typeof import('../src/kernel/state-store.js').openKernelStateStore>>;
