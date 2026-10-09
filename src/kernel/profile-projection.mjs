import { createHash } from 'node:crypto';

export const PROFILE_OWNERSHIP = Object.freeze({
  OWNED_FILE: 'owned-file',
  OWNED_DIRECTORY: 'owned-directory',
  JSON_PATHS: 'json-paths',
  MANAGED_SECTION: 'managed-section',
});

export const MANAGED_SECTION_ID = 'moon-relay-kernel';

export const managedSectionMarkers = (sectionId = MANAGED_SECTION_ID) => ({
  start: `<!-- ${sectionId}:start -->`,
  end: `<!-- ${sectionId}:end -->`,
});

export const valueDigest = (value) => createHash('sha256')
  .update(JSON.stringify(value))
  .digest('hex');

const countOccurrences = (text, marker) => String(text).split(marker).length - 1;

export const inspectManagedSection = (text, sectionId = MANAGED_SECTION_ID) => {
  const target = String(text || '');
  const { start, end } = managedSectionMarkers(sectionId);
  const starts = countOccurrences(target, start);
  const ends = countOccurrences(target, end);
  if (starts === 0 && ends === 0) return { status: 'missing', body: null, digest: null, start, end };
  if (starts !== 1 || ends !== 1) {
    return { status: 'collision', body: null, digest: null, start, end, reason: 'managed-section-markers-invalid' };
  }
  const startIndex = target.indexOf(start);
  const endIndex = target.indexOf(end);
  if (endIndex < startIndex + start.length) {
    return { status: 'collision', body: null, digest: null, start, end, reason: 'managed-section-order-invalid' };
  }
  const body = target.slice(startIndex + start.length, endIndex)
    .replace(/^\r?\n/, '')
    .replace(/\r?\n$/, '');
  return { status: 'present', body, digest: valueDigest(body), start, end, startIndex, endIndex };
};

export const renderManagedSection = (incoming, sectionId = MANAGED_SECTION_ID) => {
  const { start, end } = managedSectionMarkers(sectionId);
  const body = String(incoming || '').trim();
  return `${start}\n${body}\n${end}`;
};

export const mergeManagedSection = (existing, incoming, sectionId = MANAGED_SECTION_ID) => {
  const target = String(existing || '');
  const inspected = inspectManagedSection(target, sectionId);
  const block = renderManagedSection(incoming, sectionId);
  if (inspected.status === 'collision') {
    const error = new Error(`managed_section_collision: ${sectionId}`);
    error.code = 'managed_section_collision';
    error.reason = inspected.reason;
    throw error;
  }
  if (inspected.status === 'missing') {
    const trimmed = target.trimEnd();
    return trimmed ? `${trimmed}\n\n${block}\n` : `${block}\n`;
  }
  const prefix = target.slice(0, inspected.startIndex).trimEnd();
  const suffix = target.slice(inspected.endIndex + inspected.end.length).trimStart();
  return [prefix, block, suffix].filter(Boolean).join('\n\n') + '\n';
};

export const removeManagedSection = (existing, sectionId = MANAGED_SECTION_ID) => {
  const target = String(existing || '');
  const inspected = inspectManagedSection(target, sectionId);
  if (inspected.status === 'missing') return { text: target, status: 'missing' };
  if (inspected.status === 'collision') {
    const error = new Error(`managed_section_collision: ${sectionId}`);
    error.code = 'managed_section_collision';
    error.reason = inspected.reason;
    throw error;
  }
  const before = target.slice(0, inspected.startIndex).replace(/[ \t]*\r?\n?$/, '');
  const after = target.slice(inspected.endIndex + inspected.end.length).replace(/^\r?\n?\s*/, '');
  const text = before && after ? `${before}\n\n${after}\n` : before ? `${before}\n` : after ? `${after}\n` : '';
  return { text, status: 'removed', body: inspected.body, digest: inspected.digest };
};

