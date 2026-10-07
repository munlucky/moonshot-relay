import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { access, readdir, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import {
  ensureKnowledgeStoreDirectories,
  prepareProjectKnowledgeNamespaceMigration,
  projectKnowledgeDirectory,
  recoverProjectKnowledgeNamespaceMigrations,
  writeAtomicJson,
} from '../scripts/kernel/knowledge/store.mjs';
import { resolveKernelProjectIdentity } from '../scripts/kernel/project-identity.mjs';
import { openKernelStateStore } from '../scripts/kernel/state-store.mjs';
import { canonicalPath } from '../scripts/kernel/runtime-home.mjs';

const digest = (letter) => `sha256:${letter.repeat(64)}`;
const canonicalRoot = (value) => {
  const root = canonicalPath(value).replaceAll('\\', '/');
  return process.platform === 'win32' ? root.toLowerCase() : root;
};
const prepareMigration = (options) => prepareProjectKnowledgeNamespaceMigration({
  canonicalRoot: path.join(options.runtimeHome, 'identity-repo'),
  identityDigest: `digest-${options.projectId}`,
  ...options,
});

test('identity migration preparation rejects a missing witness pair before filesystem replacement', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-identity-prepare-missing-witnesses-'));
  try {
    assert.throws(
      () => prepareProjectKnowledgeNamespaceMigration({
        runtimeHome,
        legacyProjectIds: ['legacy-prepare-missing-witnesses'],
        projectId: 'canonical-prepare-missing-witnesses',
      }),
      (error) => error.code === 'IDENTITY_MIGRATION_JOURNAL_INVALID',
    );
  } finally {
    await rm(runtimeHome, { recursive: true, force: true });
  }
});

test('knowledge namespace IDs reject traversal instead of escaping Runtime Home', () => {
  assert.throws(
    () => projectKnowledgeDirectory('../outside'),
    (error) => error.code === 'INVALID_NAMESPACE_ID',
  );
});

