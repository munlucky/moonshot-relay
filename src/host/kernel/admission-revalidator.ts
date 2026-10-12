import {
  policyDigests,
  revalidateAdmissionAtDispatch,
  type AdmissionLike,
  type AdmissionPolicyDigests,
} from './route-admission.js';

type UnknownRecord = Record<string, unknown>;

export interface HostPolicyRegistry {
  profiles?: UnknownRecord;
}

export interface CurrentHostPoliciesOptions {
  registry?: (HostPolicyRegistry | null) | undefined;
  capabilities?: (UnknownRecord) | undefined;
  toolPolicy?: (UnknownRecord) | undefined;
  permissionPolicy?: (UnknownRecord) | undefined;
  modelPolicyRevision?: (string) | undefined;
}

export const currentHostPolicies = ({
  registry,
  capabilities = {},
  toolPolicy = {},
  permissionPolicy = {},
  modelPolicyRevision = 'kernel-model-policy.v1',
}: CurrentHostPoliciesOptions = {}): AdmissionPolicyDigests => policyDigests({
  modelPolicyRevision,
  profiles: registry?.profiles || {},
  capabilities,
  toolPolicy,
  permissionPolicy,
});

export const revalidateBeforeDispatch = ({
  admission,
  registry,
  capabilities,
  toolPolicy,
  permissionPolicy,
  modelPolicyRevision,
}: CurrentHostPoliciesOptions & {
  admission?: AdmissionLike | null;
} = {}) => (
  revalidateAdmissionAtDispatch({
    admission,
    policies: currentHostPolicies({
      registry,
      capabilities,
      toolPolicy,
      permissionPolicy,
      modelPolicyRevision,
    }),
  })
);

export { policyDigests };
