import type { WorkspaceObservation, ScopedWorkspaceObservation, ResolveStableWorkspaceIdentity, MutationPathObservation, MutationWorkspaceObservation } from '../contracts/workspace-observation.js';
import type { ScanRepositoryEvidence, ObserveRepositoryStructure, ListTrackedFiles, InspectRepositoryFiles, ObserveGitTreeDigest } from '../contracts/repository-observation.js';
import type { ProjectCommandDeclarationObservation } from '../contracts/project-command.js';
import type { ProofEnvironmentObservation } from '../contracts/proof-environment.js';
import type { TrustedProofInput, ApprovedProofInput, ProofExecutionResult, FlakyExecutionLike } from '../contracts/proof-execution.js';
import type { GitCloseoutHost } from '../contracts/git-closeout.js';
import type { retryGitCloseout } from './git/closeout.js';
import type { existsSync, lstatSync, realpathSync } from 'node:fs';

// Host performs observations and effects. Kernel retains decision authority.
export interface KernelHostServices {
  observeWorkspaceIdentity: (input: { projectRoot: string }) => WorkspaceObservation;
  observeScopedWorkspaceIdentity: (input: { projectRoot: string; scopes?: readonly unknown[] }) => ScopedWorkspaceObservation;
  resolveStableWorkspaceIdentity: ResolveStableWorkspaceIdentity;
  scanRepositoryEvidence: ScanRepositoryEvidence;
  observeRepositoryStructure: ObserveRepositoryStructure;
  listTrackedFiles: ListTrackedFiles;
  inspectRepositoryFiles: InspectRepositoryFiles;
  observeGitTreeDigest: ObserveGitTreeDigest;
  resolveMutationPath: (input: { workspaceRoot: string; targetPath: unknown; platform?: NodeJS.Platform }) => MutationPathObservation;
  inspectMutationWorkspace: (input: { workspaceRoot: string }) => MutationWorkspaceObservation;
  contractPathAccess: { resolveRealpath: typeof realpathSync; checkExists: typeof existsSync; lstatPath: typeof lstatSync };
  observeProjectCommandDeclarations: (input: { projectRoot: string }) => ProjectCommandDeclarationObservation;
  observeProofEnvironment: () => ProofEnvironmentObservation;
  executeTrustedProof: (input: TrustedProofInput) => ProofExecutionResult;
  executeApprovedProof: (input: ApprovedProofInput) => ProofExecutionResult;
  executeWithFlakyRerun: <T extends FlakyExecutionLike>(runner: () => T) => T & { flaky: boolean; reruns: number; firstStatus?: string };
  retryGitCloseout: typeof retryGitCloseout;
  gitCloseoutHost: GitCloseoutHost;
  processObservation: { currentPid: number; isProcessAlive: (pid: number) => boolean };
  isUntrustedCommandError: (error: unknown) => boolean;
}
