import { createHash } from 'node:crypto';
import type { ProofEnvironmentObservation } from '../../contracts/proof-environment.js';

export const EVIDENCE_IDENTITY_FIELDS = Object.freeze([
  'commandDigest',
  'verifierVersion',
  'sourceInputDigest',
  'artifactDigest',
  'fixtureDigest',
  'environmentFingerprint',
  'verificationScopeDigest',
] as const);

export type EvidenceIdentityField = typeof EVIDENCE_IDENTITY_FIELDS[number];

export const VERIFICATION_SCOPE_FIELD: EvidenceIdentityField = 'verificationScopeDigest';

type EvidenceIdentityValues = Partial<Record<EvidenceIdentityField, unknown>> & Record<string, unknown>;

export type NormalizedEvidenceIdentity = {
  schemaVersion: 1;
  freshnessInputs: string[];
  values: Record<string, unknown>;
  digest: string;
}

export interface ProofEnvironmentInput extends Partial<ProofEnvironmentObservation> {
  fingerprint?: string;
}

export interface BuildEvidenceIdentityInput {
  commandRef?: (unknown) | undefined;
  command?: unknown;
  args?: unknown[];
  verifierVersion?: string;
  sourceInputDigest?: unknown;
  artifactDigest?: unknown;
  fixtureDigest?: unknown;
  environment?: ProofEnvironmentInput | null;
  networkPolicy?: unknown;
  freshnessInputs?: (readonly string[]) | undefined;
  verificationScopeDigest?: unknown;
}

export interface EvidenceReuseSource {
  status?: unknown;
  evidenceDigest?: unknown;
  evidenceIdentity?: unknown;
  values?: Record<string, unknown>;
  freshnessInputs?: string[];
}

const digest = (value: unknown): string => (
  `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`
);

export const commandDigest = ({
  commandRef = '',
  command = '',
  args = [],
}: {
  commandRef?: unknown;
  command?: unknown;
  args?: unknown[];
} = {}): string => digest({
  commandRef: String(commandRef || ''),
  command: String(command || ''),
  args: Array.isArray(args) ? args.map(String) : [],
});

export const environmentFingerprint = ({
  platform,
  arch,
  nodeVersion,
  networkPolicy = 'inherited',
  verifierVersion = 'kernel-proof-v1',
}: { [K in keyof ProofEnvironmentObservation]?: ProofEnvironmentObservation[K] | undefined } & {
  networkPolicy?: unknown;
  verifierVersion?: unknown;
} = {}): string => {
  if (!platform || !arch || !nodeVersion) {
    throw Object.assign(new Error('proof_environment_observation_required'), {
      code: 'PROOF_ENVIRONMENT_OBSERVATION_REQUIRED',
    });
  }
  return digest({
    platform: String(platform),
    arch: String(arch),
    nodeVersion: String(nodeVersion),
    networkPolicy: String(networkPolicy || 'inherited'),
    verifierVersion: String(verifierVersion || 'kernel-proof-v1'),
  });
};

export const normalizeEvidenceIdentity = (
  identity: EvidenceIdentityValues = {},
  { freshnessInputs = EVIDENCE_IDENTITY_FIELDS }: { freshnessInputs?: (readonly string[]) | undefined } = {},
): NormalizedEvidenceIdentity => {
  const selected = [...new Set(
    Array.isArray(freshnessInputs) && freshnessInputs.length > 0
      ? freshnessInputs.map(String)
      : [...EVIDENCE_IDENTITY_FIELDS],
  )];
  const normalized: Record<string, unknown> = {};
  for (const field of selected) normalized[field] = identity[field] ?? null;
  return {
    schemaVersion: 1,
    freshnessInputs: selected,
    values: normalized,
    digest: digest({ freshnessInputs: selected, values: normalized }),
  };
};

