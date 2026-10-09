// Evidence plan gating (§8) now lives with the Task Contract, because a plan
// is only meaningful once it is compiled into obligations and persisted.
// This module stays as the stable import surface.
export {
  MissingEvidencePlanError,
  normalizeAcceptance,
  assertEvidencePlans,
  acceptanceStatements,
} from './task-contract.mjs';
