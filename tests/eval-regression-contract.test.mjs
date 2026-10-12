import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, test } from 'node:test';

import { REQUIRED_HARNESS_CONTROL_PLANE_CASES } from '../tools/evals/harness-control-plane.mjs';

const root = process.cwd();
const tempRoots = [];

const makeTempRoot = async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'moonshot-eval-regression-'));
  tempRoots.push(dir);
  return dir;
};

after(async () => {
  await Promise.all(tempRoots.map((dir) => rm(dir, { recursive: true, force: true })));
});

const runNode = (args, env = {}) => spawnSync(process.execPath, args, {
  cwd: root,
  encoding: 'utf8',
  env: {
    ...process.env,
    ...env,
  },
});

const runNpm = (args, env = {}) => spawnSync('npm', args, {
  cwd: root,
  encoding: 'utf8',
  shell: process.platform === 'win32',
  env: {
    ...process.env,
    ...env,
  },
});

const json = (result) => {
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
};

test('harness-control-plane golden fixture namespace covers all required regressions', async () => {
  const fixture = JSON.parse(await readFile(path.join(root, 'tests/fixtures/harness-control-plane/golden-regression.json'), 'utf8'));
  const packagedFixture = JSON.parse(await readFile(path.join(root, 'tools/evals/fixtures/harness-control-plane/golden-regression.json'), 'utf8'));
  const ids = fixture.cases.map((entry) => entry.id).sort();

  assert.deepEqual(packagedFixture, fixture);
  assert.deepEqual(ids, [...REQUIRED_HARNESS_CONTROL_PLANE_CASES].sort());
});

test('npm run test:eval is an executable golden eval gate', () => {
  const result = runNpm(['run', 'test:eval']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout.slice(result.stdout.indexOf('{')));
  assert.equal(output.status, 'passed');
  assert.equal(output.score, 1);
});

test('golden eval records scorecards into runtime eval_results', async () => {
  const tempRoot = await makeTempRoot();
  const env = { PHASE_RUNTIME_DB: path.join(tempRoot, 'runtime-state.sqlite') };
  const result = json(runNode([
    'tools/evals/harness-control-plane.mjs',
    'run',
    '--run-id',
    'run-eval-golden',
    '--goal-id',
    'goal-eval-golden',
    '--json',
  ], env));
  const status = json(runNode([
    'scripts/runtime-state.mjs',
    'status',
    '--run-id',
    'run-eval-golden',
    '--goal-id',
    'goal-eval-golden',
    '--json',
  ], env));

  assert.equal(result.status, 'passed');
  assert.equal(result.evalResult.status, 'recorded');
  assert.equal(status.compactStatus.latestEval.suite, 'harness-control-plane-golden');
  assert.equal(status.compactStatus.latestEval.status, 'passed');
  assert.equal(status.compactStatus.latestEval.regressionWorsened, false);
  assert.equal(status.compactStatus.latestEval.score.score, 1);
});

test('mutating expected output cannot make unchanged production behavior pass', async () => {
  const tempRoot = await makeTempRoot();
  const env = { PHASE_RUNTIME_DB: path.join(tempRoot, 'runtime-state.sqlite') };
  const fixturePath = path.join(tempRoot, 'failing-golden.json');
  const fixture = JSON.parse(await readFile(path.join(root, 'tests/fixtures/harness-control-plane/golden-regression.json'), 'utf8'));
  fixture.cases[0].expected = { releaseBlocked: false, reason: 'false pass' };
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');

  const evalRun = runNode([
    'tools/evals/harness-control-plane.mjs',
    'run',
    '--fixture',
    fixturePath,
    '--run-id',
    'run-eval-worse',
    '--goal-id',
    'goal-eval-worse',
    '--json',
  ], env);
  assert.equal(evalRun.status, 1, evalRun.stderr || evalRun.stdout);
  const output = JSON.parse(evalRun.stdout);
  assert.equal(output.regressionWorsened, true);
  assert.equal(output.failedCases[0].id, 'completion-false-positive');
  assert.deepEqual(output.failedCases[0].actual, { releaseBlocked: true, reason: 'missing accepted completion decision' });

  const assessed = json(runNode([
    'scripts/runtime-state.mjs',
    'assess-completion',
    '--run-id',
    'run-eval-worse',
    '--goal-id',
    'goal-eval-worse',
    '--json',
  ], env));
  assert.equal(assessed.status, 'rejected');
  assert.equal(assessed.reason, 'eval regression worsened: harness-control-plane-golden');
});

