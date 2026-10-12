import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { mkdtemp, readFile, writeFile, mkdir, cp, readdir, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { installKernel } from '../src/kernel/installer.js';
import { materializeKernelPackage, planKernelPackage } from '../src/kernel/package-build.js';
import { assertRuntimeBuild } from '../src/shared/runtime-build.js';
import { buildRuntime, ROOT } from '../tools/build/runtime.js';

const temp = async (t: TestContext) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'runtime-only-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
};

const sha256File = async (target: string) => createHash('sha256').update(await readFile(target)).digest('hex');

const payloadEntries = (value: unknown): { path: string; checksum?: string }[] => {
  assert.ok(value && typeof value === 'object' && 'files' in value && Array.isArray(value.files));
  return value.files.map((entry: unknown) => {
    assert.ok(entry && typeof entry === 'object' && 'path' in entry && typeof entry.path === 'string');
    const checksum = 'checksum' in entry ? entry.checksum : undefined;
    assert.ok(checksum === undefined || typeof checksum === 'string');
    return { path: entry.path, checksum };
  });
};

const collectRelativeFiles = async (root: string, relative = ''): Promise<string[]> => {
  const target = path.join(root, relative);
  const info = await stat(target);
  if (info.isFile()) return [relative.replaceAll('\\', '/')];
  const files = [];
  for (const entry of await readdir(target, { withFileTypes: true })) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...await collectRelativeFiles(root, child));
    else files.push(child.replaceAll('\\', '/'));
  }
  return files.sort();
};
const assertExecutable = async (root: string) => {
  for (const relative of ['src', 'tools/build', 'node_modules/typescript']) assert.equal(existsSync(path.join(root, relative)), false, relative);
  assert.equal((await assertRuntimeBuild(root)).mode, 'runtime-only');
  const env = { ...process.env, NODE_PATH: '', MOON_RELAY_KERNEL_HOME: path.join(root, 'isolated-state'), MOON_RELAY_KERNEL_RUN_ID: '', MOON_RELAY_KERNEL_SESSION_ID: '', CODEX_THREAD_ID: '', MOON_RELAY_TRACK: '' };
  const help = spawnSync(process.execPath, [path.join(root, 'bin/moon-relay-kernel.mjs'), '--help'], { cwd: root, encoding: 'utf8', env, windowsHide: true });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /kernel <command>/);
  const doctor = spawnSync(process.execPath, [path.join(root, 'bin/moon-relay-kernel.mjs'), 'doctor', '--json'], { cwd: root, encoding: 'utf8', env, windowsHide: true });
  assert.equal(doctor.status, 0, doctor.stderr);
  assert.equal(JSON.parse(doctor.stdout).productId, 'moon-relay-kernel');
  const script = "import {executionClassForAction} from './scripts/contracts/execution-class.js'; import {resolveOptionalCapabilities} from './scripts/kernel/run/optional-capabilities.js'; if(executionClassForAction('implement',{complexity:'complex'})!=='complex_implementation') process.exit(1); if(resolveOptionalCapabilities({actionKind:'implement'}).active['independent-review']) process.exit(2);";
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: root, env, encoding: 'utf8', windowsHide: true });
  assert.equal(run.status, 0, run.stderr);

  const sqliteScript = [
    "import { openSqliteDb } from './scripts/kernel/sqlite-adapter.js';",
    "const db = await openSqliteDb(':memory:', { backend: 'better-sqlite3' });",
    "db.exec('CREATE TABLE native_probe(value TEXT)');",
    "db.prepare('INSERT INTO native_probe(value) VALUES(?)').run('ok');",
    "if (db.prepare('SELECT value FROM native_probe').get().value !== 'ok') process.exit(3);",
    "db.close();",
  ].join(' ');
  const sqlite = spawnSync(process.execPath, ['--input-type=module', '-e', sqliteScript], {
    cwd: root,
    env,
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(sqlite.status, 0, sqlite.stderr);
};

test('npm archive contains runnable Kernel assets and excludes development source and compiler tooling', () => {
  const args = ['pack', '--dry-run', '--ignore-scripts', '--json'];
  const result = process.env.npm_execpath
    ? spawnSync(process.execPath, [process.env.npm_execpath, ...args], { cwd: ROOT, encoding: 'utf8', windowsHide: true })
    : process.platform === 'win32'
      ? spawnSync('cmd.exe', ['/d', '/s', '/c', 'npm pack --dry-run --ignore-scripts --json'], { cwd: ROOT, encoding: 'utf8', windowsHide: true })
      : spawnSync('npm', args, { cwd: ROOT, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const archive: unknown = JSON.parse(result.stdout);
  assert.ok(Array.isArray(archive));
  const files = payloadEntries(archive[0]).map(entry => entry.path);
  for (const file of ['kernel/proof-policy.yaml', 'bin/moon-relay-kernel.mjs', 'scripts/kernel/control-plane.js', 'scripts/host/kernel/host-boundary.js', 'scripts/lib/runtime-build.js']) assert.ok(files.includes(file), file);
  assert.equal(files.some((file) => file.startsWith('src/') || file.endsWith('.mts') || file.endsWith('.ts')), false);
  assert.equal(files.includes('tools/build/runtime.mjs'), false);
  assert.equal(files.includes('tools/build/source-graph.mjs'), false);
  assert.equal(files.some(file => file.startsWith('tools/build/')), false);
});

test('source prepare bootstraps without any existing generated build tools', async (t) => {
  const root = await temp(t);
  for (const relative of ['src', 'tests', 'tools/build', 'schemas', 'catalog/kernel-contracts.json', 'package/source-layout.json', 'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.build.json', 'tsconfig.tools.json', 'tsconfig.tests.json']) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await cp(path.join(ROOT, relative), path.join(root, relative), {
      recursive: true,
      filter: source => !source.startsWith(path.join(ROOT, 'tools/build') + path.sep) || !/\.(mjs|js)$/.test(source),
    });
  }
  const { symlink } = await import('node:fs/promises');
  await symlink(path.join(ROOT, 'node_modules'), path.join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(existsSync(path.join(root, 'tools/build/bootstrap.mjs')), false);
  assert.equal(existsSync(path.join(root, 'tools/build/prepare.mjs')), false);
  const result = process.env.npm_execpath
    ? spawnSync(process.execPath, [process.env.npm_execpath, 'run', 'prepare'], { cwd: root, encoding: 'utf8', windowsHide: true })
    : process.platform === 'win32'
      ? spawnSync('cmd.exe', ['/d', '/s', '/c', 'npm run prepare'], { cwd: root, encoding: 'utf8', windowsHide: true })
      : spawnSync('npm', ['run', 'prepare'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(existsSync(path.join(root, 'dist/tools/prepare.js')), true);
  assert.equal(existsSync(path.join(root, 'tools/build/bootstrap.mjs')), true);
  assert.equal(existsSync(path.join(root, 'bin/moon-relay-kernel.mjs')), true);
  assert.equal(existsSync(path.join(root, 'dist/tests/source-runtime-install.test.mjs')), true);
});

test('materialized Kernel package executes outside the checkout without source or compiler', async (t) => {
  const root = await temp(t);
  await materializeKernelPackage({ sourceRoot: ROOT, outputRoot: root });
  await assertExecutable(root);
});

test('Kernel installer produces a standalone mjs runtime without development dependencies', async (t) => {
  const root = await temp(t);
  const result = await installKernel({ sourceRoot: ROOT, targetRoot: root });
  assert.equal(result.status, 'installed');
  await assertExecutable(path.join(root, '.moon-relay/kernel-payload'));
});

test('materialized package and direct installer manage the same payload files and hashes', async (t) => {
  const packageRoot = await temp(t);
  const installRoot = await temp(t);

  await materializeKernelPackage({ sourceRoot: ROOT, outputRoot: packageRoot });
  const installResult = await installKernel({ sourceRoot: ROOT, targetRoot: installRoot });
  assert.ok(installResult.manifestPath);
  const installManifest: unknown = JSON.parse(await readFile(installResult.manifestPath, 'utf8'));

  const installedPayload = new Map(
    payloadEntries(installManifest)
      .filter((entry) => String(entry.path).startsWith('kernel-payload/'))
      .map((entry) => [String(entry.path), String(entry.checksum)]),
  );
  const materializedFiles = (await collectRelativeFiles(packageRoot))
    .filter((relative) => relative !== 'kernel-package-plan.json');

  const expectedPaths = materializedFiles.map((relative) => `kernel-payload/${relative}`).sort();
  assert.deepEqual([...installedPayload.keys()].sort(), expectedPaths);

  for (const relative of materializedFiles) {
    const installedPath = `kernel-payload/${relative}`;
    assert.equal(
      installedPayload.get(installedPath),
      await sha256File(path.join(packageRoot, relative)),
      `payload hash mismatch: ${relative}`,
    );
  }
});

test('packaging and installation reject a checkout changed after build before writing output', async (t) => {
  const fixture = await temp(t);
  for (const relative of ['src', 'tools/build', 'schemas', 'catalog/kernel-contracts.json', 'package/source-layout.json', 'package.json', 'tsconfig.json', 'tsconfig.build.json', 'tsconfig.tools.json']) {
    await mkdir(path.dirname(path.join(fixture, relative)), { recursive: true });
    await cp(path.join(ROOT, relative), path.join(fixture, relative), { recursive: true });
  }
  // A source checkout is built after npm ci. Reproduce only the type-resolution
  // part of that prerequisite; native/runtime dependencies are deliberately not
  // copied because this case must fail on stale source before installation.
  for (const relative of ['node_modules/@types', 'node_modules/@apidevtools', 'node_modules/undici-types', 'node_modules/typescript', 'node_modules/json-schema-to-typescript', 'node_modules/prettier', 'node_modules/ajv', 'node_modules/ajv-formats', 'node_modules/fast-uri']) {
    await mkdir(path.dirname(path.join(fixture, relative)), { recursive: true });
    await cp(path.join(ROOT, relative), path.join(fixture, relative), { recursive: true });
  }
  await buildRuntime({ root: fixture });
  const source = path.join(fixture, 'src/contracts/execution-class.ts');
  await writeFile(source, (await readFile(source, 'utf8')) + '\n// source changed after build\n');
  const target = path.join(fixture, 'rejected-install');
  await assert.rejects(installKernel({ sourceRoot: fixture, targetRoot: target }), /runtime_build_stale/);
  await assert.rejects(planKernelPackage({ sourceRoot: fixture, outputRoot: target }), /runtime_build_stale/);
  assert.equal(existsSync(target), false);
  await buildRuntime({ root: fixture });
  await writeFile(path.join(fixture, 'scripts/kernel/stale-log.json'), '{}\n');
  await assert.rejects(assertRuntimeBuild(fixture), /runtime inventory changed/);
});
