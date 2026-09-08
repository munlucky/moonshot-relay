import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { discoverProjectCommands } from '../scripts/kernel/proof/command-catalog.mjs';

const writeTypeScriptFixture = async ({ withDependency }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kernel-command-catalog-'));
  await mkdir(path.join(root, 'node_modules', '.bin'), { recursive: true });
  await writeFile(path.join(root, 'package.json'), JSON.stringify({
    name: 'command-catalog-fixture',
    ...(withDependency ? { devDependencies: { typescript: '^5.0.0' } } : {}),
    scripts: {},
  }), 'utf8');
  await writeFile(path.join(root, 'tsconfig.json'), '{"compilerOptions":{"noEmit":true}}\n', 'utf8');
  const binary = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');
  await writeFile(binary, process.platform === 'win32' ? '@echo off\r\nexit /b 0\r\n' : '#!/bin/sh\nexit 0\n', 'utf8');
  return { root, packagePath: path.join(root, 'package.json') };
};

const writeTypeScriptFixtureWithoutScripts = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kernel-command-catalog-no-scripts-'));
  await mkdir(path.join(root, 'node_modules', '.bin'), { recursive: true });
  await writeFile(path.join(root, 'package.json'), JSON.stringify({
    name: 'command-catalog-no-scripts-fixture',
    devDependencies: { typescript: '^5.0.0' },
  }), 'utf8');
  await writeFile(path.join(root, 'tsconfig.json'), '{}\n', 'utf8');
  const binary = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');
  await writeFile(binary, process.platform === 'win32' ? '@echo off\r\nexit /b 0\r\n' : '#!/bin/sh\nexit 0\n', 'utf8');
  return { root };
};

test('discovers a local TypeScript static-analysis command only from project-owned prerequisites', async () => {
  const fixture = await writeTypeScriptFixture({ withDependency: true });
  try {
    const before = await readFile(fixture.packagePath, 'utf8');
    const commands = discoverProjectCommands({ projectRoot: fixture.root });
    const typecheck = commands.find((command) => command.commandRef === 'typescript:check');
    assert.ok(typecheck);
    assert.equal(typecheck.commandClass, 'static-analysis');
    assert.deepEqual(typecheck.args, ['--noEmit']);
    assert.match(typecheck.source, /package\.json\+tsconfig\.json\+node_modules/);
    assert.equal(await readFile(fixture.packagePath, 'utf8'), before);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('does not invent a TypeScript command when the project has no TypeScript dependency', async () => {
  const fixture = await writeTypeScriptFixture({ withDependency: false });
  try {
    const commands = discoverProjectCommands({ projectRoot: fixture.root });
    assert.equal(commands.some((command) => command.commandRef === 'typescript:check'), false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('discovers the TypeScript fallback when package.json has no scripts field', async () => {
  const fixture = await writeTypeScriptFixtureWithoutScripts();
  try {
    const commands = discoverProjectCommands({ projectRoot: fixture.root });
    assert.equal(commands.some((command) => command.commandRef === 'typescript:check'), true);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
