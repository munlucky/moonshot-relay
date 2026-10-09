import { createHash } from 'node:crypto';

export const EVIDENCE_IDENTITY_FIELDS = Object.freeze([
  'commandDigest',
  'verifierVersion',
  'sourceInputDigest',
  'artifactDigest',
  'fixtureDigest',
  'environmentFingerprint',
  'verificationScopeDigest',
]);

export const VERIFICATION_SCOPE_FIELD = 'verificationScopeDigest';

const digest = (value) => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;

export const commandDigest = ({ commandRef = '', command = '', args = [] } = {}) =>
  digest({ commandRef: String(commandRef || ''), command: String(command || ''), args: Array.isArray(args) ? args.map(String) : [] });

export const environmentFingerprint = ({ platform = process.platform, arch = process.arch, nodeVersion = process.version, networkPolicy = 'inherited', verifierVersion = 'kernel-proof-v1' } = {}) =>
  digest({ platform, arch, nodeVersion, networkPolicy, verifierVersion });

export const normalizeEvidenceIdentity = (identity = {}, { freshnessInputs = EVIDENCE_IDENTITY_FIELDS } = {}) => {
  const selected = [...new Set(Array.isArray(freshnessInputs) && freshnessInputs.length > 0 ? freshnessInputs : EVIDENCE_IDENTITY_FIELDS)];
  const normalized = {};
  for (const field of selected) normalized[field] = identity[field] ?? null;
  return {
    schemaVersion: 1,
    freshnessInputs: selected,
    values: normalized,
    digest: digest({ freshnessInputs: selected, values: normalized }),
  };
};

export const exactEvidenceIdentityMatch = (previous, current, { freshnessInputs = null } = {}) => {
  const left = previous?.values ? previous : normalizeEvidenceIdentity(previous || {}, { freshnessInputs: freshnessInputs || previous?.freshnessInputs });
  const right = current?.values ? current : normalizeEvidenceIdentity(current || {}, { freshnessInputs: freshnessInputs || current?.freshnessInputs });
  const fields = freshnessInputs || left.freshnessInputs;
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
  environment = {},
  networkPolicy = 'inherited',
  freshnessInputs = EVIDENCE_IDENTITY_FIELDS,
  verificationScopeDigest = null,
} = {}) => normalizeEvidenceIdentity({
  commandDigest: commandDigest({ commandRef, command, args }),
  verifierVersion,
  sourceInputDigest,
  artifactDigest,
  fixtureDigest,
  environmentFingerprint: environment.fingerprint || environmentFingerprint({ ...environment, networkPolicy, verifierVersion }),
  verificationScopeDigest,
}, { freshnessInputs });

export const buildEvidenceReuseReceipt = ({
  runId,
  obligationId,
  priorRunId,
  priorVerificationId,
  mutationRevision,
  identity,
  evidenceDigest,
} = {}) => ({
  schemaVersion: 1,
  receiptType: 'exact-evidence-reuse',
  receiptId: `reuse-${digest({ runId, obligationId, priorRunId, priorVerificationId, mutationRevision }).slice(-32)}`,
  runId,
  obligationId,
  priorRunId,
  priorVerificationId,
  mutationRevision: Number(mutationRevision),
  identity: identity?.digest || identity || null,
  evidenceDigest: evidenceDigest || null,
  reusedAt: new Date().toISOString(),
});

export const canReuseEvidence = ({ previous, current, status = 'passed', mutationRevision } = {}) => Boolean(
  status === 'passed'
  && previous?.status === 'passed'
  && previous?.evidenceDigest
  && exactEvidenceIdentityMatch(previous.evidenceIdentity || previous, current),
);
