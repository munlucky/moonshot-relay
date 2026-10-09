import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { digestJson, writeArtifactBundle } from './artifact-utils.mjs';

const seedBody = ({ schemaVersion, kind, authority, artifactDigest, sourceProvenance, referencedArtifacts, objective, acceptance, constraints, nonGoals }) => ({
  schemaVersion,
  kind,
  authority,
  artifactDigest,
  sourceProvenance,
  referencedArtifacts,
  objective,
  acceptance,
  constraints,
  nonGoals,
});

export const buildTaskContractSeed = ({ kind, utility, projectId, objective, acceptance = [], constraints = [], nonGoals = [], artifactDigest, referencedArtifacts = [], generatedAt = new Date().toISOString() } = {}) => {
  const sourceProvenance = { utility, projectId, generatedAt, sourceType: 'standalone-prework' };
  const body = seedBody({
    schemaVersion: 1,
    kind: 'TASK_CONTRACT_SEED',
    authority: 'prework-only',
    artifactDigest,
    sourceProvenance,
    referencedArtifacts: referencedArtifacts.map((item) => ({ ...item })),
    objective: String(objective || '').trim(),
    acceptance: Array.isArray(acceptance) ? acceptance.map(String) : [],
    constraints: Array.isArray(constraints) ? constraints.map(String) : [],
    nonGoals: Array.isArray(nonGoals) ? nonGoals.map(String) : [],
  });
  return { ...body, seedDigest: digestJson(body), generatedAt };
};

export const validateTaskContractSeed = (seed, { objective = null } = {}) => {
  const errors = [];
  if (!seed || seed.kind !== 'TASK_CONTRACT_SEED') errors.push('seed-kind-invalid');
  if (seed?.authority !== 'prework-only') errors.push('seed-authority-invalid');
  if (!seed?.seedDigest) errors.push('seed-digest-missing');
  if (seed?.seedDigest) {
    const { seedDigest: _ignored, generatedAt: _generatedAt, ...withoutDigest } = seed;
    const expected = digestJson(withoutDigest);
    if (expected !== seed.seedDigest) errors.push('seed-digest-mismatch');
  }
  if (objective !== null && String(objective).trim() !== String(seed?.objective || '').trim()) errors.push('stale-seed-objective-conflict');
  return { valid: errors.length === 0, errors };
};

export const assertCurrentSeed = (seed, { objective } = {}) => {
  const result = validateTaskContractSeed(seed, { objective });
  if (!result.valid) {
    const error = new Error(`STALE_TASK_CONTRACT_SEED: ${result.errors.join(', ')}`);
    error.code = 'STALE_TASK_CONTRACT_SEED';
    error.errors = result.errors;
    throw error;
  }
  return seed;
};

export async function readTaskContractSeed(file) {
  return JSON.parse(await readFile(path.resolve(file), 'utf8'));
}

export async function writePreworkPackage({ directory, utility, projectId, objective, kind, files, acceptance = [], constraints = [], nonGoals = [] } = {}) {
  const bundle = await writeArtifactBundle({ directory, files, metadata: { utility, projectId, kind } });
  const referencedArtifacts = bundle.files.map((item) => ({ path: item.path, digest: item.digest }));
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
  const seedBundle = await writeArtifactBundle({ directory, files: { 'TASK_CONTRACT_SEED.json': seed }, metadata: { authority: 'prework-only' } });
  return { ...bundle, seed, seedPath: path.join(directory, 'TASK_CONTRACT_SEED.json'), seedBundle };
}
