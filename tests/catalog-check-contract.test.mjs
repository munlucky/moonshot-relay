import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { checkCatalog, parsePublicRuntimeSkillsFromContract } from '../scripts/catalog-check.mjs';

const root = process.cwd();

const writeJson = (target, value) => writeFile(target, `${JSON.stringify(value, null, 2)}\n`);

test('catalog contract parses package publicRuntimeSkills lists', () => {
  const lists = parsePublicRuntimeSkillsFromContract(`
skillExposure:
  publicRuntimeSkills:
    - product-orchestrator
    - moonshot-phase-runner
`);
  assert.deepEqual(lists, [['product-orchestrator', 'moonshot-phase-runner']]);
});

test('catalog check passes against current source authority files', async () => {
  const result = await checkCatalog({ repoRoot: root, runPackageDryRun: false });

  assert.equal(result.status, 'pass', JSON.stringify(result.findings, null, 2));
  assert.deepEqual(result.publicEntrypoints, [
    'product-orchestrator',
    'moonshot-architecture',
    'moonshot-orchestrator',
    'moonshot-phase-runner',
    'moonshot-plan-writer',
    'commit-moonshot',
    'session-logger',
    'explain-diff-html',
  ]);
});

test('catalog check blocks public entrypoint order drift even when sets match', async () => {
  const runtimeSurface = JSON.parse(await readFile(path.join(root, 'package', 'runtime-surface.json'), 'utf8'));
  const temp = await mkdtemp(path.join(os.tmpdir(), 'catalog-order-'));
  const runtimeSurfacePath = path.join(temp, 'runtime-surface.json');
  await writeJson(runtimeSurfacePath, {
    ...runtimeSurface,
    publicRuntimeSkills: [...runtimeSurface.publicRuntimeSkills].reverse(),
  });

  const result = await checkCatalog({ repoRoot: root, runtimeSurfacePath, runPackageDryRun: false });
  assert.equal(result.status, 'fail');
  assert.ok(result.findings.some((item) => item.code === 'catalog.runtime_surface_order_mismatch'));
});

test('catalog check fails when package contract public surface drifts', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'catalog-check-'));
  await mkdir(path.join(temp, 'catalog'), { recursive: true });
  await mkdir(path.join(temp, 'package'), { recursive: true });
  await mkdir(path.join(temp, 'skills', 'alpha'), { recursive: true });
  await mkdir(path.join(temp, 'skills', 'beta'), { recursive: true });
  await writeFile(path.join(temp, 'skills', 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: Alpha\n---\n# Alpha\n');
  await writeFile(path.join(temp, 'skills', 'beta', 'SKILL.md'), '---\nname: beta\ndescription: Beta\n---\n# Beta\n');
  await writeJson(path.join(temp, 'catalog', 'moonshot-catalog.json'), {
    schemaVersion: 1,
    requiredDocumentation: { files: ['README.md'] },
    publicEntrypoints: [
      { name: 'alpha', source: 'skills/alpha/SKILL.md' },
      { name: 'beta', source: 'skills/beta/SKILL.md' },
    ],
    internalSkillClusters: [],
  });
  await writeJson(path.join(temp, 'package', 'runtime-surface.json'), {
    publicRuntimeSkills: ['alpha', 'beta'],
  });
  await writeFile(path.join(temp, 'package', 'package-contract.yaml'), `
accountRootInstall:
  commonPayloadEntries:
    - catalog/
skillExposure:
  publicRuntimeSkills:
    - alpha
requiredPayloadEntries:
  sharedSource:
    - source: catalog/moonshot-catalog.json
`);
  await writeFile(path.join(temp, 'README.md'), 'alpha beta\n');

  const result = await checkCatalog({ repoRoot: temp, runPackageDryRun: false });

  assert.equal(result.status, 'fail');
  assert.ok(result.findings.some((finding) => finding.code === 'catalog.package_contract_mismatch'));
});

