import assert from 'node:assert/strict'; import {spawnSync} from 'node:child_process'; import {existsSync} from 'node:fs'; import {readFile, mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises'; import {test} from 'node:test';
const schema=JSON.parse(await readFile(new URL('../schemas/kernel.track.schema.json',import.meta.url),'utf8'));
test('track schema is closed and distinguishes Relay and Kernel',()=>{assert.equal(schema.additionalProperties,false); assert.deepEqual(schema.properties.track.enum,['relay','kernel']); assert.equal(schema.properties.schemaVersion.const,1);});
test('wrong harness contract is present in eval corpus',async()=>{const c=JSON.parse(await readFile(new URL('./fixtures/kernel-eval/corpus.json',import.meta.url),'utf8')); assert.ok(c.cases.some((x: { requiredEvidence: string[] })=>x.requiredEvidence.includes('wrong-harness-receipt')));});

// The switcher establishes the track process-scoped (MOON_RELAY_TRACK) instead
// of writing a marker into the workspace, so account-root installs work without
// any per-project `.moon-relay` directory.
test('active track resolves from the switcher session when no marker exists', async () => {
  const {readProjectTrack, readProjectTrackSync} = await import('../src/kernel/runtime-home.js');
  const os = await import('node:os'); const path = await import('node:path');
  const root = await mkdtemp(path.join(os.tmpdir(), 'krn-track-'));

  assert.equal(await readProjectTrack(root, {env: {}}), null, 'nothing declares a track');
  assert.equal(await readProjectTrack(root, {env: {MOON_RELAY_TRACK: 'kernel'}}), 'kernel');
  assert.equal(await readProjectTrack(root, {env: {MOON_RELAY_TRACK: 'relay'}}), 'relay');
  assert.equal(readProjectTrackSync(root, {env: {MOON_RELAY_TRACK: 'kernel'}}), 'kernel');
  assert.equal(await readProjectTrack(root, {env: {MOON_RELAY_TRACK: 'bogus'}}), null, 'an unknown value is not a track');

  // An explicit repository declaration outranks the ambient session, so a repo
  // pinned to one track is never hijacked by a session on the other.
  await mkdir(path.join(root, '.moon-relay'), {recursive: true});
  await writeFile(path.join(root, '.moon-relay', 'track.yaml'), 'schemaVersion: 1\ntrack: relay\n');
  assert.equal(await readProjectTrack(root, {env: {MOON_RELAY_TRACK: 'kernel'}}), 'relay');
  assert.equal(readProjectTrackSync(root, {env: {MOON_RELAY_TRACK: 'kernel'}}), 'relay');
});

test('account-root track binding is created per project root without a repository marker', async () => {
  const { ensureAccountRootTrack, readProjectTrack, resolveProjectTrack, trackRegistryPath, resolveProjectTrackScope } = await import('../src/kernel/runtime-home.js');
  const os = await import('node:os'); const path = await import('node:path');
  const home = await mkdtemp(path.join(os.tmpdir(), 'krn-track-home-'));
  const first = await mkdtemp(path.join(os.tmpdir(), 'krn-track-project-a-'));
  const second = await mkdtemp(path.join(os.tmpdir(), 'krn-track-project-b-'));
  const env = { MOON_RELAY_KERNEL_HOME: home, MOON_RELAY_TRACK: '' };
  try {
    await mkdir(path.join(home, '.moon-relay'), { recursive: true });
    await writeFile(path.join(home, '.moon-relay', 'track.yaml'), 'schemaVersion: 1\ntrack: kernel\nproduct: moon-relay-kernel\n');

    const before = await resolveProjectTrack(first, { env, allowAccountRootDefault: true });
    assert.equal(before.track, 'kernel');
    assert.equal(before.source, 'account_root_runtime');
    assert.equal(before.registered, false);
    assert.equal(existsSync(path.join(first, '.moon-relay', 'track.yaml')), false);

    const firstBinding = await ensureAccountRootTrack({ startDir: first, env, projectId: 'project-a', workspaceId: 'workspace-a' });
    const secondBinding = await ensureAccountRootTrack({ startDir: second, env, projectId: 'project-b', workspaceId: 'workspace-b' });
    assert.equal(firstBinding.status, 'registered');
    assert.equal(secondBinding.status, 'registered');
    assert.notEqual(firstBinding.scope.scopeKey, secondBinding.scope.scopeKey);
    assert.notEqual(firstBinding.registryPath, secondBinding.registryPath);
    assert.equal(existsSync(path.join(first, '.moon-relay')), false);
    assert.equal(existsSync(path.join(second, '.moon-relay')), false);
    assert.equal(await readProjectTrack(first, { env }), 'kernel');
    assert.equal((await resolveProjectTrack(first, { env })).source, 'account_root_scope');
    assert.equal((await resolveProjectTrack(second, { env })).source, 'account_root_scope');
    assert.equal((await readFile(firstBinding.registryPath, 'utf8')).includes('"projectId": "project-a"'), true);
    assert.equal(trackRegistryPath({ runtimeHome: home, scope: resolveProjectTrackScope(first) }), firstBinding.registryPath);
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(first, { recursive: true, force: true });
    await rm(second, { recursive: true, force: true });
  }
});

test('a repository Relay marker remains a fail-closed boundary over the account-root Kernel default', async () => {
  const { ensureAccountRootTrack, resolveProjectTrack } = await import('../src/kernel/runtime-home.js');
  const os = await import('node:os'); const path = await import('node:path');
  const home = await mkdtemp(path.join(os.tmpdir(), 'krn-track-home-relay-'));
  const project = await mkdtemp(path.join(os.tmpdir(), 'krn-track-project-relay-'));
  const env = { MOON_RELAY_KERNEL_HOME: home, MOON_RELAY_TRACK: '' };
  try {
    await mkdir(path.join(home, '.moon-relay'), { recursive: true });
    await writeFile(path.join(home, '.moon-relay', 'track.yaml'), 'schemaVersion: 1\ntrack: kernel\nproduct: moon-relay-kernel\n');
    await mkdir(path.join(project, '.moon-relay'), { recursive: true });
    await writeFile(path.join(project, '.moon-relay', 'track.yaml'), 'schemaVersion: 1\ntrack: relay\nproduct: moonshot-relay\n');
    const resolution = await resolveProjectTrack(project, { env, allowAccountRootDefault: true });
    assert.equal(resolution.track, 'relay');
    assert.equal(resolution.source, 'project_marker');
    await assert.rejects(
      () => ensureAccountRootTrack({ startDir: project, env }),
      (error) => error instanceof Error && 'code' in error && error.code === 'wrong_harness',
    );
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  }
});

test('linked Git worktrees receive distinct account-root track scopes', async () => {
  const { ensureAccountRootTrack, resolveProjectTrackScope } = await import('../src/kernel/runtime-home.js');
  const os = await import('node:os'); const path = await import('node:path');
  const runtime = await mkdtemp(path.join(os.tmpdir(), 'krn-track-worktree-home-'));
  const repo = await mkdtemp(path.join(os.tmpdir(), 'krn-track-worktree-repo-'));
  const worktree = path.join(path.dirname(repo), `${path.basename(repo)}-linked`);
  const env = { MOON_RELAY_KERNEL_HOME: runtime, MOON_RELAY_TRACK: '' };
  const git = (cwd: string, args: string[]) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr || ''}`);
    return result;
  };
  try {
    await mkdir(path.join(runtime, '.moon-relay'), { recursive: true });
    await writeFile(path.join(runtime, '.moon-relay', 'track.yaml'), 'schemaVersion: 1\ntrack: kernel\nproduct: moon-relay-kernel\n');
    git(repo, ['init', '--initial-branch', 'main']);
    git(repo, ['config', 'user.email', 'kernel-test@example.invalid']);
    git(repo, ['config', 'user.name', 'Kernel Test']);
    git(repo, ['commit', '--allow-empty', '-m', 'initial']);
    git(repo, ['worktree', 'add', '--detach', worktree, 'HEAD']);

    const base = resolveProjectTrackScope(repo);
    const linked = resolveProjectTrackScope(worktree);
    assert.equal(base.gitCommonDir, linked.gitCommonDir);
    assert.notEqual(base.gitWorktreeDir, linked.gitWorktreeDir);
    assert.notEqual(base.scopeKey, linked.scopeKey);
    const baseBinding = await ensureAccountRootTrack({ startDir: repo, env });
    const linkedBinding = await ensureAccountRootTrack({ startDir: worktree, env });
    assert.notEqual(baseBinding.registryPath, linkedBinding.registryPath);
  } finally {
    spawnSync('git', ['worktree', 'remove', '--force', worktree], { cwd: repo, encoding: 'utf8', windowsHide: true });
    await rm(worktree, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
    await rm(runtime, { recursive: true, force: true });
  }
});
