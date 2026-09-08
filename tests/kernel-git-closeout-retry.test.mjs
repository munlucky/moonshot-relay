import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createKernelControlPlane } from '../scripts/kernel/control-plane.mjs';
import { openKernelStateStore } from '../scripts/kernel/state-store.mjs';
import { executeKernelGitCloseout } from '../scripts/kernel/git/closeout.mjs';
import { runGit } from '../scripts/lib/git-safe.mjs';

test('executeKernelGitCloseout retry skips creating duplicate commit when existingCommitSha is provided', async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'kernel-git-retry-isolated-'));
  try {
    runGit(repoRoot, ['init', '-b', 'main']);
    runGit(repoRoot, ['config', 'user.name', 'Kernel Test']);
    runGit(repoRoot, ['config', 'user.email', 'kernel-test@example.invalid']);
    await writeFile(path.join(repoRoot, 'fixture.txt'), 'retry fixture\n');
    runGit(repoRoot, ['add', 'fixture.txt']);
    assert.equal(runGit(repoRoot, ['commit', '-m', 'fixture']).status, 0);
    const existingCommitSha = runGit(repoRoot, ['rev-parse', 'HEAD']).stdout.trim();
    const receipt = await executeKernelGitCloseout({
    runId: 'retry-run-1',
    projectId: 'p-retry',
    repoRoot,
    gitCloseoutRequest: { requested: true, mode: 'soft', approvalReceipt: 'approval://user/1', existingCommitSha },
    knowledgeCommitReceipt: { digest: 'k-digest-1' },
    changedFiles: [],
  });

  assert.equal(receipt.commitSha, existingCommitSha);
  assert.equal(receipt.status, 'completed');
  assert.equal(runGit(repoRoot, ['rev-parse', 'HEAD']).stdout.trim(), existingCommitSha);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test('public Git retry blocks external mutation after push_failed and records stale receipt', async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'kernel-git-retry-public-repo-'));
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-git-retry-public-home-'));
  const runId = 'kernel-public-git-retry-external-mutation';
  const sessionId = 'codex:kernel-public-git-retry-session';
  const {
    CODEX_THREAD_ID: _codexThreadId,
    MOON_RELAY_KERNEL_SESSION_ID: _kernelSessionId,
    ...isolatedEnv
  } = process.env;
  let cp = null;
  try {
    runGit(repoRoot, ['init', '-b', 'main']);
    runGit(repoRoot, ['config', 'user.name', 'Kernel Test']);
    runGit(repoRoot, ['config', 'user.email', 'kernel-test@example.invalid']);
    await mkdir(path.join(repoRoot, '.moon-relay'), { recursive: true });
    await writeFile(path.join(repoRoot, '.moon-relay', 'track.yaml'), 'schemaVersion: 1\ntrack: kernel\n');
    await writeFile(path.join(repoRoot, 'initial.txt'), 'initial\n');
    await writeFile(path.join(repoRoot, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }));
    runGit(repoRoot, ['add', '--all']);
    runGit(repoRoot, ['commit', '-m', 'fixture']);
    await writeFile(path.join(repoRoot, 'change.txt'), 'kernel change\n');

    cp = await createKernelControlPlane({
      runtimeHome,
      projectRoot: repoRoot,
      requireHostBinding: true,
      env: {
        ...process.env,
        MOON_RELAY_KERNEL_SESSION_ID: sessionId,
        MOON_RELAY_KERNEL_PROVIDER: 'codex',
        MOON_RELAY_KERNEL_RUN_ID: runId,
      },
    });
    await cp.ensureRun({
      runId,
      objective: 'Block unsafe public Git retry',
      taskContract: {
        riskTier: 'T0',
        acceptance: [{
          acceptance: 'external mutation blocks the retry',
          evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test'], obligationId: 'default' },
        }],
      },
    });
    for (const state of ['EXECUTE', 'PROVE']) await cp.transition(runId, state);
    await cp.recordProof(runId, {
      obligationId: 'default',
      status: 'passed',
      evidenceRef: 'ev-public-retry',
      commandRef: 'test',
      command: 'npm test',
      exitCode: 0,
      evidenceDigest: `sha256:${'d'.repeat(64)}`,
      acceptanceCoverage: ['external mutation blocks the retry'],
    });
    const first = await cp.finalizeRun(runId, {
      knowledgeObservations: [{
        proposedType: 'semantic_fact',
        statement: 'Public retry must revalidate workspace identity.',
        scope: ['change.txt'],
        evidenceRefs: ['ev-public-retry'],
      }],
      gitCloseoutRequest: { requested: true, mode: 'commit_and_push', approvalReceipt: 'approval-public-retry' },
      changedPaths: ['change.txt'],
    });
    assert.equal(first.finalizationStatus, 'partial');
    const pushFailedReceipt = cp.stateStore.getGitCloseoutReceipt(runId);
    assert.equal(pushFailedReceipt.status, 'push_failed');
    const kernelCommitSha = pushFailedReceipt.commitSha;
    assert.ok(kernelCommitSha);
    await cp.close();
    cp = null;

    await writeFile(path.join(repoRoot, 'external.txt'), 'external mutation\n');
    const result = spawnSync(process.execPath, [
      path.resolve(process.cwd(), 'bin', 'moon-relay-kernel.mjs'),
      'git-closeout',
      '--run-id', runId,
      '--session-id', sessionId,
      '--provider', 'codex',
      '--project-root', repoRoot,
      '--runtime-home', runtimeHome,
      '--json',
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...isolatedEnv, MOON_RELAY_KERNEL_REEXEC: '1', MOON_RELAY_KERNEL_RUN_ID: '' },
    });
    assert.notEqual(result.status, 0);
    const errorLine = result.stderr.split(/\r?\n/).find((line) => line.trim().startsWith('{'));
    assert.ok(errorLine, result.stderr);
    const errorPayload = JSON.parse(errorLine);
    assert.equal(errorPayload.errorCode, 'WORKSPACE_IDENTITY_MISMATCH');

    const retryStore = await openKernelStateStore({ runtimeHome });
    try {
      const staleReceipt = retryStore.getGitCloseoutReceipt(runId);
      assert.equal(staleReceipt.status, 'stale_workspace');
      assert.equal(staleReceipt.errorCode, 'WORKSPACE_IDENTITY_MISMATCH');
      assert.equal(staleReceipt.pushStatus, 'not_started');
      assert.equal(String(runGit(repoRoot, ['rev-parse', 'HEAD']).stdout).trim(), kernelCommitSha);
    } finally {
      retryStore.close();
    }
  } finally {
    if (cp) await cp.close();
    await rm(repoRoot, { recursive: true, force: true });
    await rm(runtimeHome, { recursive: true, force: true });
  }
});
