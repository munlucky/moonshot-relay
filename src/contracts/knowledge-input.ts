export interface HostSessionResolution {
  provider: string;
  roots: string[];
  source: string;
  available: boolean;
}

export interface HostSessionDescriptor {
  provider: string;
  nativeSessionId: string;
  locator: string;
  sourceDigest: string;
  workingDirectory: string | null;
  remote: string | null;
  updatedAt: string;
  createdAt: string;
}

export interface HostSessionDiscovery {
  provider: string;
  status: 'ready' | 'unavailable';
  resolution: HostSessionResolution;
  sessions: HostSessionDescriptor[];
}

export interface HostSessionKnowledgeInput {
  schemaVersion: 1;
  provider: string;
  nativeSessionId: string;
  locator: string | null;
  workingDirectory: string | null;
  remote: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  objective: string | null;
  changedFiles: string[];
  decisions: string[];
  failures: string[];
  nextSteps: string[];
  sourceDigest: string;
}

export interface HostSessionProviderAdapter {
  discoverSessions(options?: {
    since?: string | null;
    limit?: number;
    env?: NodeJS.ProcessEnv;
  }): Promise<HostSessionDiscovery>;
  readSession(nativeSessionId: string, options?: {
    locator?: string | null;
    env?: NodeJS.ProcessEnv;
  }): Promise<HostSessionKnowledgeInput>;
}

export interface HostCodebaseFileObservation {
  path: string;
  imports: string[];
  symbols: string[];
  apiSurface: string[];
  size: number;
  digest: string;
}

export interface HostCodebaseIndex {
  schemaVersion: 1;
  projectId: string;
  sourceTreeDigest: string;
  sourceCommit: string;
  generatedAt: string;
  files: HostCodebaseFileObservation[];
}

export interface HostCodebaseManifest {
  schemaVersion: 1;
  projectId: string;
  sourceCommit: string;
  sourceTreeDigest: string;
  graphDigest: string;
  skillVersion: string;
  generatedAt: string;
  status: string;
}

export interface HostCodebaseIndexResult {
  status: 'completed' | 'cache_hit';
  mode: 'full' | 'incremental' | 'cache_hit';
  projectId: string;
  codebaseRoot: string;
  manifest: HostCodebaseManifest;
  changedFiles: string[];
  deletedFiles: string[];
  fileCount?: number;
}
