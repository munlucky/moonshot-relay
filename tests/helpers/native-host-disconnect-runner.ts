// Test-only, out-of-process Host fixture. The parent can SIGKILL this Host
// during an actual Codex App Server command/exec without fabricating a reply.
// Its reservation uses the production atomic Host writer admission.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { reserveHostWorkspaceWriter } from '../../src/host/kernel/workspace-writer-reservation.js';

export interface NativeDisconnectHostInput {
  runId: string;
  attemptId: string;
  workspaceId: string;
  workspaceRoot: string;
  reservationRoot: string;
  executable: string;
  argv: string[];
  timeoutMs?: number;
}

type ObjectValue = Record<string, unknown>;
type Pending = {
  resolve: (result: ObjectValue) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export const runNativeHostCommand = async (input: NativeDisconnectHostInput): Promise<ObjectValue> => {
  const reservation = await reserveHostWorkspaceWriter({
    workspaceRoot: input.workspaceRoot,
    reservationRoot: input.reservationRoot,
    runId: input.runId,
    attemptId: input.attemptId,
    workspaceId: input.workspaceId,
  });
  const child: ChildProcessWithoutNullStreams = spawn(input.executable, ['app-server'], {
    cwd: input.workspaceRoot, env: process.env, stdio: ['pipe', 'pipe', 'pipe'], shell: false,
  });
  if (!child.pid) throw new Error('native_host_test_server_start_unobserved');
  await writeFile(path.join(input.reservationRoot, 'test-server-' + input.attemptId + '.pid'),
    String(child.pid) + '\n');
  child.stderr.resume();
  child.stdout.setEncoding('utf8');
  const pending = new Map<number, Pending>();
  let nextId = 1;
  let buffer = '';
  let exited = false;
  child.once('exit', () => {
    exited = true;
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(new Error('native_host_test_app_server_connection_lost'));
    }
    pending.clear();
  });
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const end = buffer.indexOf('\n');
      if (end === -1) break;
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      let value: ObjectValue;
      try { value = JSON.parse(line) as ObjectValue; } catch { continue; }
      if (typeof value.id !== 'number') continue;
      const request = pending.get(value.id);
      if (!request) continue;
      pending.delete(value.id);
      clearTimeout(request.timer);
      if (value.error) request.reject(new Error('native_host_test_rpc_error'));
      else request.resolve(value.result as ObjectValue);
    }
  });
  const rpc = (method: string, params: ObjectValue): Promise<ObjectValue> => (
    new Promise((resolve, reject) => {
      if (exited) return reject(new Error('native_host_test_app_server_exited'));
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('native_host_test_rpc_timeout:' + method));
      }, 40_000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    })
  );
  try {
    await rpc('initialize', {
      clientInfo: { name: 'moonrelay-w0-t31', title: 'W0 Native Host disconnect fixture', version: '0.0.1' },
    });
    child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
    return await rpc('command/exec', {
      command: input.argv, cwd: input.workspaceRoot, timeoutMs: input.timeoutMs || 35_000,
      sandboxPolicy: {
        type: 'workspaceWrite', writableRoots: [input.workspaceRoot],
        networkAccess: false, excludeSlashTmp: true, excludeTmpdirEnvVar: true,
      },
    });
  } finally {
    if (!exited) {
      child.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 1500);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
      if (!exited) child.kill('SIGKILL');
    }
  }
};
