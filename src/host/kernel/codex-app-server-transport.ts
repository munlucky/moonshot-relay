// Optional Host-owned Codex App Server connection. This is a bounded,
// read-only lifecycle probe, not a worker-completion or OS process authority.
// A trusted Host explicitly creates and closes the connection; no provider
// default, Kernel completion rule, or persisted worker layer is changed.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { bindNativeCommandEvent, type NativeExecutionOwner, type NativeExecutionObserver } from './adapter-dispatch.js';
import { reserveHostWorkspaceWriter } from './workspace-writer-reservation.js';

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
  // Host may attach its pending cancel only after this exact Turn becomes
  // active; the transport queues cancellation until the Turn ID is known.
  onReady?: () => void;
  // Host-selected schema. The matching final agent message remains a model
  // claim; neither JSON shape nor Turn completion grants Report authority.
  outputSchema?: RecordValue;
  onUsage?: (usage: CodexAppServerUsage) => void;
  // Host-only generation policy. Read-only sandboxing alone permits tools.
  toolPolicy?: 'none';
  // Explicit Host-only opt-in. The reservation root must be inaccessible to
  // the Worker sandbox; this does not change the default read-only transport.
  writableWorker?: { reservationRoot: string } | null;
}

export interface CodexAppServerTurnResult {
  threadId: string;
  turnId: string;
  turnStatus: 'completed' | 'failed' | 'interrupted' | 'unknown';
  // A completed model turn is NOT proof that command descendants have exited.
  writerExitVerified: false;
  finalMessage?: string | null;
  // Configuration resolved by App Server, not provider-observed enforcement.
  resolvedModel?: string | null;
  resolvedEffort?: string | null;
  usage?: CodexAppServerUsage | null;
}

export interface CodexAppServerUsage {
  inputTokens: number | null;
  cachedInputTokens: number | null;
  cacheWriteInputTokens: number | null;
  outputTokens: number | null;
  reasoningOutputTokens: number | null;
}

export interface CodexAppServerTurnObservation {
  connection: 'connected' | 'unavailable';
  turn: 'idle' | 'starting' | 'running' | 'interrupt-requested' | 'unknown';
  threadId: string | null;
  turnId: string | null;
  // This observes only the owned App Server connection, never OS descendants.
  writerExitVerified: false;
}

export interface CodexAppServerInterruptResult {
  status: 'requested' | 'queued' | 'not-running' | 'not-addressable' | 'unavailable' | 'unknown';
  writerExitVerified: false;
}

export interface CodexAppServerTransport {
  runTurn(input: CodexAppServerTurn): Promise<CodexAppServerTurnResult>;
  observeTurn(): CodexAppServerTurnObservation;
  interruptActiveTurn(): Promise<CodexAppServerInterruptResult>;
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
  let drained = false;
  let retiringNoTools = false;
  let closed = false;
  let poisoned = false;
  let poisonReason: string | null = null;
  let nextId = 1;
  let buffer = '';
  let active = false;
  let activeTurn: { threadId: string; turnId: string } | null = null;
  let interruptRequest: Promise<CodexAppServerInterruptResult> | null = null;
  let interruptRequested = false;
  let shutdown: Promise<boolean> | null = null;
  const attemptedWorkspaces = new Set<string>();
  const pending = new Map<number, Pending>();
  const listeners = new Set<(message: ServerMessage) => void>();
  let activeReject: ((e: Error) => void) | null = null;

