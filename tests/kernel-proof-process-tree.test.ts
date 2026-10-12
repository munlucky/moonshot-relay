import { normalizeProcessRecord } from '../src/host/kernel/proof/process-tree.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import {
  cleanupWindowsTimeoutProcessTree,
  resolveVerifiedProcessTree,
  teardownVerifiedProcessTree,
} from '../src/host/kernel/proof/process-tree.js';
import { executeTrustedProof } from '../src/host/kernel/proof/proof-executor.js';

const startedAt = new Date('2026-08-04T04:00:00.000Z');
const record = (pid: number, parentPid: number, commandLine: string, offsetSeconds = 0) => ({
  ProcessId: pid,
  ParentProcessId: parentPid,
  CommandLine: commandLine,
  CreationDate: new Date(startedAt.getTime() + offsetSeconds * 1000).toISOString(),
});

test('process lineage requires exact launcher command and protects the current host ancestor', () => {
  const processes = [
    record(100, 50, 'C:\\Program Files\\nodejs\\node.exe -e fixture', 1),
    record(101, 100, 'C:\\Program Files\\nodejs\\node.exe child', 2),
    record(102, 101, 'C:\\Program Files\\nodejs\\node.exe grandchild', 3),
    record(50, 40, 'codex-host.exe', 1),
    record(40, 20, 'node.exe agent', 1),
    record(30, 50, 'desktop-host.exe', 1),
  ];

  const tree = resolveVerifiedProcessTree({
    processes,
    launcherPid: 100,
    expectedCommand: 'C:\\Program Files\\nodejs\\node.exe',
    expectedArgs: ['-e', 'fixture'],
    startedAt,
    currentPid: 999,
  });
  assert.equal(tree.status, 'ready');
  assert.deepEqual(tree.targets, [102, 101, 100]);

  const hostAncestor = resolveVerifiedProcessTree({
    processes,
    launcherPid: 50,
    expectedCommand: 'codex-host.exe',
    startedAt,
    currentPid: 30,
  });
  assert.equal(hostAncestor.status, 'blocked');
  assert.equal(hostAncestor.reason, 'host-ancestor-protected');

  const stale = resolveVerifiedProcessTree({
    processes: [record(100, 50, 'C:\\Program Files\\nodejs\\node.exe -e old', -10)],
    launcherPid: 100,
    expectedCommand: 'C:\\Program Files\\nodejs\\node.exe',
    expectedArgs: ['-e', 'old'],
    startedAt,
    currentPid: 999,
  });
  assert.equal(stale.status, 'blocked');
  assert.equal(stale.reason, 'launcher-creation-stale');
});

test('teardown kills only verified descendants in reverse depth order and tolerates exited children', () => {
  const processes = [
    record(200, 150, 'node.exe launcher', 1),
    record(201, 200, 'node.exe child', 2),
    record(202, 201, 'node.exe grandchild', 3),
    record(150, 140, 'host.exe', 1),
  ];
  const tree = resolveVerifiedProcessTree({
    processes,
    launcherPid: 200,
    expectedCommand: 'node.exe',
    expectedArgs: ['launcher'],
    startedAt,
    currentPid: 999,
  });
  const killed: number[] = [];
  const cleanup = teardownVerifiedProcessTree({
    tree,
    killProcess: (pid) => {
      killed.push(pid);
      return { pid, exitCode: 0, output: '', status: pid === 201 ? 'already-exited' : 'killed' };
    },
  });
  assert.equal(cleanup.status, 'completed');
  assert.deepEqual(killed, [202, 201, 200]);
  assert.equal(killed.includes(150), false);
  assert.equal(killed.includes(999), false);
  assert.equal(teardownVerifiedProcessTree({ tree, killProcess: (pid) => ({ pid, exitCode: 0, output: '', status: 'killed' }), remainingPids: [201] }).status, 'failed');
});

