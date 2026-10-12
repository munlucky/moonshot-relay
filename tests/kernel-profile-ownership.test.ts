import { assertTestPresent, assertTestRecord, assertTestString } from './helpers/assert-value.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { access, constants } from 'node:fs';
import { cp, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { installKernelAccountRoot, installKernelProfile, inspectProfile, profileManifestPath, uninstallKernelProfile, PROFILE_PRODUCT_ID } from '../src/kernel/profile-install.js';
import { materializeKernelMcpLauncher } from '../src/kernel/installer.js';

const tempRoots: string[] = [];

test.after(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
});

test('Provider projection preserves shared data and uninstall removes only Kernel-owned sections and paths', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'kernel-profile-ownership-'));
  tempRoots.push(home);
  const targetRoot = path.join(home, '.claude');
  const runtimeHome = path.join(home, '.moon-relay-kernel');
  await mkdir(path.join(targetRoot, 'skills', 'user-skill'), { recursive: true });
  await mkdir(path.join(targetRoot, 'sessions'), { recursive: true });
  await mkdir(path.join(targetRoot, 'cache'), { recursive: true });
  await writeFile(path.join(targetRoot, 'CLAUDE.md'), '# User instructions\n');
  await writeFile(path.join(targetRoot, 'auth.json'), '{"user":true}\n');
  await writeFile(path.join(targetRoot, 'sessions', 'session.jsonl'), 'session\n');
  await writeFile(path.join(targetRoot, 'cache', 'cache.db'), 'cache\n');
  await writeFile(path.join(targetRoot, 'skills', 'user-skill', 'SKILL.md'), '# user skill\n');
  await writeFile(path.join(targetRoot, 'settings.json'), JSON.stringify({ mcpServers: { foreign: { command: 'foreign-server' } } }, null, 2));

  const first = await installKernelProfile({ sourceRoot: process.cwd(), runtime: 'claude', targetRoot, runtimeHome });
  assert.equal(first.status, 'installed');
  const settings = JSON.parse(await readFile(path.join(targetRoot, 'settings.json'), 'utf8'));
  assert.equal(settings.mcpServers.foreign.command, 'foreign-server');
  assert.equal(settings.mcpServers['moon-relay-kernel'].args.length, 0);
  assert.equal(path.isAbsolute(settings.mcpServers['moon-relay-kernel'].command), true);

  await writeFile(path.join(targetRoot, 'CLAUDE.md'), `${await readFile(path.join(targetRoot, 'CLAUDE.md'), 'utf8')}\n# User addition\n`);
  const afterUserEdit = JSON.parse(await readFile(path.join(targetRoot, 'settings.json'), 'utf8'));
  afterUserEdit.mcpServers.foreign.extra = 'preserve';
  await writeFile(path.join(targetRoot, 'settings.json'), `${JSON.stringify(afterUserEdit, null, 2)}\n`);
  assert.equal((await inspectProfile(targetRoot)).status, 'ready');
  assert.equal((await installKernelProfile({ sourceRoot: process.cwd(), runtime: 'claude', targetRoot, runtimeHome })).status, 'already_current');

  const uninstall = await uninstallKernelProfile({ targetRoot });
  assert.equal(uninstall.status, 'uninstalled');
  assert.match(await readFile(path.join(targetRoot, 'CLAUDE.md'), 'utf8'), /# User instructions/);
  assert.match(await readFile(path.join(targetRoot, 'CLAUDE.md'), 'utf8'), /# User addition/);
  const settingsAfter = JSON.parse(await readFile(path.join(targetRoot, 'settings.json'), 'utf8'));
  assert.deepEqual(settingsAfter, { mcpServers: { foreign: { command: 'foreign-server', extra: 'preserve' } } });
  assert.equal(await readFile(path.join(targetRoot, 'auth.json'), 'utf8'), '{"user":true}\n');
  assert.equal(await readFile(path.join(targetRoot, 'sessions', 'session.jsonl'), 'utf8'), 'session\n');
  assert.equal(await readFile(path.join(targetRoot, 'cache', 'cache.db'), 'utf8'), 'cache\n');
  assert.equal(await readFile(path.join(targetRoot, 'skills', 'user-skill', 'SKILL.md'), 'utf8'), '# user skill\n');
});

