export interface RepositoryCommandObservation {
  manifest: string;
  commandRef: string;
}

export interface RepositoryEvidenceObservation {
  entrypoints: string[];
  manifests: string[];
  buildCommands: RepositoryCommandObservation[];
  testCommands: RepositoryCommandObservation[];
  dirtyPaths: string[];
}

export interface RepositoryStructureObservation {
  manifests: string[];
  sourceFileCountAtLeast: number;
  hasGitHistory: boolean;
}

export interface RepositorySymbolObservation {
  symbol: string;
  path: string;
}

export interface RepositoryFileInspection {
  digests: Record<string, string | null>;
  symbols: RepositorySymbolObservation[];
  aggregateDigest: string;
}

export interface RepositoryRootInput {
  projectRoot: string;
}

export interface InspectRepositoryFilesInput extends RepositoryRootInput {
  paths?: readonly string[];
  includeSymbols?: boolean;
}

export type ScanRepositoryEvidence = (
  input: RepositoryRootInput,
) => RepositoryEvidenceObservation;

export type ObserveRepositoryStructure = (
  input: RepositoryRootInput,
) => RepositoryStructureObservation;

export type ListTrackedFiles = (
  input: RepositoryRootInput,
) => string[];

export type InspectRepositoryFiles = (
  input: InspectRepositoryFilesInput,
) => RepositoryFileInspection;

export type ObserveGitTreeDigest = (
  input: RepositoryRootInput,
) => string | null;
