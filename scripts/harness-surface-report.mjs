#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const args = process.argv.slice(2);
const command = args[0] || 'report';
const option = (name, fallback = null) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};

const sourceRoot = path.resolve(option('--source-root', process.cwd()));
const configPath = path.resolve(sourceRoot, option('--config', 'package/harness-surface-budget.json'));
const json = args.includes('--json');

const git = (...gitArgs) => {
  const result = spawnSync('git', ['-C', sourceRoot, ...gitArgs], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr.trim() || `git ${gitArgs.join(' ')} failed`);
  return result.stdout;
};

const versionedFiles = () => git('ls-files', '-z', '--cached')
  .split('\0')
  .filter(Boolean)
  .map((entry) => entry.replaceAll('\\', '/'))
  .filter((entry) => existsSync(path.join(sourceRoot, entry)))
  .sort();

const untrackedFiles = () => git('ls-files', '-z', '--others', '--exclude-standard')
  .split('\0')
  .filter(Boolean)
  .map((entry) => entry.replaceAll('\\', '/'))
  .filter((entry) => existsSync(path.join(sourceRoot, entry)))
  .sort();

const isTestFile = (relative) => relative.startsWith('tests/') && (
  relative.endsWith('.test.mjs')
  || relative.endsWith('.test.js')
  || relative.endsWith('.test.cjs')
  || relative.endsWith('.test.ts')
  || relative.endsWith('_test.py')
  || relative.endsWith('.spec.mjs')
  || relative.endsWith('.spec.js')
  || relative.endsWith('.spec.cjs')
  || relative.endsWith('.spec.ts')
);

const compilerSurface = async (paths) => {
  const generated = new Set();
  const testSources = new Map();
  if (!existsSync(path.join(sourceRoot, 'package/source-layout.json'))) return { generated, testSources };
  const manifest = JSON.parse(await readFile(path.join(sourceRoot, 'dist/runtime-build.json'), 'utf8'));
  for (const item of manifest.files) generated.add(item.output);
  generated.add('dist/runtime-build.json');
  const contracts = JSON.parse(await readFile(path.join(sourceRoot, 'catalog/kernel-contracts.json'), 'utf8'));
  for (const contract of contracts.contracts) generated.add(contract.generatedType);
  generated.add('src/contracts/schema-definitions.generated.ts');
  for (const source of paths) {
    if (source.startsWith('tools/build/') && source.endsWith('.ts')) generated.add(source.replace(/\.ts$/, '.mjs'));
    if (!source.startsWith('tests/') || !source.endsWith('.ts')) continue;
    if (!source.startsWith('tests/types/') && !source.startsWith('tests/fixtures/')) generated.add('dist/' + source.replace(/\.ts$/, '.mjs'));
    const wrapper = source.replace(/\.ts$/, '.mjs');
    if (!existsSync(path.join(sourceRoot, wrapper))) continue;
    const body = await readFile(path.join(sourceRoot, wrapper), 'utf8');
    if (body.startsWith('// Generated test entrypoint. Edit ' + source + '.\n')) {
      generated.add(wrapper);
      testSources.set(wrapper, source);
    }
  }
  return { generated, testSources };
};

