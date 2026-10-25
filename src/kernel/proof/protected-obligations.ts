import { KERNEL_POLICY } from '../policy.js';

type UnknownRecord = Record<string, unknown>;

const asRecord = (value: unknown): UnknownRecord => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : {}
);

// Protection is explicit policy metadata. Obligation names are identifiers,
// not a second domain classifier.
export const isProtectedObligation = (obligationId: unknown = '') => {
  const value = asRecord(asRecord(asRecord(KERNEL_POLICY).obligations)[String(obligationId)]).protected;
  return value === true || value === 'true';
};

export const assertWaiverAllowed = (
  obligationId: unknown,
  declaredProtected: unknown = false,
) => {
  if (declaredProtected === true || isProtectedObligation(obligationId)) {
    throw new Error(
      'PROTECTED_OBLIGATION_WAIVER_FORBIDDEN: ' + String(obligationId) + ' requires real evidence and cannot be waived',
    );
  }
};