test('missing production evaluator is a typed failing result', async () => {
  const tempRoot = await makeTempRoot();
  const fixturePath = path.join(tempRoot, 'missing-evaluator.json');
  const fixture = JSON.parse(await readFile(path.join(root, 'tests/fixtures/harness-control-plane/golden-regression.json'), 'utf8'));
  fixture.cases[0].category = 'unregistered-category';
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');
  const result = runNode(['tools/evals/harness-control-plane.mjs', 'run', '--fixture', fixturePath, '--json']);
  assert.equal(result.status, 1, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout);
  assert.equal(output.failedCases[0].failureClass, 'evaluator_missing');
  assert.equal(output.failedCases[0].evaluatorExecuted, false);
});

test('low-score traces produce reviewed testcase candidates with rollback metadata', async () => {
  const tempRoot = await makeTempRoot();
  const outPath = path.join(tempRoot, '.moonshot-relay', 'traces', 'candidates', 'candidate.json');
  const result = json(runNode([
    'tools/awtl/trace-to-testcase.mjs',
    'candidate',
    '--trace-json',
    JSON.stringify({
      traceId: 'trace-low-score',
      status: 'failed',
      score: 0.42,
      failedCase: {
        id: 'completion-false-positive',
        category: 'completion_authority',
        input: { phaseStatusComplete: true },
        expected: { releaseBlocked: true },
      },
    }),
    '--out',
    outPath,
    '--json',
  ]));
  const written = JSON.parse(await readFile(outPath, 'utf8'));

  assert.equal(result.status, 'candidate_created');
  assert.equal(result.candidate.reviewStatus, 'pending_review');
  assert.equal(result.candidate.promotion.requiresReview, true);
  assert.ok(result.candidate.promotion.requiredEvidence.includes('rollback-metadata'));
  assert.equal(result.candidate.improvementCandidate.schemaVersion, 1);
  assert.equal(result.candidate.improvementCandidate.state, 'ready_for_review');
  assert.equal(result.candidate.improvementCandidate.sourceMutation.allowed, false);
  assert.equal(result.candidate.improvementCandidate.sourceMutation.requiresAcceptedParentEdit, true);
  assert.ok(result.candidate.improvementCandidate.sourceMutation.forbiddenTargets.includes('schemas'));
  assert.ok(result.candidate.improvementCandidate.sourceMutation.forbiddenTargets.includes('verification_contracts'));
  assert.ok(result.candidate.improvementCandidate.requiredEvidence.includes('accepted-parent-edit'));
  assert.ok(result.candidate.improvementCandidate.requiredEvidence.includes('fresh-regression-evidence'));
  assert.match(result.candidate.rollback.removes[0], /tests\/fixtures\/harness-control-plane\/completion-false-positive\.json/);
  assert.equal(written.sourceTraceId, 'trace-low-score');
  assert.equal(written.improvementCandidate.sourceMutation.allowed, false);
});

test('eval gate package contract includes source tools and keeps generated eval artifacts out', async () => {
  const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const contract = await readFile(path.join(root, 'package/package-contract.yaml'), 'utf8');
  const packageTest = await readFile(path.join(root, 'tests/package-materialization.test.ts'), 'utf8');

  assert.match(packageJson.scripts['test:eval'], /tools\/evals\/harness-control-plane\.mjs run --json/);
  assert.match(contract, /source: tools\/evals\/harness-control-plane\.mjs/);
  assert.match(contract, /source: tools\/awtl\/trace-to-testcase\.mjs/);
  assert.match(contract, /source: schemas\/improvement-candidate-v1\.schema\.json/);
  assert.match(contract, /\.moonshot-relay\/eval-artifacts\/\*\*/);
  assert.match(packageTest, /schemas\/improvement-candidate-v1\.schema\.json/);
  assert.match(packageTest, /tools\/evals\/harness-control-plane\.mjs/);
  assert.match(packageTest, /tools\/awtl\/trace-to-testcase\.mjs/);
});
