import { createHash } from 'node:crypto';

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
const digest = (value: unknown): string => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;

export interface RecoveryObservation {
  projectRoot: string;
  runtimeHome: string;
  runId: string | null;
  workspaceIdentity: string | null;
  workspaceStatus: string;
  changedPaths: string[];
  discoveryStatus: string;
  run?: RecordValue | null;
  ownerSessionId?: string | null;
  ownerBindingActive?: boolean;
  worktreeLeaseOwned?: boolean;
  sessionId?: string | null;
  step?: RecordValue | null;
  observationErrors?: string[];
}

// This is a recovery work description, never a second completion or mutation
// authority. Every retry still enters the native binding/scope/proof gates.
export function buildAgentRecovery({ observation, failure = null, previous = null }: {
  observation: RecoveryObservation;
  failure?: unknown;
  previous?: unknown;
}) {
  const error = record(failure);
  const before = record(previous);
  const code = String(error.errorCode || error.code || error.blockedReason || 'unexpected-runtime-condition').slice(0, 160);
  const run = observation.run || {};
  const step = observation.step || {};
  const allowedPaths = strings(step.allowedPaths);
  const authority = {
    runId: observation.runId,
    projectId: run.projectId || null,
    worktreeId: run.worktreeId || null,
    ownerBindingId: run.ownerBindingId || null,
    contractRevision: run.contractRevision || null,
    planRevision: run.planRevision || null,
    mutationRevision: run.mutationRevision ?? null,
    stepId: step.stepId || null,
    ownerBindingActive: observation.ownerBindingActive === true,
    worktreeLeaseOwned: observation.worktreeLeaseOwned === true,
    allowedPaths,
    forbiddenPaths: strings(step.forbiddenPaths),
  };
  const observed = {
    projectRoot: observation.projectRoot,
    runtimeHome: observation.runtimeHome,
    workspaceIdentity: observation.workspaceIdentity,
    workspaceStatus: observation.workspaceStatus,
    discoveryStatus: observation.discoveryStatus,
    changedPaths: [...observation.changedPaths].sort(),
    runStatus: run.status || null,
    authority,
  };
  const fingerprint = digest({ code, observed });
  const repeats = before.fingerprint === fingerprint
    && record(before.observed).projectRoot === observation.projectRoot
    ? Math.min(3, Math.max(0, Number(before.unchangedAttempts) || 0) + 1) : 0;
  const ownerVerified = Boolean(observation.sessionId
    && observation.ownerBindingActive
    && observation.ownerSessionId === observation.sessionId
    && ['active', 'blocked'].includes(String(run.status)));
  const repairable = ownerVerified && allowedPaths.length > 0
    && observation.worktreeLeaseOwned === true
    && observation.workspaceStatus === 'known'
    && !observation.observationErrors?.length
    && error.recoverable !== false
    && error.blockingClass !== 'safety';
  const mode = repeats >= 3 ? 'escalate' : repairable ? 'repair' : 'inspect';
  const resumeArgs = ['next', ...(observation.runId ? [observation.runId] : []), '--project-root', observation.projectRoot, '--runtime-home', observation.runtimeHome, '--json'];
  return {
    schemaVersion: 1,
    kind: 'agent-recovery',
    errorCode: code,
    mode,
    fingerprint,
    unchangedAttempts: repeats,
    observed,
    authorityVerified: repairable,
    allowedPaths: mode === 'repair' ? allowedPaths : [],
    nextAction: mode === 'escalate' ? 'report-no-progress-blocker' : mode === 'repair' ? 'inspect-repair-revalidate' : 'inspect-authority-and-environment',
    work: [
      'Compare the failure with current Run, worktree, owner binding and file evidence; distinguish harness defects from local environment changes.',
      'Inspect the responsible source, command result and dependencies. Unknown error codes require diagnosis, not a guessed fallback.',
      mode === 'repair' ? 'Repair only within the current work unit scope; use a revised task contract through next if the required repair falls outside it.' : 'Obtain a valid next work unit before mutating project files; do not claim another owner or rewrite accepted history.',
      'Observe again after repair. If authority or scope changed, refresh next before further mutation. Submit the actual changed paths and fresh bound verification through report.',
    ],
    commands: {
      inspect: { command: 'kernel', args: ['next', ...(observation.runId ? [observation.runId] : []), '--diagnose', '--project-root', observation.projectRoot, '--runtime-home', observation.runtimeHome, '--json'] },
      resume: { command: 'kernel', args: resumeArgs, requiresContract: !observation.run?.runId },
    },
    validation: {
      authorityDigest: digest(authority),
      workspaceIdentity: observation.workspaceIdentity,
      required: ['fresh-workspace-observation', 'native-owner-and-scope-admission', 'kernel-executed-bound-proof', 'kernel-final-completion-decision'],
      agentDiagnosisIsProof: false,
    },
    progress: { maximumUnchangedRetries: 3, previousCapsuleIsAuthority: false },
    observationErrors: observation.observationErrors || [],
  };
}
