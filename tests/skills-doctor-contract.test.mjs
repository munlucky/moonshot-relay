import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, test } from 'node:test';

import {
  assertRuntimeSurfaceUnexpanded,
  auditSkillsLock,
  buildSkillsLock,
  discoverSourceSkills,
} from '../scripts/kernel/standalone/skills-lock.js';

const tempRoots = [];

after(async () => {
  await Promise.all(tempRoots.map((dir) => rm(dir, { recursive: true, force: true })));
});

const approvedLock = async () => {
  const lock = await buildSkillsLock({
    generatedAt: '2026-06-23T00:00:00.000Z',
    defaultLicense: 'MIT',
    defaultPermissions: [],
  });
  return {
    ...lock,
    skills: lock.skills.map((skill) => ({
      ...skill,
      permissionReview: { status: 'approved', reviewedAt: '2026-06-23T00:00:00.000Z', reviewer: 'test' },
    })),
  };
};

const createDoctorFixtureRoot = async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'moonshot-doctor-fixture-'));
  tempRoots.push(tempRoot);
  await mkdir(path.join(tempRoot, 'skills', 'fixture-skill'), { recursive: true });
  await mkdir(path.join(tempRoot, 'package'), { recursive: true });
  await writeFile(path.join(tempRoot, 'skills', 'fixture-skill', 'SKILL.md'), '# Fixture Skill\n');
  await writeFile(path.join(tempRoot, 'package', 'runtime-surface.json'), JSON.stringify({
    schemaVersion: 1,
    publicRuntimeSkills: ['fixture-skill'],
  }, null, 2));
  const lock = await buildSkillsLock({
    repoRoot: tempRoot,
    generatedAt: '2026-06-30T00:00:00.000Z',
    defaultLicense: 'MIT',
    defaultPermissions: [],
  });
  await writeFile(path.join(tempRoot, 'skills.lock.json'), JSON.stringify(lock, null, 2));
  return tempRoot;
};

const seedPassedHarnessLabRun = async (evidenceRoot) => {
  const runId = 'harness-lab-20260713-120000';
  const runRoot = path.join(evidenceRoot, '.moonshot-relay', 'harness-lab-runs', runId);
  const evalPath = path.join(runRoot, 'candidate', 'harness-control-plane-eval', 'stdout.txt');
  const researchPath = path.join(runRoot, 'candidate', 'moonshot-research-fixture', 'stdout.txt');
  await mkdir(path.dirname(evalPath), { recursive: true });
  await mkdir(path.dirname(researchPath), { recursive: true });
  await writeFile(evalPath, JSON.stringify({
    schemaVersion: 1,
    suite: 'harness-control-plane-golden',
    status: 'passed',
    score: 1,
    scoreThreshold: 1,
    passedCount: 14,
    failedCount: 0,
    totalCount: 14,
  }, null, 2));
  await writeFile(researchPath, JSON.stringify({
    schemaVersion: 'moonshot-research-fixture-score.v1',
    status: 'passed',
    fixtureSetId: 'moonshot-research-fixtures-v1',
    evidenceCount: 158,
    queryVariantCount: 11,
    laneFailureCount: 0,
    claimLedgerCoverage: 1,
  }, null, 2));
  await writeFile(path.join(runRoot, 'lab-result.json'), JSON.stringify({
    schemaVersion: 'moonshot-harness-lab-result.v1',
    runId,
    status: 'passed',
    promotable: true,
    createdAt: new Date().toISOString(),
    candidate: {
      status: 'passed',
      results: [
        {
          id: 'harness-control-plane-eval',
          status: 'passed',
          stdout: { path: 'candidate/harness-control-plane-eval/stdout.txt' },
        },
        {
          id: 'moonshot-research-fixture',
          status: 'passed',
          stdout: { path: 'candidate/moonshot-research-fixture/stdout.txt' },
        },
      ],
    },
  }, null, 2));
  return { runId, runRoot };
};

const runDoctor = (args, options = {}) => spawnSync(process.execPath, [
  path.join(process.cwd(), 'scripts', 'doctor.mjs'),
  'check',
  ...args,
  '--json',
], {
  cwd: options.cwd || process.cwd(),
  encoding: 'utf8',
});

test('skills audit detects missing lock hash drift license and permission review gaps', async () => {
  const missing = await auditSkillsLock({ lock: null });
  assert.equal(missing.status, 'blocked');
  assert.equal(missing.findings[0].type, 'missing_lock');

  const lock = await approvedLock();
  lock.skills[0] = {
    ...lock.skills[0],
    contentHash: '0'.repeat(64),
    license: 'UNSPECIFIED',
    permissions: ['network'],
    permissionReview: { status: 'required' },
  };
  const audited = await auditSkillsLock({ lock, runtimeSurface: { publicRuntimeSkills: [] } });

  assert.equal(audited.status, 'blocked');
  assert.ok(audited.findings.some((finding) => finding.type === 'hash_drift'));
  assert.ok(audited.findings.some((finding) => finding.type === 'license_gap'));
  assert.ok(audited.findings.some((finding) => finding.type === 'permission_review_required'));
});