test('uninstall fails closed with ownership diagnostics when a Kernel JSON path is modified', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'kernel-profile-collision-'));
  tempRoots.push(home);
  const targetRoot = path.join(home, '.claude');
  await installKernelProfile({ sourceRoot: process.cwd(), runtime: 'claude', targetRoot, runtimeHome: path.join(home, 'kernel') });
  const settingsPath = path.join(targetRoot, 'settings.json');
  const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
  settings.mcpServers['moon-relay-kernel'].command = 'user-modified';
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  const uninstall = await uninstallKernelProfile({ targetRoot });
  assert.equal(uninstall.status, 'collision');
  assert.equal(assertTestRecord(uninstall).path, 'settings.json');
  assert.equal(assertTestRecord(uninstall).ownership, 'json-paths');
  assert.equal(assertTestRecord(uninstall).reason, 'owned-path-modified');
  assert.match(await readFile(settingsPath, 'utf8'), /user-modified/);
});

test('uninstall preserves a pre-existing identical owned file', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'kernel-profile-preexisting-file-'));
  tempRoots.push(home);
  const targetRoot = path.join(home, '.claude');
  const targetSkill = path.join(targetRoot, 'skills', 'moon-relay-kernel', 'SKILL.md');
  const sourceSkill = path.join(process.cwd(), 'skills', 'moon-relay-kernel', 'SKILL.md');
  await mkdir(path.dirname(targetSkill), { recursive: true });
  await cp(sourceSkill, targetSkill);

  const installed = await installKernelProfile({ sourceRoot: process.cwd(), runtime: 'claude', targetRoot, runtimeHome: path.join(home, 'runtime') });
  const skillEntry = JSON.parse(assertTestString(await readFile(assertTestPresent(installed.manifestPath), 'utf8'))).files.find((entry: unknown) => assertTestRecord(entry).path === 'skills/moon-relay-kernel/SKILL.md');
  assert.equal(skillEntry.createdByKernel, false);
  assert.equal((await uninstallKernelProfile({ targetRoot })).status, 'uninstalled');
  assert.equal(await readFile(targetSkill, 'utf8'), await readFile(sourceSkill, 'utf8'));
});

test('sync does not overwrite an untrusted pre-existing provider skill file', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'kernel-profile-sync-collision-'));
  tempRoots.push(home);
  const targetRoot = path.join(home, '.claude');
  const targetSkill = path.join(targetRoot, 'skills', 'moon-relay-kernel', 'SKILL.md');
  const before = '# User-owned skill\n';
  await mkdir(path.dirname(targetSkill), { recursive: true });
  await writeFile(targetSkill, before);

  const result = await installKernelProfile({
    sourceRoot: process.cwd(),
    runtime: 'claude',
    targetRoot,
    runtimeHome: path.join(home, 'runtime'),
    force: true,
  });

  assert.equal(result.status, 'collision');
  const skillCollision = assertTestPresent(result.collisions).find((entry) => entry.path === 'skills/moon-relay-kernel/SKILL.md');
  assert.equal(skillCollision?.reason, 'existing-owned-file-without-manifest');
  assert.equal(await readFile(targetSkill, 'utf8'), before);
});

