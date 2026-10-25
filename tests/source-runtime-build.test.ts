import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, cp, rm, unlink, rename, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildRuntime, ROOT } from '../tools/build/runtime.js';
import { buildTests } from '../tools/build/tests.js';
import { buildContractArtifacts } from '../tools/build/contracts.js';
import { Ajv2020 } from 'ajv/dist/2020.js';

const write = async (root: string, file: string, text: string) => {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), text);
};
const fixture = async (t: TestContext) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'source-runtime-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const layout = JSON.parse(await readFile(path.join(ROOT, 'package/source-layout.json'), 'utf8'));
  layout.exceptions = [];
  await write(root, 'package/source-layout.json', JSON.stringify(layout));
  for (const module of layout.modules) await mkdir(path.join(root, module.source), { recursive: true });
  await write(root, 'tsconfig.json', JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', noEmit: true, types: [] }, include: ['src/**/*.ts', 'src/**/*.mts'] }));
  await cp(path.join(ROOT, 'tsconfig.tools.json'), path.join(root, 'tsconfig.tools.json'));
  await write(root, 'tsconfig.build.json', JSON.stringify({ extends: './tsconfig.json', compilerOptions: { noEmit: false, noEmitOnError: true, declaration: false }, include: ['src/**/*.ts', 'src/**/*.mts'] }));
  for (const file of ['tools/build/contracts.ts', 'tools/build/contracts.mjs', 'tools/build/source-graph.mjs', 'tools/build/runtime.mjs', 'tools/build/tests.mjs', 'tools/build/types.mjs', 'tools/build/source-graph.ts', 'tools/build/runtime.ts', 'tools/build/tests.ts', 'tools/build/types.ts', 'tools/build/bootstrap.ts', 'tools/build/bootstrap.mjs', 'tools/build/prepare.ts', 'tools/build/prepare.mjs', 'tools/build/typescript-cli.cjs']) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await cp(path.join(ROOT, file), path.join(root, file));
  }
  await write(root, 'src/kernel/value.ts', 'export const value: number = 42;\n');
  await write(root, 'src/shared/text.mjs', "export const text = 'scripts/kernel/value.js';\n");
  await write(root, 'src/host/kernel/provider.mjs', "export { value } from '../../kernel/value.js';\n");
  await write(root, 'src/cli/main.mjs', "#!/usr/bin/env node\nexport { value } from '../kernel/value.js';\nexport const lazy = () => import('../host/kernel/provider.mjs');\nexport const data = '../kernel/value.js';\n");
  return root;
};

