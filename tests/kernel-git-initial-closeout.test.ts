import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { admitKernelMutation, kernelCommitFailure } from '../src/application/kernel-standalone/kernel-commit.js';
import { observeWorkspaceIdentity } from '../src/host/kernel/workspace/workspace-identity.js';
import { resolveStableWorkspaceIdentity } from '../src/host/kernel/workspace/stable-workspace.js';
import { createWorkingTreeCommit, pushWorkingTreeCommit, readGitStatusEntries } from '../src/host/kernel/git/closeout-operations.js';
import { assertStagingContentSafe, isPathStagable } from '../src/kernel/git/staging-policy.js';

const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const repo = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kernel-initial-closeout-'));
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.name', 'Kernel Test']);
  git(root, ['config', 'user.email', 'kernel@example.invalid']);
  return root;
};
const initialFixture = async () => {
  const root = await repo();
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, '.env.example'), 'API_KEY=\nPORT=4310\n');
  await writeFile(path.join(root, 'src/config.ts'), 'export const config = 1;\n');
  const baseline = observeWorkspaceIdentity({ projectRoot: root });
  await writeFile(path.join(root, 'src/early.ts'), 'export const early = 1;\n');
  await writeFile(path.join(root, 'src/app.ts'), 'export const app = 1;\n');
  const observed = observeWorkspaceIdentity({ projectRoot: root });
  const project = { projectId: 'initial-project', projectRoot: root };
  const stable = resolveStableWorkspaceIdentity({ projectId: project.projectId, workspaceRoot: root });
  const run = { runId: 'initial-run', projectId: project.projectId, workspaceId: stable.workspaceId,
    worktreeId: 'worktree-initial', status: 'completed', currentState: 'CLOSE', finalizationStatus: 'completed',
    sourceIdentity: 'initial-source', mutationRevision: 2, currentWorkspaceIdentity: observed.identity,
    baselineWorkspaceEntries: baseline.changeEntries, taskContract: { allowedPaths: ['src/**', '.env.example'] } };
  const provenance = { runId: run.runId, projectId: project.projectId, workspaceId: stable.workspaceId,
    sourceIdentity: run.sourceIdentity, mutationRevision: 2, changedPaths: ['src/app.ts'], workspaceIdentity: observed.identity, status: 'passed' };
  const store = { getRun: (id: string) => id === run.runId ? run : null, listRuns: () => [run],
    getCompletionDecision: () => ({ decision: 'accepted', sourceIdentity: run.sourceIdentity, mutationRevision: 2 }),
    getMutationProvenance: () => provenance, getLatestImplementationAttempt: () => provenance,
    getStepAttempts: () => [{ status: 'passed', mutationRevision: 1, changedPaths: ['src/early.ts'] },
      { status: 'failed', mutationRevision: 2, changedPaths: ['unapproved.txt'] }],
    registerProjectWorkspace: () => ({ workspaceId: stable.workspaceId, canonicalRoot: stable.canonicalRoot }) };
  const paths = readGitStatusEntries(root).map((entry) => entry.path);
  const admit = (declared: string[] = paths) => admitKernelMutation({ stateStore: store, project,
    runId: run.runId, statusEntries: readGitStatusEntries(root), selected: readGitStatusEntries(root).map(e => e.path), initialPaths: declared });
  return { root, run, store, project, paths, admit };
};

