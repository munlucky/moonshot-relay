import { createHash } from 'node:crypto';

export interface TaskContractSeedArtifactRef {
  path?: unknown;
  digest?: unknown;
  [key: string]: unknown;
}

export interface TaskContractSeedSourceProvenance {
  utility?: unknown;
  projectId?: unknown;
  generatedAt?: unknown;
  sourceType?: unknown;
  [key: string]: unknown;
}

export interface TaskContractSeed {
  schemaVersion: number;
  kind: 'TASK_CONTRACT_SEED';
  authority: 'prework-only';
  artifactDigest?: unknown;
  sourceProvenance: TaskContractSeedSourceProvenance;
  referencedArtifacts: Record<string, unknown>[];
  objective: string;
  acceptance: string[];
  constraints: string[];
  nonGoals: string[];
  seedDigest: string;
  generatedAt: string;
  [key: string]: unknown;
}

export interface BuildTaskContractSeedInput {
  utility?: unknown;
  projectId?: unknown;
  objective?: unknown;
  acceptance?: unknown;
  constraints?: unknown;
  nonGoals?: unknown;
  artifactDigest?: unknown;
  referencedArtifacts?: TaskContractSeedArtifactRef[];
  generatedAt?: string;
  [key: string]: unknown;
}

export interface ValidateTaskContractSeedResult {
  valid: boolean;
  errors: string[];
}

export class StaleTaskContractSeedError extends Error {
  readonly code = 'STALE_TASK_CONTRACT_SEED';
  readonly errors: string[];

  constructor(errors: string[]) {
    super(`STALE_TASK_CONTRACT_SEED: ${errors.join(', ')}`);
    this.name = 'StaleTaskContractSeedError';
    this.errors = errors;
  }
}

const stringList = (value: unknown): string[] => (
  Array.isArray(value) ? value.map(String) : []
);

const digestJson = (value: unknown): string => (
  `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`
);

const seedBody = ({
  artifactDigest,
  sourceProvenance,
  referencedArtifacts,
  objective,
  acceptance,
  constraints,
  nonGoals,
}: {
  artifactDigest?: unknown;
  sourceProvenance: TaskContractSeedSourceProvenance;
  referencedArtifacts: Record<string, unknown>[];
  objective: string;
  acceptance: string[];
  constraints: string[];
  nonGoals: string[];
}) => ({
  schemaVersion: 1,
  kind: 'TASK_CONTRACT_SEED' as const,
  authority: 'prework-only' as const,
  artifactDigest,
  sourceProvenance,
  referencedArtifacts,
  objective,
  acceptance,
  constraints,
  nonGoals,
});

export const buildTaskContractSeed = ({
  utility,
  projectId,
  objective,
  acceptance = [],
  constraints = [],
  nonGoals = [],
  artifactDigest,
  referencedArtifacts = [],
  generatedAt = new Date().toISOString(),
}: BuildTaskContractSeedInput = {}): TaskContractSeed => {
  const sourceProvenance = {
    utility,
    projectId,
    generatedAt,
    sourceType: 'standalone-prework',
  };
  const body = seedBody({
    artifactDigest,
    sourceProvenance,
    referencedArtifacts: Array.isArray(referencedArtifacts)
      ? referencedArtifacts.map((item) => ({ ...item }))
      : [],
    objective: String(objective || '').trim(),
    acceptance: stringList(acceptance),
    constraints: stringList(constraints),
    nonGoals: stringList(nonGoals),
  });
  return {
    ...body,
    seedDigest: digestJson(body),
    generatedAt,
  };
};

export const validateTaskContractSeed = (
  seed: unknown,
  { objective = null }: { objective?: unknown } = {},
): ValidateTaskContractSeedResult => {
  const errors: string[] = [];
  const candidate = seed && typeof seed === 'object'
    ? seed as Record<string, unknown>
    : null;

  if (!candidate || candidate.kind !== 'TASK_CONTRACT_SEED') errors.push('seed-kind-invalid');
  if (candidate?.authority !== 'prework-only') errors.push('seed-authority-invalid');
  if (!candidate?.seedDigest) errors.push('seed-digest-missing');

  if (candidate?.seedDigest) {
    const {
      seedDigest: _ignored,
      generatedAt: _generatedAt,
      ...withoutDigest
    } = candidate;
    const expected = digestJson(withoutDigest);
    if (expected !== candidate.seedDigest) errors.push('seed-digest-mismatch');
  }

  if (
    objective !== null
    && String(objective).trim() !== String(candidate?.objective || '').trim()
  ) {
    errors.push('stale-seed-objective-conflict');
  }

  return { valid: errors.length === 0, errors };
};

export const assertCurrentSeed = (
  seed: unknown,
  { objective }: { objective?: unknown } = {},
): TaskContractSeed => {
  const result = validateTaskContractSeed(seed, { objective });
  if (!result.valid) throw new StaleTaskContractSeedError(result.errors);
  return seed as TaskContractSeed;
};
