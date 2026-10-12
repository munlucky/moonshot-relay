import { createHash } from 'node:crypto';

export const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
};

export const canonicalDigest = (value: unknown): string => (
  `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`
);

export const digestWithout = (
  value: Record<string, unknown> | null | undefined,
  omitted: readonly string[] = [],
): string => {
  const rest = { ...(value || {}) };
  for (const key of omitted) delete rest[key];
  return canonicalDigest(rest);
};
