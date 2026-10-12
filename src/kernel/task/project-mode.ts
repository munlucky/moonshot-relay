import type { RepositoryStructureObservation } from '../../contracts/repository-observation.js';

export interface ProjectModeInput {
  observation?: RepositoryStructureObservation | null;
  hasKernelKnowledge?: boolean;
}

export interface ProjectModeResult {
  mode: 'greenfield' | 'brownfield';
  signals: {
    hasManifest: boolean;
    hasSource: boolean;
    hasGitHistory: boolean;
    hasKernelKnowledge: boolean;
  };
  manifests: string[];
  sourceFileCountAtLeast: number;
}

const GREENFIELD_SOURCE_THRESHOLD = 3;

export const detectProjectMode = ({
  observation = null,
  hasKernelKnowledge = false,
}: ProjectModeInput = {}): ProjectModeResult => {
  const manifests = Array.isArray(observation?.manifests)
    ? [...observation.manifests]
    : [];
  const sourceFileCount = Number(observation?.sourceFileCountAtLeast || 0);
  const brownfieldSignals = {
    hasManifest: manifests.length > 0,
    hasSource: sourceFileCount > GREENFIELD_SOURCE_THRESHOLD,
    hasGitHistory: observation?.hasGitHistory === true,
    hasKernelKnowledge: Boolean(hasKernelKnowledge),
  };
  const brownfield = Object.values(brownfieldSignals).some(Boolean);

  return {
    mode: brownfield ? 'brownfield' : 'greenfield',
    signals: brownfieldSignals,
    manifests,
    sourceFileCountAtLeast: sourceFileCount,
  };
};
