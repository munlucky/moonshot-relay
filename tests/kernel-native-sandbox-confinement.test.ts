// Opt-in native macOS conformance. A detached OS child must retain the
// workspaceWrite boundary after its App Server parent terminates.
// This test requires an EXPLICIT disposable Codex home and never calls a model.
// Example: W0_NATIVE_SANDBOX_CONFORMANCE=1 CODEX_HOME=/path/to/test/codex
//   node --test tests/kernel-native-sandbox-confinement.test.mjs
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

const enabled = process.platform === 'darwin'
  && process.env.W0_NATIVE_SANDBOX_CONFORMANCE === '1'
  && Boolean(process.env.CODEX_HOME);
type RpcPending = {
  resolve: (value: Record<string, unknown>) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

test('Native workspaceWrite confines a detached Writer after App Server exit', {
  skip: !enabled && 'requires macOS, explicit CODEX_HOME and W0_NATIVE_SANDBOX_CONFORMANCE=1',
  timeout: 20_000,
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'w0-native-sandbox-confinement-'));
  const a = path.join(root, 'attempt-a');
  const b = path.join(root, 'attempt-b');
  const host = path.join(root, 'host-only');
  const markerB = path.join(b, 'b.marker');
  const markerHost = path.join(host, 'reservation.marker');
  let server: ChildProcessWithoutNullStreams | null = null;
  let pending = new Map<number, RpcPending>();
  let nextId = 0;
  let buffer = '';
  let writerPid: number | null = null;
  let safeToRemove = false;
  const rows = async (): Promise<number> => {
    try {
      const content = (await readFile(path.join(a, 'heartbeat.log'), 'utf8')).trim();
      return content ? content.split('\n').length : 0;
    } catch { return 0; }
  };
  const rpc = (method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
    assert.ok(server, 'server process required');
    const current = server;
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('native_rpc_timeout:' + method));
      }, 10_000);
      pending.set(id, { resolve, reject, timer });
      current.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  };
  try {
    await mkdir(a); await mkdir(b); await mkdir(host);
    await writeFile(markerB, 'B_ONLY\n');
    await writeFile(markerHost, 'HOST_ONLY\n');
    await writeFile(path.join(a, 'writer.cjs'), [
      "const fs=require('node:fs');",
      'const [heartbeat,results,bMarker,hMarker,pidfile]=process.argv.slice(2);',
      'fs.writeFileSync(pidfile,String(process.pid));',
      'let n=0,deniedB=0,deniedHost=0,allowedB=0,allowedHost=0;',
      'const timer=setInterval(()=>{',
      " const fd=fs.openSync(heartbeat,'a');try{fs.writeSync(fd,String(++n)+'\\n');fs.fsyncSync(fd)}finally{fs.closeSync(fd)}",
      " try{fs.writeFileSync(bMarker,'ILLEGAL');allowedB++}catch{deniedB++}",
      " try{fs.writeFileSync(hMarker,'ILLEGAL');allowedHost++}catch{deniedHost++}",
      ' fs.writeFileSync(results,JSON.stringify({n,deniedB,deniedHost,allowedB,allowedHost}));',
      ' if(n>=100){clearInterval(timer);process.exit(0)}',
      '},30);',
    ].join('\n') + '\n');
    const launch = path.join(a, 'spawn.cjs');
    await writeFile(launch, [
      "const {spawn}=require('node:child_process');",
      "const path=require('node:path');",
      "const child=spawn(process.execPath,[path.join(__dirname,'writer.cjs'),path.join(__dirname,'heartbeat.log'),path.join(__dirname,'writer-results.json'),process.argv[2],process.argv[3],path.join(__dirname,'writer.pid')],{detached:true,stdio:'ignore'});",
      "child.unref();process.stdout.write('CHILD_PID='+child.pid+'\\n');",
    ].join('\n') + '\n');

    server = spawn(process.env.W0_CODEX_EXECUTABLE || 'codex', ['app-server'], {
      cwd: a,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      // The App Server alone owns a fresh test-only process group. Never
      // signal a group inherited from this test runner or another Host.
      detached: true,
    });
    const serverPid = server.pid;
    assert.ok(serverPid && Number.isSafeInteger(serverPid), 'owned App Server PID required');
    const serverGroup = spawnSync('/bin/ps', ['-o', 'pgid=', '-p', String(serverPid)], { encoding: 'utf8' });
    assert.equal(serverGroup.status, 0);
    assert.equal(Number(serverGroup.stdout.trim()), serverPid,
      'group-wide signal is allowed only for this exact test-created process group');
    server.stderr.resume();
    server.stdout.setEncoding('utf8');
    server.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const pos = buffer.indexOf('\n');
        if (pos < 0) break;
        const line = buffer.slice(0, pos); buffer = buffer.slice(pos + 1);
        let parsed: Record<string, unknown>;
        try { parsed = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
        if (typeof parsed.id !== 'number') continue;
        const inflight = pending.get(parsed.id);
        if (!inflight) continue;
        pending.delete(parsed.id);
        clearTimeout(inflight.timer);
        if (parsed.error) inflight.reject(new Error('codex_rpc_error'));
        else inflight.resolve(parsed.result as Record<string, unknown>);
      }
    });
    server.once('exit', () => {
      for (const inflight of pending.values()) {
        clearTimeout(inflight.timer);
        inflight.reject(new Error('native_app_server_exited'));
      }
      pending.clear();
    });
    await rpc('initialize', {
      clientInfo: { name: 'moonrelay-w0-conformance', title: 'W0 native sandbox conformance', version: '0.0.1' },
    });
    server.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
    const result = await rpc('command/exec', {
      command: [process.execPath, launch, markerB, markerHost],
      cwd: a,
      timeoutMs: 10_000,
      sandboxPolicy: {
        type: 'workspaceWrite', writableRoots: [a], networkAccess: false,
        excludeSlashTmp: true, excludeTmpdirEnvVar: true,
      },
    });
    assert.equal(result.exitCode, 0, 'launch command must finish');
    for (let i = 0; i < 50 && !writerPid; i++) {
      try { writerPid = Number((await readFile(path.join(a, 'writer.pid'), 'utf8')).trim()); }
      catch { await delay(40); }
    }
    assert.ok(writerPid && Number.isSafeInteger(writerPid), 'OS Writer PID must be observed');
    const processRow = spawnSync('/bin/ps', [
      '-o', 'pid=,ppid=,pgid=,stat=', '-p', String(writerPid),
    ], { encoding: 'utf8' });
    assert.equal(processRow.status, 0);
    assert.ok(processRow.stdout.trim(), 'Writer must physically exist');
    const writerFields = processRow.stdout.trim().split(/\s+/u);
    assert.equal(Number(writerFields[2]), writerPid, 'Writer created its own detached process group');
    assert.notEqual(Number(writerFields[2]), serverPid, 'Writer is outside the App Server group');
    const before = await rows();
    await delay(120);
    assert.ok((await rows()) > before, 'detached Writer should outlive command/exec');
    // Retire the ENTIRE test-owned App Server group, not just its PID. The
    // detached Writer has a distinct PGID and must remain alive; this is
    // negative evidence against treating killpg as full Writer containment.
    const groupBeforeKill = spawnSync('/bin/ps', ['-o', 'pgid=', '-p', String(serverPid)], { encoding: 'utf8' });
    assert.equal(groupBeforeKill.status, 0);
    assert.equal(Number(groupBeforeKill.stdout.trim()), serverPid,
      'only signal a still-running, independently owned App Server group');
    const exit = once(server, 'exit');
    process.kill(-serverPid, 'SIGTERM');
    await Promise.race([exit, delay(1800)]);
    if (server.exitCode === null && server.signalCode === null) {
      process.kill(-serverPid, 'SIGKILL');
      await Promise.race([exit, delay(900)]);
    }
    assert.ok(server.exitCode !== null || server.signalCode !== null,
      'test-owned App Server must be observed exited after group retirement');
    const afterServer = await rows();
    await delay(130);
    assert.ok((await rows()) > afterServer, 'detached Writer should outlive App Server');
    assert.equal(await readFile(markerB, 'utf8'), 'B_ONLY\n');
    assert.equal(await readFile(markerHost, 'utf8'), 'HOST_ONLY\n');
    // The deliberately finite child expires on its own: this is NOT a
    // general descendant termination mechanism for arbitrary model commands.
    await delay(3400);
    const outcome = JSON.parse(await readFile(path.join(a, 'writer-results.json'), 'utf8')) as {
      n: number; deniedB: number; deniedHost: number;
      allowedB: number; allowedHost: number;
    };
    assert.deepEqual(outcome, {
      n: 100, deniedB: 100, deniedHost: 100, allowedB: 0, allowedHost: 0,
    });
    assert.equal(await readFile(markerB, 'utf8'), 'B_ONLY\n');
    assert.equal(await readFile(markerHost, 'utf8'), 'HOST_ONLY\n');
    const last = await rows();
    await delay(150);
    assert.equal(last, 100);
    assert.equal(await rows(), last);
    const psFinal = spawnSync('/bin/ps', ['-o', 'pid=', '-p', String(writerPid)], {
      encoding: 'utf8',
    });
    assert.equal(psFinal.stdout.trim(), '', 'test-owned finite PID must not remain');
    safeToRemove = true;
    console.log(JSON.stringify({
      case: 'W0 detached sandbox inheritance and App Server group retirement',
      appServerOwnedGroup: serverPid, childPid: writerPid,
      processRow: processRow.stdout.trim(), writes: outcome, rows: last,
      result: 'PASS', writerExitVerifiedForArbitraryTurn: false,
    }));
  } finally {
    if (server && server.exitCode === null && server.signalCode === null) {
      const done = once(server, 'exit');
      server.kill('SIGTERM');
      await Promise.race([done, delay(900)]);
      if (server.exitCode === null && server.signalCode === null) server.kill('SIGKILL');
    }
    if (safeToRemove) await rm(root, { recursive: true, force: true });
    else console.warn('Native conformance fixture preserved (unverified child exit):', root);
  }
});