test('existing Runtime Home namespace junctions are rejected before knowledge writes', async (t) => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-identity-namespace-link-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'kernel-identity-namespace-outside-'));
  try {
    const projectsRoot = path.join(runtimeHome, 'state', 'projects');
    await mkdir(projectsRoot, { recursive: true });
    const linked = path.join(projectsRoot, 'linked-project');
    try {
      await symlink(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      t.skip(`symlink/junction creation unavailable: ${error.code || error.message}`);
      return;
    }
    await assert.rejects(
      ensureKnowledgeStoreDirectories('linked-project', { env: { MOON_RELAY_KERNEL_HOME: runtimeHome } }),
      (error) => ['SYMLINK_NAMESPACE_UNSUPPORTED', 'NAMESPACE_PATH_ESCAPE'].includes(error.code),
    );
  } finally {
    await rm(runtimeHome, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('identity migration rewrites identity fields but preserves free-form JSON text', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-identity-json-fields-'));
  const projectRoot = path.join(runtimeHome, 'repo');
  const legacyId = 'legacy-origin-owned';
  const canonicalId = 'path-json-fields-target';
  const store = await openKernelStateStore({ runtimeHome });
  try {
    await mkdir(projectRoot, { recursive: true });
    store.createRun({
      runId: 'json-fields-run',
      objective: 'json field migration',
      sourceIdentity: digest('a'),
      projectId: legacyId,
      workspaceId: 'json-fields-workspace',
      taskContract: {
        projectId: legacyId,
        statement: `The prose mentions ${legacyId} and must not be rewritten`,
        nested: { project_id: legacyId },
        arbitraryList: [legacyId],
      },
    });
    store.registerProjectWorkspace({
      workspaceId: 'json-fields-workspace',
      canonicalRoot: canonicalRoot(projectRoot),
      gitCommonDir: null,
      gitWorktreeDir: null,
      identity: { projectId: legacyId, canonicalRoot: canonicalRoot(projectRoot) },
    });

    store.registerProjectIdentity({
      projectId: canonicalId,
      canonicalRoot: projectRoot,
      identitySource: 'workspace_root',
      identityDigest: 'digest-json-fields',
      legacyAliases: [{ projectId: legacyId, source: 'origin' }],
    });

    const migrated = store.getRun('json-fields-run').taskContract;
    assert.equal(migrated.projectId, canonicalId);
    assert.equal(migrated.nested.project_id, canonicalId);
    assert.equal(migrated.statement, `The prose mentions ${legacyId} and must not be rewritten`);
    assert.deepEqual(migrated.arbitraryList, [legacyId]);
  } finally {
    store.close();
    await rm(runtimeHome, { recursive: true, force: true });
  }
});

test('origin text without persisted root/workspace ownership fails closed', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-identity-origin-ownership-'));
  const projectRoot = path.join(runtimeHome, 'repo');
  const store = await openKernelStateStore({ runtimeHome });
  try {
    await mkdir(projectRoot, { recursive: true });
    store.createRun({
      runId: 'unowned-origin-run',
      objective: 'unowned origin',
      sourceIdentity: digest('b'),
      projectId: 'github-com-shared-origin',
    });

    assert.throws(() => store.registerProjectIdentity({
      projectId: 'path-unowned-origin',
      canonicalRoot: projectRoot,
      identitySource: 'workspace_root',
      identityDigest: 'digest-unowned-origin',
      legacyAliases: [{ projectId: 'github-com-shared-origin', source: 'origin' }],
    }), (error) => error.code === 'project_identity_legacy_ownership_unproven');
    assert.equal(store.getRun('unowned-origin-run').projectId, 'github-com-shared-origin');
    assert.equal(store.getProjectIdentity({ projectId: 'path-unowned-origin' }), null);
  } finally {
    store.close();
    await rm(runtimeHome, { recursive: true, force: true });
  }
});

test('project identity registration rejects IDs that cannot be materialized as namespace segments', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-identity-invalid-id-'));
  const store = await openKernelStateStore({ runtimeHome });
  try {
    for (const projectId of ['../escaped-project', 'con', 'com1.txt']) {
      assert.throws(() => store.registerProjectIdentity({
        projectId,
        canonicalRoot: path.join(runtimeHome, 'repo'),
        identitySource: 'workspace_root',
        identityDigest: `digest-invalid-${projectId.replace(/[^a-z0-9]+/gi, '-')}`,
      }), (error) => error.code === 'project_identity_invalid');
    }
  } finally {
    store.close();
    await rm(runtimeHome, { recursive: true, force: true });
  }
});

test('knowledge namespaces reject Windows reserved names, trailing dots, and ADS syntax', () => {
  for (const projectId of ['con', 'com1.txt', 'foo.', 'foo:bar']) {
    assert.throws(
      () => projectKnowledgeDirectory(projectId),
      (error) => error.code === 'INVALID_NAMESPACE_ID',
      `expected ${projectId} to be rejected before filesystem materialization`,
    );
  }
});

test('the same origin alias from another repository fails closed without Git common-dir proof', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-identity-origin-collision-'));
  const firstRoot = path.join(runtimeHome, 'origin-first');
  const secondRoot = path.join(runtimeHome, 'origin-second');
  const origin = 'https://github.com/example/shared-origin';
  const store = await openKernelStateStore({ runtimeHome });
  try {
    await mkdir(firstRoot, { recursive: true });
    await mkdir(secondRoot, { recursive: true });
    store.registerProjectIdentity({
      projectId: 'origin-first-project',
      canonicalRoot: firstRoot,
      identitySource: 'workspace_root',
      identityDigest: 'digest-origin-first',
      aliases: [origin],
    });

    assert.throws(() => store.registerProjectIdentity({
      projectId: 'origin-second-project',
      canonicalRoot: secondRoot,
      identitySource: 'workspace_root',
      identityDigest: 'digest-origin-second',
      aliases: [origin],
    }), (error) => error.code === 'project_identity_alias_ownership_unproven');
    assert.equal(store.getProjectIdentity({ projectId: 'origin-second-project' }), null);
    assert.equal(store.registerProjectIdentity({ projectId: 'origin-first-project', canonicalRoot: secondRoot,
      identitySource: 'account_alias_registry', identityDigest: 'x', aliases: [origin] }).projectId, 'origin-first-project');
  } finally {
    store.close();
    await rm(runtimeHome, { recursive: true, force: true });
  }
});

