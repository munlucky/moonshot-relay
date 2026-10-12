import { assertTestPresent, assertTestRecord, assertTestString } from './helpers/assert-value.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { realpathSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { pathHashId, resolveKernelProjectIdentity, normalizeRemoteUrl, sanitizeId } from '../src/kernel/project-identity.js';
import { openKernelStateStore } from '../src/kernel/state-store.js';
import {
  approveKernelProjectIdentityRepair,
  bootstrapKernelProjectIdentity as bootstrapKernelProjectIdentityCore,
  inspectKernelProjectIdentity,
  repairKernelProjectIdentity as repairKernelProjectIdentityCore,
} from '../src/kernel/project-identity-preflight.js';
import { createKernelControlPlane } from '../src/host/kernel/control-plane-runtime.js';
import { resolveStableWorkspaceIdentity } from '../src/host/kernel/workspace/stable-workspace.js';

const bootstrapKernelProjectIdentity = (options = {}) => bootstrapKernelProjectIdentityCore({
  ...options,
  resolveStableWorkspaceIdentity,
});
const repairKernelProjectIdentity = (options = {}) => repairKernelProjectIdentityCore({
  ...options,
  resolveStableWorkspaceIdentity,
});

const canonicalTestRoot = (value: string) => {
  const resolved = realpathSync(value).replaceAll('\\', '/');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};

const runGit = (cwd: string, args: string[]) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
};

test('resolveKernelProjectIdentity anchors identity to the workspace root and keeps origin as an alias', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'kernel-identity-test-'));
  const gitDir = path.join(tmp, '.git');
  await mkdir(gitDir, { recursive: true });
  await writeFile(path.join(gitDir, 'config'), '[remote "origin"]\n  url = git@github.com:myorg/my-cool-project.git\n');

  const result = resolveKernelProjectIdentity({ cwd: tmp, env: { MOON_RELAY_KERNEL_HOME: path.join(tmp, '.moon-relay-kernel') } });
  assert.match(result.projectId, /^path-[a-f0-9]{16}$/);
  assert.equal(result.identitySource, 'workspace_root');
  assert.deepEqual(result.aliases, ['https://github.com/myorg/my-cool-project']);
  assert.ok(result.identityDigest);
  assert.ok(result.namespaces.projectKnowledgeRoot.includes(result.projectId));
});

test('adding origin after the first resolution preserves projectId and identityDigest', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'kernel-identity-origin-migration-'));
  try {
    const gitDir = path.join(tmp, '.git');
    await mkdir(gitDir, { recursive: true });
    await writeFile(path.join(gitDir, 'config'), '[core]\n\trepositoryformatversion = 0\n');
    const env = { MOON_RELAY_KERNEL_HOME: path.join(tmp, '.moon-relay-kernel') };
    const before = resolveKernelProjectIdentity({ cwd: tmp, env });
    await writeFile(path.join(gitDir, 'config'), '[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = https://github.com/myorg/my-cool-project.git\n');
    const after = resolveKernelProjectIdentity({ cwd: tmp, env });
    assert.equal(after.projectId, before.projectId);
    assert.equal(after.identityDigest, before.identityDigest);
    assert.deepEqual(after.aliases, ['https://github.com/myorg/my-cool-project']);
    assert.ok(after.legacyProjectIds.includes('github-com-myorg-my-cool-project'));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('normalizeRemoteUrl normalizes git ssh and https URLs cleanly', () => {
  assert.equal(normalizeRemoteUrl('git@github.com:foo/bar.git'), 'https://github.com/foo/bar');
  assert.equal(normalizeRemoteUrl('https://github.com/foo/bar.git/'), 'https://github.com/foo/bar');
});

test('resolveKernelProjectIdentity prefers local project.identity.yaml when present', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'kernel-identity-test-'));
  const localDir = path.join(tmp, '.moon-relay');
  await mkdir(localDir, { recursive: true });
  await writeFile(path.join(localDir, 'project.identity.yaml'), 'projectId: explicit-project-id\n');

  const result = resolveKernelProjectIdentity({ cwd: tmp, env: { MOON_RELAY_KERNEL_HOME: path.join(tmp, '.moon-relay-kernel') } });
  assert.equal(result.projectId, 'explicit-project-id');
  assert.equal(result.identitySource, 'local_identity_file');
});