// Imported Node test suites are registered by the invoking npm script too.
// Follow literal local imports only; this is an inventory, never execution.
const testScriptCoverage = async (paths, scripts, testSources) => {
  const coverage = new Map();
  for (const [name, command] of scripts) {
    const testArguments = [...String(command).matchAll(/\btests\/[^\s'";&|]+/g)].map(match => match[0]);
    const declared = testArguments.map(argument => new RegExp('^' + argument.split('**').map(part => part.split('*').map(literal => literal.replace(/[\\^$+?.()|{}\[\]]/g, '\\$&')).join('[^/]*')).join('.*') + '$'));
    const pending = paths.filter((relative) => isTestFile(relative) && declared.some(pattern => pattern.test(relative)));
    const visited = new Set();
    while (pending.length > 0) {
      const relative = pending.pop();
      if (visited.has(relative)) continue;
      visited.add(relative);
      if (isTestFile(relative)) {
        const registered = coverage.get(relative) || new Set();
        registered.add(name);
        coverage.set(relative, registered);
        const source = testSources.get(relative);
        if (source) {
          const sourceRegistration = coverage.get(source) || new Set();
          sourceRegistration.add(name);
          coverage.set(source, sourceRegistration);
        }
      }
      const body = await readFile(path.join(sourceRoot, relative), 'utf8');
      const imports = /\b(?:import\s*(?:[^'";\n]*?\bfrom\s*)?|import\s*\(\s*)['"](\.[^'"]+)['"]/g;
      for (const match of body.matchAll(imports)) {
        const target = path.resolve(sourceRoot, path.dirname(relative), match[1]);
        const child = path.relative(sourceRoot, target).replaceAll('\\', '/');
        if (child.startsWith('../') || path.isAbsolute(child) || !/\.[cm]?js$/.test(child)) continue;
        if (existsSync(target)) pending.push(child);
      }
    }
  }
  return coverage;
};

const collectReport = async () => {
  // Surface budget authority is the versioned repository surface only. Keep
  // untracked paths visible for diagnosis, but never let them move a budget
  // metric or its baseline.
  const files = versionedFiles();
  const untracked = untrackedFiles();
  const packageJson = JSON.parse(await readFile(path.join(sourceRoot, 'package.json'), 'utf8'));
  const scripts = Object.entries(packageJson.scripts || {});
  const { generated, testSources } = await compilerSurface([...files, ...untracked]);
  const canonicalFiles = files.filter(relative => !generated.has(relative));
  const scriptCoverage = await testScriptCoverage([...files, ...untracked], scripts, testSources);
  let utf8Bytes = 0;
  let nonblankLines = 0;
  const categories = {};

  for (const relative of canonicalFiles) {
    const body = await readFile(path.join(sourceRoot, relative));
    utf8Bytes += body.byteLength;
    nonblankLines += body.toString('utf8').split(/\r?\n/u).filter((line) => line.trim()).length;
    const category = relative.includes('/') ? relative.split('/')[0] : 'root';
    categories[category] = (categories[category] || 0) + 1;
  }

  const tests = canonicalFiles.filter(isTestFile).map((relative) => ({
    path: relative,
    kind: relative.startsWith('tests/fixtures/') || relative.startsWith('tests/types/') ? 'fixture' : 'runnable',
    scripts: [...(scriptCoverage.get(relative) || [])].sort(),
  }));
  const runnableTests = tests.filter((entry) => entry.kind === 'runnable');
  const fixtureTests = tests.filter((entry) => entry.kind === 'fixture');
  const unregistered = runnableTests.filter((entry) => entry.scripts.length === 0).map((entry) => entry.path);
  const status = git('status', '--porcelain').trim() ? 'dirty' : 'clean';

  return {
    schemaVersion: 1,
    source: { root: sourceRoot, head: git('rev-parse', 'HEAD').trim(), status },
    authority: {
      kind: 'versioned-repository-surface',
      command: 'git ls-files --cached',
      includesUntracked: false,
      excludesCompilerGenerated: true,
    },
    diagnostics: {
      untrackedFiles: untracked,
      untrackedCount: untracked.length,
      compilerGeneratedFiles: files.filter(relative => generated.has(relative)),
      versionedFileCount: files.length,
    },
    totals: {
      files: canonicalFiles.length,
      nonblankLines,
      utf8Bytes,
      estimatedPromptTokens: Math.ceil(utf8Bytes / 4),
    },
    categories,
    testInventory: {
      trackedCount: tests.length,
      runnableCount: runnableTests.length,
      fixtureCount: fixtureTests.length,
      registeredCount: runnableTests.length - unregistered.length,
      unregisteredCount: unregistered.length,
      unregistered,
    },
  };
};

const check = async (report) => {
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  if (config.schemaVersion !== 1) throw new Error('Surface budget schemaVersion must be 1');
  const blockers = [];
  for (const metric of ['files', 'nonblankLines', 'utf8Bytes', 'estimatedPromptTokens']) {
    const baseline = Number(config.baseline?.[metric]);
    const allowance = Number(config.allowedDelta?.[metric]);
    if (!Number.isFinite(baseline) || !Number.isFinite(allowance) || allowance < 0) {
      throw new Error(`Invalid surface budget for ${metric}`);
    }
    const limit = baseline + allowance;
    if (report.totals[metric] > limit) blockers.push({ metric, actual: report.totals[metric], limit });
  }
  const allowedUnregistered = Number(config.allowedUnregisteredTests ?? 0);
  if (!Number.isInteger(allowedUnregistered) || allowedUnregistered < 0) {
    throw new Error('allowedUnregisteredTests must be a non-negative integer');
  }
  if (report.testInventory.unregisteredCount > allowedUnregistered) {
    blockers.push({
      metric: 'unregisteredTests',
      actual: report.testInventory.unregisteredCount,
      limit: allowedUnregistered,
      paths: report.testInventory.unregistered,
    });
  }
  return { ...report, config: { path: configPath, ...config }, status: blockers.length ? 'fail' : 'pass', blockers };
};

try {
  const report = await collectReport();
  const result = command === 'report' ? { ...report, status: 'pass', blockers: [] }
    : command === 'check' ? await check(report)
      : (() => { throw new Error('Usage: harness-surface-report.mjs report|check [--source-root <path>] [--config <path>] [--json]'); })();
  if (json) console.log(JSON.stringify(result, null, 2));
  else console.log(`${result.status}: ${result.totals.files} files, ${result.totals.utf8Bytes} bytes, ${result.testInventory.unregisteredCount} unregistered tests`);
  if (result.status !== 'pass') process.exitCode = 1;
} catch (error) {
  const failure = { status: 'fail', error: String(error?.message || error) };
  if (json) console.log(JSON.stringify(failure, null, 2));
  else console.error(failure.error);
  process.exitCode = 1;
}