test('sync does not trust a profile manifest without its paired Kernel marker', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'kernel-profile-manifest-without-marker-'));
  tempRoots.push(home);
  const targetRoot = path.join(home, '.claude');
  const targetSkill = path.join(targetRoot, 'skills', 'moon-relay-kernel', 'SKILL.md');
  const before = '# User-owned skill with copied manifest\n';
  await mkdir(path.dirname(targetSkill), { recursive: true });
  await writeFile(targetSkill, before);
  await writeFile(profileManifestPath(targetRoot), `${JSON.stringify({
    schemaVersion: 2,
    productId: PROFILE_PRODUCT_ID,
    runtime: 'moon-relay-kernel',
    provider: 'claude',
    targetRoot,
    files: [{
      path: 'skills/moon-relay-kernel/SKILL.md',
      ownership: 'owned-file',
      checksum: '0'.repeat(64),
    }],
  }, null, 2)}\n`);

  const result = await installKernelProfile({
    sourceRoot: process.cwd(),
    runtime: 'claude',
    targetRoot,
    runtimeHome: path.join(home, 'runtime'),
    force: true,
  });

  assert.equal(result.status, 'collision');
  const skillCollision = assertTestPresent(result.collisions).find((entry) => entry.path === 'skills/moon-relay-kernel/SKILL.md');
  assert.equal(skillCollision?.reason, 'existing-owned-file-without-manifest');
  assert.equal(await readFile(targetSkill, 'utf8'), before);
});

test('sync updates a trusted Kernel-owned projection after the canonical source changes', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'kernel-profile-sync-owned-'));
  tempRoots.push(home);
  const sourceRoot = path.join(home, 'source');
  const targetRoot = path.join(home, '.claude');
  await cp(path.join(process.cwd(), 'skills', 'moon-relay-kernel'), path.join(sourceRoot, 'skills', 'moon-relay-kernel'), { recursive: true });
  await cp(path.join(process.cwd(), 'package', 'kernel', 'profiles', 'claude'), path.join(sourceRoot, 'package', 'kernel', 'profiles', 'claude'), { recursive: true });

  await installKernelProfile({ sourceRoot, runtime: 'claude', targetRoot, runtimeHome: path.join(home, 'runtime') });
  const sourceInstructions = path.join(sourceRoot, 'package', 'kernel', 'profiles', 'claude', 'CLAUDE.md');
  await writeFile(sourceInstructions, `${await readFile(sourceInstructions, 'utf8')}\nTrusted sync revision\n`);

  const result = await installKernelProfile({
    sourceRoot,
    runtime: 'claude',
    targetRoot,
    runtimeHome: path.join(home, 'runtime'),
    force: true,
  });

  assert.equal(result.status, 'reinstalled');
  assert.match(await readFile(path.join(targetRoot, 'CLAUDE.md'), 'utf8'), /Trusted sync revision/);
});

test('account-root sync does not overwrite an untrusted pre-existing standalone skill file', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'kernel-account-sync-collision-'));
  tempRoots.push(home);
  const targetRoot = path.join(home, '.codex');
  const targetSkill = path.join(targetRoot, 'skills', 'project-memory', 'SKILL.md');
  const before = '# User-owned standalone skill\n';
  await mkdir(path.dirname(targetSkill), { recursive: true });
  await writeFile(targetSkill, before);

  const result = await installKernelAccountRoot({
    sourceRoot: process.cwd(),
    targetRoot,
    runtimeHome: path.join(home, 'runtime'),
    force: true,
  });

  assert.equal(result.status, 'collision');
  const skillCollision = assertTestPresent(result.collisions).find((entry) => entry.path === 'skills/project-memory/SKILL.md');
  assert.equal(skillCollision?.reason, 'existing-owned-file-without-manifest');
  assert.equal(await readFile(targetSkill, 'utf8'), before);
});

