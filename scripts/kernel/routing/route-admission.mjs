// Provider-neutral Route Admission receipt semantics.
//
// The Host owns admission calculation because provider/model/session/cost and
// native capability resolution are execution concerns. Kernel Core only needs
// to understand whether a persisted admission allowed dispatch so Trust can
// reason about execution evidence without importing Host policy.

export const ADMISSION_SCHEMA_VERSION = 1;
export const ADMISSION_DECISIONS = Object.freeze([
  'admitted',
  'fallback_admitted',
  'advisory_admitted',
  'blocked',
  'redecision_required',
]);
export const ADMITTED_DECISIONS = Object.freeze([
  'admitted',
  'fallback_admitted',
  'advisory_admitted',
]);

export const admissionAllowsDispatch = (admission) =>
  ADMITTED_DECISIONS.includes(admission?.decision);
