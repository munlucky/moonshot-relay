// Host-side boundary adapter.
//
// This module is the first Host-owned step after Kernel `next()`. It validates
// the provider-neutral execution contract before the Host resolves model,
// session, worktree, Git, prompt, or cache details.

import {
  HOST_EXECUTION_CONTRACT_SCHEMA_VERSION,
  buildHostExecutionContract,
  validateHostExecutionContract,
} from '../../kernel/run/host-execution-contract.mjs';

export const HOST_BOUNDARY_SCHEMA_VERSION = 1;

export const HOST_EXECUTION_ORDER = Object.freeze([
  'model/provider-policy',
  'prompt-envelope/cache',
  'session-execution',
  'worktree',
  'git',
  'package/profile',
]);

export const normalizeHostBoundaryRequest = ({
  modelInput = {},
  hostDirective = {},
} = {}) => {
  const decision = hostDirective.modelRouteDecision;
  const contract = hostDirective.executionContract
    || buildHostExecutionContract({
      decision,
      assignment: hostDirective.executionAssignment,
      capsule: hostDirective.executionCapsule,
      attemptId: hostDirective.attemptId,
      workUnit: modelInput.action?.step || null,
    });
  validateHostExecutionContract(contract);
  return Object.freeze({
    schemaVersion: HOST_BOUNDARY_SCHEMA_VERSION,
    contractSchemaVersion: HOST_EXECUTION_CONTRACT_SCHEMA_VERSION,
    modelInput,
    hostDirective,
    contract,
  });
};