test('caller-provided candidate canonicalRoot is not ownership proof', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-identity-forged-candidate-'));
  const projectRoot = path.join(runtimeHome, 'forged-candidate-root');
  const store = await openKernelStateStore({ runtimeHome });
  try {
    await mkdir(projectRoot, { recursive: true });
    store.createRun({
      runId: 'forged-candidate-run',
      objective: 'forged candidate ownership',
      sourceIdentity: digest('d'),
      projectId: 'legacy-forged-candidate',
    });
    assert.throws(() => store.registerProjectIdentity({
      projectId: 'path-forged-candidate',
      canonicalRoot: projectRoot,
      identitySource: 'workspace_root',
      identityDigest: 'digest-forged-candidate',
      legacyAliases: [{
        projectId: 'legacy-forged-candidate',
        source: 'package',
        canonicalRoot: projectRoot,
      }],
    }), (error) => error.code === 'project_identity_legacy_ownership_unproven');
    assert.equal(store.getProjectIdentity({ projectId: 'path-forged-candidate' }), null);
  } finally {
    store.close();
    await rm(runtimeHome, { recursive: true, force: true });
  }
});

test('caller-provided Git common-dir and non-workspace project-id reuse require derived proof', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-identity-common-proof-'));
  const firstRoot = path.join(runtimeHome, 'first-root');
  const secondRoot = path.join(runtimeHome, 'second-root');
  const store = await openKernelStateStore({ runtimeHome });
  try {
    await mkdir(firstRoot, { recursive: true });
    await mkdir(secondRoot, { recursive: true });
    store.registerProjectIdentity({
      projectId: 'explicit-common-proof',
      canonicalRoot: firstRoot,
      identitySource: 'workspace_root',
      identityDigest: 'digest-explicit-common-proof',
    });
    assert.throws(() => store.registerProjectIdentity({
      projectId: 'explicit-common-proof',
      canonicalRoot: secondRoot,
      identitySource: 'local_identity_file',
      identityDigest: 'digest-forged-common-proof',
      gitCommonDir: path.join(runtimeHome, 'forged-common-dir'),
    }), (error) => error.code === 'project_identity_git_common_dir_unverified');
    assert.throws(() => store.registerProjectIdentity({
      projectId: 'explicit-common-proof',
      canonicalRoot: secondRoot,
      identitySource: 'local_identity_file',
      identityDigest: 'digest-unproven-common-proof',
    }), (error) => error.code === 'project_identity_alias_ownership_unproven');
  } finally {
    store.close();
    await rm(runtimeHome, { recursive: true, force: true });
  }
});

