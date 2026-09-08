#!/usr/bin/env node
import process from 'node:process';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveKernelRuntimeHome, resolveProjectTrack, ensureAccountRootTrack } from '../scripts/kernel/runtime-home.mjs';
import { resolveKernelNode } from '../scripts/kernel/runtime-resolver.mjs';
import { computeKernelSourceIdentity } from '../scripts/kernel/control-plane.mjs';
import { resolveCanonicalHostSession } from '../scripts/kernel/run/host-session.mjs';
import { recoveryForKernelError } from '../scripts/kernel/run/binding-preflight.mjs';
import { discoverRunLocator } from '../scripts/kernel/run/run-locator.mjs';
import { createOpaqueRunId } from '../scripts/kernel/run/run-identity.mjs';
import { projectKernelModelView } from '../scripts/kernel/run/model-view.mjs';

const args = process.argv.slice(2);
const command = args[0] || 'doctor';
const json = args.includes('--json');

if (args.includes('--help') || args.includes('-h') || command === 'help') {
  const help = {
    usage: 'kernel <command> [options]',
    commands: {
      next: 'kernel next [run-id] [--contract-json <file>] [--project-root <path>] [--json] [--verbose]',
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
    ],
  };
  if (json) console.log(JSON.stringify(help));
  else if (command !== 'help' && help.commands[command]) console.log(`Usage: ${help.commands[command].replace(/^kernel\s+/, '')}`);
  else console.log([help.usage, '', 'Commands:', ...Object.entries(help.commands).map(([name, usage]) => `  ${name.padEnd(10)} ${usage.replace(/^kernel\s+[^\s]+\s*/, '')}`), '', ...help.notes, `Report JSON example: ${JSON.stringify(help.reportExample)}`].join('\n'));
  process.exit(0);
}

const getArgValue = (flag) => {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : null;
};

