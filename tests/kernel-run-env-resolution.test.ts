import { assertTestPresent, assertTestRecord, assertTestString, parseCliErrorReceipt } from './helpers/assert-value.js';
import { loadLegacyRecordFunction } from './helpers/legacy-module-boundary.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createKernelControlPlane, resolveDeclaredStepForReplan } from '../src/host/kernel/control-plane-runtime.js';
const buildProcessEnvironment = await loadLegacyRecordFunction('scripts/switcher/launch-adapter.mjs', 'buildProcessEnvironment');
import { recoveryForKernelError } from '../src/kernel/run/binding-preflight.js';
import './kernel-isolation-wave0.fixture.js';
import './kernel-stable-workspace-identity.fixture.js';

test('run selection rejects conflicting explicit/environment identities before fallback resolution', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kernel-run-resolution-'));
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-run-resolution-state-'));
  await mkdir(path.join(root, '.moon-relay'), { recursive: true });
  await writeFile(path.join(root, '.moon-relay', 'track.yaml'), 'track: kernel\n');
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
  const cp = await createKernelControlPlane({ runtimeHome, projectRoot: root });
  try {
    await cp.startRun({ runId: 'run-one', objective: 'one', taskContract: { acceptance: ['one'] } });
    assert.equal(await cp.resolveRunId({}), 'run-one');
    await assert.rejects(
      () => cp.resolveRunId({ envRunId: 'run-env' }),
      (error) => assertTestRecord(error).code === 'run_access_denied',
    );
    assert.equal(await cp.resolveRunId({ explicitRunId: 'run-one', envRunId: 'run-one' }), 'run-one');
    await assert.rejects(
      () => cp.resolveRunId({ explicitRunId: 'run-one', envRunId: 'run-env' }),
      (error) => assertTestRecord(error).code === 'run_binding_conflict',
    );
    await assert.rejects(
      () => cp.startRun({ runId: 'run-two', objective: 'two', taskContract: { acceptance: ['two'] } }),
      (error) => assertTestRecord(error).code === 'worktree_run_conflict',
    );
    assert.equal(await cp.resolveRunId({}), 'run-one');
  } finally {
    await cp.close();
  }
});

test('CLI rejects conflicting explicit and environment run identities with recovery guidance', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kernel-run-binding-conflict-project-'));
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-run-binding-conflict-state-'));
  const contractPath = path.join(root, 'task-contract.json');
  await mkdir(path.join(root, '.moon-relay'), { recursive: true });
  await writeFile(path.join(root, '.moon-relay', 'track.yaml'), 'track: kernel\n');
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }));
  await writeFile(contractPath, JSON.stringify({ objective: 'reject run conflict', acceptance: ['conflict is rejected'] }));

  const result = spawnSync(process.execPath, [
    path.join(process.cwd(), 'bin', 'moon-relay-kernel.mjs'),
    'next',
    '--run-id', 'run-from-cli',
    '--contract-json', contractPath,
    '--project-root', root,
    '--runtime-home', runtimeHome,
    '--json',
  ], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      CODEX_THREAD_ID: '',
      MOON_RELAY_KERNEL_SESSION_ID: 'codex:run-conflict-session',
      MOON_RELAY_KERNEL_PROVIDER: 'codex',
      MOON_RELAY_KERNEL_RUN_ID: 'run-from-environment',
      MOON_RELAY_KERNEL_REEXEC: '1',
    },
  });

  assert.notEqual(result.status, 0);
  const payload = parseCliErrorReceipt(result.stderr || result.stdout);
  assert.equal(payload.errorCode, 'run_binding_conflict');
  assert.equal(payload.nextAction, 'reopen-from-correct-worktree');
  assert.match(assertTestString(assertTestRecord(assertTestRecord(payload.diagnostics).remediation).command), /kernel next --diagnose/);
});

