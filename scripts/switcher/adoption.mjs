import path from 'node:path';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { KERNEL_RUNTIME_ID, SURFACES } from './constants.mjs';
import { resolveSurfaceRoots, physicalTargetIdentity } from './paths.mjs';
import { listProviderProcesses } from './process-guard.mjs';
import { installKernelProfile } from '../kernel/profile-install.mjs';
import { materializeKernelCommandShim } from '../kernel/installer.mjs';
import { installSwitcher } from './installer.mjs';

const execFileAsync = promisify(execFile);
export const LIVE_APPROVAL_TOKEN = 'APPROVE_LIVE_HARNESS_SWITCHER';
const userHome = () => process.env.USERPROFILE || process.env.HOME || '';
const profileRuntimeForSurface = (surface) => {
  if (surface === 'claude_cli' || surface === 'claude_desktop') return 'claude';
  if (surface === 'codex_cli' || surface === 'codex_desktop') return 'codex';
  if (surface === 'qwen_cli') return 'qwen';
  if (surface === 'ade_cli') return 'ade';
  if (surface === 'antigravity_desktop') return 'antigravity';
  return null;
};

export async function buildLivePreflight({ sourceRoot = process.cwd(), kernelHome: requestedKernelHome = null, processProvider } = {}) {
  const home = userHome();
  const kernelHome = path.resolve(requestedKernelHome || process.env.MOON_RELAY_KERNEL_HOME || path.join(home, '.moon-relay-kernel'));
  const switcherHome = process.env.MOON_HARNESS_SWITCHER_HOME || path.join(home, '.moon-harness-switcher');
  const kernelHomeIdentity = await physicalTargetIdentity(kernelHome);
  const targets = [{ surface: null, kind: 'runtimeHome', target: kernelHome, identity: kernelHomeIdentity }];
  const seen = new Set([kernelHome]);
  for (const surface of SURFACES) {
    if (surface === 'ade_cli' && !process.env.ADE_HOME) continue;
    const roots = resolveSurfaceRoots({ surface, sourceRoot, kernelHome });
    for (const [kind, target] of Object.entries(roots)) {
      if (!['providerHome', 'appDataRoot'].includes(kind) || !target || seen.has(target)) continue;
      seen.add(target);
      targets.push({ surface, kind, target, identity: await physicalTargetIdentity(target, { protectedRoots: [kernelHome] }) });
    }
  }
  const processes = {};
  for (const surface of SURFACES.filter((item) => item.endsWith('_desktop'))) {
    processes[surface] = await listProviderProcesses({ surface, processProvider });
  }
  let head = null;
  let status = 'scoped_dirty_worktree';
  try {
    head = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, windowsHide: true })).stdout.trim();
    if (process.env.MOON_HARNESS_PREFLIGHT_CLEAN === '1') status = 'ready';
  } catch {
    status = 'source_identity_unavailable';
  }
  return {
    schemaVersion: 1,
    runtime: KERNEL_RUNTIME_ID,
    status,
    sourceRoot: path.resolve(sourceRoot),
    sourceHead: head,
    requestedKernelHome: kernelHome,
    kernelHome: kernelHomeIdentity.canonicalPath,
    kernelHomeIdentity,
    targets,
    processes,
    approvalRequired: true,
    liveMutationCount: 0,
    sensitiveContentRead: false,
    credentialContentRead: false,
    protectedRootsPreserved: true,
    switcherHome,
  };
}

export async function adoptLive({ sourceRoot = process.cwd(), kernelHome: requestedKernelHome = null, approved = false, approvalToken = '', processProvider } = {}) {
  const preflight = await buildLivePreflight({ sourceRoot, kernelHome: requestedKernelHome, processProvider });
  if (!preflight.kernelHomeIdentity?.safe) return { status: 'unsafe_target', errorCode: 'unsafe_target', preflight, liveMutationCount: 0 };
  if (!approved || approvalToken !== LIVE_APPROVAL_TOKEN) return { status: 'operator_approval_missing', errorCode: 'operator_approval_missing', preflight, liveMutationCount: 0 };
  if (Object.values(preflight.processes).some((items) => items.length)) return { status: 'process_active', errorCode: 'process_active', preflight, liveMutationCount: 0 };

  const installed = [];
  const installedProfiles = new Set();
  for (const surface of SURFACES) {
    if (surface === 'ade_cli' && !process.env.ADE_HOME) continue;
    const runtime = profileRuntimeForSurface(surface);
    if (!runtime || installedProfiles.has(runtime)) continue;
    const roots = resolveSurfaceRoots({ surface, sourceRoot, kernelHome: preflight.kernelHome });
    installed.push(await installKernelProfile({ sourceRoot, runtime, targetRoot: roots.providerHome, runtimeHome: preflight.kernelHome }));
    installedProfiles.add(runtime);
  }
  const entrypointCandidates = [
    path.join(preflight.kernelHome, '.moon-relay', 'kernel-payload', 'bin', 'moon-relay-kernel.mjs'),
    path.join(preflight.kernelHome, 'kernel-payload', 'bin', 'moon-relay-kernel.mjs'),
    path.join(preflight.kernelHome, 'bin', 'moon-relay-kernel.mjs'),
  ];
  const entrypoint = entrypointCandidates.find(existsSync);
  if (!entrypoint) throw new Error('kernel_entrypoint_missing: install the Kernel runtime before provider adoption');
  installed.push(await materializeKernelCommandShim({ runtimeHome: preflight.kernelHome, entrypoint }));
  installed.push(await installSwitcher({ sourceRoot, targetRoot: preflight.switcherHome }));
  return {
    status: 'adopted',
    runtime: KERNEL_RUNTIME_ID,
    installId: String(Date.now()) + '-' + process.pid,
    installed,
    preflight,
    liveMutationCount: installed.length,
    rollback: 'metadata/profile manifest rollback only; provider-created data preserved',
  };
}
