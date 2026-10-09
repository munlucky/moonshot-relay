const ACCESS = Object.freeze({
  next: ['owner'],
  report: ['owner'],
  blocker: ['owner'],
  resume: ['owner'],
  finalize: ['owner'],
  status: ['owner', 'reviewer', 'read_only'],
  context: ['owner', 'reviewer', 'read_only'],
});

export class KernelBindingError extends Error {
  constructor(code) {
    super(code);
    this.name = 'KernelBindingError';
    this.code = code;
  }
}

const fail = (code) => { throw new KernelBindingError(code); };

// Recovery guidance is intended to be copied into a POSIX shell. Single-quote
// every byte and splice literal apostrophes without ever reopening an
// attacker-controlled expansion context. Escaping only double quotes leaves
// `$()` and backticks executable when a workspace path is copied verbatim.
const shellQuote = (value) => `'${String(value || '').replaceAll("'", `'"'"'`)}'`;

export const recoveryForKernelError = ({ code, projectRoot, provider = 'codex' } = {}) => {
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
  ].includes(code)) {
    return {
      action: 'reopen-from-correct-worktree',
      command: `moon-harness-switcher launch --track kernel --surface ${surface} --project-root ${shellQuote(projectRoot)} --execute`,
    };
  }
  return null;
};

export const bindingErrorPayload = (error, { projectRoot = process.cwd(), provider = 'codex' } = {}) => {
  const errorCode = error?.code || error?.message || 'host_binding_missing';
  // Public lifecycle responses keep their established minimal shape except
  // for the two operator-recoverable harness bootstrap failures. Cross-scope
  // mismatches intentionally disclose no extra project/workspace context.
  const remediation = ['host_binding_missing', 'wrong_harness', 'host_binding_conflict', 'run_binding_conflict'].includes(errorCode)
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
} = {}) => {
  if (!sessionId || !requestedRunId) fail('host_binding_missing');
  const projectId = currentProject?.projectId || currentProject;
  if (!projectId) fail('run_project_mismatch');
  const binding = stateStore.getActiveRunBinding({
    projectId,
    sessionId,
    runId: requestedRunId,
  });
  if (!binding) {
    const observedScope = stateStore.getActiveRunBindingScope({
      sessionId,
      runId: requestedRunId,
    });
    if (observedScope && observedScope.projectId !== projectId) fail('run_project_mismatch');
    fail('host_binding_missing');
  }
  if (binding.expiresAt && Date.parse(binding.expiresAt) <= Date.now()) fail('binding_expired');
  if (binding.status !== 'active') fail('binding_expired');
  if (binding.runId !== String(requestedRunId)) fail('run_session_mismatch');
  const run = stateStore.getRunMetadata(requestedRunId);
  if (!run) fail('active_run_not_found');
  if (!projectId || run.projectId !== projectId || binding.projectId !== projectId) fail('run_project_mismatch');
  if (binding.sessionId !== String(sessionId)) fail('run_session_mismatch');
  if (binding.accessMode === 'owner' && run.ownerBindingId !== binding.bindingId) fail('run_access_denied');
  const allowed = ACCESS[requiredAccess || command] || ['owner'];
  if (!allowed.includes(binding.accessMode)) fail('run_access_denied');
  const workspaceId = currentWorkspace?.workspaceId || currentWorkspace;
  if (run.workspaceId && binding.workspaceId !== run.workspaceId) fail('run_workspace_mismatch');
  if (workspaceId && binding.workspaceId && workspaceId !== binding.workspaceId) fail('run_workspace_mismatch');
  return { run, binding, projectId, workspaceId: binding.workspaceId, accessMode: binding.accessMode };
};
