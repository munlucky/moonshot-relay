// Obligation categories that a waiver can never auto-complete (§17.6): the
// run cannot silently pass these on a waiver, only on real hard evidence.
const PROTECTED_PATTERNS = [
  /\bauth(entication|orization)?\b/i,
  /\bpay(ment|ments)?\b|\bbilling\b|\bcheckout\b/i,
  /\bmigration\b|\bmigrate\b/i,
  /\bdata[-_ ]?loss\b|\bbackup\b|\brestore\b/i,
  /\bsecurity\b|\bsecret\b|\bcredential\b/i,
  /\bcore[-_ ]?(scenario|flow|journey)\b/i,
];

export const isProtectedObligation = (obligationId = '') => {
  const value = String(obligationId);
  return PROTECTED_PATTERNS.some((pattern) => pattern.test(value));
};
