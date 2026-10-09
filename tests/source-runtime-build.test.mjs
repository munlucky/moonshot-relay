import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, cp, rm, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildRuntime, ROOT } from '../tools/build/runtime.mjs';

const write = async (root, file, text) => {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), text);
};
const fixture = async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'source-runtime-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const layout = JSON.parse(await readFile(path.join(ROOT, 'package/source-layout.json'), 'utf8'));
  layout.exceptions = [];
  await write(root, 'package/source-layout.json', JSON.stringify(layout));
  await write(root, 'tsconfig.json', JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', module: 'NodeNext', noEmit: true, types: [] }, include: ['src/**/*.mts'] }));
  for (const file of ['tools/build/source-graph.mjs', 'tools/build/runtime.mjs']) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await cp(path.join(ROOT, file), path.join(root, file));
  }
  await write(root, 'src/kernel/value.mts', 'export const value: number = 42;\n');
  await write(root, 'src/shared/text.mjs', "export const text = 'scripts/kernel/value.mjs';\n");
  await write(root, 'src/host/kernel/provider.mjs', "export { value } from '../../kernel/value.mjs';\n");
  await write(root, 'src/cli/main.mjs', "#!/usr/bin/env node\nexport { value } from '../kernel/value.mjs';\nexport const lazy = () => import('../host/kernel/provider.mjs');\nexport const data = '../kernel/value.mjs';\n");
  return root;
};

test('source build preserves executable ESM paths, exports, lazy imports and data strings', async (t) => {
  const root = await fixture(t);
  assert.equal((await buildRuntime({ root })).files, 4);
  const module = await import(pathToFileURL(path.join(root, 'bin/main.mjs')).href);
  assert.equal(module.value, 42);
  assert.equal((await module.lazy()).value, 42);
  assert.equal(module.data, '../kernel/value.mjs');
  assert.match(await readFile(path.join(root, 'bin/main.mjs'), 'utf8'), /^#!\/usr\/bin\/env node\n/);
  const manifest = await readFile(path.join(root, 'dist/runtime-build.json'), 'utf8');
  assert.equal((await buildRuntime({ root })).changed, 0);
  assert.equal(await readFile(path.join(root, 'dist/runtime-build.json'), 'utf8'), manifest);
  assert.equal((await buildRuntime({ root, check: true })).status, 'passed');
});

test('drift gate rejects edited source, tampered output, missing output and orphaned output', async (t) => {
  const root = await fixture(t);
  await buildRuntime({ root });
  await write(root, 'src/kernel/value.mts', 'export const value: number = 43;\n');
  await assert.rejects(buildRuntime({ root, check: true }), /Runtime build is stale/);
  await buildRuntime({ root });
  await write(root, 'scripts/kernel/value.mjs', 'export const value = 999;\n');
  await assert.rejects(buildRuntime({ root, check: true }), /Runtime build is stale/);
  await buildRuntime({ root });
  await unlink(path.join(root, 'scripts/kernel/value.mjs'));
  await assert.rejects(buildRuntime({ root, check: true }), /Runtime build is stale/);
  await buildRuntime({ root });
  await write(root, 'scripts/kernel/orphan.mjs', 'export const stale = true;\n');
  await assert.rejects(buildRuntime({ root, check: true }), /orphaned/);
  assert.equal((await buildRuntime({ root })).removed, 1);
});

test('new Kernel to Host dependency is rejected for import, re-export and dynamic import', async (t) => {
  const root = await fixture(t);
  for (const statement of [
    "import '../host/kernel/provider.mjs';",
    "export { value } from '../host/kernel/provider.mjs';",
    "export const load = () => import('../host/kernel/provider.mjs');",
    "const provider = require('../host/kernel/provider.mjs');",
  ]) {
    await write(root, 'src/kernel/forbidden.mjs', statement);
    await assert.rejects(buildRuntime({ root }), /Module boundary violation/);
  }
});

test('unresolved source imports and new development dependencies fail before emission', async (t) => {
  const root = await fixture(t);
  await write(root, 'src/kernel/missing.mjs', "import './absent.mjs';");
  await assert.rejects(buildRuntime({ root }), /Unresolved source dependency/);
  await write(root, 'src/kernel/missing.mjs', "import 'typescript';");
  await assert.rejects(buildRuntime({ root }), /Undeclared runtime package/);
});

test('strict TypeScript errors fail the build without overwriting working output', async (t) => {
  const root = await fixture(t);
  await buildRuntime({ root });
  const before = await readFile(path.join(root, 'scripts/kernel/value.mjs'), 'utf8');
  await write(root, 'src/kernel/value.mts', "export const value: number = 'invalid';\n");
  await assert.rejects(buildRuntime({ root }), /not assignable to type 'number'/);
  assert.equal(await readFile(path.join(root, 'scripts/kernel/value.mjs'), 'utf8'), before);
});

test('source deletion removes its old generated runtime without deleting other bin entries', async (t) => {
  const root = await fixture(t);
  await write(root, 'src/cli/retired.mjs', 'export const retired = true;\n');
  await write(root, 'bin/unmanaged.mjs', 'export const ownedElsewhere = true;\n');
  await buildRuntime({ root });
  await unlink(path.join(root, 'src/cli/retired.mjs'));
  assert.equal((await buildRuntime({ root })).removed, 1);
  assert.match(await readFile(path.join(root, 'bin/unmanaged.mjs'), 'utf8'), /ownedElsewhere/);
});
