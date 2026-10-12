import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { installKernel, uninstallKernel, rollbackKernel } from '../src/kernel/installer.js';

test('Kernel manifest explicitly excludes Relay state and profiles', async () => {
  const m = JSON.parse(await readFile(new URL('../package/kernel/manifest.json', import.meta.url), 'utf8'));
  assert.ok(m.exclude.includes('.moonshot-relay'));
  assert.ok(m.exclude.includes('runtime-state.sqlite'));
  assert.equal(m.runtimeHome, '~/.moon-relay-kernel');
});

test('Kernel installer protects Relay marker and owned-file collisions', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'krn-install-'));
  await writeFile(path.join(root, '.keep'), 'relay');
  await mkdir(path.join(root, '.moon-relay'), { recursive: true });
  await writeFile(path.join(root, '.moon-relay', 'track.yaml'), 'schemaVersion: 1\ntrack: relay\nproduct: moonshot-relay\n');
  await assert.rejects(() => installKernel({ targetRoot: root, sourceRoot: process.cwd() }), /Relay marker is protected/);
});

test('Kernel sync replaces modified retired payload files only after preserving a backup', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'krn-install-sync-'));
  try {
    const first = await installKernel({ targetRoot: root, sourceRoot: process.cwd() });
    assert.ok(first.manifestPath);
    const retiredRel = 'kernel-payload/scripts/host/kernel/codex-review-host.mjs';
    const retiredTarget = path.join(root, '.moon-relay', retiredRel);
    const manifestPath = first.manifestPath;
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.files.push({ path: retiredRel, checksum: '0'.repeat(64) });
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    await writeFile(retiredTarget, 'retired local implementation\n');

    const blocked = await installKernel({ targetRoot: root, sourceRoot: process.cwd() });

    assert.equal(blocked.status, 'collision');
    assert.ok(blocked.collisions);
    assert.equal(blocked.collisions[0].path, retiredRel);

    const synced = await installKernel({ targetRoot: root, sourceRoot: process.cwd(), replaceModified: true });

    assert.ok(synced.manifestPath);
    assert.equal(synced.status, 'installed');
    assert.ok(synced.backupPath);
    assert.equal(await readFile(path.join(synced.backupPath, 'snapshot', retiredRel), 'utf8'), 'retired local implementation\n');
    await assert.rejects(() => readFile(retiredTarget, 'utf8'));
    const syncedManifest: { files: { path: string }[] } = JSON.parse(await readFile(synced.manifestPath, 'utf8'));
    assert.equal(syncedManifest.files.some((entry) => entry.path === retiredRel), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Kernel installer creates a backup and rollback restores owned files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'krn-install-'));
  const first = await installKernel({ targetRoot: root, sourceRoot: process.cwd() });
  assert.ok(first.manifestPath);
  const second = await installKernel({ targetRoot: root, sourceRoot: process.cwd() });
  assert.ok(second.manifestPath);
  assert.ok(second.backupPath);
  const payload = path.join(root, '.moon-relay', 'kernel-payload', 'bin', 'moon-relay-kernel.mjs');
  await writeFile(payload, 'tampered');
  const result = await uninstallKernel({ targetRoot: root });
  assert.equal(result.status, 'collision');
  const blocked = await rollbackKernel({ targetRoot: root, backupPath: second.backupPath });
  assert.equal(blocked.status, 'collision');
  await writeFile(payload, await readFile(path.join(process.cwd(), 'bin', 'moon-relay-kernel.mjs')));
  const rollback = await rollbackKernel({ targetRoot: root, backupPath: second.backupPath });
  assert.equal(rollback.status, 'rolled_back');
  assert.ok(first.manifestPath);
});

test('Kernel rollback removes runtime files introduced by a later install and restores the prior manifest', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'krn-install-extra-'));
  const runtimeOne = await mkdtemp(path.join(os.tmpdir(), 'krn-runtime-one-'));
  const runtimeTwo = await mkdtemp(path.join(os.tmpdir(), 'krn-runtime-two-'));
  const nodeRel = process.platform === 'win32' ? 'node.exe' : path.join('bin', 'node');
  try {
    for (const runtime of [runtimeOne, runtimeTwo]) {
      await mkdir(path.join(runtime, 'runtime', 'current', path.dirname(nodeRel)), { recursive: true });
      await writeFile(path.join(runtime, 'runtime', 'current', nodeRel), 'managed-node');
    }
    await writeFile(path.join(runtimeTwo, 'runtime', 'current', 'added-runtime-file.txt'), 'added');
    const first = await installKernel({ targetRoot: root, sourceRoot: process.cwd(), runtimeSource: runtimeOne });
    assert.ok(first.manifestPath);
    const firstManifest = JSON.parse(await readFile(first.manifestPath, 'utf8'));
    const second = await installKernel({ targetRoot: root, sourceRoot: process.cwd(), runtimeSource: runtimeTwo });
    assert.ok(second.manifestPath);
    assert.ok(second.backupPath);
    const added = path.join(root, '.moon-relay', 'kernel-payload', 'runtime', 'current', 'added-runtime-file.txt');
    assert.equal(await readFile(added, 'utf8'), 'added');
    const rolled = await rollbackKernel({ targetRoot: root, backupPath: second.backupPath });
    assert.equal(rolled.status, 'rolled_back');
    assert.ok(rolled.removed);
    assert.ok(rolled.removed.includes('kernel-payload/runtime/current/added-runtime-file.txt'));
    await assert.rejects(() => readFile(added, 'utf8'));
    const restoredManifest = JSON.parse(await readFile(first.manifestPath, 'utf8'));
    assert.deepEqual(restoredManifest.files, firstManifest.files);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(runtimeOne, { recursive: true, force: true });
    await rm(runtimeTwo, { recursive: true, force: true });
  }
});