test('Kernel host injects run, project, session, and workspace identity process-scoped', () => {
  const env = buildProcessEnvironment({
    surface: 'codex_cli',
    track: 'kernel',
    roots: { runtimeHome: '/runtime', providerHome: '/provider' },
    runId: 'run-1',
    projectId: 'project-1',
    sessionId: 'session-1',
    workspaceId: 'workspace-1',
    baseEnv: { PATH: '/usr/bin' },
  });
  assert.equal(env.MOON_RELAY_KERNEL_RUN_ID, 'run-1');
  assert.equal(env.MOON_RELAY_KERNEL_PROJECT_ID, 'project-1');
  assert.equal(env.MOON_RELAY_KERNEL_SESSION_ID, 'codex-cli:session-1');
  assert.equal(env.MOON_RELAY_KERNEL_PROVIDER, 'codex-cli');
  assert.equal(env.MOON_RELAY_KERNEL_WORKSPACE_ID, 'workspace-1');
});

test('Codex thread identity bootstraps next without explicit Kernel binding variables', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kernel-codex-thread-project-'));
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-codex-thread-state-'));
  const contractPath = path.join(root, 'task-contract.json');
  const threadId = '019fb139-cadf-73e2-93de-568646c75e92';
  await mkdir(path.join(root, '.moon-relay'), { recursive: true });
  await writeFile(path.join(root, '.moon-relay', 'track.yaml'), 'schemaVersion: 1\ntrack: kernel\nproduct: moon-relay-kernel\n');
  await writeFile(path.join(root, 'package.json'), JSON.stringify({
    name: 'kernel-codex-thread-bootstrap',
    version: '0.0.1',
    scripts: { test: 'node -e "process.exit(0)"' },
  }));
  await writeFile(contractPath, JSON.stringify({
    objective: 'bootstrap from Codex task identity',
    acceptance: ['next returns one authoritative action'],
    constraints: ['remain in the temporary project'],
    nonGoals: ['external mutation'],
  }));

  const result = spawnSync(process.execPath, [
    path.join(process.cwd(), 'bin', 'moon-relay-kernel.mjs'),
    'next',
    '--contract-json',
    contractPath,
    '--project-root',
    root,
    '--runtime-home',
    runtimeHome,
    '--json',
  ], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      CODEX_THREAD_ID: threadId,
      MOON_RELAY_KERNEL_REEXEC: '1',
      MOON_RELAY_KERNEL_HOME: runtimeHome,
      MOON_RELAY_KERNEL_RUN_ID: '',
      MOON_RELAY_KERNEL_SESSION_ID: '',
      MOON_RELAY_KERNEL_PROJECT_ID: '',
      MOON_RELAY_KERNEL_WORKSPACE_ID: '',
    },
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.match(payload.runId, /^run-[0-9a-f-]{36}$/i);
  assert.doesNotMatch(payload.runId, new RegExp(threadId));
  assert.ok(payload.action);
});

test('bare next in a fresh Codex session directs the Host to supply the task contract', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kernel-codex-contract-required-project-'));
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-codex-contract-required-state-'));
  await mkdir(path.join(root, '.moon-relay'), { recursive: true });
  await writeFile(path.join(root, '.moon-relay', 'track.yaml'), 'schemaVersion: 1\ntrack: kernel\nproduct: moon-relay-kernel\n');
  await writeFile(path.join(root, 'package.json'), JSON.stringify({
    name: 'kernel-codex-contract-required',
    version: '0.0.1',
    scripts: { test: 'node -e "process.exit(0)"' },
  }));

  const result = spawnSync(process.execPath, [
    path.join(process.cwd(), 'bin', 'moon-relay-kernel.mjs'),
    'next',
    '--project-root',
    root,
    '--runtime-home',
    runtimeHome,
    '--json',
  ], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      CODEX_THREAD_ID: '019fb139-cadf-73e2-93de-568646c75e93',
      MOON_RELAY_KERNEL_REEXEC: '1',
      MOON_RELAY_KERNEL_HOME: runtimeHome,
      MOON_RELAY_KERNEL_RUN_ID: '',
      MOON_RELAY_KERNEL_SESSION_ID: '',
      MOON_RELAY_KERNEL_PROJECT_ID: '',
      MOON_RELAY_KERNEL_WORKSPACE_ID: '',
    },
  });

  assert.notEqual(result.status, 0);
  const payloadLine = `${result.stderr}\n${result.stdout}`
    .split(/\r?\n/)
    .find((line) => line.trim().startsWith('{'));
  assert.ok(payloadLine, result.stderr || result.stdout);
  const payload = JSON.parse(payloadLine);
  assert.equal(payload.errorCode, 'host_binding_missing');
  assert.equal(payload.nextAction, 'supply-a-task-contract');
  assert.equal(payload.diagnostics.remediation.action, 'supply-a-task-contract');
  assert.equal(payload.diagnostics.remediation.command, 'kernel next --contract-json <task-contract.json>');
});

