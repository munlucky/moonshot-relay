export type BindingAccessMode = 'owner' | 'reviewer' | 'read_only';
export type BindingAccessCommand = 'next' | 'report' | 'blocker' | 'resume' | 'finalize' | 'status' | 'context';

const ACCESS: Readonly<Record<BindingAccessCommand, readonly BindingAccessMode[]>> = Object.freeze({
  next: ['owner'],
  report: ['owner'],
  blocker: ['owner'],
  resume: ['owner'],
  finalize: ['owner'],
  status: ['owner', 'reviewer', 'read_only'],
  context: ['owner', 'reviewer', 'read_only'],
});

interface BindingRecord {
  bindingId: string;
  sessionId: string;
  projectId: string;
  runId: string;
  workspaceId?: string | null;
  accessMode: string;
  status: string;
  expiresAt?: string | null;
}

interface RunMetadata {
  runId?: string;
  projectId: string | null;
  workspaceId?: string | null;
  ownerBindingId?: string | null;
}

interface BindingStateStore {
  getActiveRunBinding(input: { projectId: string; sessionId: string; runId: string }): BindingRecord | null;
  getActiveRunBindingScope(input: { sessionId: string; runId: string }): { projectId?: string | null } | null;
  getRunMetadata(runId: string): RunMetadata | null;
}

interface KernelErrorLike {
  code?: string;
  message?: string;
  nextAction?: string;
  details?: {
    expected?: unknown;
    provided?: unknown;
    recovery?: unknown;
  };
}

export class KernelBindingError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'KernelBindingError';
  }
}

const fail = (code: string): never => {
  throw new KernelBindingError(code);
};

// Recovery guidance is intended to be copied into a POSIX shell. Single-quote
// every byte and splice literal apostrophes without ever reopening an
// attacker-controlled expansion context.
const shellQuote = (value: unknown): string => (
  `'${String(value || '').replaceAll("'", `'"'"'`)}'`
);

export const recoveryForKernelError = ({
  code,
  projectRoot,
  provider = 'codex',
}: {
  code?: unknown;
  projectRoot?: unknown;
  provider?: unknown;
} = {}) => {
  const normalizedProvider = String(provider || '').toLowerCase();
  const surface = normalizedProvider.startsWith('claude') ? 'claude'
    : normalizedProvider.startsWith('qwen') ? 'qwen'
    : normalizedProvider.startsWith('antigravity') ? 'antigravity'
    : 'codex';

  if ([
    'wrong_harness',
    'host_binding_missing',
    'host_binding_conflict',
    'run_binding_conflict',
    'provider_session_invalid',
    'run_session_mismatch',
    'run_project_mismatch',
    'run_workspace_mismatch',
  ].includes(String(code || ''))) {
    return {
      action: 'reopen-from-correct-worktree',
      command: `kernel next --diagnose --project-root ${shellQuote(projectRoot)} --provider ${surface} --json`,
    };
  }
  return null;
};

export const bindingErrorPayload = (
  value: unknown,
  { projectRoot = process.cwd(), provider = 'codex' }: { projectRoot?: string; provider?: string } = {},
) => {
  const error = value && typeof value === 'object' ? value as KernelErrorLike : null;
  const errorCode = error?.code || error?.message || 'host_binding_missing';
  const remediation = [
    'host_binding_missing',
    'wrong_harness',
    'host_binding_conflict',
    'run_binding_conflict',
  ].includes(errorCode)
    ? recoveryForKernelError({ code: errorCode, projectRoot, provider })
    : null;
  const expected = error?.details?.expected && typeof error.details.expected === 'object'
    ? error.details.expected
    : null;
  const provided = error?.details?.provided && typeof error.details.provided === 'object'
    ? error.details.provided
    : null;
  const recovery = error?.details?.recovery && typeof error.details.recovery === 'object'
    ? error.details.recovery
    : remediation
      ? { action: remediation.action }
      : null;

  return {
    schemaVersion: 1,
    status: 'error',
    errorCode,
    ...(error?.nextAction ? { nextAction: error.nextAction } : remediation ? { nextAction: remediation.action } : {}),
    ...(remediation ? { remediation } : {}),
    ...(expected ? { expected } : {}),
    ...(provided ? { provided } : {}),
    ...(recovery ? { recovery } : {}),
  };
};

export const assertBoundRunAccess = ({
  stateStore,
  requestedRunId,
  currentProject,
  currentWorkspace = null,
  sessionId,
  requiredAccess,
  command,
}: {
  stateStore?: BindingStateStore;
  requestedRunId?: unknown;
  currentProject?: { projectId?: unknown } | unknown;
  currentWorkspace?: { workspaceId?: unknown } | unknown;
  sessionId?: unknown;
  requiredAccess?: BindingAccessCommand;
  command?: BindingAccessCommand;
} = {}) => {
  if (!stateStore || !sessionId || !requestedRunId) throw new KernelBindingError('host_binding_missing');
  const store: BindingStateStore = stateStore;

  const projectId = typeof currentProject === 'object' && currentProject !== null
    ? String((currentProject as { projectId?: unknown }).projectId || '')
    : String(currentProject || '');
  if (!projectId) throw new KernelBindingError('run_project_mismatch');

  const normalizedSessionId = String(sessionId);
  const normalizedRunId = String(requestedRunId);
  const binding = store.getActiveRunBinding({
    projectId,
    sessionId: normalizedSessionId,
    runId: normalizedRunId,
  });

  if (!binding) {
    const observedScope = store.getActiveRunBindingScope({
      sessionId: normalizedSessionId,
      runId: normalizedRunId,
    });
    if (observedScope && observedScope.projectId !== projectId) {
      throw new KernelBindingError('run_project_mismatch');
    }
    throw new KernelBindingError('host_binding_missing');
  }
  const activeBinding: BindingRecord = binding;
  if (activeBinding.expiresAt && Date.parse(activeBinding.expiresAt) <= Date.now()) fail('binding_expired');
  if (activeBinding.status !== 'active') fail('binding_expired');
  if (activeBinding.runId !== normalizedRunId) fail('run_session_mismatch');

  const run = store.getRunMetadata(normalizedRunId);
  if (!run) throw new KernelBindingError('active_run_not_found');
  const runMetadata: RunMetadata = run;
  if (runMetadata.projectId !== projectId || activeBinding.projectId !== projectId) fail('run_project_mismatch');
  if (activeBinding.sessionId !== normalizedSessionId) fail('run_session_mismatch');
  if (activeBinding.accessMode === 'owner' && runMetadata.ownerBindingId !== activeBinding.bindingId) fail('run_access_denied');

  const accessKey = requiredAccess || command;
  const allowed = accessKey ? ACCESS[accessKey] : ACCESS.next;
  if (!allowed.some((mode) => mode === activeBinding.accessMode)) fail('run_access_denied');

  const workspaceId = typeof currentWorkspace === 'object' && currentWorkspace !== null
    ? String((currentWorkspace as { workspaceId?: unknown }).workspaceId || '')
    : currentWorkspace ? String(currentWorkspace) : '';
  if (runMetadata.workspaceId && activeBinding.workspaceId !== runMetadata.workspaceId) fail('run_workspace_mismatch');
  if (workspaceId && activeBinding.workspaceId && workspaceId !== activeBinding.workspaceId) fail('run_workspace_mismatch');

  return {
    run: runMetadata,
    binding: activeBinding,
    projectId,
    workspaceId: activeBinding.workspaceId,
    accessMode: activeBinding.accessMode,
  };
};
