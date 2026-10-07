import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const sourceRoot = path.resolve('.');
const script = path.join(sourceRoot, 'scripts', 'harness-surface-report.mjs');
const tempRoots = [];
after(async () => Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true }))));

const run = (...args) => spawnSync(process.execPath, [script, ...args], {
  cwd: sourceRoot,
  encoding: 'utf8',
});

const fixture = async (files) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'moonshot-surface-fixture-'));
  tempRoots.push(root);
  for (const [relative, body] of Object.entries(files)) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, body);
  }
  const initialized = spawnSync('git', ['init', '--quiet'], { cwd: root, encoding: 'utf8' });
  assert.equal(initialized.status, 0, initialized.stderr);
  const staged = spawnSync('git', ['add', '--all'], { cwd: root, encoding: 'utf8' });
  assert.equal(staged.status, 0, staged.stderr);
  const committed = spawnSync('git', [
    '-c', 'user.name=Moonshot Fixture',
    '-c', 'user.email=fixture@example.invalid',
    'commit', '--quiet', '-m', 'fixture',
  ], { cwd: root, encoding: 'utf8' });
  assert.equal(committed.status, 0, committed.stderr);
  return root;
};

test('surface report inventories every tracked test and current budget passes', () => {
  const reported = run('report', '--source-root', sourceRoot, '--json');
  assert.equal(reported.status, 0, reported.stderr);
  const report = JSON.parse(reported.stdout);
  assert.equal(report.status, 'pass');
  assert.ok(report.totals.files > 0);
  assert.ok(report.totals.nonblankLines > 0);
  assert.equal(report.testInventory.unregisteredCount, 0, report.testInventory.unregistered.join('\n'));

  const checked = run('check', '--source-root', sourceRoot, '--json');
  assert.equal(checked.status, 0, checked.stdout || checked.stderr);
  assert.equal(JSON.parse(checked.stdout).status, 'pass');
});

test('surface inventory follows imported test suites and leaves unreachable suites unregistered', async () => {
  const root = await fixture({
    'package.json': JSON.stringify({ scripts: { test: 'node --test tests/entry.test.mjs' } }),
    'tests/entry.test.mjs': "import './behavior.test.mjs';\n",
    'tests/behavior.test.mjs': "import './entry.test.mjs';\n",
    'tests/unreachable.test.mjs': "import test from 'node:test';\n",
  });
  const reported = run('report', '--source-root', root, '--json');
  assert.equal(reported.status, 0, reported.stderr);
  const report = JSON.parse(reported.stdout);
  assert.deepEqual(report.testInventory.unregistered, ['tests/unreachable.test.mjs']);
});

test('surface check blocks a deterministic over-budget source', async () => {
  const reported = run('report', '--source-root', sourceRoot, '--json');
  assert.equal(reported.status, 0, reported.stderr);
  const report = JSON.parse(reported.stdout);
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'moonshot-surface-budget-'));
  tempRoots.push(tempRoot);
  const config = path.join(tempRoot, 'budget.json');
  await writeFile(config, `${JSON.stringify({
    schemaVersion: 1,
    baseline: { ...report.totals, files: report.totals.files - 1 },
    allowedDelta: { files: 0, nonblankLines: 0, utf8Bytes: 0, estimatedPromptTokens: 0 },
    allowedUnregisteredTests: 0,
  }, null, 2)}\n`);

  const checked = run('check', '--source-root', sourceRoot, '--config', config, '--json');
  assert.equal(checked.status, 1);
  const result = JSON.parse(checked.stdout);
  assert.equal(result.status, 'fail');
  assert.ok(result.blockers.some((blocker) => blocker.metric === 'files'));
});

test('surface report measures the actual worktree after an unstaged deletion', async () => {
  const root = await fixture({
    'README.md': 'remove me\n',
    'package.json': JSON.stringify({ scripts: { test: 'node --test tests/registered.test.js' } }),
    'tests/registered.test.js': 'export {};\n',
  });
  await rm(path.join(root, 'README.md'));
  const reported = run('report', '--source-root', root, '--json');
  assert.equal(reported.status, 0, reported.stderr);
  const report = JSON.parse(reported.stdout);
  assert.equal(report.totals.files, 2);
  assert.equal(report.testInventory.unregisteredCount, 0);
});

test('surface report finds JS/CJS specs and invalid test allowances fail closed', async () => {
  const root = await fixture({
    'package.json': JSON.stringify({ scripts: {} }),
    'tests/missed.spec.js': 'export {};\n',
    'tests/missed.spec.cjs': 'module.exports = {};\n',
  });
  const reported = run('report', '--source-root', root, '--json');
  assert.equal(reported.status, 0, reported.stderr);
  const report = JSON.parse(reported.stdout);
  assert.deepEqual(report.testInventory.unregistered, [
    'tests/missed.spec.cjs',
    'tests/missed.spec.js',
  ]);

  const config = path.join(root, 'budget.json');
  await writeFile(config, `${JSON.stringify({
    schemaVersion: 1,
    baseline: report.totals,
    allowedDelta: { files: 10, nonblankLines: 10, utf8Bytes: 1000, estimatedPromptTokens: 250 },
    allowedUnregisteredTests: 'typo',
  }, null, 2)}\n`);
  const checked = run('check', '--source-root', root, '--config', config, '--json');
  assert.equal(checked.status, 1);
  assert.match(JSON.parse(checked.stdout).error, /non-negative integer/);
});

test('surface budget measures versioned files only and keeps untracked diagnostics informational', async () => {
  const root = await fixture({
    'README.md': 'versioned\n',
    'package.json': JSON.stringify({ scripts: { test: 'node --test tests/registered.test.js' } }),
    'tests/registered.test.js': 'export {};\n',
  });
  await writeFile(path.join(root, 'diagnostic.log'), 'untracked diagnostic\n');
  const reported = run('report', '--source-root', root, '--json');
  assert.equal(reported.status, 0, reported.stderr);
  const report = JSON.parse(reported.stdout);
  assert.equal(report.authority.includesUntracked, false);
  assert.equal(report.authority.command, 'git ls-files --cached');
  assert.ok(report.diagnostics.untrackedFiles.includes('diagnostic.log'));
  assert.equal(report.totals.files, 3);

  const config = path.join(root, 'budget.json');
  const configText = `${JSON.stringify({
    schemaVersion: 1,
    baseline: report.totals,
    allowedDelta: { files: 0, nonblankLines: 0, utf8Bytes: 0, estimatedPromptTokens: 0 },
    allowedUnregisteredTests: 0,
  }, null, 2)}\n`;
  await writeFile(config, configText);
  const checked = run('check', '--source-root', root, '--config', config, '--json');
  assert.equal(checked.status, 0, checked.stdout || checked.stderr);
  assert.equal(JSON.parse(checked.stdout).status, 'pass');
  assert.equal(await readFile(config, 'utf8'), configText, 'check must not ratchet the baseline');
});
