import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile, mkdir, cp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { installKernel } from '../scripts/kernel/installer.mjs';
import { materializeKernelPackage, planKernelPackage } from '../scripts/kernel/package-build.mjs';
import { assertRuntimeBuild } from '../scripts/lib/runtime-build.mjs';
import { buildRuntime, ROOT } from '../tools/build/runtime.mjs';

const temp = async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'runtime-only-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
};
const assertExecutable = async (root) => {
  for (const relative of ['src', 'tools/build', 'node_modules/typescript']) assert.equal(existsSync(path.join(root, relative)), false, relative);
  assert.equal((await assertRuntimeBuild(root)).mode, 'runtime-only');
  const env = { ...process.env, NODE_PATH: '', MOON_RELAY_KERNEL_HOME: path.join(root, 'isolated-state'), MOON_RELAY_KERNEL_RUN_ID: '', MOON_RELAY_KERNEL_SESSION_ID: '', CODEX_THREAD_ID: '', MOON_RELAY_TRACK: '' };
  const help = spawnSync(process.execPath, [path.join(root, 'bin/moon-relay-kernel.mjs'), '--help'], { cwd: root, encoding: 'utf8', env, windowsHide: true });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /kernel <command>/);
  const doctor = spawnSync(process.execPath, [path.join(root, 'bin/moon-relay-kernel.mjs'), 'doctor', '--json'], { cwd: root, encoding: 'utf8', env, windowsHide: true });
  assert.equal(doctor.status, 0, doctor.stderr);
  assert.equal(JSON.parse(doctor.stdout).productId, 'moon-relay-kernel');
  const script = "import {executionClassForAction} from './scripts/kernel/run/execution-class.mjs'; import {resolveOptionalCapabilities} from './scripts/kernel/run/optional-capabilities.mjs'; if(executionClassForAction('implement',{complexity:'complex'})!=='complex_implementation') process.exit(1); if(resolveOptionalCapabilities({actionKind:'implement'}).active['independent-review']) process.exit(2);";
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: root, env, encoding: 'utf8', windowsHide: true });
  assert.equal(run.status, 0, run.stderr);
};

test('npm archive contains runnable Kernel assets and excludes development source and compiler tooling', () => {
  const args = ['pack', '--dry-run', '--ignore-scripts', '--json'];
  const result = process.env.npm_execpath
    ? spawnSync(process.execPath, [process.env.npm_execpath, ...args], { cwd: ROOT, encoding: 'utf8', windowsHide: true })
    : process.platform === 'win32'
      ? spawnSync('cmd.exe', ['/d', '/s', '/c', 'npm pack --dry-run --ignore-scripts --json'], { cwd: ROOT, encoding: 'utf8', windowsHide: true })
      : spawnSync('npm', args, { cwd: ROOT, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const files = JSON.parse(result.stdout)[0].files.map((entry) => entry.path);
  for (const file of ['kernel/proof-policy.yaml', 'bin/moon-relay-kernel.mjs', 'scripts/kernel/control-plane.mjs', 'scripts/host/kernel/host-boundary.mjs', 'scripts/lib/runtime-build.mjs']) assert.ok(files.includes(file), file);
  assert.equal(files.some((file) => file.startsWith('src/') || file.endsWith('.mts')), false);
  assert.equal(files.includes('tools/build/runtime.mjs'), false);
  assert.equal(files.includes('tools/build/source-graph.mjs'), false);
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

test('packaging and installation reject a checkout changed after build before writing output', async (t) => {
  const fixture = await temp(t);
  for (const relative of ['src', 'tools/build', 'package/source-layout.json', 'package.json', 'tsconfig.json']) {
    await mkdir(path.dirname(path.join(fixture, relative)), { recursive: true });
    await cp(path.join(ROOT, relative), path.join(fixture, relative), { recursive: true });
  }
  await buildRuntime({ root: fixture });
  const source = path.join(fixture, 'src/kernel/run/execution-class.mts');
  await writeFile(source, (await readFile(source, 'utf8')) + '\n// source changed after build\n');
  const target = path.join(fixture, 'rejected-install');
  await assert.rejects(installKernel({ sourceRoot: fixture, targetRoot: target }), /runtime_build_stale/);
  await assert.rejects(planKernelPackage({ sourceRoot: fixture, outputRoot: target }), /runtime_build_stale/);
  assert.equal(existsSync(target), false);
  await buildRuntime({ root: fixture });
  await writeFile(path.join(fixture, 'scripts/kernel/stale-log.json'), '{}\n');
  await assert.rejects(assertRuntimeBuild(fixture), /runtime inventory changed/);
});
