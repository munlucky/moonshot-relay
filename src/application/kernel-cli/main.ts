import path from 'node:path';
import { resolveKernelRuntimeHome, resolveProjectTrack, ensureAccountRootTrack } from '../../kernel/runtime-home.js';
import { resolveKernelNode } from '../../kernel/runtime-resolver.js';
import { computeKernelSourceIdentity } from '../../kernel/control-plane.js';
import { resolveCanonicalHostSession } from '../../host/kernel/host-session.js';
import { recoveryForKernelError } from '../../kernel/run/binding-preflight.js';
import { discoverRunLocator } from '../../kernel/run/run-locator.js';
import { normalizeTaskContract } from '../../kernel/task/task-contract.js';
import { STATES, type KernelState } from '../../kernel/transition.js';
import { createOpaqueRunId } from '../../kernel/run/run-identity.js';
import { projectKernelModelView } from '../../kernel/run/model-view.js';
import { resolveStableWorkspaceIdentity } from '../../host/kernel/workspace/stable-workspace.js';
import { resolveKernelWorktreeIdentity } from '../../host/kernel/workspace/worktree-resolution.js';
import { diagnoseKernelRecovery } from './recovery.js';


type UnknownRecord = Record<string, unknown>;

interface KernelCliApplicationOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  managedRuntimeHome?: string;
  readJsonFile?: ((file: string) => Promise<unknown>) | null;
  emitOutput?: (value: string) => void;
  emitError?: (value: string) => void;
}

interface TrackScope {
  canonicalRoot?: string | null;
  scopeKey?: string | null;
}

interface TrackResolution {
  track?: string | null;
  source: string;
  scope?: TrackScope | null;
  registryPath?: string | null;
  registered?: boolean;
}

type HostSessionResolution = ReturnType<typeof resolveCanonicalHostSession>;
type KernelStateStore = Awaited<ReturnType<typeof import('../../kernel/state-store.js').openKernelStateStore>>;
type KernelControlPlane = Awaited<ReturnType<typeof import('../../host/kernel/control-plane-runtime.js').createKernelControlPlane>>;
type Invocation = ReturnType<KernelControlPlane['resolveBoundInvocation']> | { mode: 'resume'; runId: string };
type DiagnosticsLike = { schemaVersion?: number; status: string; findings: UnknownRecord[]; counts: Record<string, number> };
type ProjectIdentityLike = Partial<Awaited<ReturnType<typeof import('../../kernel/project-identity-preflight.js').inspectKernelProjectIdentity>>> & { projectId: string; status: string };

const asRecord = (value: unknown): UnknownRecord => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : {}
);

const readKernelState = (value: string): KernelState => {
  if (!STATES.some(state => state === value)) throw new Error('UNKNOWN_STATE: '+value);
  return value as KernelState;
};

const errorRecord = (value: unknown): UnknownRecord => asRecord(value);
const errorMessage = (value: unknown): string => (
  value instanceof Error ? value.message : String(value)
);

