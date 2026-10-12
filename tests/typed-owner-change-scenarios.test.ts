import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildRuntime, ROOT } from '../tools/build/runtime.js';
import { runGit } from '../src/shared/git-safe.js';
import type { RuntimeManifest } from '../tools/build/types.js';

interface Scenario {
  name: string;
  source: string;
  output: string;
  before: string;
  after: string;
  probe: string;
  baseline: unknown;
  changed: unknown;
}

const scenarios: Scenario[] = [
  {
    name: 'Codex model policy belongs to Host',
    source: 'src/host/kernel/codex-model-policy.ts', output: 'scripts/host/kernel/codex-model-policy.js',
    before: "standard: Object.freeze({ model: CODEX_MODELS.luna, effort: 'max' })",
    after: "standard: Object.freeze({ model: CODEX_MODELS.luna, effort: 'high' })",
    probe: "const { CODEX_EXECUTION_POLICY } = await import('./scripts/host/kernel/codex-model-policy.js'); console.log(JSON.stringify(CODEX_EXECUTION_POLICY.standard.effort));",
    baseline: 'max', changed: 'high',
  },
  {
    name: 'Knowledge path ranking belongs to Knowledge',
    source: 'src/kernel/knowledge/path-scope.ts', output: 'scripts/kernel/knowledge/path-scope.js',
    before: 'if (s === targetPath) score += 40;', after: 'if (s === targetPath) score += 42;',
    probe: "const { scoreRelevance } = await import('./scripts/kernel/knowledge/path-scope.js'); console.log(JSON.stringify(scoreRelevance({item:{scope:['src/example.ts']},paths:['src/example.ts']})));",
    baseline: 45, changed: 47,
  },
  {
    name: 'Completion policy belongs to Trust',
    source: 'src/kernel/proof/completion-view.ts', output: 'scripts/kernel/proof/completion-view.js',
    before: "const done = kernelAcceptance === 'accepted' && finalization === 'complete';",
    after: "const done = kernelAcceptance === 'accepted' && finalization === 'complete' && review === 'passed';",
    probe: "const { computeCompletionView } = await import('./scripts/kernel/proof/completion-view.js'); console.log(JSON.stringify(computeCompletionView({run:{finalizationStatus:'completed'},completionDecision:{decision:'accepted'}}).overall));",
    baseline: 'done', changed: 'active',
  },
  {
    name: 'Resume policy belongs to Work',
    source: 'src/kernel/run/invocation-resolver.ts', output: 'scripts/kernel/run/invocation-resolver.js',
    before: "mode: revised ? 'revise' : 'resume',",
    after: "mode: cursorRun.status === 'blocked' || revised ? 'revise' : 'resume',",
    probe: "const {resolveBoundInvocation}=await import('./scripts/kernel/run/invocation-resolver.js'); const run={runId:'scenario',projectId:'project',status:'blocked'}; console.log(JSON.stringify(resolveBoundInvocation({stateStore:{getRun:()=>run},projectId:'project',workspaceId:'workspace',explicitRunId:'scenario'}).mode));",
    baseline: 'resume', changed: 'revise',
  },
];

const probe = (root: string, code: string): unknown => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: root, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
};

for (const scenario of scenarios) {
  test(scenario.name, { timeout: 120_000 }, async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'typed-owner-change-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    for (const relative of ['src', 'tools/build', 'schemas', 'catalog/kernel-contracts.json', 'package/source-layout.json', 'package.json', 'tsconfig.json', 'tsconfig.build.json', 'tsconfig.tools.json']) {
      await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
      await cp(path.join(ROOT, relative), path.join(root, relative), { recursive: true });
    }
    await symlink(path.join(ROOT, 'node_modules'), path.join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    runGit(root, ['init', '-b', 'main']);
    runGit(root, ['config', 'user.name', 'Owner Scenario']);
    runGit(root, ['config', 'user.email', 'owner-scenario@example.invalid']);
    runGit(root, ['add', 'src', 'tools', 'package', 'package.json', 'tsconfig.json', 'tsconfig.build.json', 'tsconfig.tools.json']);
    runGit(root, ['commit', '-m', 'isolated source baseline']);
    await buildRuntime({ root });
    const baseline: RuntimeManifest = JSON.parse(await readFile(path.join(root, 'dist/runtime-build.json'), 'utf8'));
    assert.deepEqual(probe(root, scenario.probe), scenario.baseline);
    const source = path.join(root, scenario.source);
    const original = await readFile(source, 'utf8');
    assert.equal(original.split(scenario.before).length, 2, 'the trial edits exactly one owner policy');
    await writeFile(source, original.replace(scenario.before, scenario.after));
    const result = await buildRuntime({ root });
    assert.equal(result.changed, 1);
    const changed: RuntimeManifest = JSON.parse(await readFile(path.join(root, 'dist/runtime-build.json'), 'utf8'));
    const previous = new Map(baseline.files.map(file => [file.source, file]));
    assert.deepEqual(changed.files.filter(file => file.sourceDigest !== previous.get(file.source)?.sourceDigest).map(file => file.source), [scenario.source]);
    assert.deepEqual(changed.files.filter(file => file.outputDigest !== previous.get(file.source)?.outputDigest).map(file => file.output), [scenario.output]);
    assert.deepEqual(probe(root, scenario.probe), scenario.changed);
    assert.equal((await buildRuntime({ root, check: true })).status, 'passed');
    assert.equal((await readFile(path.join(ROOT, scenario.source), 'utf8')), original, 'the product source is unchanged');
  });
}
