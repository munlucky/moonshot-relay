import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { runGit } from '../scripts/lib/git-safe.mjs';
import {
  isPathStagable,
  filterStagingSelection,
  partitionStagingPathsByTracking,
  stageSelectedPaths,
} from '../scripts/kernel/git/staging-policy.mjs';

const git = (repoRoot, args) => {
  const result = runGit(repoRoot, args);
  if (result.error || (result.status ?? 0) !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${String(result.stderr || result.error?.message || '')}`);
  }
  return String(result.stdout || '');
};

// Repository shaped like the closeout failure seen in the field: a file that is
// tracked and ALSO covered by an ignore rule on its parent directory.
const createIgnoredTrackedRepo = async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'kernel-staging-repo-'));
  git(repoRoot, ['init', '-q', '.']);
  git(repoRoot, ['config', 'user.email', 'kernel@test.local']);
  git(repoRoot, ['config', 'user.name', 'kernel-test']);
  await mkdir(path.join(repoRoot, 'runtime'), { recursive: true });
  await writeFile(path.join(repoRoot, 'runtime', 'project-routes.yaml'), 'routes: 1\n');
  await writeFile(path.join(repoRoot, 'app.mjs'), 'export const value = 1;\n');
  git(repoRoot, ['add', '-f', '--', 'runtime/project-routes.yaml', 'app.mjs']);
  git(repoRoot, ['commit', '-qm', 'seed']);
  await writeFile(path.join(repoRoot, '.gitignore'), 'runtime/\n');
  git(repoRoot, ['add', '--', '.gitignore']);
  git(repoRoot, ['commit', '-qm', 'ignore runtime']);
  return repoRoot;
};

const stagedPaths = (repoRoot) => git(repoRoot, ['diff', '--cached', '--name-only'])
  .split(/\r?\n/)
  .filter(Boolean)
  .sort();

test('isPathStagable rejects runtime DB, env, and memorygraph files', () => {
  assert.equal(isPathStagable('src/index.mjs'), true);
  assert.equal(isPathStagable('.env'), false);
  assert.equal(isPathStagable('.moonshot-relay/state/runtime-state.sqlite'), false);
  assert.equal(isPathStagable('.claude/memorygraph/graph.json'), false);
});

test('filterStagingSelection separates allowed source paths from hard deny paths', () => {
  const input = ['scripts/kernel/test.mjs', '.env.local', 'state.sqlite'];
  const { selectedPaths, excludedPaths } = filterStagingSelection(input);

  assert.deepEqual(selectedPaths, ['scripts/kernel/test.mjs']);
  assert.deepEqual(excludedPaths, ['.env.local', 'state.sqlite']);
});

test('staging deny patterns cover provider sessions, git internals, and account state', () => {
  for (const denied of [
    '.env',
    '.env.local',
    '.codex/state/session.json',
    '.qwen/session.json',
    '.git/config',
    '.agents/skills/example/SKILL.md',
    '.mcp.json',
    '.claude/memory.json',
    '.claude/cache/memorygraph/graph.json',
    '.moon-relay-kernel/state/runtime-state.sqlite',
    'data/local.sqlite',
  ]) {
    assert.equal(isPathStagable(denied), false, `expected deny: ${denied}`);
  }
  for (const allowed of ['src/app.mjs', 'scripts/kernel/git/staging-policy.mjs', 'docs/readme.md']) {
    assert.equal(isPathStagable(allowed), true, `expected allow: ${allowed}`);
  }
});

test('stageSelectedPaths stages a tracked path that an ignore rule also matches', async () => {
  const repoRoot = await createIgnoredTrackedRepo();
  try {
    await writeFile(path.join(repoRoot, 'runtime', 'project-routes.yaml'), 'routes: 2\n');

    const partition = partitionStagingPathsByTracking({ repoRoot, paths: ['runtime/project-routes.yaml'] });
    assert.deepEqual(partition.tracked, ['runtime/project-routes.yaml']);
    assert.deepEqual(partition.untracked, []);

    // Plain `git add -- <path>` exits non-zero here; the helper must not.
    const result = stageSelectedPaths({ repoRoot, paths: ['runtime/project-routes.yaml'] });
    assert.deepEqual(result.staged, ['runtime/project-routes.yaml']);
    assert.deepEqual(stagedPaths(repoRoot), ['runtime/project-routes.yaml']);

    git(repoRoot, ['commit', '-qm', 'update routes']);
    assert.deepEqual(stagedPaths(repoRoot), []);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test('stageSelectedPaths stages tracked deletions and new untracked files together', async () => {
  const repoRoot = await createIgnoredTrackedRepo();
  try {
    await writeFile(path.join(repoRoot, 'runtime', 'project-routes.yaml'), 'routes: 3\n');
    await writeFile(path.join(repoRoot, 'added.mjs'), 'export const added = true;\n');
    await rm(path.join(repoRoot, 'app.mjs'));

    const result = stageSelectedPaths({
      repoRoot,
      paths: ['runtime/project-routes.yaml', 'added.mjs', 'app.mjs'],
    });

    assert.deepEqual(result.untracked, ['added.mjs']);
    assert.deepEqual(result.tracked.sort(), ['app.mjs', 'runtime/project-routes.yaml']);
    assert.deepEqual(stagedPaths(repoRoot), ['added.mjs', 'app.mjs', 'runtime/project-routes.yaml']);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test('stageSelectedPaths still refuses an untracked path that is ignored', async () => {
  const repoRoot = await createIgnoredTrackedRepo();
  try {
    await writeFile(path.join(repoRoot, 'runtime', 'generated.yaml'), 'generated: true\n');

    assert.throws(
      () => stageSelectedPaths({ repoRoot, paths: ['runtime/generated.yaml'] }),
      /GIT_ADD_FAILED/,
    );
    assert.deepEqual(stagedPaths(repoRoot), []);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test('the default npm test command runs the staging and unification suites', async () => {
  const manifest = JSON.parse(await readFile(path.join(process.cwd(), 'package.json'), 'utf8'));
  const composed = String(manifest.scripts?.test || '')
    .split('&&')
    .map((segment) => segment.trim().replace(/^npm run\s+/, ''))
    .map((name) => String(manifest.scripts?.[name] || ''))
    .join(' ');
  // A regression only the non-default suites catch is a regression the next
  // contributor — and CI running `npm test` — will not see.
  for (const required of [
    'tests/kernel-git-staging-policy.test.mjs',
    'tests/kernel-standalone-unification.test.mjs',
    'tests/kernel-standalone-project-knowledge.test.mjs',
  ]) {
    assert.ok(composed.includes(required), `npm test must run ${required}`);
  }
});

test('Kernel Git staging call sites share the staging-policy helper', async () => {
  const callSites = [
    'scripts/kernel/standalone/kernel-commit.mjs',
    'scripts/kernel/git/closeout.mjs',
    'scripts/host/kernel/workspace/physical-worktree.mjs',
  ];
  for (const relativePath of callSites) {
    const source = await readFile(path.join(process.cwd(), relativePath), 'utf8');
    assert.match(source, /stageSelectedPaths/, `${relativePath} must stage through staging-policy`);
    assert.doesNotMatch(
      source,
      /\[\s*'add'\s*,/,
      `${relativePath} must not invoke git add directly`,
    );
  }
});