test('owned-directory uninstall verifies every declared child before removal', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'kernel-profile-directory-'));
  tempRoots.push(home);
  const targetRoot = path.join(home, '.profile');
  const ownedDirectory = path.join(targetRoot, 'skills', 'moon-relay-kernel');
  const ownedFile = path.join(ownedDirectory, 'SKILL.md');
  await mkdir(ownedDirectory, { recursive: true });
  await writeFile(ownedFile, '# Kernel skill\n');
  const checksum = createHash('sha256').update(await readFile(ownedFile)).digest('hex');
  await writeFile(profileManifestPath(targetRoot), `${JSON.stringify({
    schemaVersion: 2,
    productId: 'moon-relay-kernel-profile',
    files: [{
      path: 'skills/moon-relay-kernel',
      ownership: 'owned-directory',
      children: [{ path: 'SKILL.md', checksum }],
    }],
  }, null, 2)}\n`);

  assert.equal((await inspectProfile(targetRoot)).status, 'ready');
  await writeFile(ownedFile, '# User-modified skill\n');
  const collision = await uninstallKernelProfile({ targetRoot });
  assert.equal(collision.status, 'collision');
  assert.equal(assertTestRecord(collision).path, 'skills/moon-relay-kernel');
  assert.equal(assertTestRecord(collision).ownership, 'owned-directory');
  assert.equal(assertTestRecord(collision).reason, 'modified-owned-directory');
  assert.equal(await readFile(ownedFile, 'utf8'), '# User-modified skill\n');

  await writeFile(ownedFile, '# Kernel skill\n');
  const removed = await uninstallKernelProfile({ targetRoot });
  assert.equal(removed.status, 'uninstalled');
  assert.equal(await inspectProfile(targetRoot).then((result) => result.status), 'not_installed');
});

test('legacy account-root manifests require an ownership-aware reinstall before uninstall', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'kernel-profile-legacy-account-'));
  tempRoots.push(home);
  const targetRoot = path.join(home, '.codex');
  const agentsPath = path.join(targetRoot, 'AGENTS.md');
  await mkdir(targetRoot, { recursive: true });
  await writeFile(agentsPath, '# User guidance\n');
  await writeFile(profileManifestPath(targetRoot), `${JSON.stringify({
    schemaVersion: 1,
    productId: 'moon-relay-kernel-profile',
    layout: 'account-root-direct',
    files: [{ path: 'AGENTS.md', checksum: 'legacy' }],
  }, null, 2)}\n`);

  const result = await uninstallKernelProfile({ targetRoot });
  assert.equal(result.status, 'collision');
  assert.equal(assertTestRecord(result).path, 'AGENTS.md');
  assert.equal(assertTestRecord(result).ownership, 'owned-file');
  assert.equal(assertTestRecord(result).reason, 'legacy-account-manifest-requires-reinstall');
  assert.equal(await readFile(agentsPath, 'utf8'), '# User guidance\n');
});

test('generic profile source changes reproject the managed section while preserving user text', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'kernel-profile-source-change-'));
  tempRoots.push(home);
  const sourceRoot = path.join(home, 'source');
  const targetRoot = path.join(home, '.claude');
  await cp(path.join(process.cwd(), 'skills', 'moon-relay-kernel'), path.join(sourceRoot, 'skills', 'moon-relay-kernel'), { recursive: true });
  await cp(path.join(process.cwd(), 'package', 'kernel', 'profiles', 'claude'), path.join(sourceRoot, 'package', 'kernel', 'profiles', 'claude'), { recursive: true });

  await installKernelProfile({ sourceRoot, runtime: 'claude', targetRoot, runtimeHome: path.join(home, 'runtime') });
  await writeFile(path.join(targetRoot, 'CLAUDE.md'), `${await readFile(path.join(targetRoot, 'CLAUDE.md'), 'utf8')}\n# User text\n`);
  const sourceInstructions = path.join(sourceRoot, 'package', 'kernel', 'profiles', 'claude', 'CLAUDE.md');
  await writeFile(sourceInstructions, `${await readFile(sourceInstructions, 'utf8')}\nSource revision\n`);

  const result = await installKernelProfile({ sourceRoot, runtime: 'claude', targetRoot, runtimeHome: path.join(home, 'runtime') });
  assert.equal(result.status, 'reinstalled');
  const targetText = await readFile(path.join(targetRoot, 'CLAUDE.md'), 'utf8');
  assert.match(targetText, /# User text/);
  assert.match(targetText, /Source revision/);
});

