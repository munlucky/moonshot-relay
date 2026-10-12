import type { ProofEnvironmentObservation } from '../../../contracts/proof-environment.js';

export const observeProofEnvironment = (): ProofEnvironmentObservation => ({
  platform: process.platform,
  arch: process.arch,
  nodeVersion: process.version,
});
