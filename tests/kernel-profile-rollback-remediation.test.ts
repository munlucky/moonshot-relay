import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  installKernelProfile,
  rollbackKernelProfile,
  inspectProfile,
  uninstallKernelProfile,
  PROFILE_PRODUCT_ID,
  PROFILE_MANIFEST_NAME,
  PROFILE_MARKER_NAME,
} from '../src/kernel/profile-install.js';

const makeTmpDir = async () => fs.mkdtemp(path.join(os.tmpdir(), 'kernel-rollback-test-'));

test('profile rollback removes newly introduced files and restores clean prior state', async () => {
  const tmpDir = await makeTmpDir();
  const sourceRoot = path.join(tmpDir, 'source');
  const targetRoot = path.join(tmpDir, 'target');

  // Setup fake canonical skill in sourceRoot
  const skillSourceDir = path.join(sourceRoot, 'skills', 'moon-relay-kernel');
  await fs.mkdir(skillSourceDir, { recursive: true });
  await fs.writeFile(path.join(skillSourceDir, 'SKILL.md'), '# Moon Relay Kernel Skill\n', 'utf8');

  // Setup fake profile source
  const profileSourceDir = path.join(sourceRoot, 'package', 'kernel', 'profiles', 'codex');
  await fs.mkdir(profileSourceDir, { recursive: true });
  await fs.writeFile(path.join(profileSourceDir, 'AGENTS.md'), '# Codex Profile\n', 'utf8');

  // 1. Initial installation (simulate v1 where manifest only owned AGENTS.md, not skills/moon-relay-kernel)
  await fs.mkdir(targetRoot, { recursive: true });
  await fs.writeFile(path.join(targetRoot, 'AGENTS.md'), '# Codex Profile\n', 'utf8');
  await fs.writeFile(path.join(targetRoot, PROFILE_MARKER_NAME), JSON.stringify({ schemaVersion: 1, productId: PROFILE_PRODUCT_ID, track: 'kernel', runtime: 'codex', ownership: 'manifest-owned-static-only' }), 'utf8');

  const priorManifest = {
    schemaVersion: 1,
    productId: PROFILE_PRODUCT_ID,
    track: 'kernel',
    runtime: 'codex',
    targetRoot,
    installedAt: new Date().toISOString(),
    files: [
      { path: 'AGENTS.md', checksum: 'a98c8c5c4d0925c4ef674a2ffdd98ef36353d9e8316e6bb0ee68c340a6b73a3c' }, // placeholder sha
      { path: PROFILE_MARKER_NAME, checksum: 'placeholder' },
    ],
  };
  // Compute real checksums
  const crypto = await import('node:crypto');
  const sha256 = async (f: string) => crypto.createHash('sha256').update(await fs.readFile(f)).digest('hex');
  priorManifest.files[0].checksum = await sha256(path.join(targetRoot, 'AGENTS.md'));
  priorManifest.files[1].checksum = await sha256(path.join(targetRoot, PROFILE_MARKER_NAME));

  await fs.writeFile(path.join(targetRoot, PROFILE_MANIFEST_NAME), JSON.stringify(priorManifest, null, 2), 'utf8');

  const inspectV1 = await inspectProfile(targetRoot);
  assert.equal(inspectV1.status, 'ready');

  // 2. Perform v2 installation (which introduces skills/moon-relay-kernel)
  const v2Res = await installKernelProfile({ sourceRoot, runtime: 'codex', targetRoot });
  assert.equal(v2Res.status, 'reinstalled');

  // Verify skills/moon-relay-kernel is present in targetRoot after v2 install
  const installedSkillFile = path.join(targetRoot, 'skills', 'moon-relay-kernel', 'SKILL.md');
  const skillExistsBeforeRollback = await fs.stat(installedSkillFile).then(() => true).catch(() => false);
  assert.equal(skillExistsBeforeRollback, true);

  // 3. Perform Rollback using v2Res.backupPath
  const rollbackRes = await rollbackKernelProfile({ targetRoot, backupPath: v2Res.backupPath });
  assert.equal(rollbackRes.status, 'rolled_back');

  // 4. Verify introduced file (skills/moon-relay-kernel) was completely removed
  const skillExistsAfterRollback = await fs.stat(installedSkillFile).then(() => true).catch(() => false);
  assert.equal(skillExistsAfterRollback, false, 'skills/moon-relay-kernel should be removed after rollback');

  // 5. Verify inspectProfile is ready
  const inspectPostRollback = await inspectProfile(targetRoot);
  assert.equal(inspectPostRollback.status, 'ready');

  // 6. Uninstall post-rollback leaves zero orphans
  const uninstallRes = await uninstallKernelProfile({ targetRoot });
  assert.equal(uninstallRes.status, 'uninstalled');

  const remainingFiles = await fs.readdir(targetRoot);
  const remainingNonBackup = remainingFiles.filter((f) => f !== '.moon-relay-kernel-backups');
  assert.equal(remainingNonBackup.length, 0, 'No orphan files should remain after uninstall');

  await fs.rm(tmpDir, { recursive: true, force: true });
});

