const PROTECTED_PATTERNS = [
  /\bauth(entication|orization)?\b/i,
  /\bpay(ment|ments)?\b|\bbilling\b|\bcheckout\b/i,
  /\bmigration\b|\bmigrate\b/i,
  /\bdata[-_ ]?loss\b|\bbackup\b|\brestore\b/i,
  /\bsecurity\b|\bsecret\b|\bcredential\b/i,
  /\bcore[-_ ]?(scenario|flow|journey)\b/i,
] as const;

export const isProtectedObligation = (obligationId: unknown = '') => {
  const value = String(obligationId);
  return PROTECTED_PATTERNS.some((pattern) => pattern.test(value));
};