const readContextJson = () => {
  const file = getArgValue('--context-json');
  if (!file) return {};
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path.resolve(file), 'utf8'));
  } catch (error) {
    throw new Error(`context-json must be a readable JSON object: ${error.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('context-json must contain a JSON object');
  return parsed;
};

const installedPayloadRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const managedRuntimeHome = getArgValue('--managed-runtime-home') || installedPayloadRoot;

// Managed Node Bootstrap Re-Exec (R3.2)
if (!process.env.MOON_RELAY_KERNEL_REEXEC) {
  let runtimeInfo;
  try {
    runtimeInfo = await resolveKernelNode({ runtimeHome: managedRuntimeHome });
  } catch {
    runtimeInfo = null;
  }
  if (runtimeInfo?.source === 'managed' && runtimeInfo.nodePath && runtimeInfo.nodePath !== process.execPath) {
    const env = { ...process.env, MOON_RELAY_KERNEL_REEXEC: '1' };
    const child = spawnSync(runtimeInfo.nodePath, process.argv.slice(1), { env, stdio: 'inherit' });
    if (child.error) throw child.error;
    const signalExitCodes = { SIGINT: 130, SIGTERM: 143, SIGKILL: 137 };
    process.exit(child.signal ? (signalExitCodes[child.signal] || 1) : (child.status ?? 1));
  }
}

const runtimeHomeArg = getArgValue('--runtime-home');
const configuredRuntimeHome = runtimeHomeArg || process.env.MOON_RELAY_KERNEL_HOME || null;
const projectRoot = getArgValue('--project-root') || process.cwd();
const positionalRunId = ['next', 'report', 'resume', 'abandon', 'approve'].includes(command)
  && args[1]
  && !args[1].startsWith('--')
  ? args[1]
  : null;
const explicitRunId = getArgValue('--run-id') || positionalRunId || null;
const envRunId = process.env.MOON_RELAY_KERNEL_RUN_ID || null;
const locatorRunId = explicitRunId || envRunId || null;
const locatorDiscovery = discoverRunLocator({
  runId: locatorRunId,
  projectRoot,
  runtimeHome: configuredRuntimeHome,
});
// `doctor` and `version` are diagnostic metadata surfaces. `context` is
// a read-only inspection command. When bootstrapping turn 0 with a contract,
// an ambiguous or stale address-book entry must not block immediate execution:
// the control plane will safely issue a fresh Run instead of making an uncertain binding.
const hasContractInput = Boolean(
  getArgValue('--contract-json') || getArgValue('--objective-json')
);
const locatorDiscoveryFailureAllowed = !['doctor', 'version', '--version', 'context'].includes(command)
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
  || process.env.MOON_RELAY_KERNEL_HOME
  || null;
const trackEnv = () => ({
  ...kernelEnv,
  ...(effectiveRuntimeHome ? { MOON_RELAY_KERNEL_HOME: effectiveRuntimeHome } : {}),
});
const wrongHarnessError = (resolution, root) => Object.assign(
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
const assertKernelTrack = async (root = projectRoot) => {
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
const codexThreadId = process.env.CODEX_THREAD_ID || null;
const explicitSessionId = getArgValue('--session-id') || null;
const envSessionId = process.env.MOON_RELAY_KERNEL_SESSION_ID || null;
const preferredSessionId = explicitSessionId || envSessionId || codexThreadId || null;
const scopedSessionProvider = preferredSessionId?.match(/^([a-z][a-z0-9-]{0,31}):/)?.[1] || null;
const hostProvider = getArgValue('--provider')
  || process.env.MOON_RELAY_KERNEL_PROVIDER
  || scopedSessionProvider
  || (codexThreadId ? 'codex' : 'unknown-host');
let resolvedHostSession = { sessionId: null, nativeSessionId: null, source: null };
let hostSessionResolutionError = null;
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
const inferredRunId = explicitRunId || envRunId || discoveredRunId || null;
const kernelEnv = sessionId || inferredRunId
  ? {
      ...process.env,
      ...(effectiveRuntimeHome ? { MOON_RELAY_KERNEL_HOME: effectiveRuntimeHome } : {}),
      ...(sessionId ? { MOON_RELAY_KERNEL_SESSION_ID: sessionId } : {}),
      ...(sessionId ? { MOON_RELAY_KERNEL_PROVIDER: hostProvider } : {}),
      ...(legacySessionId ? { MOON_RELAY_KERNEL_LEGACY_SESSION_ID: legacySessionId } : {}),
      ...(inferredRunId ? { MOON_RELAY_KERNEL_RUN_ID: inferredRunId } : {}),
    }
  : effectiveRuntimeHome
    ? { ...process.env, MOON_RELAY_KERNEL_HOME: effectiveRuntimeHome }
    : process.env;

const openControlPlane = async () => {
  await assertKernelTrack();
  const { createKernelControlPlane } = await import('../scripts/kernel/control-plane.mjs');
  return createKernelControlPlane({
    runtimeHome: effectiveRuntimeHome || undefined,
    projectRoot,
    env: kernelEnv,
    requireHostBinding: false,
  });
};

const output = (rawValue) => {
  const value = ['next', 'report'].includes(command)
    ? projectKernelModelView(rawValue, { verbose: args.includes('--verbose') })
    : rawValue;
  console.log(
    json ? JSON.stringify(value) : typeof value === 'object' ? Object.entries(value).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join('\n') : String(value)
  );
};

try {
  if (runtimeBindingDiscoveryError) throw runtimeBindingDiscoveryError;
  if (hostSessionResolutionError) throw hostSessionResolutionError;
  if (hostRunResolutionError) throw hostRunResolutionError;
  if (command === 'mcp-bridge') {
    const { startMcpBridgeServer } = await import('../scripts/kernel/bridge/mcp.mjs');
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
      let store;
      let diagnostics;
      let projectIdentity;
      let resume = null;
      try {
        const { openKernelStateStore } = await import('../scripts/kernel/state-store.mjs');
        const { inspectKernelProjectIdentity } = await import('../scripts/kernel/project-identity-preflight.mjs');
        const { resolveKernelWorktreeIdentity } = await import('../scripts/kernel/run/worktree-binding.mjs');
        const { buildResumeView } = await import('../scripts/kernel/state-projector.mjs');
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
          const steps = typeof store.getRunSteps === 'function'
            ? store.getRunSteps(run.runId, { planRevision: run.planRevision })
            : [];
          const step = steps.find((entry) => ['active', 'ready'].includes(entry.state))
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
      } catch (error) {
        const ambiguous = String(error?.message || '').includes('UNIQUE constraint failed');
        diagnostics = {
          schemaVersion: 1,
          status: 'degraded',
          findings: [{
            code: ambiguous ? 'ambiguous_session_binding' : 'kernel_state_unavailable',
            severity: 'error',
            message: error.message,
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
    const identityArgs = { projectRoot, runtimeHome, env: kernelEnv };
    if (subcommand === 'status') {
      const { inspectKernelProjectIdentity } = await import('../scripts/kernel/project-identity-preflight.mjs');
      output(await inspectKernelProjectIdentity(identityArgs));
    } else if (subcommand === 'bootstrap') {
      const { bootstrapKernelProjectIdentity } = await import('../scripts/kernel/project-identity-preflight.mjs');
      output(await bootstrapKernelProjectIdentity({ ...identityArgs, policy: getArgValue('--policy') || 'isolate' }));
    } else if (subcommand === 'approve') {
      const { approveKernelProjectIdentityRepair } = await import('../scripts/kernel/project-identity-preflight.mjs');
      output(await approveKernelProjectIdentityRepair({
        ...identityArgs,
        legacyProjectId: getArgValue('--legacy-project-id'),
        approvalRef: getArgValue('--approval-ref'),
        approvedBy: getArgValue('--approved-by'),
      }));
    } else if (subcommand === 'repair') {
      const { repairKernelProjectIdentity } = await import('../scripts/kernel/project-identity-preflight.mjs');
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
      process.exitCode = 1;
    }
  } else if (command === 'resolve-runtime') {
    output(await resolveKernelNode({ runtimeHome: managedRuntimeHome }));
  } else if (command === 'package') {
    const trackResolution = await resolveProjectTrack(process.cwd(), { env: trackEnv(), allowAccountRootDefault: true });
    const activeTrack = trackResolution.track;
    if (activeTrack !== 'kernel') {
      output({ productId: 'moon-relay-kernel', activeTrack, trackSource: trackResolution.source, status: 'wrong_harness', message: 'package command requires account-root track to be kernel' });
      process.exitCode = 1;
    } else {
      await ensureAccountRootTrack({ startDir: process.cwd(), track: 'kernel', env: trackEnv() });
      const { materializeKernelPackage } = await import('../scripts/kernel/package-build.mjs');
      const outArg = args.indexOf('--output');
      const outputRoot = outArg >= 0 ? args[outArg + 1] : `${process.cwd()}/dist/moon-relay-kernel`;
      output(await materializeKernelPackage({ sourceRoot: process.cwd(), outputRoot, dryRun: args.includes('--dry-run') }));
    }
  } else if (command === 'install') {
    const { installKernel } = await import('../scripts/kernel/installer.mjs');
    const targetRoot = getArgValue('--target-root') || process.cwd();
    const resolvedRuntimeHome = resolveKernelRuntimeHome();
    output(await installKernel({
      targetRoot,
      sourceRoot: getArgValue('--source-root') || process.cwd(),
      runtimeSource: getArgValue('--runtime-source'),
      trackHome: getArgValue('--track-home') || (path.resolve(targetRoot) === path.resolve(resolvedRuntimeHome) ? resolvedRuntimeHome : null),
      replaceModified: args.includes('--sync'),
    }));
  } else if (command === 'profile-install') {
    const { installKernelAccountRoot, installKernelProfile } = await import('../scripts/kernel/profile-install.mjs');
    const runtime = getArgValue('--runtime-name') || getArgValue('--runtime');
    const targetRoot = getArgValue('--target-root') || process.cwd();
    const sourceRoot = getArgValue('--source-root') || process.cwd();
    output(await (args.includes('--account-root')
      ? installKernelAccountRoot({ runtime, targetRoot, sourceRoot, runtimeHome: getArgValue('--runtime-home') || undefined, force: args.includes('--sync') })
      : installKernelProfile({ runtime, targetRoot, sourceRoot, skillsRoot: getArgValue('--skills-root'), runtimeHome: getArgValue('--runtime-home') || undefined, force: args.includes('--sync') })));
  } else if (command === 'profile-doctor') {
    const { doctorKernelProfile } = await import('../scripts/kernel/profile-doctor.mjs');
    output(await doctorKernelProfile({
      targetRoot: getArgValue('--target-root') || process.cwd(),
      runtime: getArgValue('--runtime-name') || getArgValue('--runtime'),
      runtimeHome: getArgValue('--runtime-home') || resolveKernelRuntimeHome(),
    }));
  } else if (command === 'profile-uninstall') {
    const { uninstallKernelProfile } = await import('../scripts/kernel/profile-install.mjs');
    output(await uninstallKernelProfile({ targetRoot: getArgValue('--target-root') || process.cwd() }));
  } else if (command === 'profile-rollback') {
    const { rollbackKernelProfile } = await import('../scripts/kernel/profile-install.mjs');
    output(await rollbackKernelProfile({ targetRoot: getArgValue('--target-root') || process.cwd(), backupPath: getArgValue('--backup') }));
  } else if (command === 'uninstall') {
    const targetRoot = getArgValue('--target-root') || process.cwd();
    await assertKernelTrack(targetRoot);
    const { uninstallKernel } = await import('../scripts/kernel/installer.mjs');
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
    const taskContract = contractFile
      ? JSON.parse(readFileSync(path.resolve(contractFile), 'utf8'))
      : null;
    let invocation;
    let res;
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
            taskContract,
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
    } catch (err) {
      if (err.code === 'worktree_run_conflict') {
        const activeRunId = err.details?.holderRunId || err.details?.holders?.[0]?.runId || err.details?.mutableRuns?.[0]?.runId || null;
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
      if (contractFile) {
        if (invocation.mode === 'successor') {
          const successor = await cp.startSuccessor({
            invocation,
            objective: taskContract.objective,
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
            objective: taskContract.objective,
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
    let payload = {};
    if (reportFile) {
      payload = JSON.parse(readFileSync(path.resolve(reportFile), 'utf8'));
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
    const approver = getArgValue('--approver') || process.env.USERNAME || process.env.USER || 'operator';
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
      const input = readContextJson();
      const res = await cp.buildStageContext(runId, { ...input, stage: getArgValue('--stage') || input.stage || 'EXECUTE' });
      await cp.close();
      output(res);
    } else {
      const { buildProjectKnowledgeContext } = await import('../scripts/kernel/knowledge/context-load.mjs');
      const { inspectKernelProjectIdentity } = await import('../scripts/kernel/project-identity-preflight.mjs');
      const projectIdentity = await inspectKernelProjectIdentity({ projectRoot, runtimeHome: effectiveRuntimeHome, env: kernelEnv });
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
    const res = await cp.transition(runId, nextState);
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
      command: getArgValue('--command'),
      evidenceDigest: getArgValue('--evidence-digest'),
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
    const input = readContextJson();
    const res = await cp.finalizeRun(runId, {
      gitCloseoutRequest: input.gitCloseoutRequest || null,
      changedPaths: input.changedPaths || [],
      changedFileCount: input.changedFileCount || null,
      knowledgeObservations: input.knowledgeObservations || [],
      approvals: input.approvals || [],
    });
    await cp.close();
    output(res);
  } else if (command === 'finalization-status') {
    const cp = await openControlPlane();
    const runId = getArgValue('--run-id');
    if (!runId) throw new Error('finalization-status command requires --run-id');
    const store = await (await import('../scripts/kernel/state-store.mjs')).openKernelStateStore({ runtimeHome: effectiveRuntimeHome || undefined });
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
} catch (error) {
  const errorCode = error.errorCode || error.code || error.message;
  const remediation = error.details?.remediation || recoveryForKernelError({
    code: errorCode,
    projectRoot,
    provider: hostProvider,
  });
  const diagnosticKeys = [
    'legacyProjectId', 'source', 'canonicalRoot', 'legacyCanonicalRoot', 'gitCommonDir',
    'aliases', 'projectIds', 'projectId', 'nextAction', 'remediation',
  ];
  const diagnostics = {
    ...(error.details && typeof error.details === 'object' ? error.details : {}),
    ...(remediation ? { remediation } : {}),
    ...Object.fromEntries(diagnosticKeys.filter((key) => error[key] !== undefined).map((key) => [key, error[key]])),
  };
  console.error(json ? JSON.stringify({
    schemaVersion: 1,
    status: 'error',
    errorCode,
    message: error.message,
    ...(error.nextAction ? { nextAction: error.nextAction } : {}),
    ...(error.runId ? { runId: error.runId } : {}),
    ...(Object.keys(diagnostics).length ? { diagnostics } : {}),
  }) : error.message);
  process.exitCode = 1;
}
