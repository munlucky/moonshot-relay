import { createHash } from 'node:crypto';
import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { matchPathScope } from '../../shared/path-scope.js';
import { assertRunWorktreeBinding, assertRunWorktreeMutationAuthority,
  type AssertRunWorktreeBindingInput } from '../../contracts/worktree-authority.js';
import { createCodexAppServerTransport, type CodexAppServerTransportOptions,
  type CodexAppServerTurn, type CodexAppServerUsage } from './codex-app-server-transport.js';
import { createModelRegistry, type ModelOverrideMap } from './model-registry.js';
import { resolveCodexModelPolicy } from './codex-model-policy.js';
import { resolveOptimizationModes } from './provider-prompt-policy.js';
import { captureHostExecutionSnapshot, isHostExecutionSnapshotFresh } from './turn-dispatcher.js';
import { observeWorkspaceIdentity } from './workspace/workspace-identity.js';
import { resolveKernelWorktreeIdentity } from './workspace/worktree-resolution.js';
import type { createKernelControlPlane } from './control-plane-runtime.js';

export type IoControlPlane = Awaited<ReturnType<typeof createKernelControlPlane>>;

export interface IoRequest {
  references: { path: string; sha256: string }[];
  maxInputBytes: number;
  maxOutputBytes: number;
  timeoutMs: number;
}

export interface HostIoRequest extends IoRequest {
  runId: string;
  stepId: string;
  expectedWorkspaceIdentity: string;
}

// The entrypoint owns authority. File/model validation is shared by both callers.
export interface IoContext {
  root: string;
  forbidden: string[];
  allowedPaths: string[];
  requestKey: unknown;
  assertFresh: () => void | Promise<void>;
}

export interface HostIoModelOptions {
  transportOptions?: CodexAppServerTransportOptions | undefined;
  overrides?: ModelOverrideMap;
}

export interface HostIoOptions extends HostIoModelOptions {
  projectRoot: string;
  runtimeHome: string;
  env?: NodeJS.ProcessEnv;
}

export function denyIo(code: string): never {
  throw Object.assign(new Error(code), { code });
}

export const ioDigest = (bytes: string | Buffer): string =>
  'sha256:' + createHash('sha256').update(bytes).digest('hex');

export function relativeIoFile(value: string): string {
  if (typeof value !== 'string' || !value || path.win32.isAbsolute(value) || path.posix.isAbsolute(value)) denyIo('host_io_path_invalid');
  const portable = value.replaceAll('\\', '/');
  if (portable.split('/').some(part => !part || part === '.' || part === '..'
    || /[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) denyIo('host_io_path_invalid');
  return portable;
}

export async function inspectIoPath(root: string, relative: string, mustExist: boolean): Promise<string> {
  let current = root;
  const parts = relative.split('/');
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]!);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) denyIo('host_io_symlink_rejected');
      if (i < parts.length - 1 && !info.isDirectory()) denyIo('host_io_path_invalid');
      if (i === parts.length - 1) {
        if (!mustExist) denyIo('host_io_existing_file');
        if (!info.isFile()) denyIo('host_io_reference_invalid');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (mustExist) denyIo('host_io_reference_missing');
      return path.join(root, ...parts);
    }
  }
  return current;
}

export function assertIoBudgets(request: IoRequest) {
  for (const value of [request.maxInputBytes, request.maxOutputBytes, request.timeoutMs]) {
    if (!Number.isSafeInteger(value) || value <= 0) denyIo('host_io_budget_required');
  }
  if (request.timeoutMs > 10 * 60_000) denyIo('codex_app_server_timeout_invalid');
}

export async function bindIoWorkUnit(cp: IoControlPlane, request: HostIoRequest,
  { projectRoot, env = process.env }: HostIoOptions, mutation: boolean) {
  const root = await realpath(projectRoot);
  const run = await cp.getRun(request.runId);
  const step = cp.getCurrentStep(request.runId);
  if (!run || run.status !== 'active' || !step || step.stepId !== request.stepId) denyIo('host_io_stale_work_unit');
  const worktree = resolveKernelWorktreeIdentity({ cwd: root, env });
  const assertBinding = (current: AssertRunWorktreeBindingInput['run']) => {
    if (mutation) assertRunWorktreeMutationAuthority({ stateStore: cp.stateStore, run: current, worktree });
    else assertRunWorktreeBinding({ run: current, worktree });
  };
  assertBinding(run);
  const snapshot = captureHostExecutionSnapshot({ controlPlane: cp, runId: request.runId, requestedStepId: request.stepId });
  const assertFresh = () => {
    try {
      const current = cp.stateStore.getRun(request.runId);
      assertBinding(current);
      if (current?.status === 'active' && cp.getCurrentStep(request.runId)?.stepId === request.stepId
        && isHostExecutionSnapshotFresh({ controlPlane: cp, runId: request.runId, requestedStepId: request.stepId, snapshot })
        && observeWorkspaceIdentity({ projectRoot: root }).identity === request.expectedWorkspaceIdentity) return;
    } catch { /* Changed authority also invalidates the observation. */ }
    denyIo('host_io_stale_snapshot');
  };
  return { root, allowedPaths: step.allowedPaths || [], forbidden: run.taskContract?.forbiddenPaths || [],
    requestKey: [request.runId, request.stepId, snapshot], assertFresh } satisfies IoContext;
}