test('Windows timeout cleanup is fail-closed for missing lineage and reports an honest non-Windows no-op', () => {
  const missing = cleanupWindowsTimeoutProcessTree({
    launcherPid: 777,
    expectedCommand: 'node.exe',
    processTable: { status: 'ready', processes: [] },
    readProcessTable: () => ({ status: 'ready', processes: [] }),
    platform: 'win32',
    currentPid: 999,
  });
  assert.equal(missing.status, 'blocked');
  assert.equal(missing.reason, 'launcher-not-observed');

  const nonWindows = cleanupWindowsTimeoutProcessTree({
    launcherPid: 777,
    expectedCommand: 'node',
    platform: 'linux',
  });
  assert.equal(nonWindows.status, 'not-applicable');
  assert.deepEqual(nonWindows.targetPids, []);
});

test('Windows timeout cleanup takes the survivor snapshot after verified tree teardown', () => {
  const processes = [
    record(300, 250, 'node.exe launcher', 1),
    record(301, 300, 'node.exe child', 2),
  ];
  const events: string[] = [];
  const snapshots = [
    { status: 'ready', processes: processes.map(normalizeProcessRecord) },
    { status: 'ready', processes: [] },
  ];
  const cleanup = cleanupWindowsTimeoutProcessTree({
    launcherPid: 300,
    expectedCommand: 'node.exe',
    expectedArgs: ['launcher'],
    startedAt,
    platform: 'win32',
    currentPid: 999,
    readProcessTable: () => {
      events.push('snapshot');
      const snapshot = snapshots.shift(); assert.ok(snapshot);
      return snapshot.status === 'ready' ? { status: 'ready' as const, processes: snapshot.processes.map(normalizeProcessRecord) } : { status: 'unavailable' as const, reason: 'reason' in snapshot && typeof snapshot.reason === 'string' ? snapshot.reason : undefined, processes: snapshot.processes.map(normalizeProcessRecord) };
    },
    killProcess: (pid) => {
      events.push(`kill:${pid}`);
      return { pid, exitCode: 0, output: '', status: 'killed' };
    },
  });
  assert.deepEqual(events, ['snapshot', 'kill:301', 'kill:300', 'snapshot']);
  assert.equal(cleanup.status, 'completed');
  assert.deepEqual(cleanup.survivors, []);
});

test('Windows timeout cleanup ignores a supplied stale post table and blocks an unavailable fresh snapshot', () => {
  const processes = [
    record(310, 260, 'node.exe launcher', 1),
    record(311, 310, 'node.exe child', 2),
  ];
  const events: string[] = [];
  const snapshots = [
    { status: 'ready', processes: processes.map(normalizeProcessRecord) },
    { status: 'unavailable', processes: [], reason: 'process-table-timeout' },
  ];
  const cleanup = cleanupWindowsTimeoutProcessTree({
    launcherPid: 310,
    expectedCommand: 'node.exe',
    expectedArgs: ['launcher'],
    startedAt,
    platform: 'win32',
    currentPid: 999,
    readProcessTable: () => {
      events.push('snapshot');
      const snapshot = snapshots.shift(); assert.ok(snapshot); return snapshot.status === 'ready' ? { status: 'ready' as const, processes: snapshot.processes.map(normalizeProcessRecord) } : { status: 'unavailable' as const, reason: 'reason' in snapshot && typeof snapshot.reason === 'string' ? snapshot.reason : undefined, processes: snapshot.processes.map(normalizeProcessRecord) };
    },
    killProcess: (pid) => {
      events.push(`kill:${pid}`);
      return { pid, exitCode: 0, output: '', status: 'killed' };
    },
  });
  assert.deepEqual(events, ['snapshot', 'kill:311', 'kill:310', 'snapshot']);
  assert.equal(cleanup.status, 'blocked');
  assert.equal(cleanup.reason, 'post-cleanup-process-table-unavailable');
});

