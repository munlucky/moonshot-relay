// Generated from src/contracts/task-contract-seed.ts. Edit the source and run npm run build.
import { createHash } from 'node:crypto';
export class StaleTaskContractSeedError extends Error {
    code = 'STALE_TASK_CONTRACT_SEED';
    errors;
    constructor(errors) {
        super(`STALE_TASK_CONTRACT_SEED: ${errors.join(', ')}`);
        this.name = 'StaleTaskContractSeedError';
        this.errors = errors;
    }
}
const stringList = (value) => (Array.isArray(value) ? value.map(String) : []);
const digestJson = (value) => (`sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`);
const seedBody = ({ artifactDigest, sourceProvenance, referencedArtifacts, objective, acceptance, constraints, nonGoals, }) => ({
    schemaVersion: 1,
    kind: 'TASK_CONTRACT_SEED',
    authority: 'prework-only',
    artifactDigest,
    sourceProvenance,
    referencedArtifacts,
    objective,
    acceptance,
    constraints,
    nonGoals,
});
export const buildTaskContractSeed = ({ utility, projectId, objective, acceptance = [], constraints = [], nonGoals = [], artifactDigest, referencedArtifacts = [], generatedAt = new Date().toISOString(), } = {}) => {
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
export const validateTaskContractSeed = (seed, { objective = null } = {}) => {
    const errors = [];
    const candidate = seed && typeof seed === 'object'
        ? seed
        : null;
    if (!candidate || candidate.kind !== 'TASK_CONTRACT_SEED')
        errors.push('seed-kind-invalid');
    if (candidate?.authority !== 'prework-only')
        errors.push('seed-authority-invalid');
    if (!candidate?.seedDigest)
        errors.push('seed-digest-missing');
    if (candidate?.seedDigest) {
        const { seedDigest: _ignored, generatedAt: _generatedAt, ...withoutDigest } = candidate;
        const expected = digestJson(withoutDigest);
        if (expected !== candidate.seedDigest)
            errors.push('seed-digest-mismatch');
    }
    if (objective !== null
        && String(objective).trim() !== String(candidate?.objective || '').trim()) {
        errors.push('stale-seed-objective-conflict');
    }
    return { valid: errors.length === 0, errors };
};
export const assertCurrentSeed = (seed, { objective } = {}) => {
    const result = validateTaskContractSeed(seed, { objective });
    if (!result.valid)
        throw new StaleTaskContractSeedError(result.errors);
    return seed;
};
