import type { SqliteDatabase } from '../sqlite-adapter.js';

export interface PersistedProjectIdentity {
  project_id: string;
  canonical_root: string;
  identity_source: string;
  identity_digest: string;
  aliases_json: string;
  created_at: string;
  updated_at: string;
}

export interface PersistedProjectIdentityAlias {
  alias: string;
  project_id: string;
  alias_type: string;
  created_at: string;
  updated_at: string;
}

export interface ProjectIdentityPersistence {
  getIdentityByProjectId(projectId: string): PersistedProjectIdentity | null;
  getIdentityByCanonicalRoot(canonicalRoot: string): PersistedProjectIdentity | null;
  listIdentities(): PersistedProjectIdentity[];
  getIdentityByAlias(alias: string): PersistedProjectIdentity | null;
  listIdentityMatchesByAliases(aliases: string[]): PersistedProjectIdentity[];
  getAliasOwner(alias: string): string | null;
  listAliases(projectId: string, aliasType?: string | null): string[];
  insertIdentity(input: {
    projectId: string;
    canonicalRoot: string;
    identitySource: string;
    identityDigest: string;
    aliasesJson: string;
    createdAt: string;
    updatedAt: string;
  }): void;
  updateIdentityAliases(input: {
    projectId: string;
    aliasesJson: string;
    updatedAt: string;
  }): void;
  deleteIdentity(projectId: string): boolean;
  upsertAlias(input: {
    alias: string;
    projectId: string;
    aliasType: string;
    createdAt: string;
    updatedAt: string;
  }): void;
}

export const createProjectIdentityPersistence = ({
  db,
}: {
  db: SqliteDatabase;
}): ProjectIdentityPersistence => ({
  getIdentityByProjectId(projectId) {
    return (db.prepare(
      'SELECT * FROM project_identities WHERE project_id=?',
    ).get(projectId) as PersistedProjectIdentity | undefined) ?? null;
  },

  getIdentityByCanonicalRoot(canonicalRoot) {
    return (db.prepare(
      'SELECT * FROM project_identities WHERE canonical_root=?',
    ).get(canonicalRoot) as PersistedProjectIdentity | undefined) ?? null;
  },

  listIdentities() {
    return db.prepare(
      'SELECT * FROM project_identities',
    ).all() as PersistedProjectIdentity[];
  },

  getIdentityByAlias(alias) {
    return (db.prepare(`
      SELECT p.*
      FROM project_identity_aliases a
      JOIN project_identities p ON p.project_id=a.project_id
      WHERE a.alias=?
    `).get(alias) as PersistedProjectIdentity | undefined) ?? null;
  },

  listIdentityMatchesByAliases(aliases) {
    const matches = aliases
      .map((alias) => this.getIdentityByAlias(alias))
      .filter((row): row is PersistedProjectIdentity => Boolean(row));
    return [...new Map(matches.map((row) => [row.project_id, row])).values()];
  },

  getAliasOwner(alias) {
    const row = db.prepare(
      'SELECT project_id AS projectId FROM project_identity_aliases WHERE alias=?',
    ).get(alias) as { projectId?: string } | undefined;
    return row?.projectId ?? null;
  },

  listAliases(projectId, aliasType = null) {
    const rows = aliasType
      ? db.prepare(`
          SELECT alias
          FROM project_identity_aliases
          WHERE project_id=? AND alias_type=?
          ORDER BY alias
        `).all(projectId, aliasType)
      : db.prepare(`
          SELECT alias
          FROM project_identity_aliases
          WHERE project_id=?
          ORDER BY alias
        `).all(projectId);
    return (rows as Array<{ alias: string }>).map((row) => row.alias);
  },

  insertIdentity({
    projectId,
    canonicalRoot,
    identitySource,
    identityDigest,
    aliasesJson,
    createdAt,
    updatedAt,
  }) {
    db.prepare(`
      INSERT INTO project_identities(
        project_id, canonical_root, identity_source,
        identity_digest, aliases_json, created_at, updated_at
      )
      VALUES(?, ?, ?, ?, ?, ?, ?)
    `).run(
      projectId,
      canonicalRoot,
      identitySource,
      identityDigest,
      aliasesJson,
      createdAt,
      updatedAt,
    );
  },

  updateIdentityAliases({ projectId, aliasesJson, updatedAt }) {
    db.prepare(
      'UPDATE project_identities SET aliases_json=?, updated_at=? WHERE project_id=?',
    ).run(aliasesJson, updatedAt, projectId);
  },

  deleteIdentity(projectId) {
    const result = db.prepare(
      'DELETE FROM project_identities WHERE project_id=?',
    ).run(projectId) as { changes?: number | bigint };
    return Number(result.changes || 0) === 1;
  },

  upsertAlias({ alias, projectId, aliasType, createdAt, updatedAt }) {
    db.prepare(`
      INSERT INTO project_identity_aliases(
        alias, project_id, alias_type, created_at, updated_at
      )
      VALUES(?, ?, ?, ?, ?)
      ON CONFLICT(alias) DO UPDATE SET updated_at=excluded.updated_at
    `).run(alias, projectId, aliasType, createdAt, updatedAt);
  },
});
