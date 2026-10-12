import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const setup = async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'krn-wt-cc-home-'));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'krn-wt-cc-proj-'));
  spawnSync('git', ['init'], { cwd: projectRoot, encoding: 'utf8' });
  await mkdir(path.join(projectRoot, '.moon-relay'), { recursive: true });
  await writeFile(path.join(projectRoot, '.moon-relay', 'track.yaml'), 'track: kernel\nproduct: moon-relay-kernel\n');
  await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({
    name: 'worktree-concurrency-downgrade',
    version: '0.0.1',
    scripts: { test: 'node -e "process.exit(0)"' },
  }));
  await writeFile(path.join(projectRoot, 'index.mjs'), 'export const main = 1;\n');

  const contractPath1 = path.join(projectRoot, 'contract-1.json');
  await writeFile(contractPath1, JSON.stringify({
    objective: 'writer session 1',
    acceptance: [{ acceptance: 'session 1 works' }],
    allowedPaths: ['index.mjs'],
  }));

  const contractPath2 = path.join(projectRoot, 'contract-2.json');
  await writeFile(contractPath2, JSON.stringify({
    objective: 'writer session 2',
    acceptance: [{ acceptance: 'session 2 works' }],
    allowedPaths: ['index.mjs'],
  }));

  return { runtimeHome, projectRoot, contractPath1, contractPath2 };
};

const cleanup = async ({ runtimeHome, projectRoot }: { runtimeHome: string; projectRoot: string }) => {
  await rm(runtimeHome, { recursive: true, force: true });
  await rm(projectRoot, { recursive: true, force: true });
};

test('Worktree Concurrency Wave 6: Concurrent writer in same worktree downgrades to read-only analysis without crashing', async () => {
  const fixture = await setup();
  try {
    const kernelBin = path.resolve('bin/moon-relay-kernel.mjs');

    // Session 1: Starts Run 1 in Worktree
    const run1 = spawnSync(process.execPath, [
      kernelBin,
      'next',
      '--contract-json',
      fixture.contractPath1,
      '--project-root',
      fixture.projectRoot,
      '--runtime-home',
      fixture.runtimeHome,
      '--json',
    ], {
      cwd: fixture.projectRoot,
      env: (() => {
        const e: NodeJS.ProcessEnv = {
          ...process.env,
          MOON_RELAY_KERNEL_HOME: fixture.runtimeHome,
          MOON_RELAY_KERNEL_SESSION_ID: 'session-writer-1',
        };
        delete e.CODEX_THREAD_ID;
        return e;
      })(),
      encoding: 'utf8',
    });
    assert.equal(run1.status, 0, `Session 1 should succeed with code 0: ${run1.stderr}`);
    const parsed1 = JSON.parse(run1.stdout.trim());
    assert.equal(parsed1.action?.type, 'implement');

    // Session 2: Starts another task in the SAME worktree while Session 1 is active
    const run2 = spawnSync(process.execPath, [
      kernelBin,
      'next',
      '--contract-json',
      fixture.contractPath2,
      '--invocation-intent',
      'new-task',
      '--project-root',
      fixture.projectRoot,
      '--runtime-home',
      fixture.runtimeHome,
      '--json',
    ], {
      cwd: fixture.projectRoot,
      env: (() => {
        const e: NodeJS.ProcessEnv = {
          ...process.env,
          MOON_RELAY_KERNEL_HOME: fixture.runtimeHome,
          MOON_RELAY_KERNEL_SESSION_ID: 'session-writer-2',
        };
        delete e.CODEX_THREAD_ID;
        return e;
      })(),
      encoding: 'utf8',
    });

    assert.equal(run2.status, 0, `Session 2 should return exit code 0 (not crash), stderr: ${run2.stderr}`);
    const parsed2 = JSON.parse(run2.stdout.trim());
    assert.equal(parsed2.status, 'read-only', 'Should report read-only status');
    assert.equal(parsed2.action?.type, 'analysis', 'Should issue analysis action');
    assert.equal(parsed2.action?.mode, 'read-only', 'Should issue read-only mode');
    assert.match(parsed2.action?.guidance || '', /worktree/i, 'Guidance should suggest separate worktree');
  } finally {
    await cleanup(fixture);
  }
});