test('legacy project-aliases.json direct maps accept Windows backslash and forward-slash root keys', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'kernel-identity-alias-path-'));
  try {
    const stateDir = path.join(tmp, '.moon-relay-kernel', 'state');
    await mkdir(stateDir, { recursive: true });
    const resolved = path.resolve(tmp);
    const keys = [resolved.toLowerCase(), resolved.replaceAll('\\', '/').toLowerCase()];
    for (const key of keys) {
      await writeFile(path.join(stateDir, 'project-aliases.json'), JSON.stringify({
        [key]: { projectId: 'legacy-windows-identity', identitySource: 'account_alias_registry' },
      }));
      const result = resolveKernelProjectIdentity({ cwd: tmp, env: { MOON_RELAY_KERNEL_HOME: path.join(tmp, '.moon-relay-kernel') } });
      assert.equal(result.projectId, 'legacy-windows-identity');
      assert.equal(result.identitySource, 'account_alias_registry');
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('local identity changes retain persisted and path-derived lineage candidates for migration', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'kernel-identity-lineage-'));
  const runtimeHome = path.join(tmp, '.moon-relay-kernel');
  const legacyPersisted = 'legacy-persisted-lineage';
  try {
    await mkdir(path.join(tmp, '.git'), { recursive: true });
    await mkdir(path.join(tmp, '.moon-relay'), { recursive: true });
    await writeFile(path.join(tmp, '.moon-relay', 'project.identity.yaml'), 'projectId: explicit-lineage-project\n');
    await mkdir(path.join(runtimeHome, 'state'), { recursive: true });
    await writeFile(path.join(runtimeHome, 'state', 'project-aliases.json'), JSON.stringify({
      [path.resolve(tmp).toLowerCase()]: { projectId: legacyPersisted, identitySource: 'account_alias_registry' },
    }));

    const identity = resolveKernelProjectIdentity({ cwd: tmp, env: { MOON_RELAY_KERNEL_HOME: runtimeHome } });
    assert.equal(identity.projectId, 'explicit-lineage-project');
    assert.ok(identity.legacyProjectIds.includes(legacyPersisted));
    assert.ok(identity.legacyProjectIds.includes(pathHashId(tmp)));
    assert.ok(identity.legacyAliases.some((candidate) => candidate.projectId === legacyPersisted && candidate.source === 'persisted'));

    const store = await openKernelStateStore({ runtimeHome });
    try {
      store.createRun({ runId: 'persisted-lineage-run', objective: 'lineage', sourceIdentity: `sha256:${'a'.repeat(64)}`, projectId: legacyPersisted, workspaceId: 'persisted-lineage-workspace' });
      store.registerProjectWorkspace({
        workspaceId: 'persisted-lineage-workspace',
        canonicalRoot: canonicalTestRoot(tmp),
        gitCommonDir: null,
        gitWorktreeDir: null,
        identity: { projectId: legacyPersisted },
      });
      const registered = store.registerProjectIdentity(identity);
      assert.equal(assertTestPresent(registered).projectId, 'explicit-lineage-project');
      assert.equal(assertTestPresent(store.getRun('persisted-lineage-run')).projectId, 'explicit-lineage-project');
      assert.equal(assertTestPresent(store.getProjectIdentity({ alias: `project-id:${legacyPersisted}` })).projectId, 'explicit-lineage-project');
    } finally {
      store.close();
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('runtime identity registration is immutable, aliases are idempotent, and legacy project rows migrate atomically', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-identity-state-'));
  const workspaceRoot = path.join(runtimeHome, 'workspace');
  try {
    await mkdir(workspaceRoot, { recursive: true });
    const store = await openKernelStateStore({ runtimeHome });
    const sourceIdentity = `sha256:${'a'.repeat(64)}`;
    store.createRun({
      runId: 'legacy-identity-run',
      objective: 'legacy identity migration',
      sourceIdentity,
      projectId: 'github-com-myorg-my-cool-project',
      workspaceId: 'legacy-identity-workspace',
    });
    store.registerProjectWorkspace({
      workspaceId: 'legacy-identity-workspace',
      canonicalRoot: workspaceRoot,
      gitCommonDir: null,
      gitWorktreeDir: null,
      identity: { projectId: 'github-com-myorg-my-cool-project', canonicalRoot: workspaceRoot },
    });
    const first = store.registerProjectIdentity({
      projectId: 'path-immutable-project',
      canonicalRoot: workspaceRoot,
      identitySource: 'workspace_root',
      identityDigest: 'digest-immutable-project',
      aliases: [],
      legacyProjectIds: ['github-com-myorg-my-cool-project'],
      legacyAliases: [{ projectId: 'github-com-myorg-my-cool-project', source: 'origin' }],
    });
    const second = store.registerProjectIdentity({
      projectId: 'github-com-myorg-my-cool-project',
      canonicalRoot: workspaceRoot,
      identitySource: 'git_remote_origin',
      identityDigest: 'digest-must-not-replace',
      aliases: ['https://github.com/myorg/my-cool-project'],
      legacyProjectIds: [],
    });
    assert.equal(assertTestPresent(first).projectId, 'path-immutable-project');
    assert.equal(assertTestPresent(second).projectId, assertTestPresent(first).projectId);
    assert.equal(assertTestPresent(second).identityDigest, assertTestPresent(first).identityDigest);
    assert.deepEqual(assertTestPresent(second).aliases, ['https://github.com/myorg/my-cool-project']);
    assert.equal(assertTestPresent(store.getProjectIdentity({ alias: 'https://github.com/myorg/my-cool-project' })).projectId, assertTestPresent(first).projectId);
    assert.equal(assertTestPresent(store.getRun('legacy-identity-run')).projectId, assertTestPresent(first).projectId);
    const repeat = store.registerProjectIdentity({
      projectId: 'path-immutable-project',
      canonicalRoot: workspaceRoot,
      identitySource: 'workspace_root',
      identityDigest: assertTestPresent(first).identityDigest,
      aliases: ['https://github.com/myorg/my-cool-project'],
      legacyProjectIds: [],
    });
    assert.deepEqual(assertTestPresent(repeat).aliases, assertTestPresent(second).aliases);
    store.close();
  } finally {
    await rm(runtimeHome, { recursive: true, force: true });
  }
});

test('canonicalIdentityRoot preserves POSIX path casing on case-sensitive platforms', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'kernel-identity-case-AB12-'));
  try {
    const gitDir = path.join(tmp, '.git');
    await mkdir(gitDir, { recursive: true });
    await writeFile(path.join(gitDir, 'config'), '[core]\n\trepositoryformatversion = 0\n');
    const env = { MOON_RELAY_KERNEL_HOME: path.join(tmp, '.moon-relay-kernel') };
    const result = resolveKernelProjectIdentity({ cwd: tmp, env });
    if (process.platform !== 'win32') {
      assert.equal(result.canonicalRoot, realpathSync(tmp).replaceAll('\\', '/'));
    } else {
      assert.equal(result.canonicalRoot, path.resolve(tmp).replaceAll('\\', '/').toLowerCase());
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('identity preflight bootstraps a fresh namespace without a Kernel Run', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'kernel-identity-preflight-bootstrap-'));
  const runtimeHome = path.join(tmp, 'runtime');
  try {
    await mkdir(path.join(tmp, '.git'), { recursive: true });
    const before = await inspectKernelProjectIdentity({ projectRoot: tmp, runtimeHome });
    assert.equal(before.status, 'bootstrap_required');
    const bootstrapped = await bootstrapKernelProjectIdentity({ projectRoot: tmp, runtimeHome, policy: 'isolate' });
    assert.equal(bootstrapped.status, 'ready');
    assert.equal(bootstrapped.mutation, 'isolated');
    assert.ok(bootstrapped.workspaceId);
    assert.equal((await inspectKernelProjectIdentity({ projectRoot: tmp, runtimeHome })).status, 'ready');

    const store = await openKernelStateStore({ runtimeHome });
    try {
      assert.equal(store.listActiveRuns({ projectId: bootstrapped.projectId }).length, 0);
      assert.equal(assertTestPresent(store.getProjectIdentity({ canonicalRoot: path.resolve(tmp) })).projectId, bootstrapped.projectId);
    } finally {
      store.close();
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('linked worktree identity preflight reuses the proven logical project identity', async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'kernel-identity-linked-worktree-'));
  const repository = path.join(fixtureRoot, 'repository');
  const linkedWorktree = path.join(fixtureRoot, 'linked-worktree');
  const runtimeHome = path.join(fixtureRoot, 'runtime');
  try {
    await mkdir(repository, { recursive: true });
    await writeFile(path.join(repository, 'tracked.txt'), 'fixture\n');
    runGit(repository, ['init']);
    runGit(repository, ['config', 'user.email', 'kernel-test@example.invalid']);
    runGit(repository, ['config', 'user.name', 'Kernel Test']);
    runGit(repository, ['add', '.']);
    runGit(repository, ['commit', '-m', 'fixture']);
    runGit(repository, ['worktree', 'add', '-b', 'linked', linkedWorktree, 'HEAD']);

    const primary = await bootstrapKernelProjectIdentity({ projectRoot: repository, runtimeHome, policy: 'isolate' });
    const linked = await inspectKernelProjectIdentity({ projectRoot: linkedWorktree, runtimeHome });

    assert.equal(linked.status, 'ready');
    assert.equal(linked.projectId, primary.projectId);
    assert.equal(assertTestPresent(linked.identity).projectId, primary.projectId);
    assert.equal(assertTestPresent(linked.identity).canonicalRoot, canonicalTestRoot(repository));
    assert.notEqual(linked.canonicalRoot, assertTestPresent(linked.identity).canonicalRoot);

    const controlPlane = await createKernelControlPlane({
      runtimeHome,
      projectRoot: linkedWorktree,
      env: {
        MOON_RELAY_KERNEL_HOME: runtimeHome,
        MOON_RELAY_KERNEL_PROVIDER: 'codex',
        MOON_RELAY_KERNEL_SESSION_ID: 'codex:linked-worktree-preflight',
      },
      requireHostBinding: false,
    });
    await controlPlane.close();
  } finally {
    try { runGit(repository, ['worktree', 'remove', '--force', linkedWorktree]); } catch {}
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test('identity preflight isolates unowned legacy data and preserves it', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'kernel-identity-preflight-legacy-'));
  const runtimeHome = path.join(tmp, 'runtime');
  const legacyProjectId = 'github-com-example-legacy-project';
  try {
    await mkdir(path.join(tmp, '.git'), { recursive: true });
    await writeFile(path.join(tmp, '.git', 'config'), '[remote "origin"]\n  url = https://github.com/example/legacy-project.git\n');
    const store = await openKernelStateStore({ runtimeHome });
    store.createRun({
      runId: 'legacy-unowned-run',
      objective: 'legacy state',
      sourceIdentity: `sha256:${'b'.repeat(64)}`,
      projectId: legacyProjectId,
    });
    store.close();

    const before = await inspectKernelProjectIdentity({ projectRoot: tmp, runtimeHome });
    assert.equal(before.status, 'repair_required');
    assert.equal(before.unresolvedLegacyCandidates[0].projectId, legacyProjectId);
    const isolated = await bootstrapKernelProjectIdentity({ projectRoot: tmp, runtimeHome, policy: 'isolate' });
    assert.equal(isolated.legacyState, 'preserved-unimported');
    assert.notEqual(isolated.projectId, legacyProjectId);

    const afterStore = await openKernelStateStore({ runtimeHome });
    try {
      assert.equal(assertTestPresent(afterStore.getRun('legacy-unowned-run')).projectId, legacyProjectId);
      assert.equal(assertTestPresent(afterStore.getProjectIdentity({ canonicalRoot: path.resolve(tmp) })).projectId, isolated.projectId);
    } finally {
      afterStore.close();
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('identity repair adopts a selected legacy namespace only with an approval reference', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'kernel-identity-preflight-repair-'));
  const runtimeHome = path.join(tmp, 'runtime');
  const legacyProjectId = 'github-com-example-approved-project';
  try {
    await mkdir(path.join(tmp, '.git'), { recursive: true });
    await writeFile(path.join(tmp, '.git', 'config'), '[remote "origin"]\n  url = https://github.com/example/approved-project.git\n');
    const store = await openKernelStateStore({ runtimeHome });
    store.createRun({
      runId: 'legacy-approved-run',
      objective: 'legacy state',
      sourceIdentity: `sha256:${'c'.repeat(64)}`,
      projectId: legacyProjectId,
    });
    store.close();

    await assert.rejects(
      repairKernelProjectIdentity({ projectRoot: tmp, runtimeHome, legacyProjectId }),
      (error) => assertTestRecord(error).code === 'project_identity_approval_required',
    );
    const approval = await approveKernelProjectIdentityRepair({
      projectRoot: tmp,
      runtimeHome,
      legacyProjectId,
      approvalRef: 'operator:approved-project',
      approvedBy: os.userInfo().username,
    });
    assert.equal(approval.status, 'approved');
    const repaired = await repairKernelProjectIdentity({
      projectRoot: tmp,
      runtimeHome,
      legacyProjectId,
      approvalRef: 'operator:approved-project',
    });
    assert.equal(repaired.status, 'ready');
    assert.equal(repaired.projectId, legacyProjectId);
    assert.equal(repaired.legacyState, 'retained-under-adopted-id');
    assert.equal(repaired.approval.approvedBy, os.userInfo().username);
    assert.deepEqual(repaired.approval.signer, { kind: 'os-user', username: os.userInfo().username, uid: typeof process.getuid === 'function' ? String(process.getuid()) : null });
    assert.match(assertTestString(repaired.approval.approvalDigest), /^hmac-sha256:/);
    assert.deepEqual(repaired.receipt.signer, repaired.approval.signer);
    assert.ok(repaired.receipt.path);

    const afterStore = await openKernelStateStore({ runtimeHome });
    try {
      assert.equal(assertTestPresent(afterStore.getProjectIdentity({ canonicalRoot: path.resolve(tmp) })).projectId, legacyProjectId);
      assert.equal(assertTestPresent(afterStore.getRun('legacy-approved-run')).projectId, legacyProjectId);
      assert.ok(afterStore.getProjectWorkspace(repaired.workspaceId));
    } finally {
      afterStore.close();
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

type TestControlPlane = Awaited<ReturnType<typeof import('../src/host/kernel/control-plane-runtime.js').createKernelControlPlane>>;
type TestStateStore = Awaited<ReturnType<typeof import('../src/kernel/state-store.js').openKernelStateStore>>;
