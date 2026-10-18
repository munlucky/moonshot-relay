import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { execFileSync, execSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planKernelPackage, materializeKernelPackage } from '../src/kernel/package-build.js';
import {
  assertRuntimeDependencyCompatibility,
  resolveRuntimeDependencyEntries,
} from '../src/shared/runtime-dependencies.js';

const sourceRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

const temp = async (t: TestContext, prefix: string) => {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
};

test('Kernel package dry plan contains only Kernel payload roots and includes required schemas and skills', async (t) => {
  const out = await temp(t, 'kernel-pkg-');
  const plan = await planKernelPackage({ sourceRoot, outputRoot: out });
  assert.equal(plan.manifest.productId, 'moon-relay-kernel');
  assert.ok(plan.planned.every((p) => !p.target.includes('.moonshot-relay')));
  assert.ok(plan.planned.some((p) => p.rel.includes('schemas/kernel.track.schema.json')));
  assert.ok(plan.planned.some((p) => p.rel.includes('skills/kernel-minimal-correct-change')));
  assert.ok(plan.planned.some((p) => p.rel === 'package.json'));
  assert.ok(plan.planned.some((p) => p.rel === 'bin/moon-relay-kernel.mjs'));
  assert.ok(plan.planned.some((p) => p.rel.replace(/\/$/, '') === 'scripts/host/kernel'));
  const packageJson = JSON.parse(await readFile(path.join(sourceRoot, 'package.json'), 'utf8'));
  for (const dependency of Object.keys(packageJson.dependencies || {})) {
    assert.ok(
      plan.planned.some((p) => p.rel === `node_modules/${dependency}`),
      `runtime dependency missing from package plan: ${dependency}`,
    );
  }
});

test('native runtime dependency preflight fails closed without mutating an incompatible addon', async (t) => {
  const root = await temp(t, 'kernel-native-incompatible-');
  const packageRoot = path.join(root, 'node_modules', 'native-fixture');
  const addon = path.join(packageRoot, 'build', 'Release', 'fixture.node');
  await mkdir(path.dirname(addon), { recursive: true });
  await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name: 'native-fixture', version: '1.0.0' }));
  const bytes = Buffer.from('not-a-native-addon');
  await writeFile(addon, bytes);

  await assert.rejects(
    () => assertRuntimeDependencyCompatibility([{
      name: 'native-fixture',
      sourcePath: packageRoot,
      relativePath: 'node_modules/native-fixture',
    }]),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as Error & { code?: string }).code, 'NATIVE_RUNTIME_INCOMPATIBLE');
      return true;
    },
  );
  assert.deepEqual(await readFile(addon), bytes);
});

test('native runtime dependency preflight selects only the current surface prebuild', async () => {
  const entries = await resolveRuntimeDependencyEntries({
    sourceRoot,
    dependencyNames: ['better-sqlite3'],
  });
  await assert.doesNotReject(() => assertRuntimeDependencyCompatibility(entries));
});

test('Kernel package materialization creates files on disk, validates mandatory files, and executes doctor cleanly', async (t) => {
  const out = await temp(t, 'kernel-pkg-mat-');
  const result = await materializeKernelPackage({ sourceRoot, outputRoot: out, dryRun: false });
  assert.equal(result.dryRun, false);

  const reqFiles = [
    'schemas/kernel.track.schema.json',
    'schemas/kernel.runtime-state.schema.json',
    'skills/kernel-minimal-correct-change/SKILL.md',
    'skills/kernel-verification-before-completion/SKILL.md',
    'package.json',
    'package/kernel/skills.lock.json',
    'scripts/kernel/standalone/skills-lock.js',
    'scripts/lib/candidate-identity.js',
    'scripts/contracts/host-session.js',
    'scripts/host/kernel/host-session.js',
    'scripts/kernel/run/invocation-resolver.js',
    'scripts/kernel/run/successor-key.js',
    'scripts/switcher/app-resolver/common.mjs',
    'bin/moon-relay-kernel.mjs',
    'scripts/host/kernel/adapters/codex.js',
    'package/profile-templates/codex/AGENTS.md',
  ];

  for (const file of reqFiles) {
    const s = await stat(path.join(out, file));
    assert.ok(s.isFile(), `Expected file ${file} to exist in materialized package`);
  }

  const packageJson = JSON.parse(await readFile(path.join(sourceRoot, 'package.json'), 'utf8'));
  for (const dependency of Object.keys(packageJson.dependencies || {})) {
    const dependencyPackage = path.join(out, 'node_modules', dependency, 'package.json');
    assert.ok((await stat(dependencyPackage)).isFile(), `Expected runtime dependency ${dependency} to be materialized`);
  }

  const sqliteScript = [
    "import { openSqliteDb } from './scripts/kernel/sqlite-adapter.js';",
    "const db = await openSqliteDb(':memory:', { backend: 'better-sqlite3' });",
    "db.exec('CREATE TABLE native_probe(value TEXT)');",
    "db.prepare('INSERT INTO native_probe(value) VALUES(?)').run('ok');",
    "if (db.prepare('SELECT value FROM native_probe').get().value !== 'ok') process.exit(3);",
    "db.close();",
  ].join(' ');
  execFileSync(process.execPath, ['--input-type=module', '-e', sqliteScript], {
    cwd: out,
    encoding: 'utf8',
    env: { ...process.env, NODE_PATH: '' },
  });

  // Execute doctor command directly inside materialized package output directory to verify ESM dependency closure
  const binPath = path.join(out, 'bin', 'moon-relay-kernel.mjs');
  const doctorOutput = execSync(`node "${binPath}" doctor --json`, {
    cwd: out,
    encoding: 'utf8',
    env: {
      ...process.env,
      MOON_RELAY_TRACK: '',
      MOON_RELAY_KERNEL_HOME: path.join(out, 'non-kernel-runtime'),
      MOON_RELAY_KERNEL_SESSION_ID: '',
      MOON_RELAY_KERNEL_RUN_ID: '',
      CODEX_THREAD_ID: '',
    },
  });
  const doctorJson = JSON.parse(doctorOutput);
  assert.equal(doctorJson.productId, 'moon-relay-kernel');
  assert.equal(doctorJson.status, 'wrong_harness');
});
