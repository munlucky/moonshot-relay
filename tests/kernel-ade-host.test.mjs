import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { SURFACES, SURFACE_ENV } from '../scripts/switcher/constants.mjs';
import { resolveSurfaceRoots } from '../scripts/switcher/paths.mjs';
import { nativeProviderDescriptor } from '../scripts/switcher/native-provider.mjs';
import { buildLaunchSpec } from '../scripts/switcher/launch-adapter.mjs';
import { providerForSurface } from '../scripts/kernel/run/host-session.mjs';
import { installKernelProfile, inspectProfile } from '../scripts/kernel/profile-install.mjs';
import { createAdeAdapter } from '../scripts/host/kernel/adapters/ade.mjs';
import { createKernelHostReviewBridge } from '../scripts/host/kernel/lifecycle-bridge.mjs';
import { createKernelControlPlane } from '../scripts/kernel/control-plane.mjs';
import { dispatchKernelTurn } from '../scripts/host/kernel/turn-dispatcher.mjs';
import { createModelRegistry } from '../scripts/host/kernel/model-registry.mjs';

const workerReport = (summary = 'done') => ({
  status: 'completed',
  summary,
  changedPaths: [],
  risks: [],
  verifications: [],
  requestedVerifications: [],
  judgments: [],
  knowledgeObservations: [],
  blocker: null,
});

test('ADE switcher selection schema admits ade_cli as a persisted native surface', async () => {
  const schema = JSON.parse(await readFile(path.join(process.cwd(), 'schemas', 'harness-switcher.selection.schema.json'), 'utf8'));
  assert.ok(schema.properties.surface.enum.includes('ade_cli'));
});

test('ADE is a first-class native surface with ADE-owned home, executable, and session identity', () => {
  assert.ok(SURFACES.includes('ade_cli'));
  assert.equal(SURFACE_ENV.ade_cli, 'ADE_HOME');
  assert.equal(providerForSurface('ade_cli'), 'ade');
  assert.equal(providerForSurface('ade'), 'ade');

  const baseEnv = {
    USERPROFILE: '/tmp/ade-user',
    ADE_HOME: '/tmp/ade-home',
    ADE_EXECUTABLE: '/opt/ade/bin/ade',
    PATH: process.env.PATH || '',
  };
  const roots = resolveSurfaceRoots({
    surface: 'ade_cli',
    sourceRoot: process.cwd(),
    kernelHome: '/tmp/kernel-home',
    baseEnv,
  });
  assert.equal(roots.providerHome.replaceAll('\\', '/'), '/tmp/ade-home');

  const provider = nativeProviderDescriptor({ surface: 'ade_cli', runtimeHome: roots.runtimeHome, env: baseEnv });
  assert.equal(provider.provider, 'ade');
  assert.equal(provider.command, '/opt/ade/bin/ade');
  assert.equal(provider.commandSource, 'operator-env');

  const spec = buildLaunchSpec({ surface: 'ade_cli', roots, sourceRoot: process.cwd(), sessionId: 'owner-1' });
  assert.equal(spec.command, 'ade');
  assert.equal(spec.env.MOON_RELAY_KERNEL_PROVIDER, 'ade');
  assert.equal(spec.env.MOON_RELAY_KERNEL_SURFACE, 'ade_cli');
  assert.equal(spec.env.MOON_RELAY_KERNEL_SESSION_ID, 'ade:owner-1');
  assert.equal(spec.env.ADE_HOME.replaceAll('\\', '/'), '/tmp/ade-home');

  assert.throws(
    () => resolveSurfaceRoots({ surface: 'ade_cli', sourceRoot: process.cwd(), kernelHome: '/tmp/kernel-home', baseEnv: { USERPROFILE: '/tmp/ade-user' } }),
    /ADE_HOME is required for ade_cli/,
  );
});

test('ADE Kernel profile installs Qwen-compatible orchestrator policy and isolated child agents into an arbitrary ADE_HOME', async (t) => {
  const targetRoot = await mkdtemp(path.join(os.tmpdir(), 'kernel-ade-profile-'));
  t.after(() => rm(targetRoot, { recursive: true, force: true }));

  const installed = await installKernelProfile({ sourceRoot: process.cwd(), runtime: 'ade', targetRoot });
  assert.equal(installed.status, 'installed');
  const manifest = await inspectProfile(targetRoot);
  assert.equal(manifest.status, 'ready');
  assert.equal(manifest.manifest.provider, 'ade');

  const qwen = await readFile(path.join(targetRoot, 'QWEN.md'), 'utf8');
  assert.match(qwen, /orchestration-only/i);
  assert.match(qwen, /exactly one fresh native\s+child agent/i);
  assert.match(qwen, /Never run two Kernel child agents concurrently/i);
  assert.match(qwen, /Maximum child\s+depth is one/i);
  assert.match(qwen, /prove.*close.*Kernel-owned/is);
  assert.match(await readFile(path.join(targetRoot, 'agents', 'kernel-worker.md'), 'utf8'), /Do not delegate/);
  assert.match(await readFile(path.join(targetRoot, 'agents', 'kernel-reviewer.md'), 'utf8'), /Read only/);
});

