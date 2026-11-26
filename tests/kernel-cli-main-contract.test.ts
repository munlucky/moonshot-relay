import test from 'node:test';
import assert from 'node:assert/strict';
import { main as kernelMain } from '../src/cli/moon-relay-kernel.js';
import { main as standaloneMain } from '../src/cli/moon-relay-standalone.js';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createKernelControlPlane } from '../src/host/kernel/control-plane-runtime.js';
import { openKernelStateStore } from '../src/kernel/state-store.js';

test('kernel CLI main(argv, deps) is import-safe and writes help through injected output', async () => {
  const stdout: string[] = [];
  const stderr = [];
  const result = await kernelMain(['--help', '--json'], {
    cwd: process.cwd(),
    env: { ...process.env, MOON_RELAY_KERNEL_REEXEC: '1' },
    stdout: (value) => stdout.push(String(value)),
    stderr: (value) => stderr.push(String(value)),
    managedRuntimeHome: process.cwd(),
  });

  assert.equal(result.exitCode, 0);
  assert.equal(stderr.length, 0);
  assert.equal(stdout.length, 1);
  const help = JSON.parse(stdout[0]);
  assert.equal(help.usage, 'kernel <command> [options]');
  assert.ok(help.commands.next);
  assert.match(help.commands['recover-owner'], /--expected-owner.*--approval-ref/);
  assert.ok(help.commands['worker-host']);
  assert.match(help.commands['worker-host'], /--enable-io-writer/);
  assert.match(help.commands['mcp-bridge'], /--enable-io-writer/);
  assert.match(help.commands['worker-host'], /--enable-io-reader/);
  assert.match(help.commands['mcp-bridge'], /--enable-io-reader/);
});

