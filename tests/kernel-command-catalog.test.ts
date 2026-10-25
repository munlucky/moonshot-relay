import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { discoverProjectCommands } from '../src/contracts/command-catalog.js';
import { observeProjectCommandDeclarations } from '../src/host/kernel/proof/project-command-observation.js';

const projectCommands = (projectRoot: string) => discoverProjectCommands({
  observation: observeProjectCommandDeclarations({ projectRoot }),
});

const writeInstalledTypeScript = async (root: string) => {
  const packageRoot = path.join(root, 'node_modules', 'typescript');
  await mkdir(path.join(packageRoot, 'bin'), { recursive: true });
  await mkdir(path.join(root, 'node_modules', '.bin'), { recursive: true });
  await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({
    name: 'typescript',
    version: '7.0.2',
    bin: { tsc: './bin/tsc' },
  }), 'utf8');
  await writeFile(path.join(packageRoot, 'bin', 'tsc'), '#!/usr/bin/env node\nprocess.exit(0);\n', 'utf8');
  const poisonedBin = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');
  await writeFile(
    poisonedBin,
    process.platform === 'win32'
      ? '@echo off\r\nexit /b 91\r\n'
      : '#!/bin/sh\nexit 91\n',
    'utf8',
  );
};

const writeTypeScriptFixture = async ({ withDependency }: { withDependency: boolean }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kernel-command-catalog-'));
  await writeInstalledTypeScript(root);
  await writeFile(path.join(root, 'package.json'), JSON.stringify({
    name: 'command-catalog-fixture',
    ...(withDependency ? { devDependencies: { typescript: '7.0.2' } } : {}),
    scripts: {},
  }), 'utf8');
  await writeFile(path.join(root, 'tsconfig.json'), '{"compilerOptions":{"noEmit":true}}\n', 'utf8');
  return { root, packagePath: path.join(root, 'package.json') };
};

const writeTypeScriptFixtureWithoutScripts = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kernel-command-catalog-no-scripts-'));
  await writeInstalledTypeScript(root);
  await writeFile(path.join(root, 'package.json'), JSON.stringify({
    name: 'command-catalog-no-scripts-fixture',
    devDependencies: { typescript: '7.0.2' },
  }), 'utf8');
  await writeFile(path.join(root, 'tsconfig.json'), '{}\n', 'utf8');
  return { root };
};

test('discovers a local TypeScript static-analysis command only from project-owned prerequisites', async () => {
  const fixture = await writeTypeScriptFixture({ withDependency: true });
  try {
    const before = await readFile(fixture.packagePath, 'utf8');
    const commands = projectCommands(fixture.root);
    const typecheck = commands.find((command) => command.commandRef === 'typescript:check');
    assert.ok(typecheck);
    assert.equal(typecheck.commandClass, 'static-analysis');
    assert.equal(typecheck.command, 'node');
    assert.deepEqual(typecheck.args, ['node_modules/typescript/bin/tsc', '--noEmit']);
    assert.equal(typecheck.source, 'package.json+tsconfig.json+typescript package bin');
    assert.equal(typecheck.declaration, 'node node_modules/typescript/bin/tsc --noEmit');
    assert.equal(await readFile(fixture.packagePath, 'utf8'), before);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('does not invent a TypeScript command when the project has no TypeScript dependency', async () => {
  const fixture = await writeTypeScriptFixture({ withDependency: false });
  try {
    const commands = projectCommands(fixture.root);
    assert.equal(commands.some((command) => command.commandRef === 'typescript:check'), false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('discovers the TypeScript fallback when package.json has no scripts field', async () => {
  const fixture = await writeTypeScriptFixtureWithoutScripts();
  try {
    const commands = projectCommands(fixture.root);
    assert.equal(commands.some((command) => command.commandRef === 'typescript:check'), true);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
