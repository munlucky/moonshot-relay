// Optional Host-owned Codex App Server connection. This is a bounded,
// read-only lifecycle probe, not a worker-completion or OS process authority.
// A trusted Host explicitly creates and closes the connection; no provider
// default, Kernel completion rule, or persisted worker layer is changed.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { bindNativeCommandEvent, type NativeExecutionOwner, type NativeExecutionObserver } from './adapter-dispatch.js';

type RecordValue = Record<string, unknown>;
type ServerMessage = RecordValue & { id?: unknown; method?: unknown; params?: unknown };
type Pending = {
  resolve: (value: RecordValue) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export interface CodexAppServerTurn {
  cwd: string;
  prompt: string;
  model: string;
  effort: string;
  timeoutMs?: number;
  executionOwner?: NativeExecutionOwner | null;
  onNativeExecution?: NativeExecutionObserver | null;
}

export interface CodexAppServerTurnResult {
  threadId: string;
  turnId: string;
  turnStatus: 'completed' | 'failed' | 'interrupted' | 'unknown';
  // A completed model turn is NOT proof that command descendants have exited.
  writerExitVerified: false;
}

export interface CodexAppServerTransport {
  runTurn(input: CodexAppServerTurn): Promise<CodexAppServerTurnResult>;
  close(): Promise<{ appServerExited: boolean; writerExitVerified: false }>;
}

export interface CodexAppServerTransportOptions {
  executable?: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  clientName?: string;
}

const MAX_LINE_BYTES = 4 * 1024 * 1024;
const MAX_BEFORE_ACK = 128;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_TURN_TIMEOUT_MS = 60_000;

const object = (value: unknown): RecordValue | null => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as RecordValue
    : null
);
const name = (value: unknown): string | null => (
  typeof value === 'string' && value.trim().length ? value : null
);
const error = (code: string): Error & { code: string } => (
  Object.assign(new Error(code), { code })
);
const timeBudget = (value: number | undefined, fallback: number): number => {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0 || value > 10 * 60_000) {
    throw error('codex_app_server_timeout_invalid');
  }
  return value;
};

