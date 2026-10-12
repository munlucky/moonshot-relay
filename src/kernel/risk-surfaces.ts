import { KERNEL_POLICY } from './policy.js';

type ProofTier = 'T0' | 'T1' | 'T2' | 'T3';

interface KernelPolicyLike {
  hardFloors: Record<string, ProofTier>;
}

const policy = KERNEL_POLICY as KernelPolicyLike;

export const RISK_SURFACES = Object.freeze([
  ...new Set([...Object.keys(policy.hardFloors), 'installer']),
]);

const highRiskSet = new Set<string>(RISK_SURFACES);

const surfaceAliases: Readonly<Record<string, string>> = Object.freeze({
  security: 'security_boundary',
  securityboundary: 'security_boundary',
  datamigration: 'data_migration',
  'data-migration': 'data_migration',
  publicapi: 'public_contract',
  'public-api': 'public_contract',
  publiccontract: 'public_contract',
  schema: 'schema_change',
  schemachange: 'schema_change',
  runtimeauthority: 'runtime_authority',
  'runtime-authority': 'runtime_authority',
  installer: 'installer',
});

export const normalizeRiskSurface = (value: unknown): string => {
  const clean = String(value || '').trim();
  const lower = clean.toLowerCase();
  const stripped = lower.replace(/[-_]/g, '');
  return surfaceAliases[stripped] || surfaceAliases[lower] || clean;
};

export const isHighRiskSurface = (surface: unknown) => highRiskSet.has(normalizeRiskSurface(surface));

export const floorForSurface = (surface: unknown): ProofTier | null => (
  policy.hardFloors[normalizeRiskSurface(surface)] || null
);