export async function runKernelCliApplication(
  argv: string[] = [],
  options: KernelCliApplicationOptions = {},
): Promise<{ exitCode: number }> {
  const cwd = options.cwd ?? '.';
  const env = options.env ?? {};
  const managedRuntimeHome = options.managedRuntimeHome ?? cwd;
  const readJsonFile = options.readJsonFile ?? null;
  const emitOutput = options.emitOutput ?? (() => {});
  const emitError = options.emitError ?? (() => {});
  if (typeof readJsonFile !== 'function') {
    throw Object.assign(
      new Error('kernel_cli_read_json_required'),
      { code: 'kernel_cli_read_json_required' },
    );
  }
  let exitCode = 0;
  const resolvePath = (...segments: string[]) => path.resolve(cwd, ...segments);

const args = [...argv];
const command = args[0] || 'doctor';
const json = args.includes('--json');

if (args.includes('--help') || args.includes('-h') || command === 'help') {
  const help: {
    usage: string;
    commands: Record<string, string>;
    reportExample: UnknownRecord;
    notes: string[];
  } = {
    usage: 'kernel <command> [options]',
    commands: {
      next: 'kernel next [run-id] [--contract-json <file>] [--diagnose [--failure-json <file>] [--previous-recovery-json <file>] [--reconcile-derived-state]] [--project-root <path>] [--json] [--verbose]',
      report: 'kernel report [run-id] --report-json <file> [--project-root <path>] [--json] [--verbose]',
      approve: 'kernel approve [run-id] [--obligation <id>] [--reason <text>] [--approver <name>] [--approval-ref <host-ref>] [--all-judgments] [--json]',
      status: 'kernel status --run-id <id> [--json]',
      context: 'kernel context [--run-id <id>] [--stage <stage>] [--json]',
      finalize: 'kernel finalize [run-id] [--json]',
      resume: 'kernel resume [run-id] [--json]',
      doctor: 'kernel doctor [--project-root <path>] [--json]',
    },
    reportExample: {
      stepId: '<current stepId from next>',
      summary: 'What changed',
      changedPaths: ['src/example.mjs'],
      verifications: [{ obligationId: '<from next>', commandRef: '<allowed command ref>', acceptanceCoverage: ['AC-1'] }],
    },
    notes: [
      'First invocation: next --contract-json <file>. Continue a bound Run with next.',
      'Common binding flags: --project-root <path>, --runtime-home <path>, --session-id <id>, --provider <name>.',
      'next/report default to a compact model view. --verbose returns full diagnostic snapshots.',
      'Help exits before runtime binding, lease acquisition, report submission, or verification.',
      'Unexpected condition: next --diagnose observes authority without acquiring a lease. Host-managed surfaces retain recovery continuity automatically; --previous-recovery-json is only for stateless/manual CLI continuation. Repair within next scope, then resume next/report with fresh proof.',
    ],
  };
  if (json) emitOutput(JSON.stringify(help));
  else if (command !== 'help' && help.commands[command]) emitOutput(`Usage: ${help.commands[command].replace(/^kernel\s+/, '')}`);
  else emitOutput([help.usage, '', 'Commands:', ...Object.entries(help.commands).map(([name, usage]) => `  ${name.padEnd(10)} ${usage.replace(/^kernel\s+[^\s]+\s*/, '')}`), '', ...help.notes, `Report JSON example: ${JSON.stringify(help.reportExample)}`].join('\n'));
  return { exitCode: 0 };
}

const getArgValue = (flag: string): string | null => {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? (args[idx + 1] ?? null) : null;
};

const readJsonObjectFile = async (
  file: string,
  label: string,
): Promise<UnknownRecord> => {
  let parsed: unknown;
  try {
    parsed = await readJsonFile(resolvePath(file));
  } catch (error: unknown) {
    throw new Error(`${label} must be a readable JSON object: ${errorMessage(error)}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} must contain a JSON object`);
  }
  return parsed as UnknownRecord;
};

const readContextJson = async (): Promise<UnknownRecord> => {
  const file = getArgValue('--context-json');
  return file ? readJsonObjectFile(file, 'context-json') : {};
};

const runtimeHomeArg = getArgValue('--runtime-home');
const configuredRuntimeHome = runtimeHomeArg || env.MOON_RELAY_KERNEL_HOME || null;
const projectRoot = getArgValue('--project-root') || cwd;
const positionalRunId = ['next', 'report', 'resume', 'abandon', 'approve'].includes(command)
  && args[1]
  && !args[1].startsWith('--')
  ? args[1]
  : null;
const explicitRunId = getArgValue('--run-id') || positionalRunId || null;
const envRunId = env.MOON_RELAY_KERNEL_RUN_ID || null;
const locatorRunId = explicitRunId || envRunId || null;
const locatorDiscovery = discoverRunLocator({
  runId: locatorRunId,
  projectRoot,
  runtimeHome: configuredRuntimeHome || undefined,
});
// `doctor` and `version` are diagnostic metadata surfaces. `context` is
// a read-only inspection command. When bootstrapping turn 0 with a contract,
// an ambiguous or stale address-book entry must not block immediate execution:
// the control plane will safely issue a fresh Run instead of making an uncertain binding.
const hasContractInput = Boolean(
  getArgValue('--contract-json') || getArgValue('--objective-json')
);
const locatorDiscoveryFailureAllowed = !['doctor', 'version', '--version', 'context'].includes(command)
  && !(command === 'next' && args.includes('--diagnose'))
  && !(command === 'next' && hasContractInput && !explicitRunId);
const isLocatorUnresolved = ['ambiguous', 'stale'].includes(locatorDiscovery.status);
const runtimeBindingDiscoveryError = isLocatorUnresolved
  && locatorDiscoveryFailureAllowed
  ? Object.assign(new Error(
      locatorDiscovery.status === 'stale' ? 'runtime_binding_stale' : 'runtime_binding_ambiguous',
    ), {
      code: locatorDiscovery.status === 'stale' ? 'runtime_binding_stale' : 'runtime_binding_ambiguous',
      errorCode: locatorDiscovery.status === 'stale' ? 'runtime_binding_stale' : 'runtime_binding_ambiguous',
      nextAction: locatorDiscovery.status === 'stale' ? 'repair-runtime-binding' : 'resolve-runtime-binding',
      details: {
        expected: {
          runId: locatorRunId,
          projectRoot,
          locatorStatus: locatorDiscovery.status,
          candidates: locatorDiscovery.candidates,
        },
        provided: {
          runtimeHome: configuredRuntimeHome,
          runId: locatorRunId,
        },
        candidates: locatorDiscovery.candidates,
        recovery: {
          action: locatorDiscovery.status === 'stale' ? 'inspect-run-locator' : 'resume-existing-run',
        },
      },
    })
  : null;
// An explicit CLI path remains the strongest override. A validated account-root
// locator is the next-strongest address: project/worktree discovery must not
// reopen a stale ambient home just because the caller did not know the Run id.
// The SQLite runtime selected below remains authoritative after it opens and
// validates the Run binding.
const discoveredRuntimeHome = locatorDiscovery.status === 'resolved'
  ? locatorDiscovery.runtimeHome
  : null;
const discoveredRunId = locatorDiscovery.status === 'resolved'
  ? locatorDiscovery.locator?.runId || null
  : null;
const effectiveRuntimeHome = runtimeHomeArg
  || discoveredRuntimeHome
  || env.MOON_RELAY_KERNEL_HOME
  || null;
const trackEnv = (): NodeJS.ProcessEnv => ({
  ...kernelEnv,
  ...(effectiveRuntimeHome ? { MOON_RELAY_KERNEL_HOME: effectiveRuntimeHome } : {}),
});
const wrongHarnessError = (resolution: TrackResolution, root: string) => Object.assign(
  new Error(`wrong_harness: Kernel command requires account-root track=kernel (found ${resolution.track || 'none'} from ${resolution.source} for ${root})`),
  {
    code: 'wrong_harness',
    errorCode: 'wrong_harness',
    nextAction: 'reopen-from-correct-worktree',
    details: {
      activeTrack: resolution.track || null,
      source: resolution.source,
      canonicalRoot: resolution.scope?.canonicalRoot || null,
      scopeKey: resolution.scope?.scopeKey || null,
      registryPath: resolution.registryPath || null,
    },
  },
);
const assertKernelTrack = async (root: string = projectRoot): Promise<string | null | undefined> => {
  const resolution = await resolveProjectTrack(root, { env: trackEnv(), allowAccountRootDefault: true });
  if (resolution.track !== 'kernel') throw wrongHarnessError(resolution, root);
  await ensureAccountRootTrack({
    startDir: root,
    track: 'kernel',
    env: trackEnv(),
    projectId: trackEnv().MOON_RELAY_KERNEL_PROJECT_ID || null,
    workspaceId: trackEnv().MOON_RELAY_KERNEL_WORKSPACE_ID || null,
  });
  return resolution.track;
};

// The lease holder must be stable across the separate processes of one model
// session; `--session-id` lets a host pin it explicitly (P0-6).
// Codex Desktop already exports a stable UUID for the current task. Treat it
// as a host-provided binding only when the explicit Kernel variables are
// absent, so direct skill invocations can bootstrap without weakening the
// cross-session/project preflight.
const codexThreadId = env.CODEX_THREAD_ID || null;
const explicitSessionId = getArgValue('--session-id') || null;
const envSessionId = env.MOON_RELAY_KERNEL_SESSION_ID || null;
const preferredSessionId = explicitSessionId || envSessionId || codexThreadId || null;
const scopedSessionProvider = preferredSessionId?.match(/^([a-z][a-z0-9-]{0,31}):/)?.[1] || null;
const hostProvider = getArgValue('--provider')
  || env.MOON_RELAY_KERNEL_PROVIDER
  || scopedSessionProvider
  || (codexThreadId ? 'codex' : 'unknown-host');
let resolvedHostSession: HostSessionResolution = { sessionId: null, nativeSessionId: null, source: null };
let hostSessionResolutionError: unknown = null;
try {
  resolvedHostSession = resolveCanonicalHostSession({
    provider: hostProvider,
    explicitSessionId,
    envSessionId,
    codexThreadId: explicitSessionId ? null : codexThreadId,
  });
} catch (error) {
  hostSessionResolutionError = error;
}
const nativeSessionId = resolvedHostSession.nativeSessionId;
const sessionId = resolvedHostSession.sessionId;
const legacySessionId = nativeSessionId && sessionId !== nativeSessionId && !nativeSessionId.includes(':')
  ? nativeSessionId
  : null;
const hostRunResolutionError = explicitRunId && envRunId && String(explicitRunId) !== String(envRunId)
  ? Object.assign(new Error('run_binding_conflict'), {
      code: 'run_binding_conflict',
      errorCode: 'run_binding_conflict',
      nextAction: 'reopen-from-correct-worktree',
      details: { bindings: [{ source: 'cli', runId: explicitRunId }, { source: 'environment', runId: envRunId }] },
    })
  : null;
// Discovery is an address, not a caller's explicit recovery target. A new
// task must not inherit an automatically discovered predecessor as envRunId.
const startingNewTask = command === 'next' && getArgValue('--invocation-intent') === 'new-task';
const inferredRunId = explicitRunId || envRunId || (startingNewTask ? null : discoveredRunId) || null;
const kernelEnv: NodeJS.ProcessEnv = sessionId || inferredRunId
  ? {
      ...env,
      ...(effectiveRuntimeHome ? { MOON_RELAY_KERNEL_HOME: effectiveRuntimeHome } : {}),
      ...(sessionId ? { MOON_RELAY_KERNEL_SESSION_ID: sessionId } : {}),
      ...(sessionId ? { MOON_RELAY_KERNEL_PROVIDER: hostProvider } : {}),
      ...(legacySessionId ? { MOON_RELAY_KERNEL_LEGACY_SESSION_ID: legacySessionId } : {}),
      ...(inferredRunId ? { MOON_RELAY_KERNEL_RUN_ID: inferredRunId } : {}),
    }
  : effectiveRuntimeHome
    ? { ...env, MOON_RELAY_KERNEL_HOME: effectiveRuntimeHome }
    : env;

const openControlPlane = async (): Promise<KernelControlPlane> => {
  await assertKernelTrack();
  const moduleValue = await import('../../host/kernel/control-plane-runtime.js');
  const { createKernelControlPlane } = moduleValue;
  return createKernelControlPlane({
    runtimeHome: effectiveRuntimeHome || undefined,
    projectRoot,
    env: kernelEnv,
    requireHostBinding: false,
  });
};

const output = (rawValue: unknown): void => {
  const payload = asRecord(rawValue);
  const failureStatuses = ['error', 'blocked', 'contract-rejected', 'evidence-rejected'];
  let enriched = rawValue;
  if (['next', 'report'].includes(command) && asRecord(payload.recovery).kind !== 'agent-recovery' && failureStatuses.includes(String(payload.status))) {
    try {
      enriched = { ...payload, ...(payload.recovery ? { bindingRecovery: payload.recovery } : {}), recovery: diagnoseKernelRecovery({ projectRoot, runtimeHome: effectiveRuntimeHome || resolveKernelRuntimeHome({ env }),
        runId: String(payload.runId || inferredRunId || '') || null, sessionId, failure: payload, env }).recovery };
    } catch { /* Original rejection remains authoritative when observation fails. */ }
  }
  const value = ['next', 'report'].includes(command)
    ? projectKernelModelView(asRecord(enriched), { verbose: args.includes('--verbose') }) : enriched;
  emitOutput(
    json ? JSON.stringify(value) : value !== null && typeof value === 'object' ? Object.entries(value).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join('\n') : String(value)
  );
};

try {
  if (command === 'next' && args.includes('--diagnose')) {
    if (args.includes('--reconcile-derived-state')) await assertKernelTrack();
    const failureFile = getArgValue('--failure-json');
    const previousFile = getArgValue('--previous-recovery-json');
    const failurePayload = failureFile ? await readJsonObjectFile(failureFile, 'failure-json') : runtimeBindingDiscoveryError;
    const embeddedRecovery = asRecord(asRecord(failurePayload).recovery);
    const previousPayload = previousFile
      ? await readJsonObjectFile(previousFile, 'previous-recovery-json')
      : embeddedRecovery.kind === 'agent-recovery'
        ? embeddedRecovery
        : null;
    output(diagnoseKernelRecovery({ projectRoot, runtimeHome: effectiveRuntimeHome || resolveKernelRuntimeHome({ env }),
      runId: explicitRunId || envRunId, sessionId: hostSessionResolutionError ? null : sessionId,
      failure: failurePayload,
      previous: previousPayload?.recovery || previousPayload,
      reconcile: args.includes('--reconcile-derived-state'), env }));
    return { exitCode: 0 };
  }
  if (runtimeBindingDiscoveryError) throw runtimeBindingDiscoveryError;
  if (hostSessionResolutionError) throw hostSessionResolutionError;
  if (hostRunResolutionError) throw hostRunResolutionError;
  if (command === 'mcp-bridge') {
    const moduleValue = await import('../../kernel/bridge/mcp.js');
    const { startMcpBridgeServer } = moduleValue;
    startMcpBridgeServer({ runtimeHome: effectiveRuntimeHome || undefined, env: kernelEnv });
  } else if (command === '--version' || command === 'version') {
    output({ productId: 'moon-relay-kernel', version: '0.1.0' });
  } else if (command === 'doctor') {
    const runtimeHome = runtimeHomeArg || resolveKernelRuntimeHome({ env: trackEnv() });
    const trackResolution = await resolveProjectTrack(projectRoot, { env: trackEnv(), allowAccountRootDefault: true });
    const activeTrack = trackResolution.track;
    if (activeTrack !== 'kernel') {
      output({ productId: 'moon-relay-kernel', runtimeHome, activeTrack, trackSource: trackResolution.source, scope: trackResolution.scope, status: 'wrong_harness' });
    } else {
      let store: KernelStateStore | null = null;
      let diagnostics: DiagnosticsLike = {
        status: 'degraded',
        findings: [],
        counts: {},
      };
      let projectIdentity: ProjectIdentityLike = {
        projectId: '',
        status: 'unknown',
      };
      let resume: unknown = null;
      try {
        const stateStoreModule = await import('../../kernel/state-store.js');
        const identityModule = await import('../../kernel/project-identity-preflight.js');
        const projectorModule = await import('../../kernel/state-projector.js');
        const { openKernelStateStore } = stateStoreModule;
        const { inspectKernelProjectIdentity } = identityModule;
        const { buildResumeView } = projectorModule;
        projectIdentity = await inspectKernelProjectIdentity({ projectRoot, runtimeHome, env: kernelEnv });
        store = await openKernelStateStore({ runtimeHome });
        diagnostics = store.diagnoseLifecycleState({
          projectId: projectIdentity.projectId,
        });
        const currentWorktree = resolveKernelWorktreeIdentity({ cwd: projectRoot, workspaceRoot: projectRoot });
        const worktreeLease = currentWorktree.worktreeId && typeof store.getWorktreeMutationLease === 'function'
          ? store.getWorktreeMutationLease(currentWorktree.worktreeId)
          : null;
        const mutableRuns = store.listRuns({
          projectId: projectIdentity.projectId,
          ...(currentWorktree.worktreeId ? { worktreeId: currentWorktree.worktreeId } : {}),
          statuses: ['active', 'blocked'],
        }).filter((run) => run.status === 'active'
          || worktreeLease?.holderRunId === run.runId);
        if (mutableRuns.length === 1) {
          const run = mutableRuns[0];
          if (!run) throw new Error('Mutable run selection is empty');
          const steps = typeof store.getRunSteps === 'function'
            ? store.getRunSteps(run.runId, { planRevision: run.planRevision })
            : [];
          const step = steps.find((entry) => ['active', 'ready'].includes(String(entry.state || '')))
            || steps.find((entry) => entry.state !== 'passed')
            || null;
          const context = store.getKnowledgeContextReceipt(run.runId, run.state)?.receiptJson
            || store.getKnowledgeContextReceipt(run.runId, 'FRAME')?.receiptJson
            || null;
          resume = buildResumeView({
            run,
            step,
            verifications: store.getVerifications(run.runId),
            obligations: store.getRunObligations(run.runId),
            reviews: store.listReviewReceipts(run.runId),
            completionDecision: store.getCompletionDecision(run.runId),
            finalizationReceipt: store.getFinalizationReceipt(run.runId),
            gitCloseout: store.getGitCloseoutReceipt(run.runId),
            routeDecisions: store.listModelRouteDecisions(run.runId),
            usageReceipts: store.listModelUsageReceipts(run.runId),
            context,
          });
        } else if (mutableRuns.length > 1) {
          resume = {
            schemaVersion: 1,
            status: 'ambiguous',
            candidates: mutableRuns.map((run) => ({
              runId: run.runId,
              status: run.status,
              state: run.state,
              updatedAt: run.updatedAt,
              worktreeId: run.worktreeId || null,
              workspaceId: run.workspaceId || null,
            })),
            recovery: { action: 'resume-existing-run' },
          };
        } else {
          resume = {
            schemaVersion: 1,
            status: 'not-found',
            candidates: [],
            recovery: { action: 'supply-a-task-contract' },
          };
        }
        if (projectIdentity.status === 'repair_required') {
          diagnostics.findings.push({
            code: 'project_identity_preflight_required',
            severity: projectIdentity.status === 'repair_required' ? 'error' : 'warning',
            status: projectIdentity.status,
            projectId: projectIdentity.projectId,
            canonicalRoot: projectIdentity.canonicalRoot,
            unresolvedLegacyCandidates: projectIdentity.unresolvedLegacyCandidates,
            remediation: projectIdentity.remediation,
          });
          diagnostics.counts.project_identity_preflight_required = (diagnostics.counts.project_identity_preflight_required || 0) + 1;
          if (projectIdentity.status === 'repair_required') diagnostics.status = 'degraded';
        }
      } catch (error: unknown) {
        const message = errorMessage(error);
        const ambiguous = message.includes('UNIQUE constraint failed');
        diagnostics = {
          schemaVersion: 1,
          status: 'degraded',
          findings: [{
            code: ambiguous ? 'ambiguous_session_binding' : 'kernel_state_unavailable',
            severity: 'error',
            message,
          }],
          counts: { [ambiguous ? 'ambiguous_session_binding' : 'kernel_state_unavailable']: 1 },
        };
      } finally {
        store?.close();
      }
      output({
        productId: 'moon-relay-kernel',
        runtimeHome,
        activeTrack,
        trackSource: trackResolution.source,
        trackScope: trackResolution.scope,
        accountRootTrack: {
          status: trackResolution.registered ? 'registered' : 'registration_required',
          path: trackResolution.registryPath || null,
        },
        status: diagnostics.status,
        diagnostics,
        projectIdentity,
        resume,
      });
    }
  } else if (command === 'identity') {
    await assertKernelTrack(projectRoot);
    const runtimeHome = resolveKernelRuntimeHome({ env: trackEnv() });
    const subcommand = args[1] && !args[1].startsWith('--') ? args[1] : 'status';
    const identityArgs = {
      projectRoot,
      runtimeHome,
      env: kernelEnv,
      resolveStableWorkspaceIdentity,
    };
    const identityModulePromise = import('../../kernel/project-identity-preflight.js');
    if (subcommand === 'status') {
      const { inspectKernelProjectIdentity } = await identityModulePromise;
      output(await inspectKernelProjectIdentity(identityArgs));
    } else if (subcommand === 'bootstrap') {
      const { bootstrapKernelProjectIdentity } = await identityModulePromise;
      output(await bootstrapKernelProjectIdentity({
        ...identityArgs,
        policy: getArgValue('--policy') || 'isolate',
      }));
    } else if (subcommand === 'approve') {
      const { approveKernelProjectIdentityRepair } = await identityModulePromise;
      output(await approveKernelProjectIdentityRepair({
        ...identityArgs,
        legacyProjectId: getArgValue('--legacy-project-id'),
        approvalRef: getArgValue('--approval-ref'),
        approvedBy: getArgValue('--approved-by'),
      }));
    } else if (subcommand === 'repair') {
      const { repairKernelProjectIdentity } = await identityModulePromise;
      output(await repairKernelProjectIdentity({
        ...identityArgs,
        legacyProjectId: getArgValue('--legacy-project-id'),
        approvalRef: getArgValue('--approval-ref'),
      }));
    } else {
      throw new Error(`Unknown identity subcommand: ${subcommand}`);
    }
  } else if (command === 'assert-track') {
    const runtimeHome = resolveKernelRuntimeHome({ env: trackEnv() });
    const projectOnly = args.includes('--project-only');
    const trackResolution = await resolveProjectTrack(projectRoot, { env: trackEnv(), allowAccountRootDefault: !projectOnly });
    const activeTrack = trackResolution.track;
    const isReady = activeTrack === 'kernel';
    const allowNonKernel = args.includes('--allow-non-kernel');
    output({ productId: 'moon-relay-kernel', runtimeHome, activeTrack, trackSource: trackResolution.source, trackScope: trackResolution.scope, status: isReady ? 'ready' : 'wrong_harness', blocking: !isReady && !allowNonKernel });
    if (!isReady && !allowNonKernel) {
      exitCode = 1;
    }
  } else if (command === 'resolve-runtime') {
    output(await resolveKernelNode({ runtimeHome: managedRuntimeHome }));
  } else if (command === 'package') {
    const trackResolution = await resolveProjectTrack(cwd, { env: trackEnv(), allowAccountRootDefault: true });
    const activeTrack = trackResolution.track;
    if (activeTrack !== 'kernel') {
      output({ productId: 'moon-relay-kernel', activeTrack, trackSource: trackResolution.source, status: 'wrong_harness', message: 'package command requires account-root track to be kernel' });
      exitCode = 1;
    } else {
      await ensureAccountRootTrack({ startDir: cwd, track: 'kernel', env: trackEnv() });
      const { materializeKernelPackage } = await import('../../kernel/package-build.js');
      const outputRoot = getArgValue('--output') ?? `${cwd}/dist/moon-relay-kernel`;
      output(await materializeKernelPackage({ sourceRoot: cwd, outputRoot, dryRun: args.includes('--dry-run') }));
    }
  } else if (command === 'install') {
    const { installKernel } = await import('../../kernel/installer.js');
    const targetRoot = getArgValue('--target-root') || cwd;
    const resolvedRuntimeHome = resolveKernelRuntimeHome({ env });
    output(await installKernel({
      targetRoot,
      sourceRoot: getArgValue('--source-root') || cwd,
      runtimeSource: getArgValue('--runtime-source'),
      trackHome: getArgValue('--track-home') || (resolvePath(targetRoot) === resolvePath(resolvedRuntimeHome) ? resolvedRuntimeHome : null),
      replaceModified: args.includes('--sync'),
    }));
  } else if (command === 'profile-install') {
    const profileInstallModule = import('../../kernel/profile-install.js');
    const { installKernelAccountRoot } = await profileInstallModule;
    const { installKernelProfile } = await profileInstallModule;
    const runtime = getArgValue('--runtime-name') || getArgValue('--runtime') || undefined;
    const targetRoot = getArgValue('--target-root') || cwd;
    const sourceRoot = getArgValue('--source-root') || cwd;
    output(await (args.includes('--account-root')
      ? installKernelAccountRoot({ runtime, targetRoot, sourceRoot, runtimeHome: getArgValue('--runtime-home') || undefined, force: args.includes('--sync'), preserveUnmanagedSkills: args.includes('--preserve-unmanaged-skills') })
      : installKernelProfile({ runtime, targetRoot, sourceRoot, skillsRoot: getArgValue('--skills-root'), runtimeHome: getArgValue('--runtime-home') || undefined, force: args.includes('--sync') })));
  } else if (command === 'profile-doctor') {
    const { doctorKernelProfile } = await import('../../kernel/profile-doctor.js');
    output(await doctorKernelProfile({
      targetRoot: getArgValue('--target-root') || cwd,
      runtime: getArgValue('--runtime-name') || getArgValue('--runtime'),
      runtimeHome: getArgValue('--runtime-home') || resolveKernelRuntimeHome({ env }),
    }));
  } else if (command === 'profile-uninstall') {
    const { uninstallKernelProfile } = await import('../../kernel/profile-install.js');
    output(await uninstallKernelProfile({ targetRoot: getArgValue('--target-root') || cwd }));
  } else if (command === 'profile-rollback') {
    const { rollbackKernelProfile } = await import('../../kernel/profile-install.js');
    output(await rollbackKernelProfile({ targetRoot: getArgValue('--target-root') || cwd, backupPath: getArgValue('--backup') }));
  } else if (command === 'uninstall') {
    const targetRoot = getArgValue('--target-root') || cwd;
    await assertKernelTrack(targetRoot);
    const { uninstallKernel } = await import('../../kernel/installer.js');
    output(await uninstallKernel({ targetRoot }));
  } else if (command === 'next') {
    // Model-visible runtime command 1 of 2. When the host supplies a task
    // contract, `next` bootstraps the run idempotently so the model never
    // needs a separate `start` command (P0-1).
    const cp = await openControlPlane();
    const positionalRunId = args[1] && !args[1].startsWith('--') ? args[1] : null;
    const contractFile = getArgValue('--contract-json') || getArgValue('--objective-json');
    const explicitRunId = getArgValue('--run-id') || positionalRunId;
    const isLocatorUnresolved = ['ambiguous', 'stale'].includes(locatorDiscovery.status);
    const invocationIntent = getArgValue('--invocation-intent')
      || (isLocatorUnresolved ? 'new-task' : null);
    const taskContract: UnknownRecord | null = contractFile
      ? await readJsonObjectFile(contractFile, 'contract-json')
      : null;
    let invocation: Invocation | null = null;
    let res: unknown = null;
    try {
      if (contractFile) {
        if (isLocatorUnresolved && !explicitRunId) {
          const candidateRunIds = new Set((locatorDiscovery.candidates || []).map((c) => c.runId).filter(Boolean));
          let freshId = createOpaqueRunId();
          while (candidateRunIds.has(freshId)) {
            freshId = createOpaqueRunId();
          }
          invocation = {
            mode: 'create',
            runId: freshId,
            predecessorRunId: null,
            binding: null,
            reason: `locator-${locatorDiscovery.status}-fresh-run`,
            taskContract: normalizeTaskContract(taskContract || {}),
            changeClass: null,
          };
        } else {
          invocation = cp.resolveBoundInvocation({
            explicitRunId,
            envRunId: isLocatorUnresolved ? null : (kernelEnv.MOON_RELAY_KERNEL_RUN_ID || null),
            taskContract,
            invocationIntent,
          });
        }
      } else {
        const runId = await cp.resolveRunId({
          explicitRunId,
          envRunId: kernelEnv.MOON_RELAY_KERNEL_RUN_ID || null,
        });
        invocation = { mode: 'resume', runId };
      }
    } catch (err: unknown) {
      const failure = errorRecord(err);
      const details = asRecord(failure.details);
      const holders = Array.isArray(details.holders)
        ? details.holders.map(asRecord)
        : [];
      const mutableRuns = Array.isArray(details.mutableRuns)
        ? details.mutableRuns.map(asRecord)
        : [];
      if (failure.code === 'worktree_run_conflict') {
        const activeRunId = details.holderRunId
          || holders[0]?.runId
          || mutableRuns[0]?.runId
          || null;
        res = {
          schemaVersion: 1,
          status: 'read-only',
          activeWriterRunId: activeRunId,
          action: {
            type: 'analysis',
            mode: 'read-only',
            guidance: 'Another active session is modifying this worktree. This session is in read-only analysis mode. To perform independent mutations concurrently, create and checkout a separate Git worktree (git worktree add).',
          },
        };
      } else {
        throw err;
      }
    }

    if (!res) {
      if (!invocation) {
        throw new Error('invocation_resolution_failed');
      }
      if (contractFile) {
        if (!taskContract) {
          throw new Error('contract-json must contain a JSON object');
        }
        if (invocation.mode === 'successor') {
          const successor = await cp.startSuccessor({
            invocation,
            objective: typeof taskContract.objective === 'string' ? taskContract.objective : undefined,
            taskContract,
          });
          res = successor.next;
        } else if (invocation.mode === 'finalization-retry') {
          throw Object.assign(new Error('finalization_incomplete'), {
            code: 'finalization_incomplete',
            errorCode: 'finalization_incomplete',
            nextAction: 'retry-finalization',
            runId: invocation.runId,
          });
        } else if (invocation.mode === 'done') {
          res = await cp.next(invocation.runId);
        } else {
          const ensured = await cp.ensureRun({
            runId: invocation.runId,
            objective: typeof taskContract.objective === 'string' ? taskContract.objective : undefined,
            taskContract,
          });
          res = ensured.next;
        }
      } else {
        // ensureRun performs the host lifecycle re-entry needed after a
        // blocker report deactivates the owner binding. Calling next directly
        // here would turn the original blocker into host_binding_missing.
        res = (await cp.ensureRun({ runId: invocation.runId })).next;
      }
    }
    await cp.close();
    output(res);
  } else if (command === 'report') {
    // Model-visible runtime command 2 of 2.
    const cp = await openControlPlane();
    const positionalRunId = args[1] && !args[1].startsWith('--') ? args[1] : null;
    const runId = await cp.resolveRunId({
      explicitRunId: getArgValue('--run-id') || positionalRunId,
      envRunId: kernelEnv.MOON_RELAY_KERNEL_RUN_ID || null,
    });
    const reportFile = getArgValue('--report-json') || getArgValue('--context-json');
    let payload: UnknownRecord = {};
    if (reportFile) {
      payload = await readJsonObjectFile(reportFile, 'report-json');
    }
    const res = await cp.report(runId, payload);
    await cp.close();
    output(res);
  } else if (command === 'approve') {
    const cp = await openControlPlane();
    const positionalRunId = args[1] && !args[1].startsWith('--') ? args[1] : null;
    const runId = await cp.resolveRunId({
      explicitRunId: getArgValue('--run-id') || positionalRunId,
      envRunId: kernelEnv.MOON_RELAY_KERNEL_RUN_ID || null,
    });
    const obligationId = getArgValue('--obligation') || 'security-review';
    const reason = getArgValue('--reason') || 'Operator approved via kernel approve CLI';
    const approver = getArgValue('--approver') || env.USERNAME || env.USER || 'operator';
    const approvalRef = getArgValue('--approval-ref') || kernelEnv.MOON_RELAY_KERNEL_OPERATOR_APPROVAL_REF || null;
    const allJudgments = args.includes('--all-judgments') || args.includes('--all') || obligationId === 'all';
    const noFinalize = args.includes('--no-finalize');

    const res = await cp.approveObligation({
      runId,
      obligationId,
      approver,
      reason,
      approvalRef,
      allJudgments,
      autoFinalize: !noFinalize,
    });
    await cp.close();
    output(res);
  } else if (command === 'start-run') {
    // Commands below this point are internal/debug surface; models use only
    // `next` and `report`.
    const cp = await openControlPlane();
    const runId = getArgValue('--run-id') || `run-${Date.now()}`;
    const objective = getArgValue('--objective') || 'Kernel execution task';
    const sourceIdentity = computeKernelSourceIdentity({ projectRoot, objective });
    const run = await cp.startRun({ runId, objective, sourceIdentity });
    await cp.close();
    output(run);
  } else if (command === 'status') {
    const cp = await openControlPlane();
    const runId = getArgValue('--run-id');
    if (!runId) throw new Error('status command requires --run-id');
    const res = await cp.status(runId);
    await cp.close();
    output(res || { status: 'not_found' });
  } else if (command === 'context') {
    const cp = await openControlPlane();
    const positionalRunId = args[1] && !args[1].startsWith('--') ? args[1] : null;
    const runId = getArgValue('--run-id') || positionalRunId || inferredRunId;
    if (runId) {
      const input = await readContextJson();
      const res = await cp.buildStageContext(runId, { ...input, stage: getArgValue('--stage') || (typeof input.stage === 'string' ? input.stage : null) || 'EXECUTE' });
      await cp.close();
      output(res);
    } else {
      const { buildProjectKnowledgeContext } = await import('../../kernel/knowledge/context-load.js');
      const { inspectKernelProjectIdentity } = await import('../../kernel/project-identity-preflight.js');
      const projectIdentity = await inspectKernelProjectIdentity({
        projectRoot,
        runtimeHome: effectiveRuntimeHome || undefined,
        env: kernelEnv,
      });
      const stage = getArgValue('--stage') || 'FRAME';
      const res = await buildProjectKnowledgeContext({
        projectId: projectIdentity.projectId,
        stage,
        runId: 'bootstrap-context',
        projectRoot,
        stateStore: cp.stateStore,
        env: { MOON_RELAY_KERNEL_HOME: effectiveRuntimeHome || undefined },
      });
      await cp.close();
      output(res);
    }
  } else if (command === 'transition') {
    const cp = await openControlPlane();
    const runId = getArgValue('--run-id');
    const nextState = getArgValue('--state');
    if (!runId || !nextState) throw new Error('transition requires --run-id and --state');
    const res = await cp.transition(runId, readKernelState(nextState));
    await cp.close();
    output(res);
  } else if (command === 'prove') {
    const cp = await openControlPlane();
    const runId = getArgValue('--run-id');
    if (!runId) throw new Error('prove command requires --run-id');
    const res = await cp.recordProof(runId, {
      obligationId: getArgValue('--obligation') || 'default',
      status: getArgValue('--status') || 'passed',
      evidenceRef: getArgValue('--evidence-ref'),
      command: getArgValue('--command') || '',
      evidenceDigest: getArgValue('--evidence-digest') || '',
      exitCode: Number(getArgValue('--exit-code') || 0),
    });
    await cp.close();
    output(res);
  } else if (command === 'close') {
    throw new Error('DEPRECATED_COMMAND: close cannot finalize a Kernel run. Use finalize.');
  } else if (command === 'abandon') {
    const cp = await openControlPlane();
    const positionalRunId = args[1] && !args[1].startsWith('--') ? args[1] : null;
    const runId = getArgValue('--run-id') || positionalRunId || await cp.resolveRunId();
    const reason = getArgValue('--reason') || 'user_requested';
    const res = await cp.abandon(runId, { reason });
    await cp.close();
    output(res);
  } else if (command === 'resume') {
    const cp = await openControlPlane();
    const runId = getArgValue('--run-id') || args[1];
    if (!runId || runId.startsWith('--')) throw new Error('resume command requires a run id: kernel resume <run-id>');
    const res = await cp.resume(runId);
    await cp.close();
    output(res || { status: 'not_found' });
  } else if (command === 'finalize') {
    const cp = await openControlPlane();
    const runId = getArgValue('--run-id');
    if (!runId) throw new Error('finalize command requires --run-id');
    const input = await readContextJson();
    const res = await cp.finalizeRun(runId, {
      gitCloseoutRequest: input.gitCloseoutRequest ? asRecord(input.gitCloseoutRequest) : null,
      changedPaths: Array.isArray(input.changedPaths) ? input.changedPaths.filter((v): v is string => typeof v === 'string') : [],
      changedFileCount: typeof input.changedFileCount === 'number' ? input.changedFileCount : null,
      knowledgeObservations: Array.isArray(input.knowledgeObservations) ? input.knowledgeObservations : [],
      approvals: Array.isArray(input.approvals) ? input.approvals : [],
    });
    await cp.close();
    output(res);
  } else if (command === 'finalization-status') {
    const cp = await openControlPlane();
    const runId = getArgValue('--run-id');
    if (!runId) throw new Error('finalization-status command requires --run-id');
    const store = await (await import('../../kernel/state-store.js')).openKernelStateStore({ runtimeHome: effectiveRuntimeHome || undefined });
    const res = store.getFinalizationReceipt(runId);
    await cp.close();
    output(res || { status: 'not_found' });
  } else if (command === 'git-closeout') {
    const cp = await openControlPlane();
    const runId = getArgValue('--run-id');
    if (!runId) throw new Error('git-closeout command requires --run-id');
    const res = await cp.retryGitCloseout(runId);
    await cp.close();
    output(res);
  } else {
    throw new Error(`Unknown command: ${command}`);
  }
} catch (error: unknown) {
  const failure = errorRecord(error);
  const details = asRecord(failure.details);
  const message = errorMessage(error);
  const errorCode = String(failure.errorCode || failure.code || message);
  const remediation = details.remediation || recoveryForKernelError({
    code: errorCode,
    projectRoot,
    provider: hostProvider,
  });
  const diagnosticKeys = [
    'legacyProjectId', 'source', 'canonicalRoot', 'legacyCanonicalRoot', 'gitCommonDir',
    'aliases', 'projectIds', 'projectId', 'nextAction', 'remediation',
  ];
  const diagnostics: UnknownRecord = {
    ...details,
    ...(remediation ? { remediation } : {}),
    ...Object.fromEntries(
      diagnosticKeys
        .filter((key) => failure[key] !== undefined)
        .map((key) => [key, failure[key]]),
    ),
  };
  let recovery: unknown = null;
  try {
    recovery = diagnoseKernelRecovery({ projectRoot, runtimeHome: effectiveRuntimeHome || resolveKernelRuntimeHome({ env }),
      runId: String(failure.runId || inferredRunId || '') || null, sessionId,
      failure: { ...failure, ...details, errorCode }, env }).recovery;
  } catch { /* Never replace the primary failure with a secondary observer error. */ }
  emitError(json ? JSON.stringify({
    schemaVersion: 1,
    status: 'error',
    errorCode,
    message,
    ...(failure.nextAction ? { nextAction: failure.nextAction } : {}),
    ...(failure.runId ? { runId: failure.runId } : {}),
    ...(Object.keys(diagnostics).length ? { diagnostics } : {}),
    ...(recovery ? { recovery } : {}),
  }) : message);
  exitCode = 1;
}
  return { exitCode };
}
