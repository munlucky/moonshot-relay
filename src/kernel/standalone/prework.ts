import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  writeArtifactBundle,
  type ArtifactBundle,
} from './artifact-utils.js';
import {
  assertCurrentSeed,
  buildTaskContractSeed,
  validateTaskContractSeed,
  type TaskContractSeed,
} from '../../contracts/task-contract-seed.js';

export {
  assertCurrentSeed,
  buildTaskContractSeed,
  validateTaskContractSeed,
} from '../../contracts/task-contract-seed.js';

export async function readTaskContractSeed(
  file: string,
): Promise<unknown> {
  return JSON.parse(await readFile(path.resolve(file), 'utf8'));
}

export interface WritePreworkPackageInput {
  directory: string;
  utility: string;
  projectId: string;
  objective: string;
  kind: string;
  files: Record<string, unknown>;
  acceptance?: string[];
  constraints?: string[];
  nonGoals?: string[];
}

export interface PreworkPackageResult extends ArtifactBundle {
  seed: TaskContractSeed;
  seedPath: string;
  seedBundle: ArtifactBundle;
}

export async function writePreworkPackage({
  directory,
  utility,
  projectId,
  objective,
  kind,
  files,
  acceptance = [],
  constraints = [],
  nonGoals = [],
}: WritePreworkPackageInput): Promise<PreworkPackageResult> {
  const bundle = await writeArtifactBundle({
    directory,
    files,
    metadata: { utility, projectId, kind },
  });
  const referencedArtifacts = bundle.files.map((item) => ({
    path: item.path,
    digest: item.digest,
  }));
  const seed = buildTaskContractSeed({
    kind,
    utility,
    projectId,
    objective,
    acceptance,
    constraints,
    nonGoals,
    artifactDigest: bundle.artifactDigest,
    referencedArtifacts,
  });
  const seedBundle = await writeArtifactBundle({
    directory,
    files: { 'TASK_CONTRACT_SEED.json': seed },
    metadata: { authority: 'prework-only' },
  });
  return {
    ...bundle,
    seed,
    seedPath: path.join(directory, 'TASK_CONTRACT_SEED.json'),
    seedBundle,
  };
}