test('shared JSON container shape collisions fail closed without overwriting user data', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'kernel-profile-json-shape-'));
  tempRoots.push(home);
  const targetRoot = path.join(home, '.claude');
  const settingsPath = path.join(targetRoot, 'settings.json');
  await mkdir(targetRoot, { recursive: true });
  const original = JSON.stringify({ mcpServers: 'user-owned-value' }, null, 2);
  await writeFile(settingsPath, original);

  const result = await installKernelProfile({ sourceRoot: process.cwd(), runtime: 'claude', targetRoot, runtimeHome: path.join(home, 'runtime') });
  assert.equal(result.status, 'collision');
  assert.equal(assertTestPresent(result.collisions)[0].ownership, 'json-paths');
  assert.equal(assertTestPresent(result.collisions)[0].reason, 'json-path-container-invalid');
  assert.equal(await readFile(settingsPath, 'utf8'), original);
});

test('profile projection rejects symlinked descendant paths before writing', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'kernel-profile-symlink-descendant-'));
  tempRoots.push(home);
  const targetRoot = path.join(home, '.claude');
  const externalRoot = path.join(home, 'outside');
  await mkdir(targetRoot, { recursive: true });
  await mkdir(externalRoot, { recursive: true });
  await symlink(externalRoot, path.join(targetRoot, 'skills'), process.platform === 'win32' ? 'junction' : 'dir');

  await assert.rejects(
    installKernelProfile({ sourceRoot: process.cwd(), runtime: 'claude', targetRoot, runtimeHome: path.join(home, 'runtime') }),
    /unsafe_target: symlinked profile path/,
  );
  assert.equal((await readdir(externalRoot)).length, 0);
  await assert.rejects(readFile(path.join(targetRoot, '.moon-relay-kernel-profile.json')), /ENOENT/);
});

test('absolute MCP launcher uses the selected installed Node and speaks stdio MCP', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'kernel-mcp-%-launcher-'));
  tempRoots.push(home);
  const launcher = await materializeKernelMcpLauncher({
    runtimeHome: home,
    entrypoint: path.join(process.cwd(), 'bin', 'moon-relay-kernel.mjs'),
    managedNodePath: process.execPath,
  });
  assert.equal(path.isAbsolute(launcher.launcherPath), true);
  assert.equal(path.isAbsolute(launcher.nodePath), true);
  const content = await readFile(launcher.launcherPath, 'utf8');
  assert.match(content, /mcp-bridge/);
  assert.match(content, new RegExp(process.execPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  if (process.platform === 'win32' && launcher.nodePath.includes('%')) assert.match(content, /%%/);
  if (process.platform !== 'win32') await new Promise<void>((resolve, reject) => access(launcher.launcherPath, constants.X_OK, (error) => error ? reject(error) : resolve()));

  const child = spawnSync(launcher.launcherPath, [], {
    cwd: home,
    env: { ...process.env, MOON_RELAY_KERNEL_HOME: home },
    encoding: 'utf8',
    input: '{"jsonrpc":"2.0","id":1,"method":"initialize"}\n{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n',
    shell: process.platform === 'win32',
    timeout: 10000,
  });
  assert.equal(child.status, 0, child.stderr);
  const responses = child.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.equal(responses[0].result.serverInfo.name, 'moon-relay-kernel-bridge');
  assert.ok(responses[1].result.tools.some((tool: unknown) => assertTestRecord(tool).name === 'kernel_next'));
});

test('antigravity profile with external skillsRoot uninstalls external skill files cleanly', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'kernel-external-skills-uninstall-'));
  tempRoots.push(home);
  const targetRoot = path.join(home, 'antigravity');
  const skillsRoot = path.join(home, 'external-skills');
  const runtimeHome = path.join(home, 'runtime');

  const installed = await installKernelProfile({
    sourceRoot: process.cwd(),
    runtime: 'antigravity',
    targetRoot,
    skillsRoot,
    runtimeHome,
  });
  assert.equal(installed.status, 'installed');
  const externalSkillFile = path.join(skillsRoot, 'skills', 'moon-relay-kernel', 'SKILL.md');
  assert.equal(await readFile(externalSkillFile, 'utf8') !== '', true);

  const uninstalled = await uninstallKernelProfile({ targetRoot });
  assert.equal(uninstalled.status, 'uninstalled');
  await assert.rejects(readFile(externalSkillFile), /ENOENT/);
});

