import { requiredIndex } from '../shared/required-index.js';
import { createHash } from 'node:crypto';

type JsonRecord = Record<string, unknown>;

export const PROFILE_OWNERSHIP = Object.freeze({
  OWNED_FILE: 'owned-file',
  OWNED_DIRECTORY: 'owned-directory',
  JSON_PATHS: 'json-paths',
  MANAGED_SECTION: 'managed-section',
});

export const MANAGED_SECTION_ID = 'moon-relay-kernel';

export interface ManagedSectionInspection {
  status: 'missing' | 'collision' | 'present';
  body: string | null;
  digest: string | null;
  start: string;
  end: string;
  reason?: string;
  startIndex?: number;
  endIndex?: number;
}

export interface JsonPathResolution {
  present: boolean;
  value: unknown;
  parent: JsonRecord | null;
  key: string | null;
}

export interface JsonOwnershipEntry {
  ownedPaths?: string[];
  ownedPathDigests?: Record<string, string>;
  ownedArrayDigests?: Record<string, string[]>;
}

export interface JsonOwnershipFailure {
  ownedPath: string;
  reason: string;
}

class ManagedSectionCollisionError extends Error {
  readonly code = 'managed_section_collision';
  readonly reason?: string | undefined;

  constructor(sectionId: string, reason?: string) {
    super(`managed_section_collision: ${sectionId}`);
    this.name = 'ManagedSectionCollisionError';
    this.reason = reason;
  }
}

export const managedSectionMarkers = (
  sectionId = MANAGED_SECTION_ID,
): { start: string; end: string } => ({
  start: `<!-- ${sectionId}:start -->`,
  end: `<!-- ${sectionId}:end -->`,
});

export const valueDigest = (value: unknown): string => (
  createHash('sha256').update(JSON.stringify(value)).digest('hex')
);

const countOccurrences = (text: unknown, marker: string): number => (
  String(text).split(marker).length - 1
);

export const inspectManagedSection = (
  text: unknown,
  sectionId = MANAGED_SECTION_ID,
): ManagedSectionInspection => {
  const target = String(text || '');
  const { start, end } = managedSectionMarkers(sectionId);
  const starts = countOccurrences(target, start);
  const ends = countOccurrences(target, end);

  if (starts === 0 && ends === 0) {
    return {
      status: 'missing',
      body: null,
      digest: null,
      start,
      end,
    };
  }
  if (starts !== 1 || ends !== 1) {
    return {
      status: 'collision',
      body: null,
      digest: null,
      start,
      end,
      reason: 'managed-section-markers-invalid',
    };
  }

  const startIndex = target.indexOf(start);
  const endIndex = target.indexOf(end);
  if (endIndex < startIndex + start.length) {
    return {
      status: 'collision',
      body: null,
      digest: null,
      start,
      end,
      reason: 'managed-section-order-invalid',
    };
  }

  const body = target
    .slice(startIndex + start.length, endIndex)
    .replace(/^\r?\n/, '')
    .replace(/\r?\n$/, '');

  return {
    status: 'present',
    body,
    digest: valueDigest(body),
    start,
    end,
    startIndex,
    endIndex,
  };
};

export const renderManagedSection = (
  incoming: unknown,
  sectionId = MANAGED_SECTION_ID,
): string => {
  const { start, end } = managedSectionMarkers(sectionId);
  const body = String(incoming || '').trim();
  return `${start}\n${body}\n${end}`;
};

export const mergeManagedSection = (
  existing: unknown,
  incoming: unknown,
  sectionId = MANAGED_SECTION_ID,
): string => {
  const target = String(existing || '');
  const inspected = inspectManagedSection(target, sectionId);
  const block = renderManagedSection(incoming, sectionId);

  if (inspected.status === 'collision') {
    throw new ManagedSectionCollisionError(sectionId, inspected.reason);
  }
  if (inspected.status === 'missing') {
    const trimmed = target.trimEnd();
    return trimmed ? `${trimmed}\n\n${block}\n` : `${block}\n`;
  }

  const startIndex = inspected.startIndex ?? 0;
  const endIndex = inspected.endIndex ?? startIndex;
  const prefix = target.slice(0, startIndex).trimEnd();
  const suffix = target
    .slice(endIndex + inspected.end.length)
    .trimStart();
  return [...[prefix, block, suffix].filter(Boolean), ''].join('\n\n');
};

export const removeManagedSection = (
  existing: unknown,
  sectionId = MANAGED_SECTION_ID,
) => {
  const target = String(existing || '');
  const inspected = inspectManagedSection(target, sectionId);
  if (inspected.status === 'missing') {
    return { text: target, status: 'missing' as const };
  }
  if (inspected.status === 'collision') {
    throw new ManagedSectionCollisionError(sectionId, inspected.reason);
  }

  const startIndex = inspected.startIndex ?? 0;
  const endIndex = inspected.endIndex ?? startIndex;
  const before = target
    .slice(0, startIndex)
    .replace(/[ \t]*\r?\n?$/, '');
  const after = target
    .slice(endIndex + inspected.end.length)
    .replace(/^\r?\n?\s*/, '');
  const text = before && after
    ? `${before}\n\n${after}\n`
    : before
      ? `${before}\n`
      : after
        ? `${after}\n`
        : '';

  return {
    text,
    status: 'removed' as const,
    body: inspected.body,
    digest: inspected.digest,
  };
};