test('runtime surface expansion is blocked unless explicitly approved elsewhere', () => {
  assert.equal(assertRuntimeSurfaceUnexpanded({ before: ['a', 'b'], after: ['a'] }), true);
  assert.throws(() => assertRuntimeSurfaceUnexpanded({
    before: ['moonshot-phase-runner'],
    after: ['moonshot-phase-runner', 'internal-skill'],
  }), /explicit approval/);
});

test('skills audit CLI generates and audits a lock file', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'moonshot-skills-audit-'));
  tempRoots.push(tempRoot);
  const lockPath = path.join(tempRoot, 'skills.lock.json');

  const generated = spawnSync(process.execPath, [
    'scripts/skills-audit.mjs',
    'generate-lock',
    '--out',
    lockPath,
    '--json',
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  assert.equal(generated.status, 0, generated.stderr || generated.stdout);
  const generatedPayload = JSON.parse(generated.stdout);
  assert.equal(generatedPayload.status, 'generated');
  assert.ok((await readFile(lockPath, 'utf8')).includes('"skills"'));

  const audit = spawnSync(process.execPath, [
    'scripts/skills-audit.mjs',
    'audit',
    '--lock',
    lockPath,
    '--runtime-surface',
    'package/runtime-surface.json',
    '--json',
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  assert.equal(audit.status, 0, audit.stderr || audit.stdout);
  assert.equal(JSON.parse(audit.stdout).status, 'review_required');
});

test('doctor uses repository skills lock by default', () => {
  const result = runDoctor([]);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.schemaVersion, 'moonshot-doctor-readiness.v1');
  assert.ok(['pass', 'degraded'].includes(payload.status));
  for (const key of [
    'runtimeSurface',
    'skillsLock',
    'labReadiness',
    'evalReadiness',
    'researchReadiness',
    'profileTrust',
    'generatedStateBoundary',
  ]) {
    assert.ok(payload.checks[key], `missing ${key}`);
  }
  assert.equal(payload.checks.runtimeSurface.status, 'pass');
  assert.equal(payload.checks.skillsLock.status, 'pass');
  assert.equal(payload.findings.some((finding) => finding.severity === 'blocking'), false);
});

test('doctor can verify an explicit installed payload root', () => {
  const result = runDoctor([
    '--repo-root',
    process.cwd(),
    '--lock',
    'skills.lock.json',
    '--runtime-surface',
    'package/runtime-surface.json',
  ], {
    cwd: os.tmpdir(),
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.ok(['pass', 'degraded'].includes(payload.status));
  assert.equal(payload.checks.runtimeSettings, 'explicit_repo_root');
  assert.equal(payload.checks.profileTrust.mode, 'explicit_repo_root');
  assert.equal(payload.checks.profileTrust.installedInputs, 'explicit');
  assert.equal(payload.checks.repoRoot, process.cwd());
  assert.match(payload.checks.lockPath, /skills\.lock\.json$/);
  assert.match(payload.checks.runtimeSurfacePath, /package[\\/]runtime-surface\.json$/);
  assert.equal(payload.findings.some((finding) => finding.severity === 'blocking'), false);
});

test('doctor blocks missing lock and runtime surface expansion', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'moonshot-doctor-'));
  tempRoots.push(tempRoot);
  const runtimeSurfacePath = path.join(tempRoot, 'runtime-surface.json');
  await writeFile(runtimeSurfacePath, JSON.stringify({
    schemaVersion: 1,
    publicRuntimeSkills: ['moonshot-phase-runner', 'internal-skill'],
  }, null, 2));

  const result = runDoctor([
    '--runtime-surface',
    runtimeSurfacePath,
    '--expected-runtime-surface-json',
    JSON.stringify(['moonshot-phase-runner']),
  ], {
    cwd: tempRoot,
  });

  assert.equal(result.status, 2, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.schemaVersion, 'moonshot-doctor-readiness.v1');
  assert.equal(payload.status, 'blocked');
  assert.equal(payload.checks.runtimeSurface.status, 'blocked');
  assert.equal(payload.checks.skillsLock.status, 'blocked');
  assert.ok(payload.findings.some((finding) => finding.type === 'runtime_surface_expanded'));
  assert.ok(payload.findings.some((finding) => finding.type === 'missing_lock'));
});

test('doctor treats missing optional readiness evidence as degraded not blocking', async () => {
  const tempRoot = await createDoctorFixtureRoot();
  const result = runDoctor([
    '--repo-root',
    tempRoot,
    '--lock',
    'skills.lock.json',
    '--runtime-surface',
    'package/runtime-surface.json',
  ]);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, 'degraded');
  assert.equal(payload.checks.runtimeSurface.status, 'pass');
  assert.equal(payload.checks.skillsLock.status, 'pass');
  assert.equal(payload.checks.labReadiness.status, 'not_initialized');
  assert.equal(payload.checks.evalReadiness.status, 'not_available');
  assert.equal(payload.checks.researchReadiness.status, 'not_available');
  assert.ok(payload.findings.every((finding) => finding.severity !== 'blocking'));
});

