import {
  createKernelControlPlane as createKernelControlPlaneCore,
} from '../../kernel/control-plane.js';
import { openKernelStateStore } from '../../kernel/state-store.js';
import {
  retryGitCloseout as retryGitCloseoutKernel,
} from '../../kernel/git/closeout.js';
import { createGitCloseoutHost } from './git/closeout-operations.js';
import {
  observeWorkspaceIdentity,
  observeScopedWorkspaceIdentity,
} from './workspace/workspace-identity.js';
import { resolveStableWorkspaceIdentity } from './workspace/stable-workspace.js';
import {
  inspectRepositoryFiles,
  listTrackedFiles,
  observeGitTreeDigest,
  observeRepositoryStructure,
  scanRepositoryEvidence,
} from './workspace/repository-observation.js';
import {
  inspectMutationWorkspace,
  resolveMutationPath,
} from './workspace/mutation-observation.js';
import { contractPathAccess } from './workspace/contract-path-access.js';
import { observeProjectCommandDeclarations } from './proof/project-command-observation.js';
import { observeProofEnvironment } from './proof/environment-observation.js';
import {
  executeTrustedProof,
  executeApprovedProof,
  executeWithFlakyRerun,
  UntrustedCommandError,
} from './proof/proof-executor.js';
import { canonicalizeHostSessionId } from '../../contracts/host-session.js';
import { resolveHostSessionHolder } from './session-holder.js';
import {
  createHostProcessObservation,
  type HostProcessObservation,
} from './process-observation.js';

export * from '../../kernel/control-plane.js';

const gitCloseoutHost = createGitCloseoutHost();

const retryGitCloseout = (
  runId: Parameters<typeof retryGitCloseoutKernel>[0],
  options: Parameters<typeof retryGitCloseoutKernel>[1] = {},
) => retryGitCloseoutKernel(runId, {
  ...options,
  observeWorkspaceIdentity,
  gitCloseoutHost,
});

import type { KernelHostServices } from '../../kernel/host-services.js';
export type { KernelHostServices } from '../../kernel/host-services.js';

export const createDefaultKernelHostServices = (): KernelHostServices => Object.freeze({
  observeWorkspaceIdentity,
  observeScopedWorkspaceIdentity,
  resolveStableWorkspaceIdentity,
  scanRepositoryEvidence,
  observeRepositoryStructure,
  listTrackedFiles,
  inspectRepositoryFiles,
  observeGitTreeDigest,
  resolveMutationPath,
  inspectMutationWorkspace,
  contractPathAccess,
  observeProjectCommandDeclarations,
  observeProofEnvironment,
  executeTrustedProof,
  executeApprovedProof,
  executeWithFlakyRerun,
  retryGitCloseout,
  gitCloseoutHost,
  processObservation: createHostProcessObservation(),
  isUntrustedCommandError: (error: unknown) => error instanceof UntrustedCommandError,
});

interface KernelControlPlaneOptions {
  hostServices?: KernelHostServices | null;
  holder?: unknown;
  env?: NodeJS.ProcessEnv;
  projectRoot?: string;
  runtimeHome?: (string) | undefined;
  relayHome?: string;
  [key: string]: unknown;
}

interface ControlPlaneHostContext {
  provider: string;
  sessionId: string | null;
  legacySessionId: string | null;
  surface: string | null;
}

const resolveControlPlaneHostContext = (
  options: KernelControlPlaneOptions,
): ControlPlaneHostContext => {
  const env = options.env || process.env;
  const rawSessionId = String(env.MOON_RELAY_KERNEL_SESSION_ID || '').trim();
  const scopedProvider = rawSessionId.match(/^([a-z][a-z0-9-]{0,31}):/)?.[1] || null;
  const provider = String(
    env.MOON_RELAY_KERNEL_PROVIDER
    || scopedProvider
    || 'unknown-host',
  ).trim().toLowerCase();
  const sessionId = rawSessionId
    ? canonicalizeHostSessionId({ provider, sessionId: rawSessionId })
    : null;
  const explicitLegacySessionId = String(
    env.MOON_RELAY_KERNEL_LEGACY_SESSION_ID || '',
  ).trim();
  const inferredLegacySessionId = (
    rawSessionId
    && sessionId
    && rawSessionId !== sessionId
    && !rawSessionId.includes(':')
  ) ? rawSessionId : null;

  return {
    provider,
    sessionId,
    legacySessionId: explicitLegacySessionId || inferredLegacySessionId || null,
    surface: String(env.MOON_RELAY_KERNEL_SURFACE || '').trim() || null,
  };
};

const resolveControlPlaneHolder = (
  options: KernelControlPlaneOptions,
  hostContext: ControlPlaneHostContext,
): string => {
  if (options.holder) return String(options.holder);
  const env = options.env || process.env;
  return resolveHostSessionHolder({
    env: hostContext.sessionId
      ? { ...env, MOON_RELAY_KERNEL_SESSION_ID: hostContext.sessionId }
      : env,
    projectRoot: options.projectRoot || process.cwd(),
  });
};

export const createKernelControlPlane = async (
  options: KernelControlPlaneOptions = {},
) => {
  const hostContext = resolveControlPlaneHostContext(options);
  const stateStore = await openKernelStateStore({
    runtimeHome: options.runtimeHome,
    relayHome: options.relayHome,
  });
  try {
    return await createKernelControlPlaneCore({
      ...options,
      stateStore,
      holder: resolveControlPlaneHolder(options, hostContext),
      hostProvider: hostContext.provider,
      hostSessionId: hostContext.sessionId || '',
      legacyHostSessionId: hostContext.legacySessionId || '',
      hostSurface: hostContext.surface || '',
      hostServices: options.hostServices || createDefaultKernelHostServices(),
    });
  } catch (error) {
    try { stateStore.close(); } catch {}
    throw error;
  }
};