test('initial inventory admits unchanged in-scope baseline plus passed earlier waves under final snapshot', async () => {
  const f = await initialFixture();
  try {
    assert.throws(() => admitKernelMutation({ stateStore: f.store, project: f.project, runId: f.run.runId,
      statusEntries: readGitStatusEntries(f.root), selected: f.paths }), /FOREIGN_MUTATION/);
    const admission = f.admit();
    assert.deepEqual(admission.approvedPaths, [...f.paths].sort());
    assert.deepEqual(admission.initialPaths, f.paths);
    assert.ok(!admission.approvedPaths.includes('unapproved.txt'));
    assert.throws(() => f.admit(f.paths.slice(1)), /INITIAL_INVENTORY_MISMATCH/);
    assert.throws(() => admitKernelMutation({ stateStore: f.store, project: f.project,
      statusEntries: readGitStatusEntries(f.root), selected: f.paths, initialPaths: f.paths, env: {} }), /INITIAL_COMMIT_REQUIRES_UNBORN_EXPLICIT_RUN/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('initial inventory rejects altered baseline, foreign additions, scope violations and accepted snapshot drift', async () => {
  const f = await initialFixture();
  try {
    await writeFile(path.join(f.root, 'src/config.ts'), 'changed baseline\n');
    assert.throws(() => f.admit(), /INITIAL_BASELINE_NOT_ACCEPTED/);
    await writeFile(path.join(f.root, 'src/config.ts'), 'export const config = 1;\n');
    await writeFile(path.join(f.root, 'new.txt'), 'foreign\n');
    assert.throws(() => f.admit([...f.paths, 'new.txt']), /INITIAL_SCOPE_VIOLATION/);
    await rm(path.join(f.root, 'new.txt'));
    f.run.taskContract.allowedPaths = ['src/app.ts'];
    assert.throws(() => f.admit(), /INITIAL_SCOPE_VIOLATION/);
    f.run.taskContract.allowedPaths = ['src/**', '.env.example'];
    await writeFile(path.join(f.root, 'src/app.ts'), 'unverified mutation\n');
    assert.throws(() => f.admit(), /MUTATION_PROVENANCE_DRIFT/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('status inventory expands directories and preserves exact filenames', async (t) => {
  const root = await repo();
  try {
    await mkdir(path.join(root, 'src'));
    const names = ['src/한국어.ts', 'src/file with spaces.ts', 'src/brackets[1].ts'];
    for (const name of names) await writeFile(path.join(root, name), 'source\n');
    assert.deepEqual(readGitStatusEntries(root).map(e => e.path).sort(), names.sort());
    await t.test('preserves POSIX-only filenames', { skip: process.platform === 'win32' }, async () => {
      const special = ['src/quote".ts', 'src/a -> b.ts', 'src/line\nbreak.ts'];
      for (const name of special) await writeFile(path.join(root, name), 'source\n');
      assert.deepEqual(readGitStatusEntries(root).map(e => e.path).sort(), [...names, ...special].sort());
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('shared template staging accepts placeholders and rejects secrets and symlinks', async (t) => {
  const root = await repo();
  try {
    assert.equal(isPathStagable('.env.example'), true);
    assert.equal(isPathStagable('src/.env.example'), true);
    for (const denied of ['.env', '.env.local', '.env.example.backup', '.codex/state/auth.json', 'db.sqlite']) assert.equal(isPathStagable(denied), false);
    const template = path.join(root, '.env.example');
    await writeFile(template, 'API_KEY=\nTOKEN=<your-token>\nPORT=4310\nDATA_DIR=data\n');
    assert.doesNotThrow(() => assertStagingContentSafe(root, '.env.example'));
    await writeFile(template, 'API_KEY=real-private-value\n');
    assert.throws(() => assertStagingContentSafe(root, '.env.example'), /GIT_ENV_TEMPLATE_SECRET/);
    await assert.rejects(createWorkingTreeCommit({ repoRoot: root, selectedPaths: ['.env.example'], commitMessage: 'unsafe' }), /GIT_ENV_TEMPLATE_SECRET/);
    assert.equal(git(root, ['diff', '--cached', '--name-only']), '');
    await rm(template);
    await writeFile(path.join(root, 'external.txt'), 'PORT=4310\n');
    await t.test('rejects symbolic links', async (linkTest) => {
      try {
        await symlink('external.txt', template);
      } catch (error) {
        if (process.platform === 'win32' && error instanceof Error && 'code' in error
          && (error.code === 'EPERM' || error.code === 'EACCES')) {
          linkTest.skip('This Windows account cannot create file symbolic links');
          return;
        }
        throw error;
      }
      assert.throws(() => assertStagingContentSafe(root, '.env.example'), /GIT_ENV_TEMPLATE_INVALID/);
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('governed Host commits unborn HEAD and first pushes with upstream and remote parity', async () => {
  const root = await repo();
  const remote = await mkdtemp(path.join(os.tmpdir(), 'kernel-first-push-'));
  try {
    git(remote, ['init', '--bare', '-q']);
    git(root, ['remote', 'add', 'origin', remote]);
    await writeFile(path.join(root, 'source.ts'), 'export const value = 1;\n');
    const commit = await createWorkingTreeCommit({ repoRoot: root, selectedPaths: ['source.ts'], commitMessage: 'initial governed commit' });
    assert.equal(commit.beforeHeadSha, '');
    assert.equal(commit.branch, 'main');
    assert.equal(git(root, ['rev-list', '--count', 'HEAD']), '1');
    assert.equal(git(root, ['status', '--porcelain']), '');
    const pushed = pushWorkingTreeCommit({ repoRoot: root, commitSha: commit.commitSha, branch: commit.branch });
    assert.equal(pushed.status, 'completed');
    assert.equal(pushed.parity, 'matched');
    assert.equal(pushed.remoteHeadSha, commit.commitSha);
    assert.equal(git(root, ['rev-parse', '--abbrev-ref', '@{upstream}']), 'origin/main');
    await writeFile(path.join(root, 'source.ts'), 'export const value = 2;\n');
    await createWorkingTreeCommit({ repoRoot: root, selectedPaths: ['source.ts'], commitMessage: 'second commit' });
    assert.throws(() => pushWorkingTreeCommit({ repoRoot: root, commitSha: commit.commitSha, branch: 'main' }), { code: 'GIT_PUSH_HEAD_MISMATCH' });
  } finally { await rm(root, { recursive: true, force: true }); await rm(remote, { recursive: true, force: true }); }
});

test('Host preserves a user index by rejecting pre-staged mutations before first commit', async () => {
  const root = await repo();
  try {
    await writeFile(path.join(root, 'user.txt'), 'user staged\n');
    await writeFile(path.join(root, 'source.ts'), 'kernel source\n');
    git(root, ['add', '--', 'user.txt']);
    await assert.rejects(createWorkingTreeCommit({ repoRoot: root, selectedPaths: ['source.ts'], commitMessage: 'reject' }), /Preserve the existing user index/);
    assert.equal(git(root, ['diff', '--cached', '--name-only']), 'user.txt');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('an unfamiliar standalone failure enters common diagnosis without granting authority', async () => {
  const root = await repo();
  try {
    const failure = kernelCommitFailure(Object.assign(new Error('unknown adapter condition'), { code: 'NEW_UNFAMILIAR_FAILURE' }), {
      cwd: root, runId: 'missing-run', env: { MOON_RELAY_KERNEL_HOME: path.join(root, 'runtime'), MOON_RELAY_TRACK: 'kernel' },
    });
    assert.equal(failure.errorCode, 'NEW_UNFAMILIAR_FAILURE');
    assert.equal(failure.recovery.kind, 'agent-recovery');
    assert.equal(failure.recovery.mode, 'inspect');
    assert.deepEqual(failure.recovery.allowedPaths, []);
    assert.equal(failure.recovery.validation.agentDiagnosisIsProof, false);
    assert.ok(failure.recovery.commands.inspect.args.includes('--diagnose'));
  } finally { await rm(root, { recursive: true, force: true }); }
});