  const fail = (reason: string): void => {
    if (poisoned) return;
    poisoned = true;
    poisonReason = reason;
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
    if (!retiringNoTools) fail('codex_app_server_connection_lost');
  });
  child.once('close', () => { drained = true; });
  // Own only this App Server process, never its unknown tool descendants.
  // Reuse one shutdown across initialization failures and repeated close().
  const stopOwnedAppServer = (): Promise<boolean> => {
    if (shutdown) return shutdown;
    shutdown = (async () => {
      const waitForExit = (timeoutMs: number): Promise<boolean> => new Promise((resolve) => {
        if (exited) { resolve(true); return; }
        let done = false;
        const finish = (): void => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          child.removeListener('exit', finish);
          resolve(exited);
        };
        child.once('exit', finish);
        const timer = setTimeout(finish, timeoutMs);
        if (exited) finish();
      });
      if (exited) return true;
      child.kill('SIGTERM');
      if (await waitForExit(2000)) return true;
      child.kill('SIGKILL');
      return waitForExit(2000);
    })();
    return shutdown;
  };
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
      // JSON-RPC requests have a method; responses do not. Distinguish them
      // before matching pending client request IDs: a server approval request
      // can independently reuse the same numeric ID as an in-flight RPC.
      if (typeof message.method === 'string' && message.id === undefined) {
        for (const listener of listeners) listener(message);
      } else if (typeof message.method === 'string') {
        // There is no user-authorized approval channel in this transport.
        // Deny the request and poison the Turn rather than allow false success.
        try {
          child.stdin.write(JSON.stringify({
            id: message.id,
            error: { code: -32601, message: 'Host-owned transport does not accept server requests' },
          }) + '\n');
        } catch {
          fail('codex_app_server_stdin_failed');
        }
        fail('codex_app_server_unhandled_server_request');
      } else if (Number.isSafeInteger(message.id) && pending.has(message.id as number)) {
        const found = pending.get(message.id as number)!;
        pending.delete(message.id as number);
        clearTimeout(found.timer);
        if (message.error != null) found.reject(error('codex_app_server_rpc_failed'));
        else if (object(message.result)) found.resolve(object(message.result)!);
        else found.reject(error('codex_app_server_rpc_invalid'));
      }
    }
    if (Buffer.byteLength(buffer, 'utf8') > MAX_LINE_BYTES) fail('codex_app_server_frame_too_large');
  });

  const rpc = (method: string, params: RecordValue): Promise<RecordValue> => {
    if (closed || poisoned || exited) return Promise.reject(error('codex_app_server_unavailable'));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // Interrupt is advisory and bound to one known Turn. A missing ACK
        // cannot override a terminal event or poison a different Turn.
        if (method === 'turn/interrupt') {
          pending.delete(id);
          reject(error('codex_app_server_rpc_timeout'));
        } else {
          fail('codex_app_server_rpc_timeout');
        }
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
    // The caller receives no transport on initialize failure. Do not abandon
    // a live owned App Server after a timeout or rejected initialize RPC.
    if (!await stopOwnedAppServer()) {
      throw Object.assign(error('codex_app_server_shutdown_unconfirmed'), { cause });
    }
    throw cause;
  }

  const sendInterrupt = (): Promise<CodexAppServerInterruptResult> => {
    if (interruptRequest) return interruptRequest;
    if (!activeTurn) return Promise.resolve({ status: 'not-addressable', writerExitVerified: false });
    interruptRequest = rpc('turn/interrupt', { threadId: activeTurn.threadId, turnId: activeTurn.turnId })
      .then(() => ({ status: 'requested' as const, writerExitVerified: false as const }))
      .catch(() => ({ status: 'unknown' as const, writerExitVerified: false as const }));
    return interruptRequest;
  };

  return {
    observeTurn() {
      const available = !closed && !poisoned && !exited;
      return {
        connection: available ? 'connected' as const : 'unavailable' as const,
        turn: !available ? 'unknown' as const
          : interruptRequested ? 'interrupt-requested' as const
          : activeTurn ? 'running' as const
          : active ? 'starting' as const : 'idle' as const,
        threadId: activeTurn?.threadId || null,
        turnId: activeTurn?.turnId || null,
        writerExitVerified: false as const,
      };
    },

    interruptActiveTurn() {
      if (closed || poisoned || exited) return Promise.resolve({ status: 'unavailable' as const, writerExitVerified: false as const });
      if (!active) return Promise.resolve({ status: 'not-running' as const, writerExitVerified: false as const });
      // Keep the request on this exact Host Turn until turn/start returns its
      // identity. The Host must never cancel an unspecified or later Turn.
      interruptRequested = true;
      if (!activeTurn) return Promise.resolve({ status: 'queued' as const, writerExitVerified: false as const });
      // An RPC ACK is not a Turn interrupt event or an OS Writer exit proof.
      return sendInterrupt();
    },

    async runTurn({ cwd: requestedCwd, prompt, model, effort, timeoutMs: turnTimeout, executionOwner = null, onNativeExecution = null, onReady = undefined, outputSchema = undefined, onUsage = undefined, toolPolicy = undefined, writableWorker = null }) {
      if (closed || poisoned || exited) throw error('codex_app_server_unavailable');
      if (active) throw error('codex_app_server_turn_already_running');
      if (!name(prompt) || !name(model) || !name(effort) || !name(requestedCwd)) {
        throw error('codex_app_server_turn_input_invalid');
      }
      if (Boolean(executionOwner) !== Boolean(onNativeExecution)
        || (writableWorker !== null && (!executionOwner || !onNativeExecution))) {
        throw error('codex_app_server_observation_owner_required');
      }
      if (toolPolicy !== undefined && (toolPolicy !== 'none' || writableWorker || executionOwner)) {
        throw error('codex_app_server_tool_policy_invalid');
      }
      const effectiveTimeout = timeBudget(turnTimeout, DEFAULT_TURN_TIMEOUT_MS);
      // Reserve before the first await so concurrent callers cannot both
      // pass the admission check while resolving the same Workspace.
      active = true;
      activeTurn = null;
      interruptRequest = null;
      interruptRequested = false;
      let workspace: string;
      try {
        onReady?.();
        workspace = await realpath(requestedCwd);
        if (attemptedWorkspaces.has(workspace)) {
          throw error('codex_app_server_workspace_reuse_unverified');
        }
        if (writableWorker) {
          // This is admission before any thread/start or turn/start RPC.
          // Unknown/failed admission never invokes a writable model Turn.
          await reserveHostWorkspaceWriter({
            workspaceRoot: workspace,
            reservationRoot: writableWorker.reservationRoot,
            runId: executionOwner!.runId,
            attemptId: executionOwner!.attemptId,
            workspaceId: executionOwner!.workspaceId,
          });
        }
      } catch (cause) {
        active = false;
        throw cause;
      }
      let startedTurn: { threadId: string; turnId: string } | null = null;
      let buffered: ServerMessage[] = [];
      let finalMessage: { id: string; text: string } | null = null;
      let usage: CodexAppServerUsage | null = null;
      const finalText = (): string | null => finalMessage?.text ?? null;
      let turnCompleted = false;
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
        if (turnCompleted && toolPolicy !== 'none') return;
        if (!startedTurn) {
          if (buffered.length === MAX_BEFORE_ACK) {
            fail('codex_app_server_early_events_overflow');
            return;
          }
          if ((toolPolicy === 'none' && String(message.method).startsWith('item/')) || message.method === 'item/started' || message.method === 'item/completed' || message.method === 'turn/completed' || message.method === 'thread/tokenUsage/updated') buffered.push(message);
          return;
        }
        const params = object(message.params);
        const observedTurnId = message.method === 'turn/completed'
          ? name(object(params?.turn)?.id)
          : name(params?.turnId);
        if (params?.threadId !== startedTurn.threadId || observedTurnId !== startedTurn.turnId) return;
        if (toolPolicy === 'none' && String(message.method).startsWith('item/')) {
          const type = object(params?.item)?.type;
          const permitted = message.method === 'item/started' || message.method === 'item/completed'
            ? ['agentMessage', 'userMessage', 'reasoning'].includes(String(type))
            : ['item/agentMessage/delta', 'item/reasoning/textDelta', 'item/reasoning/summaryTextDelta', 'item/reasoning/summaryPartAdded'].includes(String(message.method));
          if (!permitted) { fail('codex_app_server_tool_event_forbidden'); return; }
        }
        if (turnCompleted) return;
        if (message.method === 'thread/tokenUsage/updated') {
          // One fresh thread and one Turn: total includes every model request
          // in this Turn. "last" would omit earlier tool/model requests.
          const total = object(object(params.tokenUsage)?.total);
          if (!total) return;
          const count = (key: string): number | null => {
            const value = total[key];
            return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
          };
          usage = { inputTokens: count('inputTokens'), cachedInputTokens: count('cachedInputTokens'),
            cacheWriteInputTokens: count('cacheWriteInputTokens'), outputTokens: count('outputTokens'),
            reasoningOutputTokens: count('reasoningOutputTokens') };
          try { onUsage?.({ ...usage }); }
          catch { fail('codex_app_server_observer_failed'); }
        } else if (message.method === 'item/started' || message.method === 'item/completed') {
          const item = object(params?.item);
          if (outputSchema && message.method === 'item/completed' && item?.type === 'agentMessage'
            && (item.phase === 'final_answer' || item.phase === null || item.phase === undefined)) {
            if (!name(item.id) || typeof item.text !== 'string') {
              fail('codex_app_server_final_message_invalid');
              return;
            }
            if (finalMessage && (finalMessage.id !== item.id || finalMessage.text !== item.text)) {
              fail('codex_app_server_final_message_ambiguous');
              return;
            }
            finalMessage = { id: item.id as string, text: item.text };
          }
          if (executionOwner && onNativeExecution) {
            const observation = bindNativeCommandEvent(executionOwner, message, startedTurn);
            if (observation) {
              try { onNativeExecution(observation); }
              catch { fail('codex_app_server_observer_failed'); }
            }
          }
        } else if (message.method === 'turn/completed') {
          turnCompleted = true;
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
        let noToolsConfig: RecordValue = {};
        if (toolPolicy === 'none') {
          // Discover names, never forward credentials/settings from the parent
          // catalogs. An unreadable config is a failure, not a tools-on fallback.
          const configuration = object((await rpc('config/read', { includeLayers: false, cwd: workspace })).config);
          if (!configuration) throw error('codex_app_server_tool_config_unavailable');
          const disableCatalog = (key: string) => Object.fromEntries(Object.keys(object(configuration[key]) || {})
            .map(id => [id, { enabled: false }]));
          noToolsConfig = {
            features: { shell_tool: false, multi_agent: false, multi_agent_v2: false,
              apps: false, browser_use: false, in_app_browser: false, computer_use: false,
              image_generation: false, view_image: false, code_mode_host: false, code_mode: false, code_mode_only: false,
              skill_search: false, sleep_tool: false, tool_suggest: false,
              hooks: false, goals: false, workspace_dependencies: false, remote_plugin: false },
            web_search: 'disabled',
            tools: { update_plan: { enabled: false }, experimental_request_user_input: { enabled: false } },
            mcp_servers: disableCatalog('mcp_servers'), plugins: disableCatalog('plugins'),
            apps: { ...disableCatalog('apps'), _default: { enabled: false, default_tools_enabled: false } },
          };
        }
        const thread = await rpc('thread/start', {
          cwd: workspace, sandbox: writableWorker ? 'workspace-write' : 'read-only',
          approvalPolicy: 'never', ephemeral: true, model,
          config: { model_reasoning_effort: effort, ...noToolsConfig },
        });
        const threadId = name(object(thread.thread)?.id);
        if (!threadId) throw error('codex_app_server_thread_missing');
        // Reserve this physical Workspace before asking the server to spawn a
        // model Turn. A failed/unknown turn/start cannot be retried blindly.
        attemptedWorkspaces.add(workspace);
        const turn = await rpc('turn/start', {
          threadId, input: [{ type: 'text', text: prompt }],
          model, effort, cwd: workspace,
          ...(outputSchema ? { outputSchema } : {}),
          sandboxPolicy: writableWorker
            ? { type: 'workspaceWrite', writableRoots: [workspace], networkAccess: false,
              excludeSlashTmp: true, excludeTmpdirEnvVar: true }
            : { type: 'readOnly' },
        });
        const turnId = name(object(turn.turn)?.id);
        if (!turnId) throw error('codex_app_server_turn_missing');
        startedTurn = { threadId, turnId };
        activeTurn = startedTurn;
        for (const message of buffered) observe(message);
        buffered = [];
        if (interruptRequested && !turnCompleted) void sendInterrupt();
        const turnTimer = setTimeout(() => {
          fail('codex_app_server_turn_timeout');
        }, effectiveTimeout);
        try {
          const turnStatus = await completed;
          if (toolPolicy === 'none') {
            // Keep observing through process exit and pipe drain. A terminal
            // Turn followed by a tool event in the remaining stream is not
            // an acceptable generation. This still proves no OS descendants.
            retiringNoTools = true;
            if (!await stopOwnedAppServer()) throw error('codex_app_server_shutdown_unconfirmed');
            if (!drained) await new Promise<void>((resolve, reject) => {
              const finish = () => { clearTimeout(timer); resolve(); };
              const timer = setTimeout(() => {
                child.removeListener('close', finish);
                reject(error('codex_app_server_drain_unconfirmed'));
              }, 2000);
              child.once('close', finish);
            });
          }
          if (poisoned) throw error(poisonReason || 'codex_app_server_unavailable');
          settled = true;
          return { threadId, turnId, turnStatus, writerExitVerified: false,
            resolvedModel: name(thread.model), resolvedEffort: name(thread.reasoningEffort), usage,
            ...(outputSchema ? { finalMessage: finalText() } : {}) };
        } finally {
          clearTimeout(turnTimer);
        }
      } finally {
        if (!settled) poisoned = true;
        activeReject = null;
        listeners.delete(observe);
        // Unknown/incomplete execution poisons the connection. Even completed
        // turns do not release their Workspace for another Writer.
        activeTurn = null;
        interruptRequest = null;
        interruptRequested = false;
        active = false;
      }
    },

    async close() {
      if (!closed) {
        closed = true;
        fail('codex_app_server_closed');
      }
      // A repeated close() must wait for the first shutdown, not claim exit
      // while the previously issued SIGTERM/SIGKILL is still pending.
      const appServerExited = await stopOwnedAppServer();
      return { appServerExited, writerExitVerified: false };
    },
  };
}