export async function createCodexAppServerTransport({
  executable = 'codex',
  args = ['app-server'],
  cwd,
  env = process.env,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  clientName = 'moonshot-relay-host',
}: CodexAppServerTransportOptions = {}): Promise<CodexAppServerTransport> {
  const timeout = timeBudget(requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
  if (!name(executable) || !Array.isArray(args) || !args.every(name) || !name(clientName)) {
    throw error('codex_app_server_launch_invalid');
  }

  // Only the one process spawned here is owned. No killpg or descendant claim.
  const child: ChildProcessWithoutNullStreams = spawn(executable, args, {
    cwd, env, stdio: ['pipe', 'pipe', 'pipe'], shell: false,
  });
  child.stderr.resume(); // Consume stderr without exposing credentials or logs.
  let exited = false;
  let closed = false;
  let poisoned = false;
  let nextId = 1;
  let buffer = '';
  let active = false;
  const attemptedWorkspaces = new Set<string>();
  const pending = new Map<number, Pending>();
  const listeners = new Set<(message: ServerMessage) => void>();
  let activeReject: ((e: Error) => void) | null = null;

  const fail = (reason: string): void => {
    if (poisoned) return;
    poisoned = true;
    const failure = error(reason);
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(failure);
    }
    pending.clear();
    activeReject?.(failure);
  };

  child.once('error', () => {
    exited = true;
    fail('codex_app_server_process_error');
  });
  child.once('exit', () => {
    exited = true;
    fail('codex_app_server_connection_lost');
  });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (data: string) => {
    if (poisoned || closed) return;
    buffer += data;
    if (Buffer.byteLength(buffer, 'utf8') > MAX_LINE_BYTES && !buffer.includes('\n')) {
      fail('codex_app_server_frame_too_large');
      return;
    }
    for (;;) {
      const end = buffer.indexOf('\n');
      if (end === -1 || poisoned) break;
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (!line) continue;
      if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
        fail('codex_app_server_frame_too_large');
        break;
      }
      let message: ServerMessage;
      try {
        const parsed: unknown = JSON.parse(line);
        const value = object(parsed);
        if (!value) throw error('invalid_object');
        message = value;
      } catch {
        fail('codex_app_server_protocol_invalid');
        break;
      }
      if (Number.isSafeInteger(message.id) && pending.has(message.id as number)) {
        const found = pending.get(message.id as number)!;
        pending.delete(message.id as number);
        clearTimeout(found.timer);
        if (message.error != null) found.reject(error('codex_app_server_rpc_failed'));
        else if (object(message.result)) found.resolve(object(message.result)!);
        else found.reject(error('codex_app_server_rpc_invalid'));
      } else if (typeof message.method === 'string' && message.id === undefined) {
        for (const listener of listeners) listener(message);
      } else if (message.id !== undefined && typeof message.method === 'string') {
        // Unexpected server-initiated requests are denied, never approved.
        try {
          child.stdin.write(JSON.stringify({
            id: message.id,
            error: { code: -32601, message: 'Host-owned transport does not accept server requests' },
          }) + '\n');
        } catch {
          fail('codex_app_server_stdin_failed');
        }
      }
    }
    if (Buffer.byteLength(buffer, 'utf8') > MAX_LINE_BYTES) fail('codex_app_server_frame_too_large');
  });

  const rpc = (method: string, params: RecordValue): Promise<RecordValue> => {
    if (closed || poisoned || exited) return Promise.reject(error('codex_app_server_unavailable'));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        fail('codex_app_server_rpc_timeout');
      }, timeout);
      pending.set(id, { resolve, reject, timer });
      try {
        child.stdin.write(JSON.stringify({ id, method, params }) + '\n', (writeError) => {
          if (writeError) fail('codex_app_server_stdin_failed');
        });
      } catch {
        fail('codex_app_server_stdin_failed');
      }
    });
  };

  try {
    await rpc('initialize', {
      clientInfo: { name: clientName, title: 'Moonshot Relay Host', version: '0.0.1' },
    });
    child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
  } catch (cause) {
    closed = true;
    child.kill('SIGTERM');
    throw cause;
  }

  return {
    async runTurn({ cwd: requestedCwd, prompt, model, effort, timeoutMs: turnTimeout, executionOwner = null, onNativeExecution = null }) {
      if (closed || poisoned || exited) throw error('codex_app_server_unavailable');
      if (active) throw error('codex_app_server_turn_already_running');
      if (!name(prompt) || !name(model) || !name(effort) || !name(requestedCwd)) {
        throw error('codex_app_server_turn_input_invalid');
      }
      if (Boolean(executionOwner) !== Boolean(onNativeExecution)) {
        throw error('codex_app_server_observation_owner_required');
      }
      const effectiveTimeout = timeBudget(turnTimeout, DEFAULT_TURN_TIMEOUT_MS);
      // Reserve before the first await so concurrent callers cannot both
      // pass the admission check while resolving the same Workspace.
      active = true;
      let workspace: string;
      try {
        workspace = await realpath(requestedCwd);
        if (attemptedWorkspaces.has(workspace)) {
          throw error('codex_app_server_workspace_reuse_unverified');
        }
      } catch (cause) {
        active = false;
        throw cause;
      }
      let startedTurn: { threadId: string; turnId: string } | null = null;
      let buffered: ServerMessage[] = [];
      let completionResolve: ((status: CodexAppServerTurnResult['turnStatus']) => void) | null = null;
      let completionReject: ((e: Error) => void) | null = null;
      const completed = new Promise<CodexAppServerTurnResult['turnStatus']>((resolve, reject) => {
        completionResolve = resolve;
        completionReject = reject;
      });
      // This promise may be rejected by the process while thread/start awaits.
      // Attach a rejection observer before making any RPC requests.
      void completed.catch(() => undefined);
      const observe = (message: ServerMessage): void => {
        if (!startedTurn) {
          if (buffered.length === MAX_BEFORE_ACK) {
            fail('codex_app_server_early_events_overflow');
            return;
          }
          if (message.method === 'item/started' || message.method === 'item/completed' || message.method === 'turn/completed') buffered.push(message);
          return;
        }
        const params = object(message.params);
        const observedTurnId = message.method === 'turn/completed'
          ? name(object(params?.turn)?.id)
          : name(params?.turnId);
        if (params?.threadId !== startedTurn.threadId || observedTurnId !== startedTurn.turnId) return;
        if (message.method === 'item/started' || message.method === 'item/completed') {
          if (executionOwner && onNativeExecution) {
            const observation = bindNativeCommandEvent(executionOwner, message, startedTurn);
            if (observation) {
              try { onNativeExecution(observation); }
              catch { fail('codex_app_server_observer_failed'); }
            }
          }
        } else if (message.method === 'turn/completed') {
          const rawStatus = object(params?.turn)?.status;
          const turnStatus = rawStatus === 'completed' || rawStatus === 'failed' || rawStatus === 'interrupted'
            ? rawStatus : 'unknown';
          completionResolve?.(turnStatus);
        }
      };
      listeners.add(observe);
      activeReject = (e) => { completionReject?.(e); };
      let settled = false;
      try {
        const thread = await rpc('thread/start', {
          cwd: workspace, sandbox: 'read-only', approvalPolicy: 'never', ephemeral: true,
        });
        const threadId = name(object(thread.thread)?.id);
        if (!threadId) throw error('codex_app_server_thread_missing');
        // Reserve this physical Workspace before asking the server to spawn a
        // model Turn. A failed/unknown turn/start cannot be retried blindly.
        attemptedWorkspaces.add(workspace);
        const turn = await rpc('turn/start', {
          threadId, input: [{ type: 'text', text: prompt }],
          model, effort, cwd: workspace, sandboxPolicy: { type: 'readOnly' },
        });
        const turnId = name(object(turn.turn)?.id);
        if (!turnId) throw error('codex_app_server_turn_missing');
        startedTurn = { threadId, turnId };
        for (const message of buffered) observe(message);
        buffered = [];
        const turnTimer = setTimeout(() => {
          fail('codex_app_server_turn_timeout');
        }, effectiveTimeout);
        try {
          const turnStatus = await completed;
          settled = true;
          return { threadId, turnId, turnStatus, writerExitVerified: false };
        } finally {
          clearTimeout(turnTimer);
        }
      } finally {
        if (!settled) poisoned = true;
        activeReject = null;
        listeners.delete(observe);
        // Unknown/incomplete execution poisons the connection. Even completed
        // turns do not release their Workspace for another Writer.
        active = false;
      }
    },

    async close() {
      if (!closed) {
        closed = true;
        fail('codex_app_server_closed');
        if (!exited) {
          child.kill('SIGTERM');
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 2000);
            child.once('exit', () => { clearTimeout(timer); resolve(); });
          });
          if (!exited) child.kill('SIGKILL'); // Only this owned App Server PID.
        }
      }
      return { appServerExited: exited, writerExitVerified: false };
    },
  };
}