const asNormalizedIdentity = (
  value: unknown,
  freshnessInputs?: readonly string[] | null,
): NormalizedEvidenceIdentity => {
  if (
    value
    && typeof value === 'object'
    && 'values' in value
    && 'freshnessInputs' in value
    && 'digest' in value
  ) return value as NormalizedEvidenceIdentity;

  return normalizeEvidenceIdentity(
    value && typeof value === 'object' ? value as EvidenceIdentityValues : {},
    { freshnessInputs: freshnessInputs || undefined },
  );
};

export const exactEvidenceIdentityMatch = (
  previous: unknown,
  current: unknown,
  { freshnessInputs = null }: { freshnessInputs?: readonly string[] | null } = {},
): boolean => {
  const previousInputs = previous && typeof previous === 'object' && 'freshnessInputs' in previous
    ? (previous as { freshnessInputs?: string[] }).freshnessInputs
    : undefined;
  const currentInputs = current && typeof current === 'object' && 'freshnessInputs' in current
    ? (current as { freshnessInputs?: string[] }).freshnessInputs
    : undefined;
  const left = asNormalizedIdentity(previous, freshnessInputs || previousInputs);
  const right = asNormalizedIdentity(current, freshnessInputs || currentInputs);
  const fields = freshnessInputs ? freshnessInputs.map(String) : left.freshnessInputs;
  if (JSON.stringify(fields) !== JSON.stringify(right.freshnessInputs)) return false;
  return fields.every((field) => left.values[field] === right.values[field]);
};

export const buildEvidenceIdentity = ({
  commandRef,
  command,
  args = [],
  verifierVersion = 'kernel-proof-v1',
  sourceInputDigest = null,
  artifactDigest = null,
  fixtureDigest = null,
  environment = null,
  networkPolicy = 'inherited',
  freshnessInputs = EVIDENCE_IDENTITY_FIELDS,
  verificationScopeDigest = null,
}: BuildEvidenceIdentityInput = {}): NormalizedEvidenceIdentity => {
  const observedEnvironment = environment?.fingerprint
    ? environment.fingerprint
    : environmentFingerprint({
        platform: environment?.platform,
        arch: environment?.arch,
        nodeVersion: environment?.nodeVersion,
        networkPolicy,
        verifierVersion,
      });

  return normalizeEvidenceIdentity({
    commandDigest: commandDigest({ commandRef, command, args }),
    verifierVersion,
    sourceInputDigest,
    artifactDigest,
    fixtureDigest,
    environmentFingerprint: observedEnvironment,
    verificationScopeDigest,
  }, { freshnessInputs });
};

export const buildEvidenceReuseReceipt = ({
  runId,
  obligationId,
  priorRunId,
  priorVerificationId,
  mutationRevision,
  identity,
  evidenceDigest,
}: {
  runId?: unknown;
  obligationId?: unknown;
  priorRunId?: unknown;
  priorVerificationId?: unknown;
  mutationRevision?: unknown;
  identity?: unknown;
  evidenceDigest?: unknown;
} = {}) => ({
  schemaVersion: 1 as const,
  receiptType: 'exact-evidence-reuse' as const,
  receiptId: `reuse-${digest({
    runId,
    obligationId,
    priorRunId,
    priorVerificationId,
    mutationRevision,
  }).slice(-32)}`,
  runId,
  obligationId,
  priorRunId,
  priorVerificationId,
  mutationRevision: Number(mutationRevision),
  identity: identity && typeof identity === 'object' && 'digest' in identity
    ? (identity as { digest?: unknown }).digest || null
    : identity || null,
  evidenceDigest: evidenceDigest || null,
  reusedAt: new Date().toISOString(),
});

export const canReuseEvidence = ({
  previous,
  current,
  status = 'passed',
}: {
  previous?: EvidenceReuseSource | null;
  current?: unknown;
  status?: unknown;
  mutationRevision?: unknown;
} = {}): boolean => Boolean(
  status === 'passed'
  && previous?.status === 'passed'
  && previous?.evidenceDigest
  && exactEvidenceIdentityMatch(previous.evidenceIdentity || previous, current),
);