test('CLI startup opt-in reaches local capabilities and the MCP tool schema', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kernel-cli-io-'));
  const runtimeHome = path.join(root, 'runtime');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^MOON_RELAY_KERNEL_|^CODEX_THREAD_ID$/.test(key)));
  env.MOON_RELAY_KERNEL_REEXEC = '1';
  try {
    await mkdir(path.join(root, '.moon-relay'));
    await mkdir(runtimeHome);
    await writeFile(path.join(root, '.moon-relay', 'track.yaml'), 'track: kernel\n');
    for (const command of ['worker-host', 'mcp-bridge']) for (const flags of [[], ['--enable-io-writer'], ['--enable-io-reader']]) {
      const request = command === 'worker-host' ? { id: 1, action: 'capabilities' }
        : { jsonrpc: '2.0', id: 1, method: 'tools/list' };
      const child = spawnSync(process.execPath, [path.resolve('bin/moon-relay-kernel.mjs'), command,
        '--project-root', root, '--runtime-home', runtimeHome, ...flags], {
        env, input: JSON.stringify(request) + '\n', encoding: 'utf8', timeout: 15000,
      });
      assert.equal(child.status, 0, child.stderr || child.stdout);
      const response = JSON.parse(child.stdout.trim());
      if (command === 'worker-host') {
        assert.equal(response.ioWriter.available, flags.includes('--enable-io-writer'));
        assert.equal(response.ioReader.available, flags.includes('--enable-io-reader'));
        assert.equal(response.writableStart, false);
      } else {
        const attach = response.result.tools.find((tool: { name: string }) => tool.name === 'kernel_attach');
        assert.equal(Object.hasOwn(attach.inputSchema.properties, 'ioWrite'), flags.includes('--enable-io-writer'));
        assert.equal(Object.hasOwn(attach.inputSchema.properties, 'ioRead'), flags.includes('--enable-io-reader'));
      }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('CLI owner recovery followed by contract-free next reaches same-session lifecycle admission', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kernel-cli-owner-reentry-'));
  const projectRoot = path.join(root, 'project'), runtimeHome = path.join(root, 'runtime');
  const runId = 'run-cli-owner-reentry';
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^MOON_RELAY_KERNEL_|^CODEX_THREAD_ID$/.test(key)));
  env.MOON_RELAY_KERNEL_REEXEC = '1';
  const invoke = async (args: string[]) => {
    const lines: string[] = [];
    await kernelMain([...args, '--project-root', projectRoot, '--runtime-home', runtimeHome,
      '--provider', 'codex', '--session-id', 'codex:new-owner', '--json'], {
      cwd: projectRoot, env, managedRuntimeHome: process.cwd(),
      stdout: value => lines.push(String(value)), stderr: value => lines.push(String(value)),
    });
    return JSON.parse(lines.join('\n'));
  };
  try {
    await mkdir(path.join(projectRoot, '.moon-relay'), { recursive: true });
    await writeFile(path.join(projectRoot, '.moon-relay', 'track.yaml'), 'track: kernel\n');
    await writeFile(path.join(projectRoot, '.moon-relay', 'project.identity.yaml'), 'projectId: cli-owner-reentry\n');
    await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }));
    const cp = await createKernelControlPlane({ projectRoot, runtimeHome, requireHostBinding: true,
      env: { ...env, MOON_RELAY_KERNEL_PROVIDER: 'codex', MOON_RELAY_KERNEL_SESSION_ID: 'codex:old-owner' } });
    try { await cp.ensureRun({ runId, objective: 'CLI reentry', taskContract: { objective: 'CLI reentry', acceptance: ['Resume existing work'] } }); }
    finally { await cp.close(); }
    const store = await openKernelStateStore({ runtimeHome });
    let expectedOwner: string;
    try {
      const original = store.getRunOwnerBinding(runId);
      assert.ok(original);
      expectedOwner = original.bindingId;
      store.markRunBlocked(runId, 'operator-input-needed', 'external');
    } finally { store.close(); }
    const recovered = await invoke(['recover-owner', runId, '--expected-owner', expectedOwner,
      '--approval-ref', 'user-request:resume-existing-task']);
    assert.equal(recovered.status, 'owner-recovered', JSON.stringify(recovered));
    const next = await invoke(['next', runId]);
    assert.notEqual(next.errorCode, 'host_binding_missing', JSON.stringify(next));
    assert.equal(next.runId, runId);
    assert.equal(next.action?.type, 'implement', JSON.stringify(next));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('standalone CLI main(argv, deps) reports unknown utilities without process exit side effects', async () => {
  const outputs: unknown[] = [];
  const result = await standaloneMain(['--utility', 'missing-utility', '--json'], {
    cwd: process.cwd(),
    env: process.env,
    runtimeRoot: process.cwd(),
    invokedPath: 'moon-relay-standalone.mjs',
    output: (value) => outputs.push(value),
  });

  assert.equal(result.exitCode, 1);
  assert.equal(outputs.length, 1);
  const output = outputs[0];
  assert.ok(output && typeof output === 'object' && 'status' in output && 'errorCode' in output);
  assert.equal(output.status, 'error');
  assert.equal(output.errorCode, 'UNKNOWN_STANDALONE');
});