test('same package identity from another root fails closed as a cross-repository collision', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-identity-package-collision-'));
  const firstRoot = path.join(runtimeHome, 'first-repo');
  const secondRoot = path.join(runtimeHome, 'second-repo');
  const store = await openKernelStateStore({ runtimeHome });
  try {
    await mkdir(firstRoot, { recursive: true });
    await mkdir(secondRoot, { recursive: true });
    store.registerProjectIdentity({
      projectId: 'shared-package',
      canonicalRoot: firstRoot,
      identitySource: 'workspace_root',
      identityDigest: 'digest-first-repo',
    });
    store.createRun({
      runId: 'first-repo-run',
      objective: 'first repo',
      sourceIdentity: digest('c'),
      projectId: 'shared-package',
      workspaceId: 'first-repo-workspace',
    });
    store.registerProjectWorkspace({
      workspaceId: 'first-repo-workspace',
      canonicalRoot: canonicalRoot(firstRoot),
      gitCommonDir: null,
      gitWorktreeDir: null,
      identity: { projectId: 'shared-package', canonicalRoot: canonicalRoot(firstRoot) },
    });

    assert.throws(() => store.registerProjectIdentity({
      projectId: 'path-second-repo',
      canonicalRoot: secondRoot,
      identitySource: 'workspace_root',
      identityDigest: 'digest-second-repo',
      legacyAliases: [{ projectId: 'shared-package', source: 'package' }],
    }), (error) => ['project_identity_legacy_ownership_unproven', 'project_identity_migration_conflict'].includes(error.code));
    assert.equal(store.getProjectIdentity({ projectId: 'path-second-repo' }), null);
    assert.equal(store.getRun('first-repo-run').projectId, 'shared-package');
  } finally {
    store.close();
    await rm(runtimeHome, { recursive: true, force: true });
  }
});

test('tampered identity migration journal paths are rejected before recovery', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-identity-journal-guard-'));
  try {
    const sourceRoot = path.join(runtimeHome, 'state', 'projects', 'legacy-journal-guard');
    await mkdir(sourceRoot, { recursive: true });
    await writeFile(path.join(sourceRoot, 'marker.json'), JSON.stringify({ projectId: 'legacy-journal-guard' }));
    const pending = prepareMigration({
      runtimeHome,
      legacyProjectIds: ['legacy-journal-guard'],
      projectId: 'path-journal-guard-target',
    });
    assert.deepEqual(pending.migratedProjectIds, ['legacy-journal-guard']);

    const journalName = (await readdir(path.join(runtimeHome, 'state', 'projects')))
      .find((entry) => entry.startsWith('.identity-migration-'));
    const journalPath = path.join(runtimeHome, 'state', 'projects', journalName, 'journal.json');
    const journal = JSON.parse(await readFile(journalPath, 'utf8'));
    journal.destination = path.join(runtimeHome, 'outside-runtime-home');
    await writeFile(journalPath, JSON.stringify(journal, null, 2));

    assert.throws(
      () => recoverProjectKnowledgeNamespaceMigrations({ runtimeHome, isCommitted: () => false }),
      (error) => error.code === 'IDENTITY_MIGRATION_JOURNAL_INVALID',
    );
  } finally {
    await rm(runtimeHome, { recursive: true, force: true });
  }
});