test('conflicting Codex and Kernel session bindings fail closed with one recovery command', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kernel-codex-binding-conflict-project-'));
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-codex-binding-conflict-state-'));
  const contractPath = path.join(root, 'task-contract.json');
  await mkdir(path.join(root, '.moon-relay'), { recursive: true });
  await writeFile(path.join(root, '.moon-relay', 'track.yaml'), 'track: kernel\n');
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }));
  await writeFile(contractPath, JSON.stringify({ objective: 'reject conflict', acceptance: ['conflict is rejected'] }));

  const result = spawnSync(process.execPath, [
    path.join(process.cwd(), 'bin', 'moon-relay-kernel.mjs'),
    'next',
    '--contract-json',
    contractPath,
    '--project-root',
    root,
    '--runtime-home',
    runtimeHome,
    '--json',
  ], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      CODEX_THREAD_ID: 'thread-from-host',
      MOON_RELAY_KERNEL_SESSION_ID: 'codex:other-thread',
      MOON_RELAY_KERNEL_PROVIDER: 'codex',
      MOON_RELAY_KERNEL_REEXEC: '1',
    },
  });

  assert.notEqual(result.status, 0);
  const payload = parseCliErrorReceipt(result.stderr || result.stdout);
  assert.equal(payload.errorCode, 'host_binding_conflict');
  assert.equal(payload.nextAction, 'reopen-from-correct-worktree');
  assert.match(assertTestString(assertTestRecord(assertTestRecord(payload.diagnostics).remediation).command), /kernel next --diagnose/);
});

test('binding recovery command quotes hostile workspace paths without shell expansion', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kernel-recovery-quote-'));
  const marker = path.join(root, 'expanded');
  try {
    const remediation = recoveryForKernelError({
      code: 'host_binding_missing',
      projectRoot: `${root}/$(touch ${marker})/\`touch ${marker}\`/'apostrophe`,
      provider: 'codex',
    });
    const result = spawnSync('/bin/sh', ['-c', assertTestPresent(remediation).command], {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin' },
    });
    assert.notEqual(result.status, 0, 'the fixture intentionally omits the kernel executable');
    await assert.rejects(access(marker));
    assert.match(assertTestPresent(remediation).command, /--project-root '/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('strict host binding adopts an unowned legacy run once and rejects a second owner', async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'kernel-legacy-binding-project-'));
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-legacy-binding-state-'));
  await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({
    name: 'kernel-legacy-binding',
    version: '0.0.1',
    scripts: { test: 'node -e "process.exit(0)"' },
  }));

  const legacy = await createKernelControlPlane({ runtimeHome, projectRoot });
  await legacy.startRun({
    runId: 'legacy-run',
    objective: 'adopt safely',
    taskContract: { acceptance: ['owner binding is one-shot'] },
  });
  await legacy.close();

  const owner = await createKernelControlPlane({
    runtimeHome,
    projectRoot,
    requireHostBinding: true,
    env: { MOON_RELAY_KERNEL_SESSION_ID: 'owner-session', MOON_RELAY_KERNEL_RUN_ID: 'legacy-run' },
  });
  const adopted = await owner.ensureRun({ runId: 'legacy-run' });
  assert.equal(adopted.status, 'resumed');
  await owner.close();

  const claimant = await createKernelControlPlane({
    runtimeHome,
    projectRoot,
    requireHostBinding: true,
    env: { MOON_RELAY_KERNEL_SESSION_ID: 'claimant-session', MOON_RELAY_KERNEL_RUN_ID: 'legacy-run' },
  });
  await assert.rejects(
    claimant.ensureRun({ runId: 'legacy-run' }),
    (error) => assertTestRecord(error).code === 'host_binding_missing',
  );
  await claimant.close();
});