test('catalog check fails when public entry source points at another skill', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'catalog-check-source-'));
  await mkdir(path.join(temp, 'catalog'), { recursive: true });
  await mkdir(path.join(temp, 'package'), { recursive: true });
  await mkdir(path.join(temp, 'skills', 'alpha'), { recursive: true });
  await mkdir(path.join(temp, 'skills', 'beta'), { recursive: true });
  await writeFile(path.join(temp, 'skills', 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: Alpha\n---\n# Alpha\n');
  await writeFile(path.join(temp, 'skills', 'beta', 'SKILL.md'), '---\nname: beta\ndescription: Beta\n---\n# Beta\n');
  await writeJson(path.join(temp, 'catalog', 'moonshot-catalog.json'), {
    schemaVersion: 1,
    requiredDocumentation: { files: ['README.md'] },
    publicEntrypoints: [
      { name: 'alpha', source: 'skills/beta/SKILL.md' },
    ],
    internalSkillClusters: [],
  });
  await writeJson(path.join(temp, 'package', 'runtime-surface.json'), {
    publicRuntimeSkills: ['alpha'],
  });
  await writeFile(path.join(temp, 'package', 'package-contract.yaml'), `
accountRootInstall:
  commonPayloadEntries:
    - catalog/
skillExposure:
  publicRuntimeSkills:
    - alpha
requiredPayloadEntries:
  sharedSource:
    - source: catalog/moonshot-catalog.json
`);
  await writeFile(path.join(temp, 'README.md'), 'alpha\n');

  const result = await checkCatalog({ repoRoot: temp, runPackageDryRun: false });

  assert.equal(result.status, 'fail');
  assert.ok(result.findings.some((finding) => finding.code === 'catalog.public_source_mismatch'));
});

test('catalog check CLI runs package dry-run and reports pass', () => {
  const result = spawnSync(process.execPath, [
    'scripts/catalog-check.mjs',
    '--json',
  ], {
    cwd: root,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, 'pass', JSON.stringify(payload.findings, null, 2));
});

test('catalog exposure allows profile-native skills but rejects undeclared shared skills', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'catalog-native-profile-'));
  try {
    for (const directory of ['catalog', 'package', 'skills/alpha']) {
      await mkdir(path.join(temp, directory), { recursive: true });
    }
    await writeFile(path.join(temp, 'skills/alpha/SKILL.md'), '---\nname: alpha\ndescription: Alpha\n---\n');
    await writeJson(path.join(temp, 'catalog/moonshot-catalog.json'), {
      publicEntrypoints: [{ name: 'alpha', source: 'skills/alpha/SKILL.md' }],
    });
    await writeJson(path.join(temp, 'package/runtime-surface.json'), { publicRuntimeSkills: ['alpha'] });
    await writeFile(path.join(temp, 'package/package-contract.yaml'), [
      'commonPayloadEntries:', '  - catalog/', 'publicRuntimeSkills:', '  - alpha',
      'sharedSource:', '  - source: catalog/moonshot-catalog.json', '',
    ].join('\n'));
    const runtimes = ['claude', 'codex', 'qwen'].map(runtime => ({
      runtime,
      planned: [{ from: 'skills/alpha/SKILL.md', to: `package/${runtime}/profile/.${runtime}/skills/alpha/SKILL.md` }],
    }));
    runtimes[1].planned.push({
      from: 'package/profile-templates/codex/.codex/skills/native-helper/SKILL.md',
      to: 'package/codex/profile/.codex/skills/native-helper/SKILL.md',
    });
    const writePlan = () => writeFile(path.join(temp, 'package/build-package.mjs'),
      `process.stdout.write(${JSON.stringify(JSON.stringify({ runtimes }))});\n`);
    await writePlan();
    const allowed = await checkCatalog({ repoRoot: temp });
    assert.equal(allowed.status, 'pass', JSON.stringify(allowed.findings));
    runtimes[1].planned.push({
      from: 'skills/private-helper/SKILL.md',
      to: 'package/codex/profile/.codex/skills/private-helper/SKILL.md',
    });
    await writePlan();
    const refused = await checkCatalog({ repoRoot: temp });
    assert.equal(refused.status, 'fail');
    assert.ok(refused.findings.some(item => item.code === 'catalog.profile_exposure_mismatch'
      && item.runtime === 'codex' && item.extra.includes('private-helper')));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