test('Windows timeout cleanup uses retained spawn lineage when the timeout snapshot omits launcher metadata', () => {
  const incomplete = [
    { ProcessId: 410, ParentProcessId: 350, CommandLine: null, CreationDate: null },
    record(411, 410, 'codex.exe exec --json', 2),
  ];
  const completeAtLaunch = [
    record(410, 350, 'powershell.exe -File C:\\tools\\codex.ps1', 1),
  ];
  const snapshots = [
    { status: 'ready', processes: incomplete },
    { status: 'ready', processes: [] },
  ];
  const killed: number[] = [];
  const cleanup = cleanupWindowsTimeoutProcessTree({
    launcherPid: 410,
    expectedCommand: 'powershell.exe',
    expectedArgs: ['C:\\tools\\codex.ps1'],
    startedAt,
    platform: 'win32',
    currentPid: 999,
    launchProcessTable: { status: 'ready', processes: completeAtLaunch.map(normalizeProcessRecord) },
    launcherEvidence: {
      pid: 410,
      parentPid: 350,
      command: 'powershell.exe',
      args: ['C:\\tools\\codex.ps1'],
      startedAt: startedAt.toISOString(),
    },
    readProcessTable: () => { const snapshot = snapshots.shift(); assert.ok(snapshot); return { status: 'ready', processes: snapshot.processes.map(normalizeProcessRecord) }; },
    killProcess: (pid) => {
      killed.push(pid);
      return { pid, exitCode: 0, output: '', status: 'killed' };
    },
  });
  assert.equal(cleanup.status, 'completed');
  assert.equal(cleanup.lineageSource, 'launch-snapshot');
  assert.deepEqual(killed, [411, 410]);
  assert.notEqual(cleanup.reason, 'launcher-lineage-incomplete');
});

test('Windows timeout cleanup classifies an exited launcher and kills its still-observed descendant from Host spawn evidence', () => {
  const snapshots = [
    { status: 'ready', processes: [record(421, 420, 'codex.exe exec --json', 2)] },
    { status: 'ready', processes: [] },
  ];
  const killed: number[] = [];
  const cleanup = cleanupWindowsTimeoutProcessTree({
    launcherPid: 420,
    expectedCommand: 'powershell.exe',
    expectedArgs: ['C:\\tools\\codex.ps1'],
    startedAt,
    platform: 'win32',
    currentPid: 999,
    launcherEvidence: {
      pid: 420,
      parentPid: 350,
      command: 'powershell.exe',
      args: ['C:\\tools\\codex.ps1'],
      startedAt: startedAt.toISOString(),
    },
    readProcessTable: () => { const snapshot = snapshots.shift(); assert.ok(snapshot); return { status: 'ready', processes: snapshot.processes.map(normalizeProcessRecord) }; },
    killProcess: (pid) => {
      killed.push(pid);
      return { pid, exitCode: 0, output: '', status: 'killed' };
    },
  });
  assert.equal(cleanup.status, 'completed');
  assert.equal(cleanup.lineageSource, 'host-spawn-evidence');
  assert.deepEqual(killed, [421]);
  assert.deepEqual(cleanup.survivors, []);
});

test('Windows proof timeout returns a timeout cleanup receipt without targeting the host process', { skip: process.platform !== 'win32' }, async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'kernel-timeout-tree-project-'));
  try {
    await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({
      name: 'timeout-tree-fixture',
      version: '0.0.1',
      scripts: { timeout: 'node -e "setTimeout(() => {}, 5000)"' },
    }));
    const execution = executeTrustedProof({ projectRoot, commandRef: 'timeout', timeoutMs: 50 });
    assert.equal(execution.timedOut, true);
    assert.ok(execution && typeof execution === 'object' && 'timeoutCleanup' in execution);
    assert.ok(execution.timeoutCleanup !== null && execution.timeoutCleanup !== undefined);
    assert.equal(execution.timeoutCleanup.platform, 'win32');
    assert.ok(execution && typeof execution === 'object' && 'timeoutCleanup' in execution);
    assert.ok(execution.timeoutCleanup !== null && execution.timeoutCleanup !== undefined);
    assert.equal(Number(execution.timeoutCleanup.launcherPid) === process.pid, false);
    assert.ok(execution && typeof execution === 'object' && 'timeoutCleanup' in execution);
    assert.ok(execution.timeoutCleanup !== null && execution.timeoutCleanup !== undefined);
    assert.ok(['completed', 'blocked', 'failed'].includes(execution.timeoutCleanup.status));
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});
