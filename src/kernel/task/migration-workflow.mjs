// Migration workflow (§16.4, §13.2). A migration is high-risk: it forces
// T3, a protected migration-smoke obligation, an explicit rollback path, and
// a declared verification seam. Impact analysis is scoped to the change seam,
// never a full architecture document.

export const MIGRATION_SMOKE_OBLIGATION = 'data-migration-smoke';

const asArray = (value) => (Array.isArray(value) ? value : []);

// Validates the change-seam impact analysis and, when a migration is required,
// asserts the rollback path and migration-smoke seam are present. Missing
// safety nets are returned as blocking findings rather than silently accepted.
export const buildImpactAnalysis = (input = {}) => {
  const analysis = {
    changeSeam: input.changeSeam || '',
    affectedCallers: asArray(input.affectedCallers),
    affectedContracts: asArray(input.affectedContracts),
    compatibilityRisks: asArray(input.compatibilityRisks),
    migrationRequired: Boolean(input.migrationRequired),
    verificationSeams: asArray(input.verificationSeams),
    rollback: asArray(input.rollback),
  };

  const blockingFindings = [];
  if (!analysis.changeSeam) {
    blockingFindings.push({ code: 'MISSING_CHANGE_SEAM', message: 'impact analysis requires a change seam' });
  }
  if (analysis.migrationRequired) {
    if (analysis.rollback.length === 0) {
      blockingFindings.push({ code: 'MISSING_ROLLBACK', message: 'a required migration must declare a rollback path' });
    }
    if (analysis.verificationSeams.length === 0) {
      blockingFindings.push({ code: 'MISSING_VERIFICATION_SEAM', message: 'a required migration must declare a migration-smoke verification seam' });
    }
  }

  return {
    analysis,
    blockingFindings,
    // A required migration always carries the protected smoke obligation.
    requiredObligations: analysis.migrationRequired ? [MIGRATION_SMOKE_OBLIGATION] : [],
    requiredTier: analysis.migrationRequired ? 'T3' : null,
  };
};