test('owner contract revision replans an active step when its allowed scope expands', async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'kernel-scope-replan-project-'));
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-scope-replan-state-'));
  await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({
    name: 'kernel-scope-replan',
    version: '0.0.1',
    scripts: {
      'lint:kernel': 'node -e "process.exit(0)"',
      'test:ok': 'node -e "process.exit(0)"',
    },
  }));
  const env = {
    MOON_RELAY_KERNEL_SESSION_ID: 'scope-owner',
    MOON_RELAY_KERNEL_RUN_ID: 'scope-run',
  };
  const cp = await createKernelControlPlane({
    runtimeHome,
    projectRoot,
    requireHostBinding: true,
    env,
  });

  const baseContract = {
    objective: 'expand a blocked work unit safely',
    acceptance: ['scope expansion is durable'],
    requiredObligations: ['static-analysis'],
    steps: [{
      objective: 'bounded implementation',
      allowedPaths: ['scripts/kernel/**', 'tests/**'],
      acceptanceIds: ['AC-1'],
      obligationIds: ['static-analysis'],
    }],
  };
  await cp.ensureRun({ runId: 'scope-run', objective: baseContract.objective, taskContract: baseContract });
  const before = cp.getCurrentStep('scope-run');
  await cp.report('scope-run', {
    blocker: {
      reason: 'unsupported-verification',
      detail: 'package.json is not yet in scope',
    },
  });

  const amended = {
    ...baseContract,
    steps: [{
      ...baseContract.steps[0],
      allowedPaths: [...baseContract.steps[0].allowedPaths, 'package.json'],
    }],
  };
  const resumed = await cp.ensureRun({ runId: 'scope-run', objective: amended.objective, taskContract: amended });
  const after = cp.getCurrentStep('scope-run');

  assert.equal(resumed.status, 'resumed');
  assert.equal(assertTestPresent(after).planRevision, assertTestPresent(before).planRevision + 1);
  assert.ok(assertTestPresent(assertTestPresent(after).allowedPaths).includes('package.json'));
  assert.equal(assertTestPresent(cp.getRunSteps('scope-run').find((step) => step.stepId === assertTestPresent(before).stepId)).state, 'superseded');
  assert.equal(assertTestPresent((await cp.getRun('scope-run'))).status, 'active');
  const revisionAfterAtomicResume = assertTestPresent((await cp.getRun('scope-run'))).planRevision;
  const retried = await cp.ensureRun({ runId: 'scope-run', objective: amended.objective, taskContract: amended });
  assert.equal(assertTestPresent(retried.run).status, 'active');
  assert.equal(assertTestPresent(retried.run).planRevision, revisionAfterAtomicResume, 'retry must not replan or strand the run after atomic unblock');
  await cp.close();
});

test('scope replan selects a declared step by objective before sequence fallback', () => {
  const waveFive = {
    objective: 'Wave 5',
    allowedPaths: ['scripts/kernel/**', 'package.json'],
  };
  const resolved = resolveDeclaredStepForReplan({
    steps: [
      { objective: 'Wave 0', allowedPaths: ['tests/**'] },
      waveFive,
    ],
  }, {
    stepId: 'step-2-1',
    sequence: 1,
    objective: 'Wave 5',
  });

  assert.equal(resolved, waveFive);
});

test('strict control plane rejects a Host workspace id that differs from computed identity', async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'kernel-workspace-spoof-project-'));
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-workspace-spoof-state-'));
  await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({ name: 'workspace-spoof', version: '0.0.1' }));
  await assert.rejects(
    createKernelControlPlane({
      runtimeHome,
      projectRoot,
      requireHostBinding: true,
      env: {
        MOON_RELAY_KERNEL_SESSION_ID: 'owner',
        MOON_RELAY_KERNEL_RUN_ID: 'run',
        MOON_RELAY_KERNEL_WORKSPACE_ID: 'host-spoofed-workspace',
      },
    }),
    (error) => assertTestRecord(error).code === 'run_workspace_mismatch',
  );
});

test('public switcher launch forwards all strict task binding flags', async () => {
  const source = await readFile(path.join(process.cwd(), 'bin', 'moon-harness-switcher.mjs'), 'utf8');
  for (const flag of ['--run-id', '--project-id', '--session-id', '--workspace-id']) {
    assert.match(source, new RegExp(flag));
  }
  assert.match(source, /taskBinding/);
});