test('ADE adapter forces fresh non-nested children and rejects a concurrent second worker', async () => {
  let release;
  let firstRequest = null;
  const gate = new Promise((resolve) => { release = resolve; });
  const adapter = createAdeAdapter({
    spawnAgent: async (request) => {
      firstRequest = request;
      await gate;
      return { sessionId: 'ade-child-1', report: workerReport() };
    },
  });

  assert.equal(adapter.ownerDirectAvailable, false);
  assert.equal(adapter.ownerDirectDefault, false);
  assert.equal(adapter.capabilities.orchestratorOnly, true);
  assert.equal(adapter.capabilities.maxConcurrentWorkers, 1);
  assert.equal(adapter.capabilities.maxNestedAgents, 0);
  assert.equal(adapter.capabilities.supportsConcurrentSessions, false);

  const input = {
    decision: { role: 'implementer', permissions: 'workspace_write' },
    resolution: { model: null, effort: null },
    modelInput: { objective: 'bounded', action: { type: 'implement', guidance: 'edit' } },
    parentSessionId: 'ade-owner',
    childSession: { freshSessionRequired: false, canDelegate: true, canCommit: true, maxNestedAgents: 9 },
  };
  const first = adapter.dispatch(input);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(firstRequest.taskName, 'kernel-worker');
  assert.equal(firstRequest.childSession.freshSessionRequired, true);
  assert.equal(firstRequest.childSession.freshContext, true);
  assert.equal(firstRequest.childSession.canDelegate, false);
  assert.equal(firstRequest.childSession.canCommit, false);
  assert.equal(firstRequest.childSession.maxNestedAgents, 0);

  const second = await adapter.dispatch(input);
  assert.equal(second.status, 'failed');
  assert.equal(second.errorCode, 'ade-sequential-worker-busy');

  release();
  const completed = await first;
  assert.equal(completed.status, 'completed');
  assert.equal(completed.actorSessionId, 'ade-child-1');
});

test('ADE reviewer always uses a fresh read-only non-delegating child and the lifecycle bridge selects ADE', async () => {
  let request = null;
  const host = {
    spawn_agent: async (next) => {
      request = next;
      return { sessionId: 'ade-review-1', outcome: { verdict: 'pass', findings: [], risks: [], evidenceRefs: [] } };
    },
  };
  const adapter = createAdeAdapter({ nativeAgentHost: host });
  const result = await adapter.dispatch({
    decision: { role: 'reviewer', permissions: 'read_only' },
    resolution: { model: null, effort: null },
    modelInput: { objective: 'review', action: { type: 'review' } },
    parentSessionId: 'ade-owner',
  });
  assert.equal(request.taskName, 'kernel-reviewer');
  assert.equal(request.childSession.freshSessionRequired, true);
  assert.equal(request.childSession.readOnly, true);
  assert.equal(request.childSession.canDelegate, false);
  assert.equal(result.outcome.verdict, 'pass');

  const bridge = createKernelHostReviewBridge({ surface: 'ade', nativeAgentHost: host });
  assert.equal(bridge.hostCapabilities.surface, 'ade');
  assert.equal(bridge.hostCapabilities.orchestratorOnly, true);
});

test('ADE dispatcher remains sequential and fresh even when global Kernel parallel mode is on', async (t) => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-ade-dispatch-home-'));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'kernel-ade-dispatch-project-'));
  t.after(async () => {
    await rm(runtimeHome, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  });
  spawnSync('git', ['init', '--quiet'], { cwd: projectRoot, encoding: 'utf8' });
  await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({ name: 'ade-dispatch-test', scripts: { test: 'node -e "process.exit(0)"' } }));

  const cp = await createKernelControlPlane({ runtimeHome, projectRoot });
  try {
    await cp.startRun({ runId: 'ade-sequential-run', objective: 'implement one bounded ADE turn' });
    let parallelQueried = false;
    const originalGetExecutableSteps = cp.getExecutableSteps;
    cp.getExecutableSteps = (...args) => {
      parallelQueried = true;
      return originalGetExecutableSteps.apply(cp, args);
    };
    let request = null;
    const adapter = createAdeAdapter({ spawnAgent: async (next) => {
      request = next;
      return { sessionId: 'ade-child-dispatch', report: workerReport('implemented') };
    }});
    const result = await dispatchKernelTurn({
      controlPlane: cp,
      runId: 'ade-sequential-run',
      adapter,
      registry: createModelRegistry({ surface: 'ade', env: {} }),
      parentSessionId: 'ade-owner',
      env: { MOON_RELAY_KERNEL_PARALLEL_MODE: 'on' },
    });

    assert.equal(parallelQueried, false, 'ADE must bypass the generic parallel dispatcher');
    assert.equal(result.dispatched, true);
    assert.equal(request.childSession.freshSessionRequired, true);
    assert.equal(request.childSession.canDelegate, false);
    assert.equal(request.childSession.maxNestedAgents, 0);
    assert.equal(result.dispatch.dispatchMechanism, 'native-subagent');
    assert.equal(result.resolution.source, 'host-default');
    assert.equal(result.admission.decision, 'advisory_admitted');
    assert.equal(result.hostDirective.enforcementStrategy, 'advisory');
    // ADE deliberately does not claim observed model identity, so the usage
    // receipt remains unsupported rather than fabricating enforcement.
    assert.equal(result.receipt.enforcementStatus, 'unsupported');
  } finally {
    await cp.close();
  }
});

test('public Kernel skill is provider-neutral while ADE-only isolation remains in the ADE profile', async () => {
  const skill = await readFile(path.join(process.cwd(), 'skills', 'moon-relay-kernel', 'SKILL.md'), 'utf8');
  const ade = await readFile(path.join(process.cwd(), 'package', 'kernel', 'profiles', 'ade', 'QWEN.md'), 'utf8');
  assert.doesNotMatch(skill, /Default Codex command-skill/);
  assert.match(skill, /active provider Host policy/);
  assert.doesNotMatch(skill, /exactly one fresh native child/i);
  assert.match(ade, /exactly one fresh native\s+child agent/i);
});