test('symlinked identity migration journal directories fail closed before recovery', async (t) => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-identity-journal-link-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'kernel-identity-journal-link-outside-'));
  try {
    const projectsRoot = path.join(runtimeHome, 'state', 'projects');
    await mkdir(projectsRoot, { recursive: true });
    try {
      await symlink(outside, path.join(projectsRoot, '.identity-migration-escape'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      t.skip(`symlink/junction creation unavailable: ${error.code || error.message}`);
      return;
    }
    assert.throws(
      () => recoverProjectKnowledgeNamespaceMigrations({ runtimeHome }),
      (error) => ['SYMLINK_NAMESPACE_UNSUPPORTED', 'NAMESPACE_PATH_ESCAPE'].includes(error.code),
    );
  } finally {
    await rm(runtimeHome, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('tampered identity migration install flags fail closed without deleting a destination', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-identity-journal-flags-'));
  try {
    const sourceRoot = path.join(runtimeHome, 'state', 'projects', 'legacy-journal-flags');
    await mkdir(sourceRoot, { recursive: true });
    await writeFile(path.join(sourceRoot, 'marker.json'), JSON.stringify({ projectId: 'legacy-journal-flags' }));
    const pending = prepareMigration({
      runtimeHome,
      legacyProjectIds: ['legacy-journal-flags'],
      projectId: 'path-journal-flags-target',
    });
    assert.deepEqual(pending.migratedProjectIds, ['legacy-journal-flags']);
    const journalName = (await readdir(path.join(runtimeHome, 'state', 'projects')))
      .find((entry) => entry.startsWith('.identity-migration-'));
    const journalPath = path.join(runtimeHome, 'state', 'projects', journalName, 'journal.json');
    const journal = JSON.parse(await readFile(journalPath, 'utf8'));
    journal.destinationInstalled = false;
    await writeFile(journalPath, JSON.stringify(journal, null, 2));

    assert.throws(
      () => recoverProjectKnowledgeNamespaceMigrations({ runtimeHome, isCommitted: () => false }),
      (error) => error.code === 'IDENTITY_MIGRATION_JOURNAL_INVALID',
    );
    assert.equal(await readFile(path.join(sourceRoot, 'marker.json'), 'utf8'), JSON.stringify({ projectId: 'legacy-journal-flags' }));
  } finally {
    await rm(runtimeHome, { recursive: true, force: true });
  }
});

test('tampered identity migration backup flags fail closed before rollback can delete the destination', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-identity-journal-backup-'));
  try {
    const projectsRoot = path.join(runtimeHome, 'state', 'projects');
    const sourceRoot = path.join(projectsRoot, 'legacy-journal-backup');
    const destinationRoot = path.join(projectsRoot, 'canonical-journal-backup');
    await mkdir(sourceRoot, { recursive: true });
    await mkdir(destinationRoot, { recursive: true });
    await writeFile(path.join(sourceRoot, 'source.json'), JSON.stringify({ projectId: 'legacy-journal-backup' }));
    await writeFile(path.join(destinationRoot, 'destination.json'), JSON.stringify({ projectId: 'canonical-journal-backup' }));
    const pending = prepareMigration({
      runtimeHome,
      legacyProjectIds: ['legacy-journal-backup'],
      projectId: 'canonical-journal-backup',
    });
    assert.deepEqual(pending.migratedProjectIds, ['legacy-journal-backup']);
    const journalName = (await readdir(projectsRoot)).find((entry) => entry.startsWith('.identity-migration-'));
    const journalRoot = path.join(projectsRoot, journalName);
    const journalPath = path.join(journalRoot, 'journal.json');
    const journal = JSON.parse(await readFile(journalPath, 'utf8'));
    await rm(journal.destinationBackup, { recursive: true, force: true });
    await rm(journal.destinationInstalledMarker, { force: true });
    journal.phase = 'staged';
    journal.destinationInstalled = false;
    journal.destinationBackupCreated = true;
    await writeFile(journalPath, JSON.stringify(journal, null, 2));

    assert.throws(
      () => recoverProjectKnowledgeNamespaceMigrations({ runtimeHome, isCommitted: () => false }),
      (error) => error.code === 'IDENTITY_MIGRATION_JOURNAL_INVALID',
    );
    assert.equal(await readFile(path.join(destinationRoot, 'destination.json'), 'utf8'), JSON.stringify({ projectId: 'canonical-journal-backup' }));
  } finally {
    await rm(runtimeHome, { recursive: true, force: true });
  }
});

test('identity migration journal recovers backup-pending and install-pending crash windows safely', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-identity-journal-pending-'));
  try {
    const projectsRoot = path.join(runtimeHome, 'state', 'projects');
    const sourceRoot = path.join(projectsRoot, 'legacy-journal-pending');
    const destinationRoot = path.join(projectsRoot, 'canonical-journal-pending');
    await mkdir(sourceRoot, { recursive: true });
    await mkdir(destinationRoot, { recursive: true });
    await writeFile(path.join(sourceRoot, 'source.json'), JSON.stringify({ projectId: 'legacy-journal-pending' }));
    await writeFile(path.join(destinationRoot, 'destination.json'), JSON.stringify({ projectId: 'canonical-journal-pending', version: 'original' }));

    prepareMigration({
      runtimeHome,
      legacyProjectIds: ['legacy-journal-pending'],
      projectId: 'canonical-journal-pending',
    });
    const journalName = (await readdir(projectsRoot)).find((entry) => entry.startsWith('.identity-migration-'));
    const journalRoot = path.join(projectsRoot, journalName);
    const journalPath = path.join(journalRoot, 'journal.json');
    const backupJournal = JSON.parse(await readFile(journalPath, 'utf8'));
    await rm(backupJournal.destination, { recursive: true, force: true });
    backupJournal.phase = 'backup-pending';
    backupJournal.destinationBackupPending = true;
    backupJournal.destinationBackupCreated = false;
    backupJournal.destinationInstallPending = false;
    backupJournal.destinationInstalled = false;
    await rm(backupJournal.destinationInstalledMarker, { force: true });
    await writeFile(journalPath, JSON.stringify(backupJournal, null, 2));
    recoverProjectKnowledgeNamespaceMigrations({ runtimeHome, isCommitted: () => false });
    assert.equal(await readFile(path.join(destinationRoot, 'destination.json'), 'utf8'), JSON.stringify({ projectId: 'canonical-journal-pending', version: 'original' }));

    prepareMigration({
      runtimeHome,
      legacyProjectIds: ['legacy-journal-pending'],
      projectId: 'canonical-journal-pending',
    });
    const installJournalName = (await readdir(projectsRoot)).find((entry) => entry.startsWith('.identity-migration-'));
    const installJournalRoot = path.join(projectsRoot, installJournalName);
    const installJournalPath = path.join(installJournalRoot, 'journal.json');
    const installJournal = JSON.parse(await readFile(installJournalPath, 'utf8'));
    installJournal.phase = 'destination-install-pending';
    installJournal.destinationBackupPending = false;
    installJournal.destinationInstallPending = true;
    installJournal.destinationInstalled = false;
    await rm(installJournal.destinationInstalledMarker, { force: true });
    await writeFile(installJournalPath, JSON.stringify(installJournal, null, 2));
    recoverProjectKnowledgeNamespaceMigrations({ runtimeHome, isCommitted: () => false });
    assert.equal(await readFile(path.join(destinationRoot, 'destination.json'), 'utf8'), JSON.stringify({ projectId: 'canonical-journal-pending', version: 'original' }));
  } finally {
    await rm(runtimeHome, { recursive: true, force: true });
  }
});

test('identity migration lock rejects a concurrent Kernel knowledge writer before source deletion', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-identity-writer-lock-'));
  try {
    const sourceRoot = path.join(runtimeHome, 'state', 'projects', 'legacy-writer-lock');
    await mkdir(sourceRoot, { recursive: true });
    await writeFile(path.join(sourceRoot, 'marker.json'), JSON.stringify({ projectId: 'legacy-writer-lock' }));
    const pending = prepareMigration({
      runtimeHome,
      legacyProjectIds: ['legacy-writer-lock'],
      projectId: 'canonical-writer-lock',
    });
    await assert.rejects(
      writeAtomicJson(path.join(sourceRoot, 'marker.json'), { projectId: 'legacy-writer-lock', changed: true }),
      (error) => error.code === 'IDENTITY_MIGRATION_LOCKED',
    );
    pending.rollback();
  } finally {
    await rm(runtimeHome, { recursive: true, force: true });
  }
});

