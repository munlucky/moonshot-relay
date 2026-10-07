// Dispatch-time admission revalidation (K3 §8.5). The admission was computed
// from a snapshot of the Host's configuration. This re-reads that configuration
// immediately before the worker starts and refuses to dispatch if it moved:
// a model profile edited between decision and dispatch would otherwise run a
// different model than the one the Kernel admitted.

import { policyDigests, revalidateAdmissionAtDispatch } from './route-admission.mjs';

export const currentHostPolicies = ({
  registry,
  capabilities = {},
  toolPolicy = {},
  permissionPolicy = {},
  modelPolicyRevision = 'kernel-model-policy.v1',
} = {}) => policyDigests({
  modelPolicyRevision,
  profiles: registry?.profiles || {},
  capabilities,
  toolPolicy,
  permissionPolicy,
});

export const revalidateBeforeDispatch = ({ admission, registry, capabilities, toolPolicy, permissionPolicy, modelPolicyRevision } = {}) =>
  revalidateAdmissionAtDispatch({
    admission,
    policies: currentHostPolicies({ registry, capabilities, toolPolicy, permissionPolicy, modelPolicyRevision }),
  });

export { policyDigests };
