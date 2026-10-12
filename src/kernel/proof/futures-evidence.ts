import type {
  FuturesDependencyBoundary,
  FuturesEvidence,
  FuturesEvidenceIncompleteReason,
  FuturesEvidenceInput,
} from '../../contracts/futures-evidence.js';
import { canonicalDigest, canonicalJson } from '../../shared/canonical-digest.js';

const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const WINDOWS_ABSOLUTE = /^[a-zA-Z]:\//u;

const invalid = (field: string): never => {
  throw new TypeError(`futures_evidence_invalid:${field}`);
};

const requiredText = (value: unknown, field: string): string => {
  if (typeof value !== 'string') invalid(field);
  const text = (value as string).trim();
  if (!text) invalid(field);
  return text;
};

const revisionText = (value: unknown): string => {
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 0) invalid('revision');
    return String(value);
  }
  return requiredText(value, 'revision');
};

const relativePath = (value: unknown, field: string): string => {
  const raw = requiredText(value, field).replaceAll('\\', '/');
  if (
    raw.includes('\0')
    || raw.startsWith('/')
    || WINDOWS_ABSOLUTE.test(raw)
  ) {
    invalid(field);
  }
  const parts = raw.split('/').filter((part) => part && part !== '.');
  if (parts.length === 0 || parts.includes('..')) invalid(field);
  return parts.join('/');
};

const sortedUniqueText = (
  value: unknown,
  field: string,
): readonly string[] => {
  if (!Array.isArray(value)) invalid(field);
  const entries = value as unknown[];
  return Object.freeze([
    ...new Set(entries.map((entry) => requiredText(entry, field))),
  ].sort());
};

const sortedUniquePaths = (
  value: unknown,
  field: string,
): readonly string[] => {
  if (!Array.isArray(value)) invalid(field);
  const entries = value as unknown[];
  return Object.freeze([
    ...new Set(entries.map((entry) => relativePath(entry, field))),
  ].sort());
};

const dependencyBoundaries = (
  value: FuturesEvidenceInput['dependencyBoundaries'],
): readonly Readonly<FuturesDependencyBoundary>[] | null => {
  if (value === null) return null;
  if (!Array.isArray(value)) invalid('dependencyBoundaries');
  const normalized = value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      invalid(`dependencyBoundaries[${index}]`);
    }
    return Object.freeze({
      fromPath: relativePath(entry.fromPath, `dependencyBoundaries[${index}].fromPath`),
      toPath: relativePath(entry.toPath, `dependencyBoundaries[${index}].toPath`),
    });
  });
  const unique = new Map(normalized.map((entry) => [canonicalJson(entry), entry]));
  return Object.freeze([...unique.values()].sort((left, right) => (
    canonicalJson(left).localeCompare(canonicalJson(right))
  )));
};

export const collectFuturesEvidence = (
  input: FuturesEvidenceInput,
): Readonly<FuturesEvidence> => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    invalid('input');
  }
  const revision = revisionText(input.revision);
  const contentDigest = requiredText(input.contentDigest, 'contentDigest');
  if (!SHA256.test(contentDigest)) invalid('contentDigest');

  const changeSet = input.changeSet;
  if (!changeSet || typeof changeSet !== 'object' || Array.isArray(changeSet)) {
    invalid('changeSet');
  }
  if (changeSet.status !== 'observed' && changeSet.status !== 'unavailable') {
    invalid('changeSet.status');
  }
  const changedPaths = changeSet.status === 'observed'
    ? sortedUniquePaths(changeSet.actualChangedPaths, 'changeSet.actualChangedPaths')
    : null;
  if (changeSet.status === 'unavailable' && changeSet.actualChangedPaths !== null) {
    invalid('changeSet.actualChangedPaths');
  }
  const changeReason = changeSet.status === 'unavailable'
    ? requiredText(changeSet.reason, 'changeSet.reason')
    : null;

  const boundaries = dependencyBoundaries(input.dependencyBoundaries);
  const regressionScope = input.regressionScope === null
    ? null
    : sortedUniqueText(input.regressionScope, 'regressionScope');
  const unknowns = sortedUniqueText(input.unknowns, 'unknowns');

  const incompleteReasons: FuturesEvidenceIncompleteReason[] = [];
  if (changedPaths === null) incompleteReasons.push('changed-paths-unavailable');
  if (boundaries === null) incompleteReasons.push('dependency-boundaries-unavailable');
  if (regressionScope === null) incompleteReasons.push('regression-scope-unavailable');
  if (unknowns.length > 0) incompleteReasons.push('unresolved-unknowns');

  const evidenceWithoutDigest = {
    schemaVersion: 1 as const,
    revision,
    contentDigest,
    changeObservation: Object.freeze({
      status: changeSet.status,
      reason: changeReason,
      changedPaths,
    }),
    dependencyBoundaries: boundaries,
    regressionScope,
    unknowns,
    status: incompleteReasons.length === 0 ? 'complete' as const : 'incomplete' as const,
    incompleteReasons: Object.freeze([...incompleteReasons]),
  };

  return Object.freeze({
    ...evidenceWithoutDigest,
    digest: canonicalDigest(evidenceWithoutDigest),
  });
};