export async function readIoReferences(root: string, references: IoRequest['references'],
  forbidden: string[], availableBytes: number) {
  if (availableBytes < 0) denyIo('host_io_input_budget_exceeded');
  const sources: { path: string; sha256: string; text: string; bytes: number }[] = [];
  for (const reference of references) {
    const ref = relativeIoFile(reference?.path);
    if (forbidden.length && matchPathScope(ref, forbidden)) denyIo('host_io_scope_rejected');
    const full = await inspectIoPath(root, ref, true);
    if ((await stat(full)).size > availableBytes) denyIo('host_io_input_budget_exceeded');
    const content = await readFile(full);
    availableBytes -= content.length;
    if (availableBytes < 0) denyIo('host_io_input_budget_exceeded');
    if (ioDigest(content) !== reference.sha256) denyIo('host_io_stale_reference');
    sources.push({ path: ref, sha256: reference.sha256, text: content.toString('utf8'), bytes: content.length });
  }
  return sources;
}

export async function assertIoReferencesFresh(root: string, sources: Awaited<ReturnType<typeof readIoReferences>>) {
  for (const source of sources) {
    const full = await inspectIoPath(root, source.path, true);
    if ((await stat(full)).size !== source.bytes || ioDigest(await readFile(full)) !== source.sha256) denyIo('host_io_stale_reference');
  }
}

export function createIoInvocation({ runtimeHome, env = process.env, overrides = {}, transportOptions }: HostIoOptions) {
  const started = Date.now();
  let usage: CodexAppServerUsage | null = null;
  let requestedModel: string | null = null;
  let requestedEffort: string | null = null;
  let resolvedModel: string | null = null;
  let resolvedEffort: string | null = null;
  const selectModel = () => {
    const registry = createModelRegistry({ surface: 'codex', runtimeHome, env, overrides });
    const selection = registry.resolveExecutionClass('standard');
    const policy = resolveOptimizationModes(env).codexModelPolicyMode === 'on' && selection.source !== 'invocation-override'
      ? resolveCodexModelPolicy({ executionClass: 'standard' }) : selection;
    requestedModel = policy.model;
    requestedEffort = policy.effort;
    if (!requestedModel || !requestedEffort) denyIo('host_io_model_unresolved');
    return { model: requestedModel, effort: requestedEffort };
  };
  return {
    selectModel,
    evidence: () => ({ requestedModel, requestedEffort, resolvedModel, resolvedEffort,
      observedModel: null, observedEffort: null, usage, wallMs: Date.now() - started,
      hostProductProof: 'NOT_RUN', ownerDelivery: 'HOLD_SAFE', kernelDone: false }),
    async runTurn(input: Pick<CodexAppServerTurn, 'cwd' | 'prompt' | 'timeoutMs' | 'outputSchema'>) {
      const selection = requestedModel && requestedEffort ? { model: requestedModel, effort: requestedEffort } : selectModel();
      const transport = await createCodexAppServerTransport(transportOptions);
      let result;
      try {
        result = await transport.runTurn({ ...input, ...selection,
          toolPolicy: 'none', onUsage: value => { usage = value; } });
      } finally {
        const closed = await transport.close();
        if (!closed.appServerExited) denyIo('host_io_transport_exit_unconfirmed');
      }
      usage = result.usage ?? usage;
      resolvedModel = result.resolvedModel ?? null;
      resolvedEffort = result.resolvedEffort ?? null;
      if (result.turnStatus !== 'completed') denyIo('host_io_turn_incomplete');
      if ((resolvedModel && resolvedModel !== requestedModel)
        || (resolvedEffort && resolvedEffort !== requestedEffort)) denyIo('host_io_model_mismatch');
      return result.finalMessage;
    },
  };
}

export function parseIoOutput(message: string | null | undefined, maxOutputBytes: number): unknown {
  if (!message || Buffer.byteLength(message) > maxOutputBytes) denyIo('host_io_response_invalid');
  try { return JSON.parse(message); } catch { denyIo('host_io_response_invalid'); }
}
