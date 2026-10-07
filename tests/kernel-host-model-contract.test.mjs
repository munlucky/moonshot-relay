import { prepareTestHostTurn } from './helpers/kernel-host-test-api.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createKernelControlPlane } from '../scripts/kernel/control-plane.mjs';
import { normalizeHostCapabilities, resolveEnforcementStrategy } from '../scripts/kernel/run/model-route-contract.mjs';
import { parseModelProfiles, resolveModelForClass } from '../scripts/host/kernel/model-registry.mjs';

const CLAUDE = { surface: 'claude', supportsSubagentModel: true, supportsIndependentContext: true, supportsUsageTokens: true, supportsResolvedModelIdentity: true };

const withRun = async (fn, { runId = 'r-host' } = {}) => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'krn-host-home-'));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'krn-host-proj-'));
  spawnSync('git', ['init'], { cwd: projectRoot, encoding: 'utf8' });
  await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'node -e "process.exit(0)"', lint: 'node -e "process.exit(0)"' } }));
  const cp = await createKernelControlPlane({ runtimeHome, projectRoot });
  try {
    await cp.startRun({ runId, objective: 'host model contract' });
    return await fn(cp, runId);
  } finally {
    await cp.close();
    await rm(runtimeHome, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  }
};

test('the model-visible next payload is unchanged and carries no routing vocabulary', async () => {
  await withRun(async (cp, runId) => {
    const plain = await cp.next(runId);
    const host = await prepareTestHostTurn(cp, runId, { hostCapabilities: CLAUDE });
    // The Host turn adds exactly one field: the handle for the bounded context
    // the worker is being given (K1), which the model echoes back in `report`.
    // Everything else the model sees must be identical, and no routing
    // vocabulary may reach it through either path.
    const { capsuleId, ...hostAction } = host.modelInput.action;
    assert.match(capsuleId, /^capsule-[a-f0-9]{8,64}$/);
    assert.deepEqual({ ...host.modelInput, action: hostAction }, plain);
    assert.deepEqual(plain.action.execution, {
      role: 'implementer',
      executionMode: 'owner-direct',
      delegation: { mode: 'optional' },
    });
    const serialized = JSON.stringify(host.modelInput);
    for (const term of ['modelClass', 'frontier_reasoning', 'value_coding', 'modelRouteDecision', 'enforcementStrategy', 'hostDirective']) {
      assert.doesNotMatch(serialized, new RegExp(term), `next payload must not mention ${term}`);
    }
    assert.equal(plain.hostDirective, undefined);
  });
});

test('hostNext derives the action kind from the action the model was handed', async () => {
  await withRun(async (cp, runId) => {
    const host = await prepareTestHostTurn(cp, runId, { hostCapabilities: CLAUDE });
    assert.equal(host.modelInput.action.type, 'implement');
    assert.equal(host.hostDirective.modelRouteDecision.actionKind, 'implement');
    assert.equal(host.hostDirective.modelRouteDecision.modelClass, 'value_coding');
    assert.equal(host.hostDirective.enforcementStrategy, 'subagent');
    assert.equal(host.hostDirective.executionAssignment.role, 'implementer');
    assert.equal(host.hostDirective.executionAssignment.executionMode, 'owner-direct');
    assert.deepEqual(host.hostDirective.executionAssignment.delegation, { mode: 'optional', requested: false });
    assert.equal(Object.hasOwn(host.hostDirective.executionAssignment, 'parentMayImplement'), false);
    assert.equal(Object.hasOwn(host.hostDirective.executionAssignment, 'nestedDelegationAllowed'), false);
    const review = await prepareTestHostTurn(cp, runId, { hostCapabilities: CLAUDE, actionContext: { actionKind: 'review_engineering' } });
    assert.equal(review.hostDirective.modelRouteDecision.modelClass, 'frontier_reasoning');
    assert.equal(review.hostDirective.modelRouteDecision.permissions, 'read_only');
  });
});

test('every directive is persisted before the Host is allowed to dispatch', async () => {
  await withRun(async (cp, runId) => {
    const host = await prepareTestHostTurn(cp, runId, { hostCapabilities: CLAUDE });
    const summary = cp.modelRoutingSummary(runId);
    assert.equal(summary.totalTurns, 1);
    assert.equal(summary.valueTurns, 1);
    assert.equal(summary.receiptCoverage.receipts, 0);
    assert.ok(host.hostDirective.modelRouteDecision.decisionId.startsWith('route-'));
  });
});