test('identity migration preserves a changed legacy namespace instead of deleting it', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-identity-source-change-'));
  try {
    const sourceRoot = path.join(runtimeHome, 'state', 'projects', 'legacy-source-change');
    await mkdir(sourceRoot, { recursive: true });
    await writeFile(path.join(sourceRoot, 'marker.json'), JSON.stringify({ projectId: 'legacy-source-change', revision: 1 }));
    const pending = prepareMigration({
      runtimeHome,
      legacyProjectIds: ['legacy-source-change'],
      projectId: 'canonical-source-change',
    });
    assert.deepEqual(pending.migratedProjectIds, ['legacy-source-change']);
    await writeFile(path.join(sourceRoot, 'marker.json'), JSON.stringify({ projectId: 'legacy-source-change', revision: 2 }));

    pending.finalize();
    assert.equal(await readFile(path.join(sourceRoot, 'marker.json'), 'utf8'), JSON.stringify({ projectId: 'legacy-source-change', revision: 2 }));
    assert.equal(await readFile(path.join(runtimeHome, 'state', 'projects', 'canonical-source-change', 'marker.json'), 'utf8'), JSON.stringify({ projectId: 'canonical-source-change', revision: 1 }, null, 2));
    assert.equal((await readdir(path.join(runtimeHome, 'state', 'projects'))).some((entry) => entry.startsWith('.identity-migration-')), false);
  } finally {
    await rm(runtimeHome, { recursive: true, force: true });
  }
});

