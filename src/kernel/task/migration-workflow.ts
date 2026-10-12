// Migration workflow (§16.4, §13.2). A migration is high-risk: it forces
// T3, a protected migration-smoke obligation, an explicit rollback path, and
// a declared verification seam. Impact analysis is scoped to the change seam,
// never a full architecture document.

export const MIGRATION_SMOKE_OBLIGATION = 'data-migration-smoke' as const;

export interface MigrationImpactInput {
  changeSeam?: unknown;
  affectedCallers?: unknown;
  affectedContracts?: unknown;
  compatibilityRisks?: unknown;
  migrationRequired?: unknown;
  verificationSeams?: unknown;
  rollback?: unknown;
}

export interface MigrationImpactAnalysis {
  changeSeam: string;
  affectedCallers: unknown[];
  affectedContracts: unknown[];
  compatibilityRisks: unknown[];
  migrationRequired: boolean;
  verificationSeams: unknown[];
  rollback: unknown[];
}

export interface MigrationBlockingFinding {
  code: 'MISSING_CHANGE_SEAM' | 'MISSING_ROLLBACK' | 'MISSING_VERIFICATION_SEAM';
  message: string;
}

export interface MigrationImpactResult {
  analysis: MigrationImpactAnalysis;
  blockingFindings: MigrationBlockingFinding[];
  requiredObligations: typeof MIGRATION_SMOKE_OBLIGATION[];
  requiredTier: 'T3' | null;
}

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

export const buildImpactAnalysis = (
  input: MigrationImpactInput = {},
): MigrationImpactResult => {
  const analysis: MigrationImpactAnalysis = {
    changeSeam: String(input.changeSeam || ''),
    affectedCallers: asArray(input.affectedCallers),
    affectedContracts: asArray(input.affectedContracts),
    compatibilityRisks: asArray(input.compatibilityRisks),
    migrationRequired: Boolean(input.migrationRequired),
    verificationSeams: asArray(input.verificationSeams),
    rollback: asArray(input.rollback),
  };

  const blockingFindings: MigrationBlockingFinding[] = [];
  if (!analysis.changeSeam) {
    blockingFindings.push({
      code: 'MISSING_CHANGE_SEAM',
      message: 'impact analysis requires a change seam',
    });
  }
  if (analysis.migrationRequired) {
    if (analysis.rollback.length === 0) {
      blockingFindings.push({
        code: 'MISSING_ROLLBACK',
        message: 'a required migration must declare a rollback path',
      });
    }
    if (analysis.verificationSeams.length === 0) {
      blockingFindings.push({
        code: 'MISSING_VERIFICATION_SEAM',
        message: 'a required migration must declare a migration-smoke verification seam',
      });
    }
  }

  return {
    analysis,
    blockingFindings,
    requiredObligations: analysis.migrationRequired ? [MIGRATION_SMOKE_OBLIGATION] : [],
    requiredTier: analysis.migrationRequired ? 'T3' : null,
  };
};
