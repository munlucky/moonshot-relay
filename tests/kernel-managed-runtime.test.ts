import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveKernelNode, buildRuntimeManifest, sha256File, parseNodeVersion } from '../src/kernel/runtime-resolver.js';
import { installKernel, uninstallKernel } from '../src/kernel/installer.js';
import { canonicalPath } from '../src/kernel/runtime-home.js';

test('parseNodeVersion correctly extracts major, minor, and patch', () => {
  assert.deepEqual(parseNodeVersion('v22.13.0'), { major: 22, minor: 13, patch: 0, raw: 'v22.13.0' });
  assert.deepEqual(parseNodeVersion('v20.18.1'), { major: 20, minor: 18, patch: 1, raw: 'v20.18.1' });
});

test('managed Node wins over host fallback when all 7 manifest fields and checksum match', async () => {
  const h = await mkdtemp(path.join(os.tmpdir(), 'krn-runtime-'));
  const p = path.join(h, 'runtime', 'current', process.platform === 'win32' ? 'node.exe' : path.join('bin', 'node'));
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, 'node-mock-content');
  const checksum = await sha256File(p);

  const manifestPath = path.join(h, 'runtime', 'current', 'runtime-manifest.json');
  await writeFile(
    manifestPath,
    JSON.stringify({
      schemaVersion: 1,
      productId: 'moon-relay-kernel',
      runtimeHome: h,
      platform: process.platform,
      arch: process.arch,
      nodePath: p,
      checksum,
    })
  );

  const r = await resolveKernelNode({ runtimeHome: h, fallback: '/host/node', skipExecuteCheck: true });
  assert.equal(r.source, 'managed');
  assert.equal(r.nodePath, p);

  const m = await buildRuntimeManifest({ runtimeHome: h, nodePath: p, platform: process.platform, arch: process.arch });
  assert.equal(m.schemaVersion, 1);
  assert.equal(m.productId, 'moon-relay-kernel');
  assert.equal(m.runtimeHome, h);
  assert.equal(m.nodePath, p);
  assert.match(m.checksum, /^[a-f0-9]{64}$/);
});

test('missing manifest triggers host fallback by default', async () => {
  const h = await mkdtemp(path.join(os.tmpdir(), 'krn-runtime-nomanifest-'));
  const p = path.join(h, 'runtime', 'current', process.platform === 'win32' ? 'node.exe' : path.join('bin', 'node'));
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, 'node-mock-content');

  const r = await resolveKernelNode({ runtimeHome: h, fallback: '/host/node', skipExecuteCheck: true });
  assert.equal(r.source, 'host-fallback');
  assert.equal(r.reason, 'missing-manifest');
});

test('incomplete or corrupt manifest fields fall back to host', async () => {
  const h = await mkdtemp(path.join(os.tmpdir(), 'krn-runtime-corrupt-'));
  const p = path.join(h, 'runtime', 'current', process.platform === 'win32' ? 'node.exe' : path.join('bin', 'node'));
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, 'node-corrupt-content');

  const manifestPath = path.join(h, 'runtime', 'current', 'runtime-manifest.json');
  await writeFile(
    manifestPath,
    JSON.stringify({
      schemaVersion: 1,
      productId: 'moon-relay-kernel',
      // missing runtimeHome, platform, arch, nodePath
      checksum: 'bad-checksum-1234567890123456789012345678901234567890123456789012345678901234',
    })
  );

  const r = await resolveKernelNode({ runtimeHome: h, fallback: '/host/node', skipExecuteCheck: true });
  assert.equal(r.source, 'host-fallback');
  assert.ok(r.reason);
  assert.match(r.reason, /runtime-home-mismatch/);
});

test('checksum mismatch in manifest triggers host fallback', async () => {
  const h = await mkdtemp(path.join(os.tmpdir(), 'krn-runtime-chk-'));
  const p = path.join(h, 'runtime', 'current', process.platform === 'win32' ? 'node.exe' : path.join('bin', 'node'));
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, 'node-binary-content');

  const manifestPath = path.join(h, 'runtime', 'current', 'runtime-manifest.json');
  await writeFile(
    manifestPath,
    JSON.stringify({
      schemaVersion: 1,
      productId: 'moon-relay-kernel',
      runtimeHome: h,
      platform: process.platform,
      arch: process.arch,
      nodePath: p,
      checksum: 'wrong000000000000000000000000000000000000000000000000000000000000000',
    })
  );

  const r = await resolveKernelNode({ runtimeHome: h, fallback: '/host/node', skipExecuteCheck: true });
  assert.equal(r.source, 'host-fallback');
  assert.equal(r.reason, 'checksum-mismatch');
});

test('Kernel installer places an external runtime source in the resolver runtime/current contract', async () => {
  const project = await mkdtemp(path.join(os.tmpdir(), 'krn-runtime-install-project-'));
  const runtimeSource = await mkdtemp(path.join(os.tmpdir(), 'krn-runtime-source-'));
  const nodeRel = process.platform === 'win32' ? 'node.exe' : path.join('bin', 'node');
  const nodeSource = path.join(runtimeSource, nodeRel);
  await mkdir(path.dirname(nodeSource), { recursive: true });
  await writeFile(nodeSource, 'managed-node-binary');
  try {
    await installKernel({ targetRoot: project, sourceRoot: process.cwd(), runtimeSource });
    const runtimeHome = canonicalPath(path.join(project, '.moon-relay', 'kernel-payload'));
    const resolved = await resolveKernelNode({ runtimeHome, fallback: '/host/node', skipExecuteCheck: true });
    assert.equal(resolved.source, 'managed');
    assert.equal(resolved.nodePath, path.join(runtimeHome, 'runtime', 'current', nodeRel));
    await uninstallKernel({ targetRoot: project });
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(runtimeSource, { recursive: true, force: true });
  }
});

test('Kernel installer dereferences a provider runtime/current junction before copying', async () => {
  const project = await mkdtemp(path.join(os.tmpdir(), 'krn-runtime-junction-project-'));
  const runtimeSource = await mkdtemp(path.join(os.tmpdir(), 'krn-runtime-junction-source-'));
  const nodeRel = process.platform === 'win32' ? 'node.exe' : path.join('bin', 'node');
  const versionDir = path.join(runtimeSource, 'versions', 'v24.18.0');
  const currentLink = path.join(runtimeSource, 'current');
  const nodeSource = path.join(versionDir, nodeRel);
  await mkdir(path.dirname(nodeSource), { recursive: true });
  await writeFile(nodeSource, 'junction-managed-node');
  await symlink(versionDir, currentLink, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    await installKernel({ targetRoot: project, sourceRoot: process.cwd(), runtimeSource });
    const installedCurrent = path.join(project, '.moon-relay', 'kernel-payload', 'runtime', 'current');
    assert.equal((await lstat(installedCurrent)).isSymbolicLink(), false);
    assert.equal(await readFile(path.join(installedCurrent, nodeRel), 'utf8'), 'junction-managed-node');
    await uninstallKernel({ targetRoot: project });
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(runtimeSource, { recursive: true, force: true });
  }
});

test('Kernel installer rejects an explicitly missing managed runtime source', async () => {
  const project = await mkdtemp(path.join(os.tmpdir(), 'krn-runtime-missing-project-'));
  try {
    await assert.rejects(
      () => installKernel({ targetRoot: project, sourceRoot: process.cwd(), runtimeSource: path.join(project, 'missing-runtime') }),
      /managed runtime source does not exist/
    );
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});
