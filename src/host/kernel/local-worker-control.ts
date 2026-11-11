// Explicit local Host control. The caller owns the Host lifetime; closing a
// Main connection does not cancel its Worker. No daemon or new work store.
import readline from 'node:readline';
import { createKernelControlPlane } from './control-plane-runtime.js';
import { createHostWorkerSessions } from './host-worker-sessions.js';
import { resolveKernelRuntimeHome } from '../../kernel/runtime-home.js';
import { createHostIoWriter, type HostIoWriteRequest } from './io-writer.js';
import { createHostIoReader, type HostIoReadRequest } from './io-reader.js';
import type { HostIoModelOptions } from './io-common.js';

type Value = Record<string, unknown>;
type Sessions = ReturnType<typeof createHostWorkerSessions>;
const record = (value: unknown): Value => value && typeof value === 'object' && !Array.isArray(value) ? value as Value : {};
const required = (value: unknown, code: string): string => {
  if (typeof value !== 'string' || !value.trim()) throw Object.assign(new Error(code), { code });
  return value;
};

export interface LocalWorkerControlOptions {
  projectRoot: string;
  runtimeHome?: string;
  env?: NodeJS.ProcessEnv;
  hostWorkerSessions?: Sessions;
  ioWriter?: HostIoModelOptions;
  ioReader?: HostIoModelOptions;
}