test('the Kernel core carries no provider dependency', async () => {
  const kernelRoot = new URL('../scripts/kernel/', import.meta.url);
  const walk = async (dir) => {
    const entries = await readdir(dir, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      if (entry.isDirectory()) files.push(...await walk(new URL(`${entry.name}/`, dir)));
      else if (entry.name.endsWith('.mjs')) files.push(new URL(entry.name, dir));
    }
    return files;
  };
  const forbidden = [
    /from\s+['"]openai['"]/, /from\s+['"]@anthropic-ai\//, /from\s+['"]@google\//,
    /require\(\s*['"](?:openai|@anthropic-ai)/, /https?:\/\/api\.(?:openai|anthropic)\.com/,
    /process\.env\.(?:OPENAI|ANTHROPIC|GOOGLE)_API_KEY/,
  ];
  const files = await walk(kernelRoot);
  assert.ok(files.length > 10);
  for (const file of files) {
    const body = await readFile(file, 'utf8');
    for (const pattern of forbidden) {
      assert.doesNotMatch(body, pattern, `${file.pathname} must not reach a provider directly`);
    }
  }
});

test('undeclared Host capabilities default to unsupported rather than assumed', () => {
  const bare = normalizeHostCapabilities({ surface: 'mystery' });
  assert.equal(bare.supportsSubagentModel, false);
  assert.equal(bare.supportsResolvedModelIdentity, false);
  assert.equal(resolveEnforcementStrategy(bare), 'unsupported');
  assert.equal(resolveEnforcementStrategy({ surface: 'x', supportsSubagentModel: true }), 'advisory');
  assert.equal(resolveEnforcementStrategy({ surface: 'x', supportsSessionModelOverride: true, supportsResolvedModelIdentity: true }), 'session');
  // A review may be performed from another native surface; missing child
  // context is not an ordinary enforcement blocker.
  assert.equal(resolveEnforcementStrategy(CLAUDE, { modelClass: 'frontier_reasoning', independentContextRequired: true }), 'subagent');
  assert.equal(resolveEnforcementStrategy({ ...CLAUDE, supportsIndependentContext: false }, { modelClass: 'frontier_reasoning', independentContextRequired: true }), 'subagent');
  assert.equal(resolveEnforcementStrategy(CLAUDE, { modelClass: 'kernel' }), 'unsupported');
  assert.throws(() => normalizeHostCapabilities({}), /require a surface/);
});

test('registry precedence runs override, environment, config, then host default', () => {
  const profiles = parseModelProfiles([
    'schemaVersion: 1',
    'hosts:',
    '  codex:',
    '    frontier_reasoning:',
    '      model: ${MY_FRONTIER}',
    '      effort: high',
    '    value_coding:',
    '      model: configured-value',
  ].join('\n'), { MY_FRONTIER: 'configured-frontier' });
  assert.equal(profiles.codex.frontier_reasoning.model, 'configured-frontier');

  const config = resolveModelForClass({ surface: 'codex', modelClass: 'frontier_reasoning', env: {}, profiles });
  assert.equal(config.model, 'configured-frontier');
  assert.equal(config.source, 'profile-config');
  assert.equal(config.enforcementIntent, 'enforced');

  const fromEnv = resolveModelForClass({ surface: 'codex', modelClass: 'value_coding', env: { MOON_RELAY_KERNEL_CODEX_VALUE: 'env-value' }, profiles });
  assert.equal(fromEnv.model, 'env-value');
  assert.equal(fromEnv.source, 'environment');

  const override = resolveModelForClass({ surface: 'codex', modelClass: 'value_coding', overrides: { value_coding: 'override-value' }, env: { MOON_RELAY_KERNEL_CODEX_VALUE: 'env-value' }, profiles });
  assert.equal(override.source, 'invocation-override');

  const unconfigured = resolveModelForClass({ surface: 'qwen', modelClass: 'value_coding', env: {}, profiles });
  assert.equal(unconfigured.model, null);
  assert.equal(unconfigured.source, 'host-default');
  assert.equal(unconfigured.enforcementIntent, 'advisory');

  const kernelClass = resolveModelForClass({ surface: 'codex', modelClass: 'kernel', profiles });
  assert.equal(kernelClass.model, null);
  assert.equal(kernelClass.enforcementIntent, 'not-applicable');
});

test('a completed run refuses a late usage receipt unless it is declared late', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'krn-host-late-home-'));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'krn-host-late-proj-'));
  spawnSync('git', ['init'], { cwd: projectRoot, encoding: 'utf8' });
  await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({ name: 'x', scripts: { 'test:ok': 'node -e "process.exit(0)"' } }));
  const cp = await createKernelControlPlane({ runtimeHome, projectRoot });
  try {
    await cp.startRun({ runId: 'r-late', objective: 'late receipt' });
    const host = await prepareTestHostTurn(cp, 'r-late', { hostCapabilities: CLAUDE });
    const receipt = {
      decisionId: host.hostDirective.modelRouteDecision.decisionId,
      runId: 'r-late',
      hostSurface: 'claude',
      actorSessionId: `sha256:${'a'.repeat(64)}`,
      enforcementStatus: 'advisory',
      resultStatus: 'completed',
    };
    await cp.recordModelUsage('r-late', receipt);
    assert.equal(cp.modelRoutingSummary('r-late').advisoryTurns, 1);

    const report = await cp.report('r-late', {
      summary: 'done',
      capsuleId: host.hostDirective.executionCapsule?.capsuleId,
      attemptId: host.hostDirective.attemptId,
      verifications: [{ obligationId: 'default', commandRef: 'test:ok' }],
    });
    assert.equal((await cp.getRun('r-late')).status, 'completed', JSON.stringify(report.failures));
    await assert.rejects(() => cp.recordModelUsage('r-late', { ...receipt, actorSessionId: `sha256:${'b'.repeat(64)}` }), /late-observation flag/);
    const late = await cp.recordModelUsage('r-late', { ...receipt, actorSessionId: `sha256:${'b'.repeat(64)}` }, { lateObservation: true });
    assert.equal(late.enforcementStatus, 'advisory');
  } finally {
    await cp.close();
    await rm(runtimeHome, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  }
});
