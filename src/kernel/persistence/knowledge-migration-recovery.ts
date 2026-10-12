import path from 'node:path';
import type { SqliteDatabase } from '../sqlite-adapter.js';
import { recoverProjectKnowledgeNamespaceMigrations } from '../knowledge/store.js';

export const recoverKnowledgeMigrations = (db: SqliteDatabase, runtimeHome: string): void => {
  // Finish or roll back any copy-first knowledge migration left by a process
  // crash. The SQLite identity rows are the commit witness: a canonical row
  // with no remaining legacy rows means the transaction committed; otherwise
  // the filesystem journal is restored without deleting the legacy source.
   try {
    const normalizeRecoveryRoot = (value: unknown) => {
      const resolved = path.resolve(String(value || '')).replaceAll('\\', '/');
      return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    };
    const quoteRecoveryIdentifier = (value: string) => `"${String(value).replaceAll('"', '""')}"`;
    const recoveryProjectScopedTables = (db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type='table' AND name NOT LIKE 'sqlite_%'
    `).all() as Array<{ name: string }> )
      .map(({ name }) => name)
      .filter((name) => name !== 'project_identities')
      .filter((name) => (db.prepare(`PRAGMA table_info(${quoteRecoveryIdentifier(name)})`).all() as Array<{ name: string }> )
        .some((column) => column.name === 'project_id'));
    const hasRecoveryProjectState = (projectId: string) => recoveryProjectScopedTables.some((table) => (
      Number((db.prepare(`SELECT COUNT(*) AS count FROM ${quoteRecoveryIdentifier(table)} WHERE project_id=?`).get(projectId) as { count: number } | undefined)?.count || 0) > 0
    ));

    recoverProjectKnowledgeNamespaceMigrations({
      runtimeHome,
      isCommitted: (journal) => {
        const canonical = db.prepare('SELECT canonical_root, identity_digest FROM project_identities WHERE project_id=? LIMIT 1').get(journal.projectId) as { canonical_root: string; identity_digest: string } | undefined;
        if (!canonical || !journal.canonicalRoot || !journal.identityDigest) return false;
        if (normalizeRecoveryRoot(canonical.canonical_root) !== normalizeRecoveryRoot(journal.canonicalRoot)) return false;
        if (String(canonical.identity_digest || '') !== String(journal.identityDigest)) return false;
        return journal.sourceIds.every((legacyId) => (
          !db.prepare('SELECT 1 FROM project_identities WHERE project_id=? LIMIT 1').get(legacyId)
          && !hasRecoveryProjectState(legacyId)
        ));
      },
    });
  } catch (error) {
    db.close();
    throw error;
  }

};
