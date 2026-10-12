import { assertTestRecord, assertTestArray, assertTestString } from './helpers/assert-value.js';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadLegacyFunction, loadLegacyRecordFunction, loadLegacyAsyncRecordFunction } from './helpers/legacy-module-boundary.js';
const legacyPath = path.resolve(import.meta.dirname, '../scripts/installed-release-resolve.mjs');
const compareInstallManifests = await loadLegacyRecordFunction(legacyPath, 'compareInstallManifests');
const verifyInstalledManifest = await loadLegacyAsyncRecordFunction(legacyPath, 'verifyInstalledManifest');
const readManifestHashMap = await loadLegacyFunction(legacyPath, 'manifestHashMap');
const manifestHashMap = (manifest: unknown): ReadonlyMap<string, string> => {
  const value = readManifestHashMap(manifest);
  assert.ok(value instanceof Map);
  const result = new Map<string, string>();
  for (const [key, hash] of value) result.set(assertTestString(key), assertTestString(hash));
  return result;
};
import { auditSkillsLock } from '../src/kernel/standalone/skills-lock.js';

test('installed release resolver compares managed paths and hashes exactly', () => {
  const installed = { copied: [{ path: 'a', sha256: '1' }, { path: 'b', sha256: '2' }] };
  assert.deepEqual([...manifestHashMap(installed)], [['a', '1'], ['b', '2']]);
  assert.equal(compareInstallManifests(installed, structuredClone(installed)).status, 'match');

  const result = compareInstallManifests(installed, {
    copied: [{ path: 'a', sha256: 'changed' }, { path: 'c', sha256: '3' }],
  });
  assert.equal(result.status, 'mismatch');
  assert.deepEqual(result.missing, ['b']);
  assert.deepEqual(result.extra, ['c']);
  assert.deepEqual(result.mismatch, [{ path: 'a', expectedSha256: '1', actualSha256: 'changed' }]);
});

test('installed release resolver verifies actual managed bytes and rejects duplicate paths', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'installed-release-live-'));
  const file = path.join(home, 'managed.txt');
  await writeFile(file, 'expected');
  const expectedSha256 = createHash('sha256').update('expected').digest('hex');
  const manifest = { copied: [{ path: 'managed.txt', sha256: expectedSha256 }] };

  assert.equal((await verifyInstalledManifest(home, manifest)).status, 'match');
  await writeFile(file, 'tampered');
  const tampered = await verifyInstalledManifest(home, manifest);
  assert.equal(tampered.status, 'mismatch');
  assert.equal(assertTestRecord(assertTestArray(tampered.mismatch)[0]).reason, 'content_hash_mismatch');

  await assert.rejects(
    () => verifyInstalledManifest(home, { copied: [...manifest.copied, ...manifest.copied] }),
    /duplicate managed path/,
  );
  assert.equal((await verifyInstalledManifest(home, { copied: [{ path: 'missing.txt', sha256: expectedSha256 }] })).status, 'mismatch');

  const outside = path.join(os.tmpdir(), `installed-release-outside-${path.basename(home)}.txt`);
  await writeFile(outside, 'expected');
  try {
    await symlink(outside, path.join(home, 'escaped.txt'));
    const escaped = await verifyInstalledManifest(home, { copied: [{ path: 'escaped.txt', sha256: expectedSha256 }] });
    assert.equal(escaped.status, 'mismatch');
    assert.equal(assertTestRecord(assertTestArray(escaped.mismatch)[0]).reason, 'managed_path_symlink');
  } catch (err) {
    if (assertTestRecord(err).code !== 'EPERM') throw err;
  }
});

test('canonical skills lock and public runtime surface remain in parity', async () => {
  const repoRoot = path.resolve(import.meta.dirname, '..');
  const lock = JSON.parse(await readFile(path.join(repoRoot, 'skills.lock.json'), 'utf8'));
  const runtimeSurface = JSON.parse(await readFile(path.join(repoRoot, 'package/runtime-surface.json'), 'utf8'));
  const result = await auditSkillsLock({ repoRoot, lock, runtimeSurface });
  assert.equal(result.status, 'pass', JSON.stringify(result.findings));
  assert.equal(runtimeSurface.publicRuntimeSkills.length, 8);
  assert.deepEqual(
    assertTestArray(runtimeSurface.publicRuntimeSkills).filter((name) => !assertTestArray(lock.skills).some((skill) => assertTestRecord(skill).name === name)),
    [],
  );
});

type TestControlPlane = Awaited<ReturnType<typeof import('../src/host/kernel/control-plane-runtime.js').createKernelControlPlane>>;
type TestStateStore = Awaited<ReturnType<typeof import('../src/kernel/state-store.js').openKernelStateStore>>;
