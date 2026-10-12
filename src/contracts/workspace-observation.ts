export interface StableWorkspaceIdentity {
  projectId: string;
  canonicalRoot: string;
  gitCommonDir: string | null;
  gitWorktreeDir: string | null;
}

export interface StableWorkspaceObservation {
  workspaceId: string;
  canonicalRoot: string;
  gitCommonDir: string | null;
  gitWorktreeDir: string | null;
  identity: StableWorkspaceIdentity;
}

export interface ResolveStableWorkspaceIdentityInput {
  projectId: string;
  workspaceRoot: string;
  platform?: NodeJS.Platform;
}

export type ResolveStableWorkspaceIdentity = (
  input: ResolveStableWorkspaceIdentityInput,
) => StableWorkspaceObservation;

export type WorkspaceChangeEntry = {
  path: string;
  digest: string;
  indexDigest: string | null;
  indexMode: string | null;
  indexStage: string | null;
  indexStateKnown: true;
  statusCode: string | null;};

export type WorkspaceObservation = {
  identity: string;
  method: 'git' | 'stat-walk';
  dirtyPathCount: number | null;
  changedPaths: string[] | null;
  changeEntries: WorkspaceChangeEntry[];
  projectRoot: string;
  observedAt: string;};

export type ScopedWorkspaceObservation = {
  identity: string | null;
  method: 'git-scoped' | 'unavailable';
  status: 'observed' | 'unavailable';
  reason: string | null;
  projectRoot: string;
  scopes: string[];
  observedAt: string;
  dirtyPathCount?: number;
  entries?: Array<[string, string]>;};


export interface MutationPathObservation {
  relativePath: string;
  withinWorkspace: boolean;
}

export interface MutationWorkspaceObservation {
  headCommitSha: string | null;
  workspaceStatus: string | null;
}
