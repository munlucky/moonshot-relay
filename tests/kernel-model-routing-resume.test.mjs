import { prepareTestHostTurn, decideTestModelRoute } from './helpers/kernel-host-test-api.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createKernelControlPlane } from '../scripts/kernel/control-plane.mjs';

const CLAUDE = { surface: 'claude', supportsSubagentModel: true, supportsIndependentContext: true, supportsUsageTokens: true, supportsResolvedModelIdentity: true };

// Routing history must survive a process boundary, because a resumed run has
// no chat history to recover the escalation state from.
test('route decisions and usage receipts survive a fresh process', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'krn-route-resume-home-'));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'krn-route-resume-proj-'));
  spawnSync('git', ['init'], { cwd: projectRoot, encoding: 'utf8' });
  await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'node -e "process.exit(0)"', lint: 'node -e "process.exit(0)"' } }));

  const cp = await createKernelControlPlane({ runtimeHome, projectRoot });
  let decisionId;
  try {
    await cp.startRun({ runId: 'r-resume', objective: 'resume routing' });
    const host = await prepareTestHostTurn(cp, 'r-resume', { hostCapabilities: CLAUDE });
    decisionId = host.hostDirective.modelRouteDecision.decisionId;
    await cp.recordModelUsage('r-resume', {
      decisionId,
      runId: 'r-resume',
      hostSurface: 'claude',
      actorSessionId: `sha256:${'c'.repeat(64)}`,
      resolvedModel: 'configured-value',
      enforcementStatus: 'enforced',
      resultStatus: 'completed',
      inputTokens: 500,
      outputTokens: 60,
    });
  } finally {
    await cp.close();
  }

  const script = `
    const { openKernelStateStore } = await import(${JSON.stringify(new URL('../scripts/kernel/state-store.mjs', import.meta.url).href)});
    const store = await openKernelStateStore({ runtimeHome: ${JSON.stringify(runtimeHome)} });
    const decisions = store.listModelRouteDecisions('r-resume');
    const receipts = store.listModelUsageReceipts('r-resume');
    const implementation = store.getLatestImplementationSession('r-resume');
    store.close();
    process.stdout.write(JSON.stringify({ decisions, receipts, implementation }));
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  const restored = JSON.parse(child.stdout);
  assert.equal(restored.decisions.length, 1);
  assert.equal(restored.decisions[0].decisionId, decisionId);
  assert.equal(restored.decisions[0].modelClass, 'value_coding');
  assert.equal(restored.receipts[0].enforcementStatus, 'enforced');
  assert.equal(restored.receipts[0].inputTokens, 500);
  assert.equal(restored.implementation.actorSessionId, `sha256:${'c'.repeat(64)}`);

  await rm(runtimeHome, { recursive: true, force: true });
  await rm(projectRoot, { recursive: true, force: true });
});

test('a resumed run keeps its escalation instead of silently demoting to value coding', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'krn-route-lock-home-'));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'krn-route-lock-proj-'));
  spawnSync('git', ['init'], { cwd: projectRoot, encoding: 'utf8' });
  await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({ name: 'x', scripts: { 'test:fail': 'node -e "process.exit(1)"' } }));

  const first = await createKernelControlPlane({ runtimeHome, projectRoot });
  try {
    await first.startRun({ runId: 'r-lock', objective: 'escalation lock' });
    for (let i = 0; i < 3; i += 1) {
      await first.report('r-lock', { summary: `try ${i}`, verifications: [{ obligationId: 'default', commandRef: 'test:fail' }] });
    }
    const escalated = await decideTestModelRoute(first, 'r-lock', { actionKind: 'implement', obligationId: 'default' });
    assert.equal(escalated.modelClass, 'frontier_reasoning');
  } finally {
    await first.close();
  }

  const resumed = await createKernelControlPlane({ runtimeHome, projectRoot });
  try {
    const decision = await decideTestModelRoute(resumed, 'r-lock', { actionKind: 'implement', obligationId: 'default' });
    assert.equal(decision.modelClass, 'frontier_reasoning');
    assert.equal(resumed.modelRoutingSummary('r-lock').frontierTurns, 2);
  } finally {
    await resumed.close();
    await rm(runtimeHome, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  }
});
