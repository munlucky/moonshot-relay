import { stat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { GUI_SURFACES, KERNEL_RUNTIME_ID, SURFACES } from './constants.mjs';
import { resolveApplication } from './app-resolver/index.mjs';
import { buildLaunchSpec, spawnNativeSurface } from './launch-adapter.mjs';
import { listProviderProcesses, waitForProcessPresence, waitForQuiescence } from './process-guard.mjs';
import { assertSafeTarget, pathsOverlap, resolveSurfaceRoots } from './paths.mjs';
import { createReceipt } from './receipt.mjs';
import { clearJournal, readJournal, readState, updateState } from './state-store.mjs';
import { uninstallSwitcherPackage } from './installer.mjs';
import { advanceTransaction, commitTransaction, prepareTransaction, recoverTransaction } from './transaction.mjs';
import { inspectProfile, installKernelProfile } from '../kernel/profile-install.mjs';
import { cleanupLegacyKernelHydration } from '../kernel/legacy-hydration-cleanup.mjs';
import { inspectKernelProjectIdentity } from '../kernel/project-identity-preflight.mjs';
import { loadStandaloneCatalog, standaloneDescriptors } from '../kernel/standalone/catalog.mjs';

const exists = async (file) => {
  try { await stat(file); return true; } catch { return false; }
};

const validateSurface = (surface) => {
  if (!SURFACES.includes(surface)) throw new Error('wrong_harness: unsupported surface ' + surface);
};

const safeRoots = async (roots) => {
  if (pathsOverlap(roots.runtimeHome, roots.providerHome)) {
    throw Object.assign(new Error('unsafe_target: native provider home overlaps Kernel runtime'), { code: 'unsafe_target' });
  }
  for (const root of [roots.runtimeHome, roots.providerHome, roots.appDataRoot].filter(Boolean)) {
    await assertSafeTarget(root);
  }
};

export const KERNEL_ENTRYPOINT_SKILL = 'moon-relay-kernel';

export async function discoverProviderSkills(providerHome) {
  if (!providerHome) return [];
  try {
    const entries = await readdir(path.join(providerHome, 'skills'), { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.')).map((entry) => entry.name).sort();
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

export async function inspectKernelLaunchReadiness({ runtimeHome, providerHome, projectRoot = null, sourceRoot = process.cwd(), checkProjectIdentity = true } = {}) {
  if (!runtimeHome) return { status: 'kernel_not_installed', reason: 'runtime_home_missing' };
  const runtimeManifestExists = (await exists(path.join(runtimeHome, '.moon-relay', 'install-manifest.json'))) || (await exists(path.join(runtimeHome, 'install-manifest.json')));
  if (!runtimeManifestExists) return { status: 'kernel_not_installed', reason: 'runtime_package_missing' };

  const entrypoints = [
    path.join(runtimeHome, '.moon-relay', 'kernel-payload', 'bin', 'moon-relay-kernel.mjs'),
    path.join(runtimeHome, 'kernel-payload', 'bin', 'moon-relay-kernel.mjs'),
    path.join(runtimeHome, 'bin', 'moon-relay-kernel.mjs'),
    path.join(sourceRoot, 'bin', 'moon-relay-kernel.mjs'),
  ];
  if (!(await Promise.all(entrypoints.map(exists))).some(Boolean)) {
    return { status: 'kernel_not_installed', reason: 'entrypoint_missing' };
  }
  if (!providerHome) return { status: 'kernel_profile_not_ready', reason: 'provider_home_missing' };
  if (pathsOverlap(runtimeHome, providerHome)) return { status: 'unsafe_target', reason: 'provider_home_overlaps_runtime' };

  const profileInspect = await inspectProfile(providerHome);
  if (profileInspect.status !== 'ready') return { status: 'kernel_profile_not_ready', reason: profileInspect.status };

  const discoveredSkills = await discoverProviderSkills(providerHome);
  let standaloneCatalog;
  try {
    standaloneCatalog = await loadStandaloneCatalog({ repoRoot: sourceRoot, validateSources: true });
  } catch (error) {
    return { status: 'kernel_profile_not_ready', reason: 'standalone_catalog_invalid', findings: error.findings || [] };
  }
  const standaloneNames = new Set(standaloneDescriptors(standaloneCatalog, { enabledOnly: true }).map((entry) => entry.name));
  const workflowSkills = discoveredSkills.filter((name) => !standaloneNames.has(name));
  if (!workflowSkills.includes(KERNEL_ENTRYPOINT_SKILL)) {
    return { status: 'kernel_profile_not_ready', reason: 'skill_discovery_missing', discoveredSkills: workflowSkills };
  }
  const legacyWorkflowSkills = new Set(['moonshot-orchestrator', 'moonshot-phase-runner', 'moonshot-relay-setup']);
  const conflictingSkills = workflowSkills.filter((name) => legacyWorkflowSkills.has(name));
  if (conflictingSkills.length) {
    return { status: 'shared_mutable_surface', reason: 'shared_mutable_surface', discoveredSkills: workflowSkills, conflictingSkills };
  }

  let projectIdentity = null;
  if (checkProjectIdentity) {
    try {
      projectIdentity = await inspectKernelProjectIdentity({ projectRoot: projectRoot || sourceRoot, runtimeHome });
    } catch (error) {
      return { status: 'kernel_project_identity_not_ready', reason: error.code || 'project_identity_preflight_failed', message: error.message };
    }
    if (projectIdentity.status !== 'ready') {
      return { status: 'kernel_project_identity_not_ready', reason: 'project_identity_preflight_required', projectIdentity };
    }
  }
  return { status: 'launch_candidate', ready: true, discoveredSkills: workflowSkills, projectIdentity };
}

export async function switchStatus({ surface = null } = {}) {
  const state = await readState();
  return {
    schemaVersion: 1,
    productId: 'moon-harness-switcher',
    runtime: KERNEL_RUNTIME_ID,
    status: 'ready',
    surface,
    surfaces: surface ? { [surface]: state.surfaces[surface] } : state.surfaces,
    lastCommitted: state.lastCommitted,
    journal: state.journal,
    sensitiveContentRead: false,
  };
}

export async function switchDoctor({ surface = null, processProvider } = {}) {
  const state = await readState();
  const journal = await readJournal();
  const surfaces = surface ? [surface] : SURFACES;
  const reports = {};
  for (const item of surfaces) {
    const active = await listProviderProcesses({ surface: item, processProvider });
    const selected = state.surfaces[item];
    const stateReady = selected?.effectiveRuntime === KERNEL_RUNTIME_ID;
    reports[item] = {
      status: journal && journal.surface === item && journal.state !== 'committed' ? 'recovery_required' : active.length ? 'process_active' : stateReady ? 'ready' : 'unknown',
      runtime: selected?.effectiveRuntime || 'unknown',
      processSet: active,
      sensitiveContentRead: false,
      recovery: active.length ? 'close the relevant process before mutation' : journal ? 'run recover after approved graceful close' : null,
    };
  }
  return {
    schemaVersion: 1,
    runtime: KERNEL_RUNTIME_ID,
    status: Object.values(reports).some((report) => report.status === 'recovery_required') ? 'recovery_required' : 'ready',
    reports,
    sensitiveContentRead: false,
  };
}

export async function cleanupLegacyProject({ projectRoot, providerHome } = {}) {
  const profile = await inspectProfile(providerHome);
  return cleanupLegacyKernelHydration({ projectRoot, profileReady: profile.status === 'ready' });
}

const profileRuntimeForSurface = (surface) => {
  if (surface === 'claude_cli' || surface === 'claude_desktop') return 'claude';
  if (surface === 'codex_desktop' || surface === 'codex_cli') return 'codex';
  if (surface === 'qwen_cli') return 'qwen';
  if (surface === 'ade_cli') return 'ade';
  if (surface === 'antigravity_desktop') return 'antigravity';
  return null;
};

async function launchKernelSurface({
  surface,
  sourceRoot = process.cwd(),
  projectRoot = null,
  workspaceRoot = null,
  taskBinding = null,
  processProvider,
  closeApproval = false,
  closeHandler = null,
  launchSpec = null,
  spawnImpl = null,
  dryRun = true,
  platform = process.platform,
  applicationResolver = resolveApplication,
  force = false,
  roots: explicitRoots = null,
} = {}) {
  validateSurface(surface);
  const targetProjectRoot = projectRoot || workspaceRoot || sourceRoot;
  const roots = explicitRoots || launchSpec?.roots || resolveSurfaceRoots({ surface, sourceRoot, platform });
  await safeRoots(roots);

  const state = await readState();
  const previous = state.surfaces[surface];
  const active = await listProviderProcesses({ surface, processProvider });
  if (active.length && GUI_SURFACES.has(surface)) {
    if (previous?.effectiveRuntime === KERNEL_RUNTIME_ID) {
      return createReceipt({ operation: 'launch', status: 'already_effective', surface, effective: { activated: true, processSet: active } });
    }
    if (!closeApproval || !closeHandler) {
      return createReceipt({ operation: 'launch', status: 'close_incomplete', surface, errorCode: 'operator_approval_missing', effective: { processSet: active } });
    }
    const closed = await closeHandler({ surface, processSet: active });
    if (!closed) return createReceipt({ operation: 'launch', status: 'close_incomplete', surface, errorCode: 'close_incomplete', effective: { processSet: active } });
    const quiescent = await waitForQuiescence({ surface, processProvider });
    if (quiescent.status !== 'quiescent') return createReceipt({ operation: 'launch', status: 'close_incomplete', surface, errorCode: 'process_active', effective: quiescent });
  }

  let readiness = await inspectKernelLaunchReadiness({
    runtimeHome: roots.runtimeHome,
    providerHome: roots.providerHome,
    projectRoot: targetProjectRoot,
    sourceRoot,
    checkProjectIdentity: !dryRun,
  });
  if (readiness.status !== 'launch_candidate') {
    if (readiness.status === 'kernel_profile_not_ready' && readiness.reason === 'drift' && force) {
      const runtime = profileRuntimeForSurface(surface);
      if (runtime) {
        await installKernelProfile({ sourceRoot, runtime, targetRoot: roots.providerHome, force: true, runtimeHome: roots.runtimeHome });
        readiness = await inspectKernelLaunchReadiness({
          runtimeHome: roots.runtimeHome,
          providerHome: roots.providerHome,
          projectRoot: targetProjectRoot,
          sourceRoot,
          checkProjectIdentity: !dryRun,
        });
      }
    }
    if (readiness.status !== 'launch_candidate') {
      return createReceipt({
        operation: 'launch',
        status: readiness.status,
        surface,
        errorCode: readiness.reason || readiness.status,
        effective: {
          discoveredSkills: readiness.discoveredSkills || [],
          projectIdentity: readiness.projectIdentity || null,
          remediation: readiness.projectIdentity?.remediation || null,
        },
      });
    }
  }

  let spec = launchSpec;
  if (!spec && GUI_SURFACES.has(surface) && surface !== 'claude_desktop') {
    const application = await applicationResolver(surface);
    if (!application.executable) {
      return createReceipt({ operation: 'launch', status: 'error', surface, errorCode: 'application_not_resolved', effective: { warnings: application.warnings || [] } });
    }
    const args = surface === 'antigravity_desktop' && roots.appDataRoot
      ? ['--user-data-dir=' + roots.appDataRoot]
      : [];
    spec = { ...buildLaunchSpec({ surface, sourceRoot, workspaceRoot: targetProjectRoot, roots, args, ...(taskBinding || {}) }), aumid: application.aumid || null };
  }
  spec ||= buildLaunchSpec({ surface, sourceRoot, workspaceRoot: targetProjectRoot, roots, ...(taskBinding || {}) });

  const journal = await prepareTransaction({ surface, requestedRuntime: KERNEL_RUNTIME_ID, roots, previousSelection: previous, processSet: active });
  await advanceTransaction(journal, 'old_app_stopped');
  await advanceTransaction(journal, 'launch_requested', { launch: { commandName: spec.command, argCount: spec.args.length } });

  let started;
  try {
    started = dryRun ? { status: 'launch_requested', pid: null } : spawnNativeSurface(spec, { spawnImpl: spawnImpl || undefined, platform });
  } catch (error) {
    await clearJournal();
    return createReceipt({ operation: 'launch', status: 'error', surface, errorCode: error.code || 'launch_failed' });
  }

  let observed = { status: 'not_required', processSet: [] };
  if (!dryRun && GUI_SURFACES.has(surface) && !spawnImpl) {
    observed = await waitForProcessPresence({ surface, processProvider });
    if (observed.status !== 'process_observed') {
      await clearJournal();
      return createReceipt({ operation: 'launch', status: 'error', surface, errorCode: 'launch_unverified' });
    }
  }
  await advanceTransaction(journal, 'process_observed', { pid: started.pid || null, processSet: observed.processSet });
  await advanceTransaction(journal, 'provider_home_verified', { providerHome: roots.providerHome });
  await advanceTransaction(journal, 'workspace_verified', { workspaceRoot: spec.workspaceRoot });
  const discoveredSkills = readiness?.discoveredSkills || await discoverProviderSkills(roots.providerHome);
  await advanceTransaction(journal, 'skill_discovery_verified', { discoveredSkills });

  const effective = {
    runtime: KERNEL_RUNTIME_ID,
    runtimeHome: roots.runtimeHome,
    providerHome: roots.providerHome,
    appDataRoot: roots.appDataRoot || null,
    workspaceRoot: spec.workspaceRoot || null,
    discoveredSkills,
    projectIdentity: readiness?.projectIdentity || null,
    pid: started.pid || null,
    processScoped: surface.endsWith('_cli'),
  };
  await advanceTransaction(journal, 'effective_verified', { effective });
  await commitTransaction({ ...journal, effective });
  await updateState((next) => {
    next.surfaces[surface] = {
      requestedRuntime: KERNEL_RUNTIME_ID,
      effectiveRuntime: KERNEL_RUNTIME_ID,
      requested: { runtime: KERNEL_RUNTIME_ID, roots },
      effective,
      lastCommitted: effective,
    };
    next.lastCommitted[surface] = effective;
    next.journal = null;
    return next;
  });
  return createReceipt({ operation: 'launch', status: 'committed', surface, effective });
}

export async function launchSwitch(options = {}) {
  if (options.track === 'relay' || options.runtime === 'relay') {
    return createReceipt({
      operation: 'launch',
      status: 'retired',
      surface: options.surface || 'unknown',
      errorCode: 'relay_track_retired',
      effective: { guidance: 'Launch the Kernel runtime directly.' },
    });
  }
  return launchKernelSurface(options);
}

export async function recoverSwitch({ surface, processProvider, closeApproval = false, closeHandler = null } = {}) {
  const journal = await readJournal();
  if (!journal || (surface && journal.surface !== surface)) return createReceipt({ operation: 'recover', status: 'idle', surface: surface || 'unknown' });
  const active = await listProviderProcesses({ surface: journal.surface, processProvider });
  if (active.length) {
    if (!closeApproval || !closeHandler) return createReceipt({ operation: 'recover', status: 'recovery_required', surface: journal.surface, errorCode: 'operator_approval_missing' });
    if (!(await closeHandler({ surface: journal.surface, processSet: active }))) return createReceipt({ operation: 'recover', status: 'close_incomplete', surface: journal.surface, errorCode: 'close_incomplete' });
  }
  await recoverTransaction();
  await clearJournal();
  return createReceipt({ operation: 'recover', status: 'recovered', surface: journal.surface, effective: { priorSelectionPreserved: true } });
}

export async function rollbackSwitch({ surface, processProvider } = {}) {
  const state = await readState();
  const selected = state.lastCommitted[surface] || state.surfaces[surface]?.lastCommitted;
  const active = await listProviderProcesses({ surface, processProvider });
  if (active.length && GUI_SURFACES.has(surface)) return createReceipt({ operation: 'rollback', status: 'process_active', surface, errorCode: 'process_active' });
  if (!selected) return createReceipt({ operation: 'rollback', status: 'not_found', surface });
  return createReceipt({ operation: 'rollback', status: 'metadata_only', surface, effective: { restored: true, providerCreatedData: 'preserved' } });
}

export async function uninstallSwitcher({ home = null } = {}) {
  const target = home ? path.resolve(home) : null;
  if (!target) return { status: 'uninstalled', runtime: KERNEL_RUNTIME_ID, removed: [], preserved: ['provider-created data', 'Kernel runtime state'] };
  return uninstallSwitcherPackage({ targetRoot: target });
}