test('profile rollback fails with collision if introduced file was modified by user', async () => {
  const tmpDir = await makeTmpDir();
  const sourceRoot = path.join(tmpDir, 'source');
  const targetRoot = path.join(tmpDir, 'target');

  const skillSourceDir = path.join(sourceRoot, 'skills', 'moon-relay-kernel');
  await fs.mkdir(skillSourceDir, { recursive: true });
  await fs.writeFile(path.join(skillSourceDir, 'SKILL.md'), '# Moon Relay Kernel Skill\n', 'utf8');

  const profileSourceDir = path.join(sourceRoot, 'package', 'kernel', 'profiles', 'codex');
  await fs.mkdir(profileSourceDir, { recursive: true });
  await fs.writeFile(path.join(profileSourceDir, 'AGENTS.md'), '# Codex Profile\n', 'utf8');

  await fs.mkdir(targetRoot, { recursive: true });
  await fs.writeFile(path.join(targetRoot, 'AGENTS.md'), '# Codex Profile\n', 'utf8');
  await fs.writeFile(path.join(targetRoot, PROFILE_MARKER_NAME), JSON.stringify({ schemaVersion: 1, productId: PROFILE_PRODUCT_ID, track: 'kernel', runtime: 'codex', ownership: 'manifest-owned-static-only' }), 'utf8');

  const crypto = await import('node:crypto');
  const sha256 = async (f: string) => crypto.createHash('sha256').update(await fs.readFile(f)).digest('hex');

  const priorManifest = {
    schemaVersion: 1,
    productId: PROFILE_PRODUCT_ID,
    track: 'kernel',
    runtime: 'codex',
    targetRoot,
    installedAt: new Date().toISOString(),
    files: [
      { path: 'AGENTS.md', checksum: await sha256(path.join(targetRoot, 'AGENTS.md')) },
      { path: PROFILE_MARKER_NAME, checksum: await sha256(path.join(targetRoot, PROFILE_MARKER_NAME)) },
    ],
  };
  await fs.writeFile(path.join(targetRoot, PROFILE_MANIFEST_NAME), JSON.stringify(priorManifest, null, 2), 'utf8');

  const v2Res = await installKernelProfile({ sourceRoot, runtime: 'codex', targetRoot });

  // User modifies introduced file
  const installedSkillFile = path.join(targetRoot, 'skills', 'moon-relay-kernel', 'SKILL.md');
  await fs.writeFile(installedSkillFile, '# User modified skill content\n', 'utf8');

  // Rollback should detect collision
  const rollbackRes = await rollbackKernelProfile({ targetRoot, backupPath: v2Res.backupPath });
  assert.equal(rollbackRes.status, 'collision');

  await fs.rm(tmpDir, { recursive: true, force: true });
});
