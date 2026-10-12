// Session affinity (Wave 4.6 / Wave 7). Analysis → implementation → test → fix
// on one work unit should stay in one session so the provider keeps its warm
// prefix. Anything that changes what the model *is* or what it was told before
// the volatile tail starts a new lineage.

import { createHash } from 'node:crypto';
import { canonicalJson } from '../../shared/canonical-digest.js';

export const SESSION_KEY_FIELDS = Object.freeze([
  'provider',
  'surface',
  'resolvedModel',
  'resolvedEffort',
  'speedMode',
  'role',
  'toolSchemaDigest',
  'commonHostStableDigest',
  'providerStableDigest',
  'projectStableDigest',
  'runStableDigest',
] as const);

export type SessionKeyField = (typeof SESSION_KEY_FIELDS)[number];

export interface SessionIdentity extends Partial<Record<SessionKeyField, unknown>> {
  sessionLineageId?: unknown;
}

const FIELD_RESET_REASON: Readonly<Record<SessionKeyField, string>> = Object.freeze({
  provider: 'provider-changed',
  surface: 'surface-changed',
  role: 'role-changed',
  resolvedModel: 'model-changed',
  resolvedEffort: 'effort-changed',
  speedMode: 'speed-mode-changed',
  toolSchemaDigest: 'tool-schema-changed',
  commonHostStableDigest: 'common-host-stable-changed',
  providerStableDigest: 'provider-stable-changed',
  projectStableDigest: 'project-stable-changed',
  runStableDigest: 'run-stable-changed',
});

for (const field of SESSION_KEY_FIELDS) {
  if (!Object.hasOwn(FIELD_RESET_REASON, field)) {
    throw new Error(
      `session-affinity: SESSION_KEY_FIELDS entry "${field}" has no FIELD_RESET_REASON`,
    );
  }
}

export const LINEAGE_RESET_REASONS = Object.freeze([
  ...Object.values(FIELD_RESET_REASON),
  'independent-context-required',
  'reviewer-turn',
  'explicit-reset',
].sort());

const pick = (
  identity: SessionIdentity = {},
): Record<SessionKeyField, unknown> => (
  Object.fromEntries(
    SESSION_KEY_FIELDS.map((field) => [field, identity[field] ?? null]),
  ) as Record<SessionKeyField, unknown>
);

export const buildSessionAffinityKey = (
  identity: SessionIdentity = {},
): string => (
  `session-${createHash('sha256')
    .update(canonicalJson(pick(identity)))
    .digest('hex')
    .slice(0, 32)}`
);

const mintResetLineageId = (
  key: string,
  previousLineageId: unknown,
): string => (
  `session-${createHash('sha256')
    .update(`${key}|reset|${String(previousLineageId || '')}`)
    .digest('hex')
    .slice(0, 32)}`
);

export interface SessionLineageResolution {
  schemaVersion: 1;
  sessionAffinityKey: string;
  sessionLineageId: string;
  continued: boolean;
  resetReasons: readonly string[];
}

export const resolveSessionLineage = ({
  previous = null,
  current = {},
  independentContextRequired = false,
  role = null,
  explicitReset = false,
  instanceSeed = null,
}: {
  previous?: SessionIdentity | null;
  current?: SessionIdentity;
  independentContextRequired?: boolean;
  role?: unknown;
  explicitReset?: boolean;
  instanceSeed?: unknown;
} = {}): Readonly<SessionLineageResolution> => {
  const key = buildSessionAffinityKey(current);
  const reasons: string[] = [];

  if (previous) {
    for (const [field, reason] of Object.entries(FIELD_RESET_REASON) as Array<
      [SessionKeyField, string]
    >) {
      if ((previous[field] ?? null) !== (current[field] ?? null)) {
        reasons.push(reason);
      }
    }
  }
  if (independentContextRequired) {
    reasons.push('independent-context-required');
  }
  if ((role || current.role) === 'reviewer') {
    reasons.push('reviewer-turn');
  }
  if (explicitReset) {
    reasons.push('explicit-reset');
  }

  const unique = [...new Set(reasons)].sort();
  const continued = Boolean(previous) && unique.length === 0;
  const keyFieldsChanged = Boolean(previous)
    && key !== buildSessionAffinityKey(previous || {});
  const forcedWithSameKey = !continued && Boolean(previous) && !keyFieldsChanged;

  let sessionLineageId: string;
  if (continued && previous) {
    sessionLineageId = previous.sessionLineageId
      ? String(previous.sessionLineageId)
      : key;
  } else if (forcedWithSameKey && previous) {
    sessionLineageId = mintResetLineageId(key, previous.sessionLineageId);
  } else if (!previous && instanceSeed) {
    sessionLineageId = mintResetLineageId(key, instanceSeed);
  } else {
    sessionLineageId = key;
  }

  return Object.freeze({
    schemaVersion: 1 as const,
    sessionAffinityKey: key,
    sessionLineageId,
    continued,
    resetReasons: Object.freeze(unique),
  });
};
