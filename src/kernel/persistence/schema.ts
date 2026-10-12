import type { SqliteDatabase } from '../sqlite-adapter.js';

export const initializeKernelSchema = (db: SqliteDatabase) => {
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA synchronous=NORMAL;
    PRAGMA busy_timeout=5000;
    PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS runs (
      run_id TEXT PRIMARY KEY,
      objective TEXT NOT NULL,
      state TEXT NOT NULL,
      status TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0,
      mutation_revision INTEGER NOT NULL DEFAULT 0,
      source_identity TEXT NOT NULL,
      proof_tier TEXT NOT NULL DEFAULT 'T0',
      evidence_tier TEXT NOT NULL DEFAULT 'E0',
      required_obligations TEXT NOT NULL DEFAULT '[]',
      acceptance_criteria TEXT NOT NULL DEFAULT '[]',
      release_evidence_required INTEGER NOT NULL DEFAULT 0,
      successor_key TEXT,
      run_signals_json TEXT NOT NULL DEFAULT '{}',
      baseline_changed_paths TEXT NOT NULL DEFAULT '[]',
      baseline_workspace_entries TEXT NOT NULL DEFAULT '[]',
      workspace_baseline_changed_paths TEXT NOT NULL DEFAULT '[]',
      workspace_baseline_entries TEXT NOT NULL DEFAULT '[]',
      workspace_baseline_status TEXT NOT NULL DEFAULT 'known',
      blocked_reason TEXT,
      blocking_class TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS verifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      obligation_id TEXT NOT NULL DEFAULT 'default',
      status TEXT NOT NULL,
      evidence_ref TEXT,
      verified_runtime_revision INTEGER,
      verified_mutation_revision INTEGER,
      source_identity TEXT,
      command_ref TEXT,
      command TEXT,
      exit_code INTEGER,
      evidence_digest TEXT,
      acceptance_coverage TEXT NOT NULL DEFAULT '[]',
      evidence_identity_json TEXT NOT NULL DEFAULT '{}',
      reuse_of_verification_id INTEGER,
      reuse_receipt_json TEXT,
      observed_at TEXT NOT NULL,
      FOREIGN KEY(run_id) REFERENCES runs(run_id)
    );
    CREATE TABLE IF NOT EXISTS leases (
      run_id TEXT PRIMARY KEY,
      holder TEXT NOT NULL,
      acquired_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      FOREIGN KEY(run_id) REFERENCES runs(run_id)
    );
    CREATE TABLE IF NOT EXISTS session_bindings (
      binding_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      surface TEXT,
      run_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      workspace_id TEXT,
      workspace_root TEXT,
      access_mode TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(run_id) REFERENCES runs(run_id)
    );
    CREATE INDEX IF NOT EXISTS idx_session_bindings_lookup ON session_bindings(session_id, run_id, status);
    CREATE INDEX IF NOT EXISTS idx_session_bindings_project ON session_bindings(project_id, workspace_id, status);
    CREATE TABLE IF NOT EXISTS project_identities (
      project_id TEXT PRIMARY KEY,
      canonical_root TEXT NOT NULL UNIQUE,
      identity_source TEXT NOT NULL,
      identity_digest TEXT NOT NULL,
      aliases_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS project_identity_aliases (
      alias TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      alias_type TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(project_id, alias)
    );
    CREATE INDEX IF NOT EXISTS idx_project_identity_aliases_project ON project_identity_aliases(project_id);
    CREATE TABLE IF NOT EXISTS project_workspaces (
      workspace_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      canonical_root TEXT NOT NULL,
      git_common_dir TEXT,
      git_worktree_dir TEXT,
      identity_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      UNIQUE(project_id, canonical_root)
    );
    CREATE TABLE IF NOT EXISTS workspace_mutation_locks_v2 (
      workspace_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      holder_run_id TEXT NOT NULL,
      session_token TEXT NOT NULL,
      fencing_token INTEGER NOT NULL,
      acquired_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS worktree_mutation_leases (
      worktree_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      holder_run_id TEXT NOT NULL,
      acquired_at TEXT NOT NULL,
      FOREIGN KEY(holder_run_id) REFERENCES runs(run_id)
    );
    CREATE TABLE IF NOT EXISTS waivers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      obligation_id TEXT NOT NULL,
      approved_by TEXT NOT NULL,
      reason TEXT NOT NULL,
      approved_at TEXT NOT NULL,
      approval_receipt TEXT NOT NULL,
      acceptance_coverage TEXT NOT NULL DEFAULT '[]',
      FOREIGN KEY(run_id) REFERENCES runs(run_id)
    );
    CREATE TABLE IF NOT EXISTS evidence_lineage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      evidence_digest TEXT NOT NULL,
      parent_digest TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(run_id) REFERENCES runs(run_id)
    );
    CREATE TABLE IF NOT EXISTS evidence_packs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      tier TEXT NOT NULL,
      digest TEXT NOT NULL,
      pack_json TEXT NOT NULL,
      mutation_revision INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY(run_id) REFERENCES runs(run_id)
    );
    CREATE TABLE IF NOT EXISTS knowledge_context_receipts (
      run_id TEXT NOT NULL,
      stage TEXT NOT NULL,
      knowledge_revision TEXT NOT NULL,
      digest TEXT NOT NULL,
      receipt_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (run_id, stage),
      FOREIGN KEY(run_id) REFERENCES runs(run_id)
    );
    CREATE TABLE IF NOT EXISTS knowledge_candidates (
      candidate_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      proposed_type TEXT NOT NULL,
      status TEXT NOT NULL,
      candidate_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(run_id) REFERENCES runs(run_id)
    );
    CREATE TABLE IF NOT EXISTS knowledge_commit_receipts (
      run_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      revision_before TEXT NOT NULL,
      revision_after TEXT NOT NULL,
      status TEXT NOT NULL,
      receipt_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(run_id) REFERENCES runs(run_id)
    );
    CREATE TABLE IF NOT EXISTS completion_decisions (
      run_id TEXT PRIMARY KEY,
      decision TEXT NOT NULL,
      source_identity TEXT NOT NULL,
      mutation_revision INTEGER NOT NULL,
      evidence_digest TEXT NOT NULL,
      decision_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(run_id) REFERENCES runs(run_id)
    );
    CREATE TABLE IF NOT EXISTS git_closeout_receipts (
      run_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      mode TEXT NOT NULL,
      commit_sha TEXT,
      branch TEXT,
      remote TEXT,
      push_status TEXT NOT NULL,
      parity TEXT NOT NULL,
      receipt_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(run_id) REFERENCES runs(run_id)
    );
    CREATE TABLE IF NOT EXISTS mutation_provenance (
      run_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      workspace_id TEXT,
      source_identity TEXT NOT NULL,
      base_source_identity TEXT,
      mutation_revision INTEGER NOT NULL,
      changed_paths_json TEXT NOT NULL DEFAULT '[]',
      workspace_identity TEXT NOT NULL,
      mutation_digest TEXT NOT NULL,
      attempt_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(run_id) REFERENCES runs(run_id)
    );
    CREATE TABLE IF NOT EXISTS finalization_receipts (
      run_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      completion_status TEXT NOT NULL,
      knowledge_status TEXT NOT NULL,
      projection_status TEXT NOT NULL,
      git_closeout_status TEXT NOT NULL,
      finalization_status TEXT NOT NULL,
      receipt_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(run_id) REFERENCES runs(run_id)
    );
    CREATE TABLE IF NOT EXISTS knowledge_records (
      project_id TEXT NOT NULL,
      record_id TEXT NOT NULL,
      record_type TEXT NOT NULL,
      status TEXT NOT NULL,
      trust_tier TEXT NOT NULL,
      record_json TEXT NOT NULL,
      revision INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(project_id, record_id)
    );
    CREATE TABLE IF NOT EXISTS knowledge_revisions (
      project_id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS knowledge_transactions (
      transaction_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      expected_revision INTEGER NOT NULL,
      target_revision INTEGER NOT NULL,
      status TEXT NOT NULL,
      transaction_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS knowledge_approvals (
      approval_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      candidate_id TEXT NOT NULL,
      approved_by TEXT NOT NULL,
      approval_receipt TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(run_id) REFERENCES runs(run_id)
    );
    CREATE TABLE IF NOT EXISTS knowledge_review_receipts (
      run_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      status TEXT NOT NULL,
      candidate_count INTEGER NOT NULL,
      verified_count INTEGER NOT NULL,
      rejected_count INTEGER NOT NULL,
      waiting_approval_count INTEGER NOT NULL,
      waiting_verification_count INTEGER NOT NULL,
      review_digest TEXT NOT NULL,
      receipt_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(run_id) REFERENCES runs(run_id)
    );
    CREATE TABLE IF NOT EXISTS knowledge_imports (
      import_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_identity TEXT NOT NULL,
      source_digest TEXT NOT NULL,
      source_snapshot_ref TEXT,
      status TEXT NOT NULL,
      candidate_count INTEGER NOT NULL DEFAULT 0,
      accepted_count INTEGER NOT NULL DEFAULT 0,
      rejected_count INTEGER NOT NULL DEFAULT 0,
      approval_ref TEXT,
      revision_before INTEGER,
      revision_after INTEGER,
      receipt_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      completed_at TEXT,
      UNIQUE(project_id, source_type, source_identity, source_digest)
    );
    CREATE TABLE IF NOT EXISTS candidate_evidence_bindings (
      candidate_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      evidence_digest TEXT NOT NULL,
      obligation_id TEXT NOT NULL,
      source_identity TEXT NOT NULL,
      mutation_revision INTEGER NOT NULL,
      binding_type TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(candidate_id, evidence_digest),
      FOREIGN KEY(candidate_id) REFERENCES knowledge_candidates(candidate_id),
      FOREIGN KEY(run_id) REFERENCES runs(run_id)
    );
    CREATE TABLE IF NOT EXISTS model_route_decisions (
      decision_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      attempt_number INTEGER NOT NULL,
      replan_count INTEGER NOT NULL DEFAULT 0,
      plan_revision INTEGER NOT NULL DEFAULT 1,
      obligation_id TEXT,
      action_kind TEXT NOT NULL,
      role TEXT NOT NULL,
      model_class TEXT NOT NULL,
      risk_tier TEXT NOT NULL,
      independent_context_required INTEGER NOT NULL DEFAULT 0,
      permissions TEXT NOT NULL,
      reason_codes_json TEXT NOT NULL,
      policy_revision TEXT NOT NULL,
      decision_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(run_id) REFERENCES runs(run_id)
    );
    CREATE TABLE IF NOT EXISTS model_usage_receipts (
      receipt_id TEXT PRIMARY KEY,
      decision_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      attempt_id TEXT,
      binding_id TEXT,
      host_surface TEXT NOT NULL,
      actor_session_id TEXT NOT NULL,
      parent_session_id TEXT,
      resolved_model TEXT,
      resolved_effort TEXT,
      enforcement_status TEXT NOT NULL,
      input_tokens INTEGER,
      cached_input_tokens INTEGER,
      output_tokens INTEGER,
      cost_micros INTEGER,
      wall_clock_ms INTEGER,
      result_status TEXT NOT NULL,
      receipt_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(decision_id) REFERENCES model_route_decisions(decision_id),
      FOREIGN KEY(run_id) REFERENCES runs(run_id)
    );
    CREATE TABLE IF NOT EXISTS route_admissions (
      admission_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      attempt_id TEXT,
      step_id TEXT,
      decision_id TEXT NOT NULL,
      capsule_id TEXT,
      requested_json TEXT NOT NULL,
      resolved_json TEXT NOT NULL,
      policy_json TEXT NOT NULL,
      economics_json TEXT NOT NULL,
      decision TEXT NOT NULL,
      rejection_code TEXT,
      digest TEXT NOT NULL,
      admission_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(run_id) REFERENCES runs(run_id)
    );
    CREATE INDEX IF NOT EXISTS idx_route_admissions_run ON route_admissions(run_id, decision_id);
    CREATE TABLE IF NOT EXISTS run_steps (
      step_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      objective TEXT NOT NULL,
      state TEXT NOT NULL,
      plan_revision INTEGER NOT NULL DEFAULT 1,
      dependency_ids_json TEXT NOT NULL DEFAULT '[]',
      allowed_paths_json TEXT NOT NULL DEFAULT '[]',
      forbidden_paths_json TEXT NOT NULL DEFAULT '[]',
      acceptance_ids_json TEXT NOT NULL DEFAULT '[]',
      obligation_ids_json TEXT NOT NULL DEFAULT '[]',
      expected_outputs_json TEXT NOT NULL DEFAULT '[]',
      assigned_role TEXT NOT NULL DEFAULT 'implementer',
      synthetic INTEGER NOT NULL DEFAULT 0,
      migration_origin TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      capsule_digest TEXT,
      result_digest TEXT,
      workspace_identity_start TEXT,
      workspace_identity_end TEXT,
      blocked_reason TEXT,
      execution_workspace_id TEXT,
      base_workspace_identity TEXT,
      result_workspace_identity TEXT,
      result_commit_sha TEXT,
      patch_digest TEXT,
      result_attempt_id TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(run_id, step_id),
      FOREIGN KEY(run_id) REFERENCES runs(run_id)
    );
    CREATE INDEX IF NOT EXISTS idx_run_steps_run ON run_steps(run_id, plan_revision, sequence);
    CREATE TABLE IF NOT EXISTS run_step_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      attempt_id TEXT,
      run_id TEXT NOT NULL,
      step_id TEXT NOT NULL,
      attempt_number INTEGER NOT NULL,
      binding_id TEXT,
      actor_session_id TEXT,
      capsule_id TEXT,
      capsule_digest TEXT,
      admission_id TEXT,
      route_decision_id TEXT,
      usage_receipt_id TEXT,
      parent_attempt_id TEXT,
      provenance_kind TEXT NOT NULL DEFAULT 'legacy-unattributed',
      plan_revision INTEGER,
      mutation_revision INTEGER,
      retry_reason TEXT,
      failure_category TEXT,
      status TEXT NOT NULL,
      workspace_identity_start TEXT,
      workspace_identity_end TEXT,
      summary TEXT,
      changed_paths_json TEXT NOT NULL DEFAULT '[]',
      result_digest TEXT,
      failure_reasons_json TEXT NOT NULL DEFAULT '[]',
      workspace_id TEXT,
      workspace_root_hash TEXT,
      base_workspace_identity TEXT,
      result_workspace_identity TEXT,
      result_commit_sha TEXT,
      patch_digest TEXT,
      worker_report_json TEXT,
      verification_refs_json TEXT NOT NULL DEFAULT '[]',
      knowledge_observation_refs_json TEXT NOT NULL DEFAULT '[]',
      started_at TEXT NOT NULL,
      finished_at TEXT,
      FOREIGN KEY(run_id) REFERENCES runs(run_id)
    );
    CREATE INDEX IF NOT EXISTS idx_run_step_attempts_step ON run_step_attempts(run_id, step_id);
    CREATE TABLE IF NOT EXISTS run_capsules (
      capsule_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      step_id TEXT,
      role TEXT NOT NULL,
      plan_revision INTEGER NOT NULL DEFAULT 1,
      mutation_revision INTEGER NOT NULL DEFAULT 0,
      workspace_identity TEXT NOT NULL,
      route_decision_id TEXT,
      digest TEXT NOT NULL,
      capsule_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(run_id) REFERENCES runs(run_id)
    );
    CREATE INDEX IF NOT EXISTS idx_run_capsules_run ON run_capsules(run_id, role);
    CREATE TABLE IF NOT EXISTS review_receipts (
      receipt_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      obligation_id TEXT NOT NULL,
      review_subject_key TEXT,
      review_stage TEXT NOT NULL,
      verdict TEXT NOT NULL,
      finding_class TEXT NOT NULL DEFAULT 'none',
      plan_revision INTEGER NOT NULL DEFAULT 1,
      reviewer_usage_receipt_id TEXT,
      implementer_usage_receipt_id TEXT,
      reviewer_session_id TEXT NOT NULL,
      implementer_session_id TEXT,
      route_decision_id TEXT,
      model_class TEXT NOT NULL,
      resolved_model TEXT,
      enforcement_status TEXT NOT NULL,
      workspace_identity TEXT NOT NULL,
      mutation_revision INTEGER NOT NULL,
      changed_paths_digest TEXT NOT NULL,
      evidence_digest TEXT NOT NULL,
      acceptance_coverage_json TEXT NOT NULL DEFAULT '[]',
      findings_json TEXT NOT NULL DEFAULT '[]',
      rationale TEXT NOT NULL,
      digest TEXT NOT NULL,
      receipt_json TEXT NOT NULL,
      created_by_version TEXT,
      migration_origin TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(run_id) REFERENCES runs(run_id)
    );
    CREATE INDEX IF NOT EXISTS idx_review_receipts_run ON review_receipts(run_id);
    CREATE INDEX IF NOT EXISTS idx_review_receipts_obligation ON review_receipts(run_id, obligation_id);
    CREATE TABLE IF NOT EXISTS run_obligations (
      run_id TEXT NOT NULL,
      obligation_id TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_ref TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(run_id, obligation_id),
      FOREIGN KEY(run_id) REFERENCES runs(run_id)
    );
  `);
};
