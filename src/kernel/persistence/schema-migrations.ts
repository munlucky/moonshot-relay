import type { SqliteDatabase } from '../sqlite-adapter.js';
import { deriveKernelWorktreeId } from '../../contracts/worktree-authority.js';

// Additive runtime migrations use the same open connection and transaction runner.
export const migrateKernelSchema = (db: SqliteDatabase): void => {
  const hasColumn = (table: string, column: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((entry) => entry.name === column);
  const hadWorkspaceBaselineColumns = hasColumn('runs', 'workspace_baseline_changed_paths')
    && hasColumn('runs', 'workspace_baseline_entries');
  const hadWorkspaceBaselineStatus = hasColumn('runs', 'workspace_baseline_status');
  const addCol = (t: string, c: string, typ: string) => { try { db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${typ}`); } catch {} };
  addCol('git_closeout_receipts', 'status', 'TEXT');
  addCol('git_closeout_receipts', 'before_head_sha', 'TEXT');
  addCol('git_closeout_receipts', 'selected_paths_json', 'TEXT');
  addCol('git_closeout_receipts', 'error_code', 'TEXT');
  addCol('git_closeout_receipts', 'error_message', 'TEXT');
  addCol('git_closeout_receipts', 'updated_at', 'TEXT');

  // Task Contract authority (P0-4), finalization split (P0-7), route cursor (P1-1).
  addCol('runs', 'task_contract_json', 'TEXT');
  addCol('runs', 'contract_revision', 'INTEGER DEFAULT 1');
  addCol('runs', 'finalization_status', "TEXT DEFAULT 'pending'");
  addCol('runs', 'route_json', 'TEXT');
  addCol('runs', 'implementation_context_json', 'TEXT');
  // Plan revision (K2) is the ledger's own revision: a replan supersedes the
  // live steps and writes the replacement plan at the next revision, without
  // touching the task contract's revision.
  addCol('runs', 'plan_revision', 'INTEGER DEFAULT 1');
  addCol('runs', 'workspace_id', 'TEXT');
  addCol('runs', 'worktree_id', 'TEXT');
  // project_id was introduced after the original runs table. Worktree
  // backfill joins through it, so legacy databases must gain it first.
  addCol('runs', 'project_id', 'TEXT');
  addCol('runs', 'owner_binding_id', 'TEXT');
  addCol('runs', 'successor_key', 'TEXT');
  // Nullable on migration so a legacy Run can fall back to its immutable
  // Run-start baseline. Fresh Runs always initialize these fields explicitly.
  addCol('runs', 'workspace_baseline_changed_paths', 'TEXT');
  addCol('runs', 'workspace_baseline_entries', 'TEXT');
  // A legacy Run whose workspace baseline was not captured must not silently
  // attribute pre-existing dirty files to Kernel work.
  addCol('runs', 'workspace_baseline_status', 'TEXT');
  try {
    db.prepare(`
      UPDATE runs
      SET workspace_baseline_status = CASE
        WHEN workspace_baseline_changed_paths IS NULL
          OR workspace_baseline_entries IS NULL THEN 'unknown'
        WHEN workspace_baseline_status IS NULL THEN ?
        ELSE workspace_baseline_status
      END
      WHERE workspace_baseline_status IS NULL
    `).run(hadWorkspaceBaselineColumns ? 'known' : 'unknown');
  } catch {}
  // Baselines captured before index identity was added cannot protect a
  // partially-staged pre-existing file. Mark only non-empty legacy baselines
  // unknown; an empty baseline remains sufficient because every live changed
  // path is then Run-owned by definition.
  if (!hadWorkspaceBaselineStatus || hadWorkspaceBaselineColumns) {
    try {
      const rows = db.prepare(`
        SELECT run_id AS runId, workspace_baseline_status AS status,
               baseline_changed_paths AS baselineChangedPaths,
               baseline_workspace_entries AS baselineEntries
        FROM runs
      `).all() as Array<{ runId: string; status: string; baselineChangedPaths: string | null; baselineEntries: string | null }>;
      for (const row of rows) {
        if (row.status !== 'known') continue;
        let paths: unknown = [];
        let entries: unknown = [];
        try { paths = JSON.parse(row.baselineChangedPaths || '[]'); } catch {}
        try { entries = JSON.parse(row.baselineEntries || '[]'); } catch {}
        const hasUnindexedBaseline = Array.isArray(paths) && paths.length > 0
          && (!Array.isArray(entries) || entries.some((entry) => !entry
            || typeof entry !== 'object' || Array.isArray(entry)
            || (entry as Record<string, unknown>).indexStateKnown !== true
            || !Object.prototype.hasOwnProperty.call(entry, 'statusCode')));
        if (hasUnindexedBaseline) {
          db.prepare(`UPDATE runs SET workspace_baseline_status='unknown' WHERE run_id=?`).run(row.runId);
        }
      }
    } catch {}
  }
  addCol('project_workspaces', 'worktree_id', 'TEXT');
  // Obligation binding authority (P0-2/P0-3).
  addCol('run_obligations', 'evidence_class', "TEXT DEFAULT 'hard'");
  addCol('run_obligations', 'metadata_json', "TEXT DEFAULT '{}'");
  addCol('run_obligations', 'verification_method', 'TEXT');
  addCol('run_obligations', 'allowed_command_refs', "TEXT DEFAULT '[]'");
  addCol('run_obligations', 'acceptance_ids', "TEXT DEFAULT '[]'");
  addCol('run_obligations', 'protected', 'INTEGER DEFAULT 0');
  addCol('run_obligations', 'contract_revision', 'INTEGER DEFAULT 1');
  addCol('run_obligations', 'rejected_command_refs', "TEXT DEFAULT '[]'");
  // Capsule (K1), admission (K3), and step (K2) lineage on the usage receipt.
  // Legacy receipts keep NULL: a turn that ran before these existed is not
  // retroactively claimed to have had them.
  addCol('model_usage_receipts', 'capsule_id', 'TEXT');
  addCol('model_usage_receipts', 'capsule_digest', 'TEXT');
  addCol('model_usage_receipts', 'admission_id', 'TEXT');
  addCol('model_usage_receipts', 'admission_digest', 'TEXT');
  addCol('model_usage_receipts', 'step_id', 'TEXT');
  addCol('model_usage_receipts', 'attempt_id', 'TEXT');
  addCol('model_usage_receipts', 'binding_id', 'TEXT');
  // Wave 8 cache/model economics. Additive only: existing rows keep NULL, which
  // reads as "not measured" rather than "measured as zero". There is no
  // destructive rollback for these columns by design.
  addCol('model_usage_receipts', 'provider', 'TEXT');
  addCol('model_usage_receipts', 'surface', 'TEXT');
  addCol('model_usage_receipts', 'speed_mode', 'TEXT');
  addCol('model_usage_receipts', 'reasoning_context', 'TEXT');
  addCol('model_usage_receipts', 'reasoning_mode', 'TEXT');
  addCol('model_usage_receipts', 'delegation_mode', 'TEXT');
  addCol('model_usage_receipts', 'session_lineage_id', 'TEXT');
  addCol('model_usage_receipts', 'previous_response_id_digest', 'TEXT');
  addCol('model_usage_receipts', 'prompt_prefix_digest', 'TEXT');
  addCol('model_usage_receipts', 'prompt_cache_key_digest', 'TEXT');
  addCol('model_usage_receipts', 'cache_mode', 'TEXT');
  addCol('model_usage_receipts', 'cache_ttl', 'TEXT');
  addCol('model_usage_receipts', 'cache_miss_reason', 'TEXT');
  addCol('model_usage_receipts', 'model_escalation_reason', 'TEXT');
  addCol('model_usage_receipts', 'eligible_prefix_tokens', 'INTEGER');
  addCol('model_usage_receipts', 'uncached_input_tokens', 'INTEGER');
  addCol('model_usage_receipts', 'cache_read_input_tokens', 'INTEGER');
  addCol('model_usage_receipts', 'cache_write_input_tokens', 'INTEGER');
  addCol('model_usage_receipts', 'reasoning_tokens', 'INTEGER');
  addCol('verifications', 'evidence_class', "TEXT DEFAULT 'attested'");
  addCol('verifications', 'contract_revision', 'INTEGER DEFAULT 1');
  addCol('leases', 'fencing_token', 'INTEGER DEFAULT 0');
  addCol('leases', 'owner_pid', 'INTEGER');
  addCol('session_bindings', 'closed_at', 'TEXT');
  addCol('session_bindings', 'close_reason', 'TEXT');
  addCol('session_bindings', 'successor_run_id', 'TEXT');
  addCol('run_steps', 'execution_workspace_id', 'TEXT');
  addCol('run_steps', 'base_workspace_identity', 'TEXT');
  addCol('run_steps', 'result_workspace_identity', 'TEXT');
  addCol('run_steps', 'result_commit_sha', 'TEXT');
  addCol('run_steps', 'patch_digest', 'TEXT');
  addCol('run_steps', 'result_attempt_id', 'TEXT');
  addCol('run_step_attempts', 'workspace_id', 'TEXT');
  addCol('run_step_attempts', 'workspace_root_hash', 'TEXT');
  addCol('run_step_attempts', 'base_workspace_identity', 'TEXT');
  addCol('run_step_attempts', 'result_workspace_identity', 'TEXT');
  addCol('run_step_attempts', 'result_commit_sha', 'TEXT');
  addCol('run_step_attempts', 'patch_digest', 'TEXT');
  addCol('run_step_attempts', 'worker_report_json', 'TEXT');
  addCol('run_step_attempts', 'verification_refs_json', "TEXT DEFAULT '[]'");
  addCol('run_step_attempts', 'knowledge_observation_refs_json', "TEXT DEFAULT '[]'");
  addCol('run_step_attempts', 'attempt_id', 'TEXT');
  addCol('run_step_attempts', 'binding_id', 'TEXT');
  addCol('run_step_attempts', 'capsule_id', 'TEXT');
  addCol('run_step_attempts', 'admission_id', 'TEXT');
  addCol('run_step_attempts', 'parent_attempt_id', 'TEXT');
  addCol('run_step_attempts', 'provenance_kind', "TEXT DEFAULT 'legacy-unattributed'");
  // These remain nullable so old rows do not acquire guessed plan/mutation
  // lineage. Canonical attempts supply both values at creation time.
  addCol('run_step_attempts', 'plan_revision', 'INTEGER');
  addCol('run_step_attempts', 'mutation_revision', 'INTEGER');
  addCol('run_step_attempts', 'retry_reason', 'TEXT');
  addCol('run_step_attempts', 'failure_category', 'TEXT');
  // Report operation identity is independent from payload identity. Older
  // report_digest rows mixed those concerns; terminal rows keep an explicit
  // legacy marker for audit while new writers use only report_key and
  // report_payload_digest.
  addCol('run_step_attempts', 'report_digest', 'TEXT');
  addCol('run_step_attempts', 'report_key', 'TEXT');
  addCol('run_step_attempts', 'report_checkpoint_json', 'TEXT');
  addCol('run_step_attempts', 'report_payload_digest', 'TEXT');
  addCol('run_step_attempts', 'report_result_json', 'TEXT');
  db.transaction(() => {
    db.exec(`
      UPDATE run_step_attempts
      SET report_key='legacy:' || id || ':' || report_digest,
          report_payload_digest=NULL,
          report_digest=NULL
      WHERE report_digest IS NOT NULL
        AND report_key IS NULL
        AND status NOT IN ('started','reported','verifying');
      UPDATE run_step_attempts
      SET report_digest=NULL
      WHERE report_digest IS NOT NULL
        AND status IN ('started','reported','verifying');
      CREATE UNIQUE INDEX IF NOT EXISTS uq_run_step_attempts_report_key
      ON run_step_attempts(run_id, report_key)
      WHERE report_key IS NOT NULL;
    `);
  })();
  addCol('run_step_attempts', 'review_claim_key', 'TEXT');
  addCol('run_step_attempts', 'review_claim_holder', 'TEXT');
  addCol('run_step_attempts', 'review_claim_expires_at', 'TEXT');
  // A review claim is scoped to the durable subject, not globally to a
  // caller-chosen string. This lets a new plan/step reuse a claim label
  // without colliding with an old-plan attempt.
  db.exec(`
    DROP INDEX IF EXISTS idx_run_step_attempts_review_claim;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_run_step_attempts_review_claim
    ON run_step_attempts(run_id, step_id, plan_revision, review_claim_key)
    WHERE review_claim_key IS NOT NULL;
  `);
  addCol('route_admissions', 'attempt_id', 'TEXT');
  addCol('project_workspaces', 'mutation_epoch', 'INTEGER NOT NULL DEFAULT 0');
  db.exec(`UPDATE project_workspaces SET mutation_epoch=MAX(mutation_epoch,
    COALESCE((SELECT fencing_token FROM workspace_mutation_locks_v2 WHERE workspace_id=project_workspaces.workspace_id), 0))`);
  addCol('review_receipts', 'step_id', 'TEXT');
  addCol('review_receipts', 'reviewer_binding_id', 'TEXT');
  addCol('review_receipts', 'implementer_attempt_id', 'TEXT');
  addCol('review_receipts', 'review_subject_key', 'TEXT');
  // Legacy receipts stay auditable without retroactively choosing a winner.
  // New receipts use a subject key so at most one result is adopted for one
  // plan/mutation/evidence subject while all reviewer attempt rows remain.
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_review_receipts_subject
    ON review_receipts(run_id, review_subject_key)
    WHERE review_subject_key IS NOT NULL;
  `);
  // Remove the retired execution lifecycle from databases created before the
  // compression. In-flight grouped executions become ordinary retryable Step
  // attempts; their individual receipts remain the recovery record. The
  // migration is intentionally one-way: no compatibility table or adapter is
  // recreated after the authoritative lifecycle is gone.
  try {
    db.exec(`
      UPDATE run_step_attempts
      SET status='interrupted', finished_at=COALESCE(finished_at, '${new Date().toISOString()}'),
          failure_category=COALESCE(failure_category, 'provider/infrastructure')
      WHERE wave_id IS NOT NULL AND status IN ('started', 'running');
      UPDATE run_steps
      SET state='failed', blocked_reason=COALESCE(blocked_reason, 'execution-recovered-after-lifecycle-removal')
      WHERE integration_state='pending' AND state NOT IN ('passed', 'superseded', 'cancelled');
    `);
  } catch {}
  try { db.exec('ALTER TABLE run_steps DROP COLUMN wave_id'); } catch {}
  try { db.exec('ALTER TABLE run_steps DROP COLUMN integration_state'); } catch {}
  try { db.exec('ALTER TABLE run_steps DROP COLUMN integrated_at'); } catch {}
  try { db.exec('ALTER TABLE run_step_attempts DROP COLUMN wave_id'); } catch {}
  try { db.exec('DROP TABLE IF EXISTS wave_integration_receipts'); } catch {}
  try { db.exec('DROP TABLE IF EXISTS run_waves'); } catch {}

  // Worktree identity is a deterministic projection of the existing project
  // workspace registry. Backfill it in place so legacy workspaceId-bound Runs
  // gain the new authority without inventing a second registry or database.
  const persistedWorkspaces = db.prepare(`
    SELECT workspace_id AS workspaceId, project_id AS projectId,
           canonical_root AS canonicalRoot, git_worktree_dir AS gitWorktreeDir
    FROM project_workspaces
  `).all() as Array<{ workspaceId: string; projectId: string; canonicalRoot: string; gitWorktreeDir: string | null }>;
  for (const workspace of persistedWorkspaces) {
    const worktreeId = deriveKernelWorktreeId({
      projectId: workspace.projectId,
      canonicalWorktreeRoot: workspace.canonicalRoot,
      canonicalGitDir: workspace.gitWorktreeDir || null,
    });
    db.prepare(`UPDATE project_workspaces SET worktree_id=? WHERE workspace_id=?`)
      .run(worktreeId, workspace.workspaceId);
  }
  db.prepare(`
    UPDATE runs
    SET worktree_id=(
      SELECT w.worktree_id FROM project_workspaces w
      WHERE w.workspace_id=runs.workspace_id AND w.project_id=runs.project_id
    )
    WHERE worktree_id IS NULL AND workspace_id IS NOT NULL
  `).run();
  // The worktree lease never expires. Opening a migrated database removes
  // only leases whose Run is already terminal (or whose binding is corrupt),
  // then adopts an unambiguous legacy mutable Run for each worktree. Multiple
  // mutable Runs on one worktree remain unleased and fail closed at invocation.
  db.prepare(`
    DELETE FROM worktree_mutation_leases
    WHERE holder_run_id NOT IN (
      SELECT run_id FROM runs
      WHERE status IN ('active', 'blocked')
        AND runs.project_id=worktree_mutation_leases.project_id
        AND runs.worktree_id=worktree_mutation_leases.worktree_id
    )
  `).run();
  db.prepare(`
    INSERT OR IGNORE INTO worktree_mutation_leases(
      worktree_id, project_id, holder_run_id, acquired_at
    )
    SELECT r.worktree_id, r.project_id, r.run_id, r.updated_at
    FROM runs r
    WHERE r.status IN ('active', 'blocked')
      AND r.worktree_id IS NOT NULL
      AND r.project_id IS NOT NULL
      AND (
        SELECT COUNT(*) FROM runs peer
        WHERE peer.status IN ('active', 'blocked')
          AND peer.project_id=r.project_id
          AND peer.worktree_id=r.worktree_id
      )=1
  `).run();

  // Existing rows have no trustworthy provenance. Preserve them as
  // legacy-unattributed rather than inferring an execution mode from defaults.
  db.prepare(`UPDATE run_step_attempts SET provenance_kind='legacy-unattributed' WHERE attempt_id IS NULL`).run();

  try { db.exec(`ALTER TABLE runs ADD COLUMN source_identity TEXT;`); } catch {}
  try { db.exec(`ALTER TABLE runs ADD COLUMN mutation_revision INTEGER DEFAULT 0;`); } catch {}
  try { db.exec(`ALTER TABLE runs ADD COLUMN run_start_git_commit_sha TEXT;`); } catch {}
  try { db.exec(`ALTER TABLE runs ADD COLUMN run_start_workspace_identity TEXT;`); } catch {}
  try { db.exec(`ALTER TABLE runs ADD COLUMN current_workspace_identity TEXT;`); } catch {}
  try { db.exec(`ALTER TABLE runs ADD COLUMN blocked_reason TEXT;`); } catch {}
  try { db.exec(`ALTER TABLE runs ADD COLUMN blocking_class TEXT;`); } catch {}
  try { db.exec(`ALTER TABLE runs ADD COLUMN intervention_count INTEGER DEFAULT 0;`); } catch {}
  try { db.exec(`ALTER TABLE runs ADD COLUMN project_mode TEXT;`); } catch {}
  try { db.exec(`ALTER TABLE runs ADD COLUMN baseline_failures TEXT DEFAULT '[]';`); } catch {}
  try { db.exec(`ALTER TABLE runs ADD COLUMN baseline_status TEXT DEFAULT 'pending';`); } catch {}
  try { db.exec(`ALTER TABLE runs ADD COLUMN baseline_changed_paths TEXT NOT NULL DEFAULT '[]';`); } catch {}
  try { db.exec(`ALTER TABLE runs ADD COLUMN baseline_workspace_entries TEXT NOT NULL DEFAULT '[]';`); } catch {}
  try { db.exec(`ALTER TABLE runs ADD COLUMN replan_count INTEGER DEFAULT 0;`); } catch {}
  try { db.exec(`ALTER TABLE runs ADD COLUMN proof_tier TEXT DEFAULT 'T0';`); } catch {}
  try { db.exec(`ALTER TABLE runs ADD COLUMN evidence_tier TEXT DEFAULT 'E0';`); } catch {}
  try { db.exec(`ALTER TABLE runs ADD COLUMN required_obligations TEXT DEFAULT '[]';`); } catch {}
  try { db.exec(`ALTER TABLE runs ADD COLUMN acceptance_criteria TEXT DEFAULT '[]';`); } catch {}
  try { db.exec(`ALTER TABLE runs ADD COLUMN release_evidence_required INTEGER DEFAULT 0;`); } catch {}
  try { db.exec(`ALTER TABLE runs ADD COLUMN project_id TEXT;`); } catch {}
  try { db.exec(`ALTER TABLE runs ADD COLUMN knowledge_revision_start TEXT;`); } catch {}
  try { db.exec(`ALTER TABLE runs ADD COLUMN knowledge_revision_close TEXT;`); } catch {}
  try { db.exec(`ALTER TABLE runs ADD COLUMN knowledge_status TEXT;`); } catch {}
  try { db.exec(`ALTER TABLE runs ADD COLUMN run_signals_json TEXT NOT NULL DEFAULT '{}';`); } catch {}
  try { db.exec(`ALTER TABLE runs ADD COLUMN context_pack_ref TEXT;`); } catch {}
  try { db.exec(`ALTER TABLE verifications ADD COLUMN obligation_id TEXT DEFAULT 'default';`); } catch {}
  try { db.exec(`ALTER TABLE verifications ADD COLUMN acceptance_coverage TEXT DEFAULT '[]';`); } catch {}
  try { db.exec(`ALTER TABLE verifications ADD COLUMN verified_source_identity TEXT;`); } catch {}
  try { db.exec(`ALTER TABLE verifications ADD COLUMN executor TEXT DEFAULT 'caller-attested';`); } catch {}
  try { db.exec(`ALTER TABLE verifications ADD COLUMN network_isolation TEXT;`); } catch {}
  try { db.exec(`ALTER TABLE verifications ADD COLUMN command_ref TEXT;`); } catch {}
  try { db.exec(`ALTER TABLE waivers ADD COLUMN approval_receipt TEXT;`); } catch {}
  try { db.exec(`ALTER TABLE waivers ADD COLUMN acceptance_coverage TEXT DEFAULT '[]';`); } catch {}
  try { db.exec(`ALTER TABLE evidence_packs ADD COLUMN mutation_revision INTEGER DEFAULT 0;`); } catch {}
  try { db.exec(`ALTER TABLE verifications ADD COLUMN evidence_identity_json TEXT NOT NULL DEFAULT '{}';`); } catch {}
  try { db.exec(`ALTER TABLE verifications ADD COLUMN reuse_of_verification_id INTEGER;`); } catch {}
  try { db.exec(`ALTER TABLE verifications ADD COLUMN reuse_receipt_json TEXT;`); } catch {}

  // Canonicalize the retired workflow states once when an existing database is
  // opened. This is intentionally idempotent and only touches active Runs;
  // historical/terminal rows remain an audit record of the old schema.
  try {
    db.exec(`
      UPDATE runs
      SET state='FRAME'
      WHERE status='active' AND state IN ('SHAPE', 'SLICE', 'SCHEDULE');
    `);
  } catch {}

  // Fresh state and already-valid legacy state gain database-level owner
  // invariants. If legacy corruption contains duplicate active owners, opening
  // the store fails closed instead of silently selecting one.
  try {
    db.exec(`
      DROP INDEX IF EXISTS uq_project_session_active_owner;
      DROP INDEX IF EXISTS uq_project_worktree_identity;
      CREATE UNIQUE INDEX IF NOT EXISTS uq_project_session_workspace_active_owner
      ON session_bindings(project_id, session_id, workspace_id)
      WHERE status='active' AND access_mode='owner';
      CREATE UNIQUE INDEX IF NOT EXISTS uq_run_active_owner
      ON session_bindings(run_id)
      WHERE status='active' AND access_mode='owner';
      CREATE UNIQUE INDEX IF NOT EXISTS uq_runs_successor_key
      ON runs(successor_key)
      WHERE successor_key IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS uq_run_step_attempts_attempt_id
      ON run_step_attempts(attempt_id)
      WHERE attempt_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_run_step_attempts_lineage
      ON run_step_attempts(run_id, step_id, plan_revision, mutation_revision);
      CREATE INDEX IF NOT EXISTS idx_model_usage_receipts_attempt
      ON model_usage_receipts(run_id, attempt_id);
      CREATE INDEX IF NOT EXISTS idx_route_admissions_attempt
      ON route_admissions(run_id, attempt_id);
      CREATE INDEX IF NOT EXISTS idx_runs_project_worktree_status
      ON runs(project_id, worktree_id, status);
    `);
  } catch (error) {
    db.close();
    throw error;
  }

};