const pathSegments = (jsonPath: unknown): string[] => (
  String(jsonPath || '').split('.').filter(Boolean)
);

const asIndexable = (value: object): JsonRecord => (
  value as JsonRecord
);

export const getJsonPath = (
  value: unknown,
  jsonPath: unknown,
): JsonPathResolution => {
  const segments = pathSegments(jsonPath);
  if (segments.length === 0) {
    return {
      present: true,
      value,
      parent: null,
      key: null,
    };
  }

  let current: unknown = value;
  for (let index = 0; index < segments.length; index += 1) {
    const key = requiredIndex(segments, index);
    if (!current || typeof current !== 'object') {
      return {
        present: false,
        value: undefined,
        parent: null,
        key: segments.at(-1) || null,
      };
    }
    const record = asIndexable(current);
    if (!(key in record)) {
      return {
        present: false,
        value: undefined,
        parent: null,
        key: segments.at(-1) || null,
      };
    }
    if (index === segments.length - 1) {
      return {
        present: true,
        value: record[key],
        parent: record,
        key,
      };
    }
    current = record[key];
  }

  return {
    present: false,
    value: undefined,
    parent: null,
    key: segments.at(-1) || null,
  };
};

export const deleteJsonPath = (
  value: unknown,
  jsonPath: unknown,
): boolean => {
  const resolved = getJsonPath(value, jsonPath);
  if (!resolved.present || !resolved.parent || !resolved.key) return false;
  delete resolved.parent[resolved.key];
  return true;
};

export const isKernelHookEntry = (value: unknown): boolean => {
  if (Array.isArray(value)) return value.some(isKernelHookEntry);
  if (!value || typeof value !== 'object') return false;

  const record = asIndexable(value);
  if (
    typeof record.command === 'string'
    && /assert-track\b/.test(record.command)
  ) {
    return true;
  }
  return Object.values(record).some(isKernelHookEntry);
};

export const collectJsonPathOwnership = (
  value: unknown,
  jsonPath: string,
  { array = false }: { array?: boolean } = {},
) => {
  const resolved = getJsonPath(value, jsonPath);
  if (!resolved.present) {
    return { path: jsonPath, digest: null, arrayDigests: [] as string[] };
  }
  if (array && Array.isArray(resolved.value)) {
    return {
      path: jsonPath,
      digest: null,
      arrayDigests: resolved.value
        .filter(isKernelHookEntry)
        .map(valueDigest),
    };
  }
  return {
    path: jsonPath,
    digest: valueDigest(resolved.value),
    arrayDigests: [] as string[],
  };
};

export const inspectJsonOwnership = (
  value: unknown,
  entry: JsonOwnershipEntry,
): JsonOwnershipFailure[] => {
  const failures: JsonOwnershipFailure[] = [];
  for (const jsonPath of entry.ownedPaths || []) {
    const resolved = getJsonPath(value, jsonPath);
    const expectedDigest = entry.ownedPathDigests?.[jsonPath];
    const expectedArrayDigests = entry.ownedArrayDigests?.[jsonPath] || [];

    if (!resolved.present) {
      failures.push({
        ownedPath: jsonPath,
        reason: 'owned-path-missing',
      });
      continue;
    }

    if (Object.hasOwn(entry.ownedArrayDigests || {}, jsonPath)) {
      if (!Array.isArray(resolved.value)) {
        failures.push({
          ownedPath: jsonPath,
          reason: 'owned-array-type-changed',
        });
        continue;
      }

      const actualDigests = resolved.value.map(valueDigest);
      for (const expected of expectedArrayDigests) {
        if (!actualDigests.includes(expected)) {
          failures.push({
            ownedPath: jsonPath,
            reason: 'owned-array-entry-changed',
          });
        }
      }
      if (
        resolved.value.some(
          (item) => isKernelHookEntry(item)
            && !expectedArrayDigests.includes(valueDigest(item)),
        )
      ) {
        failures.push({
          ownedPath: jsonPath,
          reason: 'owned-array-entry-changed',
        });
      }
      continue;
    }

    if (
      expectedDigest
      && valueDigest(resolved.value) !== expectedDigest
    ) {
      failures.push({
        ownedPath: jsonPath,
        reason: 'owned-path-modified',
      });
    }
  }
  return failures;
};

export const removeJsonOwnership = (
  value: unknown,
  entry: JsonOwnershipEntry,
): {
  value: unknown;
  failures: JsonOwnershipFailure[];
  changed: boolean;
} => {
  const failures = inspectJsonOwnership(value, entry);
  if (failures.length > 0) {
    return { value, failures, changed: false };
  }

  let changed = false;
  for (const jsonPath of entry.ownedPaths || []) {
    const resolved = getJsonPath(value, jsonPath);
    const expectedArrayDigests = entry.ownedArrayDigests?.[jsonPath] || [];
    if (!resolved.present) continue;

    if (
      Object.hasOwn(entry.ownedArrayDigests || {}, jsonPath)
      && Array.isArray(resolved.value)
      && resolved.parent
      && resolved.key
    ) {
      const retained = resolved.value.filter(
        (item) => !expectedArrayDigests.includes(valueDigest(item)),
      );
      if (retained.length !== resolved.value.length) {
        resolved.parent[resolved.key] = retained;
        changed = true;
      }
    } else if (deleteJsonPath(value, jsonPath)) {
      changed = true;
    }
  }

  return { value, failures: [], changed };
};