test('doctor discovers fresh passed readiness evidence from the latest real harness lab run', async () => {
  const tempRoot = await createDoctorFixtureRoot();
  await seedPassedHarnessLabRun(tempRoot);

  const result = runDoctor([
    '--repo-root',
    tempRoot,
    '--lock',
    'skills.lock.json',
    '--runtime-surface',
    'package/runtime-surface.json',
  ]);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, 'pass');
  assert.equal(payload.checks.labReadiness.status, 'ready');
  assert.equal(payload.checks.evalReadiness.status, 'ready');
  assert.equal(payload.checks.researchReadiness.status, 'ready');
  assert.equal(payload.checks.labReadiness.evidenceSource, 'harness-lab-runs');
  assert.match(payload.checks.evalReadiness.latestArtifact, /harness-lab-runs.+harness-control-plane-eval\/stdout\.txt$/);
  assert.match(payload.checks.researchReadiness.latestRunPath, /harness-lab-runs.+moonshot-research-fixture\/stdout\.txt$/);
  assert.equal(payload.findings.length, 0);
});

test('installed doctor reads preserved readiness from an explicit external evidence root', async () => {
  const installedRoot = await createDoctorFixtureRoot();
  const evidenceRoot = await mkdtemp(path.join(os.tmpdir(), 'moonshot-doctor-evidence-'));
  tempRoots.push(evidenceRoot);
  await seedPassedHarnessLabRun(evidenceRoot);

  const withoutEvidenceRoot = runDoctor([
    '--repo-root',
    installedRoot,
    '--lock',
    'skills.lock.json',
    '--runtime-surface',
    'package/runtime-surface.json',
  ]);
  assert.equal(withoutEvidenceRoot.status, 0, withoutEvidenceRoot.stderr || withoutEvidenceRoot.stdout);
  const degraded = JSON.parse(withoutEvidenceRoot.stdout);
  assert.equal(degraded.status, 'degraded');
  assert.equal(degraded.checks.evidenceRoot, installedRoot);
  assert.equal(degraded.checks.labReadiness.status, 'not_initialized');
  assert.equal(degraded.checks.profileTrust.mode, 'explicit_repo_root');
  assert.equal(degraded.checks.profileTrust.installedInputs, 'explicit');

  const withEvidenceRoot = runDoctor([
    '--repo-root',
    installedRoot,
    '--evidence-root',
    evidenceRoot,
    '--lock',
    'skills.lock.json',
    '--runtime-surface',
    'package/runtime-surface.json',
  ]);
  assert.equal(withEvidenceRoot.status, 0, withEvidenceRoot.stderr || withEvidenceRoot.stdout);
  const passed = JSON.parse(withEvidenceRoot.stdout);
  assert.equal(passed.status, 'pass');
  assert.equal(passed.checks.repoRoot, installedRoot);
  assert.equal(passed.checks.evidenceRoot, evidenceRoot);
  assert.equal(passed.checks.labReadiness.status, 'ready');
  assert.equal(passed.checks.evalReadiness.status, 'ready');
  assert.equal(passed.checks.researchReadiness.status, 'ready');
  assert.equal(passed.checks.profileTrust.mode, 'explicit_repo_root');
  assert.equal(passed.checks.profileTrust.installedInputs, 'explicit');
  assert.equal(passed.checks.runtimeSurface.status, 'pass');
  assert.equal(passed.checks.skillsLock.status, 'pass');
  assert.equal(passed.checks.generatedStateBoundary.status, 'pass');
  assert.equal(passed.findings.length, 0);
});

test('doctor blocks generated state selected for package payload', async () => {
  const tempRoot = await createDoctorFixtureRoot();
  await writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({
    files: [
      'scripts/',
      '.moonshot-relay/**',
      'docs/implementation/example/execution/**',
    ],
  }, null, 2));

  const result = runDoctor([
    '--repo-root',
    tempRoot,
    '--lock',
    'skills.lock.json',
    '--runtime-surface',
    'package/runtime-surface.json',
  ]);

  assert.equal(result.status, 2, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, 'blocked');
  assert.equal(payload.checks.generatedStateBoundary.status, 'blocked');
  assert.ok(payload.findings.some((finding) => finding.type === 'generated_state_selected_for_package'));
});

test('skills lock schema is parseable and source skill discovery finds phase runner', async () => {
  const schema = JSON.parse(await readFile(path.join(process.cwd(), 'schemas', 'skills-lock.schema.json'), 'utf8'));
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  const skills = await discoverSourceSkills();
  assert.ok(skills.some((skill) => skill.name === 'moonshot-phase-runner'));
});