test('antigravity profile reinstall with different skillsRoot updates location instead of already_current', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'kernel-external-skills-change-'));
  tempRoots.push(home);
  const targetRoot = path.join(home, 'antigravity');
  const skillsRootA = path.join(home, 'skills-a');
  const skillsRootB = path.join(home, 'skills-b');
  const runtimeHome = path.join(home, 'runtime');

  const first = await installKernelProfile({
    sourceRoot: process.cwd(),
    runtime: 'antigravity',
    targetRoot,
    skillsRoot: skillsRootA,
    runtimeHome,
  });
  assert.equal(first.status, 'installed');
  assert.equal(await readFile(path.join(skillsRootA, 'skills', 'moon-relay-kernel', 'SKILL.md'), 'utf8') !== '', true);

  const second = await installKernelProfile({
    sourceRoot: process.cwd(),
    runtime: 'antigravity',
    targetRoot,
    skillsRoot: skillsRootB,
    runtimeHome,
  });
  assert.equal(second.status, 'reinstalled');
  assert.equal(await readFile(path.join(skillsRootB, 'skills', 'moon-relay-kernel', 'SKILL.md'), 'utf8') !== '', true);
});

test('installing account-root layout over provider profile fails closed and rejects layout collision', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'kernel-layout-collision-'));
  tempRoots.push(home);
  const targetRoot = path.join(home, '.codex');
  const runtimeHome = path.join(home, 'runtime');

  const providerInstall = await installKernelProfile({
    sourceRoot: process.cwd(),
    runtime: 'codex',
    targetRoot,
    runtimeHome,
  });
  assert.equal(providerInstall.status, 'installed');

  await assert.rejects(
    installKernelAccountRoot({
      sourceRoot: process.cwd(),
      runtime: 'codex',
      targetRoot,
      runtimeHome,
    }),
    /target_collision: foreign or non-account-root Kernel profile manifest/,
  );
});

test('antigravity profile reinstall with external skillsRoot updates canonical skill files when source changes', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'kernel-external-skills-update-'));
  tempRoots.push(home);
  const targetRoot = path.join(home, 'antigravity');
  const skillsRoot = path.join(home, 'external-skills');
  const runtimeHome = path.join(home, 'runtime');
  const sourceRoot = path.join(home, 'source');

  await cp(path.join(process.cwd(), 'skills', 'moon-relay-kernel'), path.join(sourceRoot, 'skills', 'moon-relay-kernel'), { recursive: true });
  await cp(path.join(process.cwd(), 'package', 'kernel', 'profiles', 'antigravity'), path.join(sourceRoot, 'package', 'kernel', 'profiles', 'antigravity'), { recursive: true });

  const first = await installKernelProfile({
    sourceRoot,
    runtime: 'antigravity',
    targetRoot,
    skillsRoot,
    runtimeHome,
  });
  assert.equal(first.status, 'installed');

  const sourceSkill = path.join(sourceRoot, 'skills', 'moon-relay-kernel', 'SKILL.md');
  await writeFile(sourceSkill, `${await readFile(sourceSkill, 'utf8')}\nUpdated canonical skill\n`);

  const second = await installKernelProfile({
    sourceRoot,
    runtime: 'antigravity',
    targetRoot,
    skillsRoot,
    runtimeHome,
    force: true,
  });
  assert.equal(second.status, 'reinstalled');
  const installedSkill = path.join(skillsRoot, 'skills', 'moon-relay-kernel', 'SKILL.md');
  assert.match(await readFile(installedSkill, 'utf8'), /Updated canonical skill/);
});


type TestControlPlane = Awaited<ReturnType<typeof import('../src/host/kernel/control-plane-runtime.js').createKernelControlPlane>>;
type TestStateStore = Awaited<ReturnType<typeof import('../src/kernel/state-store.js').openKernelStateStore>>;