const pathSegments = (jsonPath) => String(jsonPath || '').split('.').filter(Boolean);

export const getJsonPath = (value, jsonPath) => {
  const segments = pathSegments(jsonPath);
  if (segments.length === 0) return { present: true, value, parent: null, key: null };
  let current = value;
  for (let index = 0; index < segments.length; index += 1) {
    if (!current || typeof current !== 'object' || !(segments[index] in current)) {
      return { present: false, value: undefined, parent: null, key: segments.at(-1) };
    }
    if (index === segments.length - 1) return { present: true, value: current[segments[index]], parent: current, key: segments[index] };
    current = current[segments[index]];
  }
  return { present: false, value: undefined, parent: null, key: segments.at(-1) };
};

export const deleteJsonPath = (value, jsonPath) => {
  const resolved = getJsonPath(value, jsonPath);
  if (!resolved.present || !resolved.parent) return false;
  delete resolved.parent[resolved.key];
  return true;
};

export const isKernelHookEntry = (value) => {
  if (Array.isArray(value)) return value.some(isKernelHookEntry);
  if (!value || typeof value !== 'object') return false;
  if (typeof value.command === 'string' && /assert-track\b/.test(value.command)) return true;
  return Object.values(value).some(isKernelHookEntry);
};

export const collectJsonPathOwnership = (value, jsonPath, { array = false } = {}) => {
  const resolved = getJsonPath(value, jsonPath);
  if (!resolved.present) return { path: jsonPath, digest: null, arrayDigests: [] };
  if (array && Array.isArray(resolved.value)) {
    return {
      path: jsonPath,
      digest: null,
      arrayDigests: resolved.value.filter(isKernelHookEntry).map(valueDigest),
    };
  }
  return { path: jsonPath, digest: valueDigest(resolved.value), arrayDigests: [] };
};

export const inspectJsonOwnership = (value, entry) => {
  const failures = [];
  for (const jsonPath of entry.ownedPaths || []) {
    const resolved = getJsonPath(value, jsonPath);
    const expectedDigest = entry.ownedPathDigests?.[jsonPath];
    const expectedArrayDigests = entry.ownedArrayDigests?.[jsonPath] || [];
    if (!resolved.present) {
      failures.push({ ownedPath: jsonPath, reason: 'owned-path-missing' });
      continue;
    }
    if (Object.hasOwn(entry.ownedArrayDigests || {}, jsonPath)) {
      if (!Array.isArray(resolved.value)) {
        failures.push({ ownedPath: jsonPath, reason: 'owned-array-type-changed' });
        continue;
      }
      const actualDigests = resolved.value.map(valueDigest);
      for (const expected of expectedArrayDigests) {
        if (!actualDigests.includes(expected)) failures.push({ ownedPath: jsonPath, reason: 'owned-array-entry-changed' });
      }
      if (resolved.value.some((item) => isKernelHookEntry(item) && !expectedArrayDigests.includes(valueDigest(item)))) {
        failures.push({ ownedPath: jsonPath, reason: 'owned-array-entry-changed' });
      }
      continue;
    }
    if (expectedDigest && valueDigest(resolved.value) !== expectedDigest) {
      failures.push({ ownedPath: jsonPath, reason: 'owned-path-modified' });
    }
  }
  return failures;
};

export const removeJsonOwnership = (value, entry) => {
  const failures = inspectJsonOwnership(value, entry);
  if (failures.length > 0) return { value, failures, changed: false };
  let changed = false;
  for (const jsonPath of entry.ownedPaths || []) {
    const resolved = getJsonPath(value, jsonPath);
    const expectedArrayDigests = entry.ownedArrayDigests?.[jsonPath] || [];
    if (!resolved.present) continue;
    if (Object.hasOwn(entry.ownedArrayDigests || {}, jsonPath) && Array.isArray(resolved.value)) {
      const retained = resolved.value.filter((item) => !expectedArrayDigests.includes(valueDigest(item)));
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
