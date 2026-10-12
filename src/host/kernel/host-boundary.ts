// Host-side boundary adapter.
//
// This module is the first Host-owned step after Kernel `next()`. It validates
// the provider-neutral execution contract before the Host resolves model,
// session, worktree, Git, prompt, or cache details.

import {
  HOST_EXECUTION_CONTRACT_SCHEMA_VERSION,
  buildHostExecutionContract,
  validateHostExecutionContract,
} from '../../contracts/host-execution-contract.js';
import type {
  BuildHostExecutionContractInput,
  HostWorkUnitInput,
} from '../../contracts/host-execution-contract.js';

export const HOST_BOUNDARY_SCHEMA_VERSION = 1;

export const HOST_EXECUTION_ORDER = Object.freeze([
  'model/provider-policy',
  'prompt-envelope/cache',
  'session-execution',
  'worktree',
  'git',
  'package/profile',
] as const);

interface HostBoundaryModelInput {
  action?: {
    step?: (HostWorkUnitInput & { stepId?: string | null }) | null;
  } | null;
  [key: string]: unknown;
}

interface HostBoundaryDirective {
  modelRouteDecision?: BuildHostExecutionContractInput['decision'];
  executionAssignment?: BuildHostExecutionContractInput['assignment'];
  executionCapsule?: BuildHostExecutionContractInput['capsule'];
  attemptId?: unknown;
  executionContract?: unknown;
  [key: string]: unknown;
}

export const normalizeHostBoundaryRequest = ({
  modelInput = {},
  hostDirective = {},
}: {
  modelInput?: HostBoundaryModelInput;
  hostDirective?: HostBoundaryDirective;
} = {}) => {
  const candidate = hostDirective.executionContract
    || buildHostExecutionContract({
      decision: hostDirective.modelRouteDecision,
      assignment: hostDirective.executionAssignment,
      capsule: hostDirective.executionCapsule,
      attemptId: hostDirective.attemptId,
      workUnit: modelInput.action?.step || null,
    });
  const contract = validateHostExecutionContract(candidate);
  return Object.freeze({
    schemaVersion: HOST_BOUNDARY_SCHEMA_VERSION,
    contractSchemaVersion: HOST_EXECUTION_CONTRACT_SCHEMA_VERSION,
    modelInput,
    hostDirective,
    contract,
  });
};