test('schema generation keeps refs, unions, nullability and closed objects; drift blocks runtime replacement', async t => {
  const root = await fixture(t);
  const schema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object', additionalProperties: false, required: ['kind', 'value'],
    $defs: { value: { anyOf: [{ type: 'string' }, { type: 'null' }] } },
    properties: { kind: { enum: ['text', 'empty'] }, value: { $ref: '#/$defs/value' }, count: { type: 'integer' } },
    allOf: [{ if: { properties: { kind: { const: 'empty' } } }, then: { properties: { value: { type: 'null' } } } }],
  };
  await write(root, 'schemas/kernel.pilot.schema.json', JSON.stringify(schema));
  await write(root, 'catalog/kernel-contracts.json', JSON.stringify({ schemaVersion: 1, contracts: [{
    id: 'kernel.pilot', schema: 'schemas/kernel.pilot.schema.json', version: 1, owner: 'Work', typeName: 'KernelPilot',
    generatedType: 'src/contracts/generated/kernel.pilot.ts', producer: 'pilot', consumer: 'pilot', validator: 'pilot',
  }] }));
  const validate = new Ajv2020({ strict: false }).compile(schema);
  for (const value of [{ kind: 'text', value: 'ok' }, { kind: 'empty', value: null }]) assert.equal(validate(value), true);
  for (const value of [{ kind: 'other', value: null }, { kind: 'empty', value: 'wrong' }, { kind: 'text', value: 42 }, { kind: 'text', value: 'ok', extra: true }]) assert.equal(validate(value), false);
  assert.equal((await buildContractArtifacts({ root })).contracts, 1);
  await write(root, 'src/kernel/pilot.ts', "import type { KernelPilot } from '../contracts/generated/kernel.pilot.js';\nexport const valid: KernelPilot = {kind:'empty', value:null};\n");
  await buildRuntime({ root });
  const output = await readFile(path.join(root, 'scripts/kernel/pilot.js'), 'utf8');
  const generated = path.join(root, 'src/contracts/generated/kernel.pilot.ts');
  const originalType = await readFile(generated, 'utf8');
  await writeFile(generated, originalType.replace("'text'", "'forged'"));
  await assert.rejects(buildRuntime({ root }), /Generated contract drift/);
  assert.equal(await readFile(path.join(root, 'scripts/kernel/pilot.js'), 'utf8'), output);
  await buildContractArtifacts({ root });
  schema.properties.count = { type: 'number' };
  await write(root, 'schemas/kernel.pilot.schema.json', JSON.stringify(schema));
  await assert.rejects(buildRuntime({ root }), /Generated contract drift/);
  await buildContractArtifacts({ root });
  await write(root, 'src/kernel/pilot.ts', "import type { KernelPilot } from '../contracts/generated/kernel.pilot.js';\nexport const invalid: KernelPilot = {kind:'empty', value:42};\n");
  await assert.rejects(buildRuntime({ root }), /not assignable/);
  const generatedDirectory = path.join(root, 'src/contracts/generated');
  const savedDirectory = path.join(root, 'generated-backup');
  assert.equal(path.dirname(savedDirectory), root);
  const outside = await mkdtemp(path.join(os.tmpdir(), 'schema-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const sentinel = path.join(outside, 'kernel.pilot.ts');
  await writeFile(sentinel, 'external file must stay unchanged');
  await rename(generatedDirectory, savedDirectory);
  try {
    await symlink(outside, generatedDirectory, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(buildContractArtifacts({ root }), /symlink/);
    assert.equal(await readFile(sentinel, 'utf8'), 'external file must stay unchanged');
  } finally {
    await unlink(generatedDirectory);
    await rename(savedDirectory, generatedDirectory);
  }
});

test('source build preserves executable ESM paths, exports, lazy imports and data strings', async (t) => {
  const root = await fixture(t);
  assert.equal((await buildRuntime({ root })).files, 4);
  const module = await import(pathToFileURL(path.join(root, 'bin/main.mjs')).href);
  assert.equal(module.value, 42);
  assert.equal((await module.lazy()).value, 42);
  assert.equal(module.data, '../kernel/value.js');
  const sourceMap = JSON.parse(await readFile(path.join(root, 'dist/debug/scripts/kernel/value.js.map'), 'utf8'));
  assert.equal(sourceMap.sourcesContent, undefined);
  assert.equal(path.resolve(root, 'dist/debug/scripts/kernel', sourceMap.sources[0]), path.join(root, 'src/kernel/value.ts'));
  assert.ok(sourceMap.mappings.startsWith(';'));
  assert.doesNotMatch(await readFile(path.join(root, 'scripts/kernel/value.js'), 'utf8'), /sourceMappingURL|sourcesContent/);
  assert.match(await readFile(path.join(root, 'bin/main.mjs'), 'utf8'), /^#!\/usr\/bin\/env node\n/);
  const manifest = await readFile(path.join(root, 'dist/runtime-build.json'), 'utf8');
  assert.equal((await buildRuntime({ root })).changed, 0);
  assert.equal(await readFile(path.join(root, 'dist/runtime-build.json'), 'utf8'), manifest);
  assert.equal((await buildRuntime({ root, check: true })).status, 'passed');
});

test('drift gate rejects edited source, tampered output, missing output and orphaned output', async (t) => {
  const root = await fixture(t);
  await buildRuntime({ root });
  await write(root, 'package-lock.json', JSON.stringify({ lockfileVersion: 3 }));
  await assert.rejects(buildRuntime({ root, check: true }), /Runtime build is stale/);
  await buildRuntime({ root });
  await write(root, 'package-lock.json', JSON.stringify({ lockfileVersion: 3, name: 'changed' }));
  await assert.rejects(buildRuntime({ root, check: true }), /Runtime build is stale/);
  await buildRuntime({ root });
  await write(root, 'src/kernel/value.ts', 'export const value: number = 43;\n');
  await assert.rejects(buildRuntime({ root, check: true }), /Runtime build is stale/);
  await buildRuntime({ root });
  await write(root, 'scripts/kernel/value.js', 'export const value = 999;\n');
  await assert.rejects(buildRuntime({ root, check: true }), /Runtime build is stale/);
  await buildRuntime({ root });
  await unlink(path.join(root, 'scripts/kernel/value.js'));
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
  const before = await readFile(path.join(root, 'scripts/kernel/value.js'), 'utf8');
  await write(root, 'src/kernel/value.ts', "export const value: number = 'invalid';\n");
  await assert.rejects(buildRuntime({ root }), /not assignable to type 'number'/);
  assert.equal(await readFile(path.join(root, 'scripts/kernel/value.js'), 'utf8'), before);
});

test('production-only strict options block emission without changing runtime or manifest', async (t) => {
  const root = await fixture(t);
  await buildRuntime({ root });
  const output = await readFile(path.join(root, 'scripts/kernel/value.js'), 'utf8');
  const manifest = await readFile(path.join(root, 'dist/runtime-build.json'), 'utf8');
  const buildConfig = JSON.parse(await readFile(path.join(root, 'tsconfig.build.json'), 'utf8'));
  buildConfig.compilerOptions.noUncheckedIndexedAccess = true;
  buildConfig.compilerOptions.exactOptionalPropertyTypes = true;
  await write(root, 'tsconfig.build.json', JSON.stringify(buildConfig));
  for (const invalid of [
    'export const value: number = [42][0];\n',
    'export const value: { optional?: string } = { optional: undefined };\n',
  ]) {
    await write(root, 'src/kernel/value.ts', invalid);
    await assert.rejects(buildRuntime({ root }), /not assignable/);
    assert.equal(await readFile(path.join(root, 'scripts/kernel/value.js'), 'utf8'), output);
    assert.equal(await readFile(path.join(root, 'dist/runtime-build.json'), 'utf8'), manifest);
  }
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


test('diagnostic maps track source deletion and reject drift', async (t) => {
  const root = await fixture(t);
  await buildRuntime({ root });
  const map = 'dist/debug/scripts/kernel/value.js.map';
  await write(root, map, '{}\n');
  await assert.rejects(buildRuntime({ root, check: true }), /diagnosticChanged/);
  await buildRuntime({ root });
  await write(root, 'dist/debug/scripts/kernel/retired.js.map', '{}\n');
  await assert.rejects(buildRuntime({ root, check: true }), /orphaned/);
  assert.equal((await buildRuntime({ root })).removed, 1);
  await assert.rejects(readFile(path.join(root, 'dist/debug/scripts/kernel/retired.js.map')), { code: 'ENOENT' });
});

test('typed test compilation preserves runtime imports, refuses errors, and removes orphaned output', async (t) => {
  const root = await fixture(t);
  await write(root, 'package.json', JSON.stringify({ type: 'module' }));
  await write(root, 'tsconfig.tests.json', JSON.stringify({ extends: './tsconfig.json', include: ['tests/**/*.ts'] }));
  await write(root, 'tests/helper.ts', "export { value as default } from '../src/kernel/value.js';\n");
  await write(root, 'tests/fixtures/data.json', '{"portable":true}');
  await write(root, 'tests/value.test.ts', "import value from './helper.js';\nexport { value };\nexport const assetUrl = new URL('./fixtures/data.json', import.meta.url).href;\n");
  await buildRuntime({ root });
  assert.equal((await buildTests({ root })).tests, 1);
  const output = path.join(root, 'dist/tests/value.test.mjs');
  const first = await readFile(output, 'utf8');
  const built = await import(pathToFileURL(output).href);
  assert.equal(built.value, 42);
  assert.equal(await readFile(new URL(built.assetUrl), 'utf8'), '{"portable":true}');
  assert.equal(first.includes(pathToFileURL(root).href), false);
  const relocated = await mkdtemp(path.join(os.tmpdir(), 'portable-test-'));
  t.after(() => rm(relocated, { recursive: true, force: true }));
  await cp(root, relocated, { recursive: true });
  const moved = await import(pathToFileURL(path.join(relocated, 'dist/tests/value.test.mjs')).href);
  assert.equal(moved.value, 42);
  assert.equal(await readFile(new URL(moved.assetUrl), 'utf8'), '{"portable":true}');
  assert.ok(moved.assetUrl.startsWith(pathToFileURL(relocated).href));
  const helper = await import(pathToFileURL(path.join(root, 'tests/helper.mjs')).href);
  assert.equal(helper.default, 42);
  assert.equal((await buildTests({ root, check: true })).status, 'passed');
  await write(root, 'tests/value.test.ts', 'export const value: number = "invalid";\n');
  await assert.rejects(buildTests({ root }), /not assignable/);
  assert.equal(await readFile(output, 'utf8'), first);
  await unlink(path.join(root, 'tests/value.test.ts'));
  await write(root, 'tests/other.test.ts', 'export const other = 1;\n');
  await assert.rejects(buildTests({ root, check: true }), /Orphaned test build/);
  assert.equal((await buildTests({ root })).removed, 2);
  await assert.rejects(readFile(output), { code: 'ENOENT' });
  await assert.rejects(readFile(path.join(root, 'tests/value.test.mjs')), { code: 'ENOENT' });
});
