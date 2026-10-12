import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { openKernelStateStore } from '../src/kernel/state-store.js';

const kernelCli = path.join(process.cwd(), 'bin', 'moon-relay-kernel.mjs');

const parseCliJson = (result: import('node:child_process').SpawnSyncReturns<string>) => {
  const line = String(result.stdout || result.stderr || '')
    .split(/\r?\n/)
    .find((entry) => entry.trim().startsWith('{'));
  assert.ok(line, result.stderr || result.stdout);
  return JSON.parse(line);
};

const cliEnvironment = () => ({
  ...process.env,
  MOON_RELAY_KERNEL_REEXEC: '1',
  MOON_RELAY_KERNEL_RUN_ID: '',
  MOON_RELAY_KERNEL_SESSION_ID: '',
  MOON_RELAY_KERNEL_PROJECT_ID: '',
  MOON_RELAY_KERNEL_WORKSPACE_ID: '',
  CODEX_THREAD_ID: '',
});

const runKernelCli = ({ cwd, runtimeHome, sessionId, args }: { cwd: string; runtimeHome: string; sessionId: string; args: string[] }) => spawnSync(process.execPath, [
  kernelCli,
  ...args,
  '--session-id', sessionId,
  '--provider', 'codex',
  '--project-root', cwd,
  '--runtime-home', runtimeHome,
  '--json',
], {
  cwd,
  encoding: 'utf8',
  env: cliEnvironment(),
});

const runGit = (cwd: string, args: string[]) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
};

const makeWorkspace = async ({ prefix, projectId }: { prefix: string; projectId: string }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
  await mkdir(path.join(root, '.moon-relay'), { recursive: true });
  await writeFile(path.join(root, '.moon-relay', 'track.yaml'), 'track: kernel\n');
  await writeFile(path.join(root, '.moon-relay', 'project.identity.yaml'), `projectId: ${projectId}\n`);
  await writeFile(path.join(root, 'package.json'), JSON.stringify({
    name: projectId,
    version: '0.0.1',
    scripts: { test: 'node -e "process.exit(0)"' },
  }));
  return root;
};