test('S3 CLI authorized resume settles ready Run via Kernel without empty report while foreign/read-only calls never mutate', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kernel-cli-s3-resume-'));
  const projectRoot = path.join(root, 'project');
  const runtimeHome = path.join(root, 'runtime');
  const runId = 'run-cli-s3-resume';
  const ownerSession = 'codex:s3-owner';
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^MOON_RELAY_KERNEL_|^CODEX_THREAD_ID$/.test(key)));
  env.MOON_RELAY_KERNEL_REEXEC = '1';
  const invoke = async (args: string[], sessionId: string = ownerSession) => {
    const out: string[] = [];
    const err: string[] = [];
    const res = await kernelMain([...args, '--project-root', projectRoot, '--runtime-home', runtimeHome,
      '--provider', 'codex', '--session-id', sessionId, '--json'], {
      cwd: projectRoot, env, managedRuntimeHome: process.cwd(),
      stdout: value => out.push(String(value)), stderr: value => err.push(String(value)),
    });
    return { exitCode: res.exitCode, body: JSON.parse((out.length > 0 ? out : err).join('\n')) };
  };
  try {
    await mkdir(path.join(projectRoot, '.moon-relay'), { recursive: true });
    await writeFile(path.join(projectRoot, '.moon-relay', 'track.yaml'), 'track: kernel\n');
    await writeFile(path.join(projectRoot, '.moon-relay', 'project.identity.yaml'), 'projectId: cli-s3-resume\n');
    await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"', lint: 'node -e "process.exit(0)"' } }));
    await writeFile(path.join(projectRoot, 'app.mjs'), 'export const value = 0;\n');
    spawnSync('git', ['init', '-b', 'main'], { cwd: projectRoot, encoding: 'utf8' });
    spawnSync('git', ['config', 'user.name', 'CLI S3'], { cwd: projectRoot, encoding: 'utf8' });
    spawnSync('git', ['config', 'user.email', 'cli-s3@example.invalid'], { cwd: projectRoot, encoding: 'utf8' });
    spawnSync('git', ['add', '.'], { cwd: projectRoot, encoding: 'utf8' });
    spawnSync('git', ['commit', '-m', 'init', '--quiet'], { cwd: projectRoot, encoding: 'utf8' });

    const cp = await createKernelControlPlane({
      projectRoot, runtimeHome, requireHostBinding: true,
      env: { ...env, MOON_RELAY_KERNEL_PROVIDER: 'codex', MOON_RELAY_KERNEL_SESSION_ID: ownerSession },
    });
    try {
      await cp.ensureRun({
        runId,
        objective: 'Update app securely',
        taskContract: { objective: 'Update app securely', surfaces: ['security_boundary'], acceptance: ['secure update'], allowedPaths: ['app.mjs'] },
      });
      await writeFile(path.join(projectRoot, 'app.mjs'), 'export const value = 1;\n');
      await cp.report(runId, { summary: 'updated app', changedPaths: ['app.mjs'] });
      await cp.approveObligation({
        runId, obligationId: 'security-review', approver: 'operator',
        reason: 'pre-existing evidence before resume', approvalRef: 'operator-ref:s3-resume',
        autoFinalize: false,
      });
    } finally { await cp.close(); }

    // 1. Read-only status must not finalize
    const statusRes = await invoke(['status', '--run-id', runId]);
    assert.equal(statusRes.exitCode, 0);
    assert.equal(statusRes.body.run?.status, 'active');

    // 2. Foreign owner next must fail closed without finalizing
    const foreignRes = await invoke(['next', runId], 'codex:s3-foreign');
    assert.equal(foreignRes.exitCode, 1);
    assert.equal(foreignRes.body.errorCode, 'host_binding_missing');

    // 3. Authorized owner next settles directly via Kernel to done without needing empty report
    const ownerRes = await invoke(['next', runId], ownerSession);
    assert.equal(ownerRes.exitCode, 0, JSON.stringify(ownerRes.body));
    assert.equal(ownerRes.body.action?.type, 'done', JSON.stringify(ownerRes.body));
    assert.equal(ownerRes.body.finalization?.completionStatus, 'accepted');
    assert.equal(ownerRes.body.finalization?.finalizationStatus, 'completed');
    const gitCount = spawnSync('git', ['rev-list', '--count', 'HEAD'], { cwd: projectRoot, encoding: 'utf8' }).stdout.trim();
    assert.equal(gitCount, '1', 'no git commit created without explicit closeout request');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('S3 Moonremote CLI contract revision while review pending keeps passed Step ID on same scope, requires new evidence, and replans on real scope change', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kernel-cli-moonremote-'));
  const projectRoot = path.join(root, 'project');
  const runtimeHome = path.join(root, 'runtime');
  const runId = 'run-cli-moonremote-reentry';
  const ownerSession = 'codex:moonremote-owner';
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^MOON_RELAY_KERNEL_|^CODEX_THREAD_ID$/.test(key)));
  env.MOON_RELAY_KERNEL_REEXEC = '1';
  const invoke = async (args: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const res = await kernelMain([...args, '--project-root', projectRoot, '--runtime-home', runtimeHome,
      '--provider', 'codex', '--session-id', ownerSession, '--json'], {
      cwd: projectRoot, env, managedRuntimeHome: process.cwd(),
      stdout: value => out.push(String(value)), stderr: value => err.push(String(value)),
    });
    return { exitCode: res.exitCode, body: JSON.parse((out.length > 0 ? out : err).join('\n')) };
  };
  try {
    await mkdir(path.join(projectRoot, '.moon-relay'), { recursive: true });
    await writeFile(path.join(projectRoot, '.moon-relay', 'track.yaml'), 'track: kernel\n');
    await writeFile(path.join(projectRoot, '.moon-relay', 'project.identity.yaml'), 'projectId: cli-moonremote\n');
    await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"', lint: 'node -e "process.exit(0)"' } }));
    await writeFile(path.join(projectRoot, 'app.mjs'), 'export const v = 0;\n');
    await writeFile(path.join(projectRoot, 'extra.mjs'), 'export const x = 0;\n');
    spawnSync('git', ['init', '-b', 'main'], { cwd: projectRoot, encoding: 'utf8' });
    spawnSync('git', ['config', 'user.name', 'Moonremote'], { cwd: projectRoot, encoding: 'utf8' });
    spawnSync('git', ['config', 'user.email', 'moonremote@example.invalid'], { cwd: projectRoot, encoding: 'utf8' });
    spawnSync('git', ['add', '.'], { cwd: projectRoot, encoding: 'utf8' });
    spawnSync('git', ['commit', '-m', 'init', '--quiet'], { cwd: projectRoot, encoding: 'utf8' });

    const c1 = path.join(root, 'contract-v1.json');
    await writeFile(c1, JSON.stringify({
      objective: 'Harden auth endpoint',
      surfaces: ['security_boundary'],
      acceptance: ['Unit tests pass for auth guard'],
      allowedPaths: ['app.mjs'],
    }));
    const startRes = await invoke(['next', runId, '--contract-json', c1]);
    assert.equal(startRes.exitCode, 0, JSON.stringify(startRes.body));
    const originalStepId = startRes.body.stepId;
    assert.ok(originalStepId);

    await writeFile(path.join(projectRoot, 'app.mjs'), 'export const v = 1;\n');
    const reportFile = path.join(root, 'report-v1.json');
    await writeFile(reportFile, JSON.stringify({ summary: 'hardened auth guard', changedPaths: ['app.mjs'] }));
    const repRes = await invoke(['report', runId, '--report-json', reportFile]);
    assert.equal(repRes.exitCode, 0, JSON.stringify(repRes.body));
    assert.equal(repRes.body.step?.state, 'passed');
    assert.equal(repRes.body.next?.action?.type, 'review');

    // Re-enter via CLI with reinforced Acceptance (added AC-2) and SAME implementation scope
    const c2 = path.join(root, 'contract-v2.json');
    await writeFile(c2, JSON.stringify({
      objective: 'Harden auth endpoint',
      surfaces: ['security_boundary'],
      acceptance: [
        'Unit tests pass for auth guard',
        'Invalid token payload is rejected fail-closed',
      ],
      allowedPaths: ['app.mjs'],
    }));
    const revisedRes = await invoke(['next', runId, '--contract-json', c2]);
    assert.equal(revisedRes.exitCode, 0, JSON.stringify(revisedRes.body));
    assert.notEqual(revisedRes.body.action?.type, 'done', 'uncovered reinforced acceptance must require evidence');

    const store = await openKernelStateStore({ runtimeHome });
    try {
      const runAfterV2 = store.getRun(runId);
      assert.equal(runAfterV2?.contractRevision, 2);
      assert.equal(runAfterV2?.planRevision, 1, 'same implementation scope must keep planRevision=1');
      assert.equal(runAfterV2?.replanCount, 0, 'same implementation scope must not replan');
      const stepsV2 = store.getRunSteps(runId);
      assert.equal(stepsV2.length, 1);
      assert.equal(stepsV2[0]?.stepId, originalStepId, 'existing passed Step ID must be preserved');
    } finally { store.close(); }

    // Now re-enter with an actual scope change (expanded allowedPaths) -> legitimate Replan allowed
    const c3 = path.join(root, 'contract-v3.json');
    await writeFile(c3, JSON.stringify({
      objective: 'Harden auth endpoint',
      surfaces: ['security_boundary'],
      acceptance: [
        'Unit tests pass for auth guard',
        'Invalid token payload is rejected fail-closed',
      ],
      allowedPaths: ['app.mjs', 'extra.mjs'],
    }));
    const replannedRes = await invoke(['next', runId, '--contract-json', c3]);
    assert.equal(replannedRes.exitCode, 0, JSON.stringify(replannedRes.body));
    const store2 = await openKernelStateStore({ runtimeHome });
    try {
      const runAfterV3 = store2.getRun(runId);
      assert.equal(runAfterV3?.planRevision, 2, 'real scope change must replan');
      assert.equal(runAfterV3?.replanCount, 1);
    } finally { store2.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