test('recovery requires the canonical root/digest witness and preserves a filesystem-only legacy source', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-identity-recovery-witness-'));
  const sourceRoot = path.join(runtimeHome, 'state', 'projects', 'legacy-recovery-witness');
  const currentRoot = path.join(runtimeHome, 'current-repo');
  const unrelatedRoot = path.join(runtimeHome, 'unrelated-repo');
  const store = await openKernelStateStore({ runtimeHome });
  try {
    await mkdir(sourceRoot, { recursive: true });
    await writeFile(path.join(sourceRoot, 'marker.json'), JSON.stringify({ projectId: 'legacy-recovery-witness' }));
    const pending = prepareMigration({
      runtimeHome,
      legacyProjectIds: ['legacy-recovery-witness'],
      projectId: 'canonical-recovery-witness',
      canonicalRoot: currentRoot,
      identityDigest: 'digest-current-recovery-witness',
    });
    assert.deepEqual(pending.migratedProjectIds, ['legacy-recovery-witness']);

    store.registerProjectIdentity({
      projectId: 'canonical-recovery-witness',
      canonicalRoot: unrelatedRoot,
      identitySource: 'workspace_root',
      identityDigest: 'digest-unrelated-recovery-witness',
    });
    store.close();

    const reopened = await openKernelStateStore({ runtimeHome });
    try {
      assert.equal(await readFile(path.join(sourceRoot, 'marker.json'), 'utf8'), JSON.stringify({ projectId: 'legacy-recovery-witness' }));
      assert.equal(await readFile(path.join(runtimeHome, 'state', 'projects', 'canonical-recovery-witness', 'marker.json'), 'utf8').then(() => true, () => false), false);
      assert.equal((await readdir(path.join(runtimeHome, 'state', 'projects'))).some((entry) => entry.startsWith('.identity-migration-')), false);
    } finally {
      reopened.close();
    }
  } finally {
    // `store` may already be closed after the simulated crash boundary.
    try { store.close(); } catch {}
    await rm(runtimeHome, { recursive: true, force: true });
  }
});