export function createLocalWorkerControl({
  projectRoot, runtimeHome, env = process.env,
  hostWorkerSessions = createHostWorkerSessions({ env }),
  ioWriter, ioReader,
}: LocalWorkerControlOptions) {
  const home = runtimeHome || resolveKernelRuntimeHome({ env });
  // A trusted Host must opt in. The model-visible Worker receives no new tool
  // or delegation capability, and normal start/resume adds no helper call.
  const writeCandidate = ioWriter ? createHostIoWriter({ projectRoot, runtimeHome: home, env, ...ioWriter }) : null;
  const readEvidence = ioReader ? createHostIoReader({ projectRoot, runtimeHome: home, env, ...ioReader }) : null;
  return async (input: unknown): Promise<Value> => {
    const request = record(input);
    try {
      const action = required(request.action, 'host_worker_action_required');
      if (action === 'capabilities') {
        let failureCode: string | null = null;
        try { hostWorkerSessions.assertNativeStartAvailable(); }
        catch (error) { failureCode = String(record(error).code || 'host_worker_native_isolation_unverified'); }
        return { schemaVersion: 1, status: failureCode ? 'unsupported' : 'available',
          writableStart: !failureCode, failureCode, authority: 'bound-kernel-run',
          lifetime: 'current-host-process', ioWriter: { available: Boolean(writeCandidate), adoption: 'opt-in' },
          ioReader: { available: Boolean(readEvidence), adoption: 'opt-in' } };
      }
      if (!['start', 'resume', 'status', 'attach', 'interrupt', 'io-write', 'io-read'].includes(action)) {
        return { schemaVersion: 1, status: 'error', failureCode: 'host_worker_action_unknown' };
      }
      if ((action === 'io-write' && !writeCandidate) || (action === 'io-read' && !readEvidence)) {
        return { schemaVersion: 1, status: 'unsupported', failureCode: 'host_io_not_enabled' };
      }
      const starting = action === 'start' || action === 'resume';
      // Reject malformed execution requests before Kernel can prepare a Step.
      const model = starting ? required(request.model, 'host_worker_start_fields_missing') : '';
      const effort = starting ? required(request.effort, 'host_worker_start_fields_missing') : '';
      const attemptId = action === 'interrupt' ? required(request.attemptId, 'host_worker_attempt_required') : '';
      const cp = await createKernelControlPlane({ projectRoot, runtimeHome: home, env,
        requireHostBinding: Boolean(env.MOON_RELAY_KERNEL_SESSION_ID) });
      try {
        const runId = await cp.resolveRunId({
          explicitRunId: request.runId == null ? null : required(request.runId, 'host_worker_run_required'),
          envRunId: env.MOON_RELAY_KERNEL_RUN_ID || null,
        });
        const snapshot = record(await cp.status(runId));
        const run = record(snapshot.run);
        if (typeof run.runId !== 'string') {
          return { schemaVersion: 1, runId, status: snapshot.status || 'not_found',
            failureCode: snapshot.errorCode || snapshot.failureCode || null };
        }
        if (action === 'io-write' && writeCandidate) {
          if (request.runId !== runId) return { schemaVersion: 1, status: 'error', failureCode: 'host_io_run_required' };
          return { schemaVersion: 1, runId, ...await writeCandidate(cp, request as unknown as HostIoWriteRequest) };
        }
        if (action === 'io-read' && readEvidence) {
          if (request.runId !== runId) return { schemaVersion: 1, status: 'error', failureCode: 'host_io_run_required' };
          return { schemaVersion: 1, runId, ...await readEvidence(cp, request as unknown as HostIoReadRequest) };
        }
        if (starting) {
          const worker = await hostWorkerSessions.startLocal({ projectRoot, runtimeHome: home, runId, model, effort });
          return { schemaVersion: 1, runId, status: 'host-worker-attached', hostWorker: worker };
        }
        if (action === 'interrupt') {
          return { schemaVersion: 1, runId,
            hostWorkerSignal: await hostWorkerSessions.interrupt(projectRoot, home, runId, attemptId) };
        }
        // Keep canonical state distinct from live observations. A new Host
        // can read persisted Attempts, but cannot invent their live handles.
        return { schemaVersion: 1, runId, status: 'attached',
          canonical: { status: run.status, state: run.state, planRevision: run.planRevision,
            mutationRevision: run.mutationRevision,
            finalization: record(record(snapshot.resume).finalization).status || null },
          workerAttempts: cp.getHostRoutingSnapshot(runId).stepAttempts.map(attempt => ({
            attemptId: attempt.attemptId, stepId: attempt.stepId, status: attempt.status,
            workspaceId: attempt.workspaceId, provenanceKind: attempt.provenanceKind,
            liveState: 'unobserved', writerExitVerified: false,
          })),
          liveWorker: await hostWorkerSessions.status(projectRoot, home, runId) };
      } finally { await cp.close(); }
    } catch (error) {
      const failureCode = String(record(error).code || record(error).errorCode || 'host_worker_control_failed');
      return { schemaVersion: 1,
        status: failureCode === 'host_worker_native_isolation_unverified' ? 'unsupported' : 'error',
        failureCode };
    }
  };
}

// One JSON object per line: { id, action, runId, ... }. This foreground
// transport is optional; Native Hosts can call createLocalWorkerControl directly.
export function startLocalWorkerControl({
  stdin = process.stdin, stdout = process.stdout, ...options
}: LocalWorkerControlOptions & { stdin?: NodeJS.ReadableStream; stdout?: NodeJS.WritableStream }) {
  const handle = createLocalWorkerControl(options);
  const lines = readline.createInterface({ input: stdin, terminal: false });
  let closed = false;
  lines.on('line', (line: string) => {
    if (!line.trim()) return;
    let request: Value;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid request');
      request = parsed as Value;
      if (request.id != null && typeof request.id !== 'string' && !Number.isSafeInteger(request.id)) throw new Error('invalid id');
    } catch {
      stdout.write(JSON.stringify({ id: null, status: 'error', failureCode: 'host_worker_request_invalid' }) + '\n');
      return;
    }
    void handle(request).then(result => {
      if (!closed) stdout.write(JSON.stringify({ id: request.id ?? null, ...result }) + '\n');
    }).catch(() => {
      // Losing this response channel does not cancel the owning Host job.
      closed = true;
      lines.close();
    });
  });
  return { close() { closed = true; lines.close(); } };
}
