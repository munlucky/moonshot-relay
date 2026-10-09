import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { sha256Hex } from './candidate-identity.mjs';
import { loadStandaloneCatalog, standaloneDescriptors } from '../kernel/standalone/catalog.mjs';

const normalizePath = (value = '') => String(value).replaceAll('\\', '/');

const readSkillBody = async (repoRoot, skillPath) => readFile(path.join(repoRoot, skillPath, 'SKILL.md'), 'utf8');

const isKernelSkill = (name) => (name.startsWith('kernel-') && name !== 'kernel-commit') || name === 'moon-relay-kernel';
const commitShaRegex = /^[a-f0-9]{40}$/i;

const standaloneMembership = async (repoRoot) => {
  try {
    const catalog = await loadStandaloneCatalog({ repoRoot, validateSources: false });
    const entries = standaloneDescriptors(catalog);
    return {
      names: new Set(entries.map((entry) => entry.name)),
      relayCompatibility: new Set(entries.filter((entry) => entry.legacyRelayCompatibility === true).map((entry) => entry.name)),
    };
  } catch {
    return { names: new Set(), relayCompatibility: new Set() };
  }
};

const skillBelongsToScope = (name, scope, standalone, relayCompatibility) => {
  if (scope === 'kernel') return isKernelSkill(name);
  if (scope === 'standalone') return standalone.has(name);
  return !isKernelSkill(name) && (!standalone.has(name) || relayCompatibility.has(name));
};

export const discoverSourceSkills = async ({ repoRoot = process.cwd(), skillsRoot = 'skills' } = {}) => {
  const root = path.join(repoRoot, skillsRoot);
  const entries = await readdir(root, { withFileTypes: true });
  const skills = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const relativePath = normalizePath(path.join(skillsRoot, entry.name));
    try {
      const body = await readSkillBody(repoRoot, relativePath);
      skills.push({
        name: entry.name,
        path: relativePath,
        contentHash: sha256Hex(body),
      });
    } catch {
      skills.push({
        name: entry.name,
        path: relativePath,
        contentHash: '',
        missingSkillFile: true,
      });
    }
  }
  return skills.sort((left, right) => left.name.localeCompare(right.name));
};

export const buildSkillsLock = async ({
  repoRoot = process.cwd(),
  scope = 'relay',
  generatedAt = new Date().toISOString(),
  sourceCommit = '',
  defaultLicense = 'UNSPECIFIED',
  defaultStages = [],
  defaultPermissions = ['filesystem-read'],
} = {}) => {
  const membership = await standaloneMembership(repoRoot);
  const sourceSkills = (await discoverSourceSkills({ repoRoot })).filter((s) => skillBelongsToScope(s.name, scope, membership.names, membership.relayCompatibility));

  return {
    schemaVersion: 1,
    generatedAt,
    sourceCommit,
    scope: scope === 'standalone' ? 'kernel-standalone' : scope,
    skills: sourceSkills.map((skill) => ({
      name: skill.name,
      path: skill.path,
      source: 'canonical',
      contentHash: skill.contentHash || sha256Hex('missing'),
      license: defaultLicense,
      stages: defaultStages,
      permissions: defaultPermissions,
      permissionReview: {
        status: defaultPermissions.length > 0 ? 'required' : 'approved',
      },
    })),
  };
};

export const auditSkillsLock = async ({
  repoRoot = process.cwd(),
  scope = 'relay',
  lock = null,
  runtimeSurface = null,
} = {}) => {
  const findings = [];
  const membership = await standaloneMembership(repoRoot);
  const standalone = membership.names;
  if (!lock) {
    findings.push({ type: 'missing_lock', severity: 'blocking' });
    return { status: 'blocked', findings };
  }

  if (lock.schemaVersion !== 1) {
    findings.push({ type: 'schema_version_mismatch', severity: 'blocking', expected: 1, actual: lock.schemaVersion });
  }

  if (scope === 'kernel') {
    if (lock.scope !== 'kernel') {
      findings.push({ type: 'scope_mismatch', severity: 'blocking', expected: 'kernel', actual: lock.scope });
    }
    if (!lock.sourceCommit || typeof lock.sourceCommit !== 'string' || !commitShaRegex.test(lock.sourceCommit)) {
      findings.push({ type: 'invalid_source_commit_sha', severity: 'blocking', actual: lock.sourceCommit });
    }
  }
  if (scope === 'standalone' && lock.scope !== 'kernel-standalone') {
    findings.push({ type: 'scope_mismatch', severity: 'blocking', expected: 'kernel-standalone', actual: lock.scope });
  }

  const lockedNames = (lock.skills || []).map((s) => s.name);
  const duplicates = lockedNames.filter((name, idx) => lockedNames.indexOf(name) !== idx);
  if (duplicates.length > 0) {
    findings.push({ type: 'duplicate_lock_entries', severity: 'blocking', duplicates });
  }

  const sourceSkills = new Map(
    (await discoverSourceSkills({ repoRoot }))
      .filter((s) => skillBelongsToScope(s.name, scope, standalone, membership.relayCompatibility))
      .map((skill) => [skill.name, skill])
  );
  const lockedSkills = new Map((lock.skills || []).map((skill) => [skill.name, skill]));

  for (const [name, sourceSkill] of sourceSkills.entries()) {
    const locked = lockedSkills.get(name);
    if (!locked) {
      findings.push({ type: 'missing_lock_entry', severity: 'blocking', skill: name });
      continue;
    }
    if (locked.contentHash !== sourceSkill.contentHash) {
      findings.push({ type: 'hash_drift', severity: 'blocking', skill: name });
    }
    if (!locked.license || locked.license === 'UNSPECIFIED') {
      findings.push({ type: 'license_gap', severity: 'review', skill: name });
    }
    if ((locked.permissions || []).length > 0 && locked.permissionReview?.status !== 'approved') {
      findings.push({ type: 'permission_review_required', severity: 'review', skill: name });
    }
  }

  for (const [lockedName] of lockedSkills.entries()) {
    if (!sourceSkills.has(lockedName)) {
      findings.push({ type: 'unmapped_lock_entry', severity: 'blocking', skill: lockedName });
    }
  }

  if (scope === 'relay') {
    const publicSkills = new Set(runtimeSurface?.publicRuntimeSkills || []);
    for (const skill of publicSkills) {
      if (!sourceSkills.has(skill)) {
        findings.push({ type: 'runtime_surface_missing_source_skill', severity: 'blocking', skill });
      }
    }
  }

  return {
    status: findings.some((finding) => finding.severity === 'blocking') ? 'blocked' : findings.length ? 'review_required' : 'pass',
    findings,
  };
};

export const assertRuntimeSurfaceUnexpanded = ({ before = [], after = [] } = {}) => {
  const beforeSet = new Set(before);
  const added = after.filter((skill) => !beforeSet.has(skill));
  if (added.length > 0) {
    throw new Error(`runtime surface expansion requires explicit approval: ${added.join(', ')}`);
  }
  return true;
};