test('a committed sources-removed journal missing both identity witnesses fails closed and preserves canonical data', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-identity-recovery-missing-both-'));
  const sourceId = 'legacy-recovery-missing-both';
  const projectId = 'canonical-recovery-missing-both';
  const sourceRoot = path.join(runtimeHome, 'state', 'projects', sourceId);
  const canonicalRoot = path.join(runtimeHome, 'canonical-repo');
  try {
    await mkdir(sourceRoot, { recursive: true });
    await writeFile(path.join(sourceRoot, 'marker.json'), JSON.stringify({ projectId: sourceId, marker: 'must-survive' }));
    const pending = prepareMigration({
      runtimeHome,
      legacyProjectIds: [sourceId],
      projectId,
      canonicalRoot,
      identityDigest: 'digest-missing-both-regression',
    });
    const projectsRoot = path.join(runtimeHome, 'state', 'projects');
    const journalName = (await readdir(projectsRoot)).find((entry) => entry.startsWith('.identity-migration-'));
    const journalRoot = path.join(projectsRoot, journalName);
    const journalPath = path.join(journalRoot, 'journal.json');
    const journal = JSON.parse(await readFile(journalPath, 'utf8'));
    journal.phase = 'sources-removed';
    delete journal.canonicalRoot;
    delete journal.identityDigest;
    await writeFile(journalPath, JSON.stringify(journal, null, 2));
    await rm(sourceRoot, { recursive: true, force: true });

    const canonicalNamespace = path.join(projectsRoot, projectId);
    const before = await readFile(path.join(canonicalNamespace, 'marker.json'), 'utf8');
    assert.throws(
      () => recoverProjectKnowledgeNamespaceMigrations({ runtimeHome, isCommitted: () => true }),
      (error) => error.code === 'IDENTITY_MIGRATION_JOURNAL_INVALID',
    );
    assert.equal(await readFile(path.join(canonicalNamespace, 'marker.json'), 'utf8'), before);
    assert.equal(await access(journalPath).then(() => true, () => false), true, 'invalid journal remains for operator recovery');
    pending.rollback();
  } finally {
    await rm(runtimeHome, { recursive: true, force: true });
  }
});

test('origin fallback parser does not borrow a URL from another remote section', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'kernel-identity-origin-section-'));
  try {
    const gitDir = path.join(tmp, '.git');
    await mkdir(gitDir, { recursive: true });
    const env = { MOON_RELAY_KERNEL_HOME: path.join(tmp, '.moon-relay-kernel') };
    await writeFile(path.join(gitDir, 'config'), '[remote "backup"]\n\turl = https://github.com/backup/borrowed.git\n[remote "origin"]\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n');
    const withoutOrigin = resolveKernelProjectIdentity({ cwd: tmp, env });
    assert.deepEqual(withoutOrigin.aliases, []);
    assert.equal(withoutOrigin.legacyProjectIds.includes('github-com-backup-borrowed'), false);

    await writeFile(path.join(gitDir, 'config'), '[remote "backup"]\n\turl = https://github.com/backup/borrowed.git\n[remote "origin"]\n\turl = https://github.com/real/origin.git\n');
    const withOrigin = resolveKernelProjectIdentity({ cwd: tmp, env });
    assert.deepEqual(withOrigin.aliases, ['https://github.com/real/origin']);
    assert.equal(withOrigin.legacyProjectIds.includes('github-com-real-origin'), true);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('junction or symlink access resolves to one realpath identity and digest', async (t) => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'kernel-identity-realpath-'));
  try {
    const realRoot = path.join(tmp, 'real-repository');
    const linkedRoot = path.join(tmp, 'linked-repository');
    await mkdir(path.join(realRoot, '.git'), { recursive: true });
    try {
      await symlink(realRoot, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      t.skip(`symlink/junction creation unavailable: ${error.code || error.message}`);
      return;
    }
    const env = { MOON_RELAY_KERNEL_HOME: path.join(tmp, '.moon-relay-kernel') };
    const realIdentity = resolveKernelProjectIdentity({ cwd: realRoot, env });
    const linkedIdentity = resolveKernelProjectIdentity({ cwd: linkedRoot, env });
    assert.equal(linkedIdentity.canonicalRoot, realIdentity.canonicalRoot);
    assert.equal(linkedIdentity.projectId, realIdentity.projectId);
    assert.equal(linkedIdentity.identityDigest, realIdentity.identityDigest);
    const store = await openKernelStateStore({ runtimeHome: env.MOON_RELAY_KERNEL_HOME });
    try {
      store.registerProjectIdentity({ ...realIdentity, identityDigest: 'digest-realpath-root' });
      store.registerProjectIdentity({ ...linkedIdentity, identityDigest: 'digest-linked-root' });
      assert.equal(store.getProjectIdentity({ canonicalRoot: realIdentity.canonicalRoot }).projectId, realIdentity.projectId);
    } finally {
      store.close();
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