const successorAcrossWorktreesSpec = async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-successor-worktree-state-'));
  const projectId = 'kernel-successor-worktree-project';
  const firstRoot = await makeWorkspace({ prefix: 'kernel-successor-first', projectId });
  const secondParent = await mkdtemp(path.join(os.tmpdir(), 'kernel-successor-second-parent-'));
  const secondRoot = path.join(secondParent, 'second');
  const sessionId = 'codex:worktree-session';
  const predecessorRunId = 'codex-worktree-session';
  const predecessorContractPath = path.join(firstRoot, 'contract-a.json');
  const predecessorReportPath = path.join(firstRoot, 'report-a.json');
  const contractPath = path.join(secondRoot, 'contract-b.json');
  const successorReportPath = path.join(secondRoot, 'report-b.json');
  try {
    runGit(firstRoot, ['init']);
    runGit(firstRoot, ['config', 'user.email', 'kernel-test@example.invalid']);
    runGit(firstRoot, ['config', 'user.name', 'Kernel Test']);
    runGit(firstRoot, ['add', '.']);
    runGit(firstRoot, ['commit', '-m', 'worktree fixture']);
    runGit(firstRoot, ['worktree', 'add', secondRoot, 'HEAD']);

    await writeFile(predecessorContractPath, JSON.stringify({
      objective: 'contract A in worktree A',
      requestedTier: 'T0',
      acceptance: [{
        acceptance: 'worktree A contract completes',
        evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test'], obligationId: 'default' },
      }],
    }));
    const predecessorNext = runKernelCli({
      cwd: firstRoot,
      runtimeHome,
      sessionId,
      args: ['next', '--run-id', predecessorRunId, '--contract-json', predecessorContractPath],
    });
    assert.equal(predecessorNext.status, 0, predecessorNext.stderr || predecessorNext.stdout);
    const predecessorPayload = parseCliJson(predecessorNext);
    await writeFile(predecessorReportPath, JSON.stringify({
      stepId: predecessorPayload.action.step.stepId,
      summary: 'complete the predecessor through the public CLI',
      verifications: [{ obligationId: 'default', commandRef: 'test', acceptanceCoverage: ['worktree A contract completes'] }],
    }));
    const predecessorReport = runKernelCli({
      cwd: firstRoot,
      runtimeHome,
      sessionId,
      args: ['report', '--run-id', predecessorRunId, '--report-json', predecessorReportPath],
    });
    assert.equal(predecessorReport.status, 0, predecessorReport.stderr || predecessorReport.stdout);
    assert.equal(parseCliJson(predecessorReport).next.action.type, 'done');

    const store = await openKernelStateStore({ runtimeHome });
    let predecessorWorkspaceId;
    try {
      const run = store.getRun(predecessorRunId);
      assert.ok(run && typeof run === 'object' && 'workspaceId' in run);
      predecessorWorkspaceId = run.workspaceId;
      assert.ok(run && typeof run === 'object' && 'status' in run);
      assert.equal(run.status, 'completed');
      assert.ok(run && typeof run === 'object' && 'finalizationStatus' in run);
      assert.equal(run.finalizationStatus, 'completed');
    } finally {
      store.close();
    }

    await writeFile(contractPath, JSON.stringify({
      objective: 'contract B in worktree B',
      requestedTier: 'T0',
      acceptance: [{
        acceptance: 'worktree B receives an independent successor',
        evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test'], obligationId: 'default' },
      }],
    }));
    const result = runKernelCli({
      cwd: secondRoot,
      runtimeHome,
      sessionId,
      args: ['next', '--contract-json', contractPath],
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = parseCliJson(result);
    assert.notEqual(payload.runId, predecessorRunId);
    await writeFile(successorReportPath, JSON.stringify({
      stepId: payload.action.step.stepId,
      summary: 'complete the delegated successor through the public CLI',
      verifications: [{ obligationId: 'default', commandRef: 'test', acceptanceCoverage: ['worktree B receives an independent successor'] }],
    }));
    const successorReport = runKernelCli({
      cwd: secondRoot,
      runtimeHome,
      sessionId,
      args: ['report', '--run-id', payload.runId, '--report-json', successorReportPath],
    });
    assert.equal(successorReport.status, 0, successorReport.stderr || successorReport.stdout);
    const successorReportPayload = parseCliJson(successorReport);
    assert.equal(successorReportPayload.status, 'completed');
    assert.equal(successorReportPayload.next.action.type, 'done');

    const after = await openKernelStateStore({ runtimeHome });
    try {
      const successor = after.getRun(payload.runId);
      assert.ok(successor && typeof successor === 'object' && 'projectId' in successor);
      assert.equal(successor.projectId, projectId);
      assert.ok(successor && typeof successor === 'object' && 'workspaceId' in successor);
      assert.notEqual(successor.workspaceId, predecessorWorkspaceId);
      assert.ok(successor && typeof successor === 'object' && 'finalizationStatus' in successor);
      assert.equal(successor.finalizationStatus, 'completed');
      const observedValue11 = after.getRun(predecessorRunId);
    assert.ok(observedValue11);
    assert.equal(observedValue11.workspaceId, predecessorWorkspaceId);
    } finally {
      after.close();
    }
  } finally {
    if (existsSync(secondRoot)) runGit(firstRoot, ['worktree', 'remove', '--force', secondRoot]);
    await rm(firstRoot, { recursive: true, force: true });
    await rm(secondParent, { recursive: true, force: true });
    await rm(secondRoot, { recursive: true, force: true });
    await rm(runtimeHome, { recursive: true, force: true });
  }
};
test('a different worktree starts an independent Run even when the Host session is reused', successorAcrossWorktreesSpec);
