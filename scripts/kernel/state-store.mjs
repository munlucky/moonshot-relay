import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { resolveKernelRuntimeHome, assertIsolatedRuntimeHomes } from './runtime-home.mjs';
import { canTransition } from './transition.mjs';
import { openSqliteDb } from './sqlite-adapter.mjs';
import { mapCandidateToCanonicalRecord } from './knowledge/canonical-record-mapper.mjs';
import { isProtectedObligation } from './proof/protected-obligations.mjs';
import { assertCommandBinding } from './run/obligation-compiler.mjs';
import { hashSessionId, normalizeModelRouteDecision, normalizeModelUsageReceipt } from './run/model-route-contract.mjs';
import { ATTEMPT_PROVENANCE_KINDS, assertAttemptLineage, normalizeAttemptProvenance } from './run/attempt-provenance.mjs';
import { digestOfEvidence, evaluateReviewReceipt, normalizeReviewReceipt, parseReviewEvidenceRef } from './proof/review-receipt.mjs';
import { sanitizePersistentPayload, sanitizePersistentText } from './persistent-sanitizer.mjs';
import { buildSuccessorKey } from './run/successor-key.mjs';
import { emptyKnowledgeDoctorFinding, canonicalKnowledgeIdentity } from './knowledge/capture.mjs';
import { exactEvidenceIdentityMatch } from './proof/evidence-reuse.mjs';
import { normalizeAcceptanceCoverage } from './task/task-contract.mjs';
import { deriveKernelWorktreeId } from './run/worktree-binding.mjs';
import {
  prepareProjectKnowledgeNamespaceMigration,
  projectKnowledgeNamespaceHasData,
  recoverProjectKnowledgeNamespaceMigrations,
} from './knowledge/store.mjs';
import { buildKernelDurableStateView } from './persistence/durable-state.mjs';

const TIER_RANK = { T0: 0, T1: 1, T2: 2, T3: 3 };
const EVIDENCE_RANK = { E0: 0, E1: 1, E2: 2 };
const PROJECT_ID_PATTERN = /^(?!(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$)[a-z0-9][a-z0-9._-]{1,126}[a-z0-9]$/;

export const kernelDbPath = (runtimeHome = resolveKernelRuntimeHome()) => path.join(runtimeHome, 'state', 'runtime-state.sqlite');

const canonicalRuntimeHome = (value) => {
  const resolved = path.resolve(value);
  let current = resolved;
  const suffix = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return resolved;
    suffix.unshift(path.basename(current));
    current = parent;
  }
  try {
    return path.join(fs.realpathSync.native(current), ...suffix);
  } catch {
    return resolved;
  }
};

// A lease whose owning process has exited cannot be a live conflict; this is
// what lets consecutive CLI invocations of one session proceed while genuinely
// concurrent runners are still detected.
const isProcessAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
};

const sourceIdentityRegex = /^(?:[a-f0-9]{40}|sha256:[a-f0-9]{64}|[a-zA-Z0-9_.:/-]{1,128})$/i;
const sha256Regex = /^sha256:[a-f0-9]{64}$/i;

export const openKernelStateStore = async ({ runtimeHome: runtimeHomeInput = resolveKernelRuntimeHome(), relayHome } = {}) => {
  const runtimeHome = canonicalRuntimeHome(runtimeHomeInput);
  assertIsolatedRuntimeHomes(runtimeHome, relayHome);
  const dbPath = kernelDbPath(runtimeHome);
  await mkdir(path.dirname(dbPath), { recursive: true });
  const db = await openSqliteDb(dbPath);

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
    CREATE TABLE IF NOT EXISTS workspace_mutation_locks (
      project_id TEXT PRIMARY KEY,
      holder_run_id TEXT NOT NULL,
      session_token TEXT NOT NULL,
      fencing_token INTEGER NOT NULL,
      acquired_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
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
    CREATE TABLE IF NOT EXISTS attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      attempt_number INTEGER NOT NULL,
      state TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      status TEXT NOT NULL,
      FOREIGN KEY(run_id) REFERENCES runs(run_id)
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

  const hasColumn = (table, column) => db.prepare(`PRAGMA table_info(${table})`).all()
    .some((entry) => entry.name === column);
  const hadWorkspaceBaselineColumns = hasColumn('runs', 'workspace_baseline_changed_paths')
    && hasColumn('runs', 'workspace_baseline_entries');
  const hadWorkspaceBaselineStatus = hasColumn('runs', 'workspace_baseline_status');
  const addCol = (t, c, typ) => { try { db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${typ}`); } catch {} };
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
      `).all();
      for (const row of rows) {
        if (row.status !== 'known') continue;
        let paths = [];
        let entries = [];
        try { paths = JSON.parse(row.baselineChangedPaths || '[]'); } catch {}
        try { entries = JSON.parse(row.baselineEntries || '[]'); } catch {}
        const hasUnindexedBaseline = Array.isArray(paths) && paths.length > 0
          && (!Array.isArray(entries) || entries.some((entry) => !entry
            || Array.isArray(entry)
            || entry.indexStateKnown !== true
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
  addCol('run_step_attempts', 'report_digest', 'TEXT');
  addCol('run_step_attempts', 'report_result_json', 'TEXT');
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
  addCol('review_receipts', 'step_id', 'TEXT');
  addCol('review_receipts', 'reviewer_binding_id', 'TEXT');
  addCol('review_receipts', 'implementer_attempt_id', 'TEXT');
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
  `).all();
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

  // Finish or roll back any copy-first knowledge migration left by a process
  // crash. The SQLite identity rows are the commit witness: a canonical row
  // with no remaining legacy rows means the transaction committed; otherwise
  // the filesystem journal is restored without deleting the legacy source.
   try {
    const normalizeRecoveryRoot = (value) => {
      const resolved = path.resolve(String(value || '')).replaceAll('\\', '/');
      return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    };
    const quoteRecoveryIdentifier = (value) => `"${String(value).replaceAll('"', '""')}"`;
    const recoveryProjectScopedTables = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type='table' AND name NOT LIKE 'sqlite_%'
    `).all()
      .map(({ name }) => name)
      .filter((name) => name !== 'project_identities')
      .filter((name) => db.prepare(`PRAGMA table_info(${quoteRecoveryIdentifier(name)})`).all()
        .some((column) => column.name === 'project_id'));
    const hasRecoveryProjectState = (projectId) => recoveryProjectScopedTables.some((table) => (
      Number(db.prepare(`SELECT COUNT(*) AS count FROM ${quoteRecoveryIdentifier(table)} WHERE project_id=?`).get(projectId)?.count || 0) > 0
    ));

    recoverProjectKnowledgeNamespaceMigrations({
      runtimeHome,
      isCommitted: (journal) => {
        const canonical = db.prepare('SELECT canonical_root, identity_digest FROM project_identities WHERE project_id=? LIMIT 1').get(journal.projectId);
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

  const now = () => new Date().toISOString();

  const safeJsonParse = (str, fallback = []) => {
    try {
      return JSON.parse(str || '[]');
    } catch {
      return fallback;
    }
  };
  const persistentJson = (value) => typeof value === 'string'
    ? sanitizePersistentText(value)
    : JSON.stringify(sanitizePersistentPayload(value));
  const canonicalReceiptPaths = (paths) => [...new Set((Array.isArray(paths) ? paths : [])
    .map((value) => String(value).replaceAll('\\', '/').replace(/^\.\//u, ''))
    .filter(Boolean))].sort();
  const canonicalReceiptValue = (field, value) => field === 'changedPaths'
    ? canonicalReceiptPaths(value)
    : value;
  const receiptValueIsMissing = (field, value) => value === null
    || value === undefined
    || (Array.isArray(value) && value.length === 0)
    || (field === 'workerReport' && value && typeof value === 'object' && Object.keys(value).length === 0);
  const receiptValuesEqual = (field, left, right) => JSON.stringify(canonicalReceiptValue(field, left))
    === JSON.stringify(canonicalReceiptValue(field, right));
  const mergeImmutableReceiptFields = (current, incoming, fields) => {
    const patch = {};
    for (const field of fields) {
      const nextValue = incoming?.[field];
      if (receiptValueIsMissing(field, nextValue)) continue;
      const currentValue = current?.[field];
      if (receiptValueIsMissing(field, currentValue)) {
        patch[field] = field === 'changedPaths' ? canonicalReceiptPaths(nextValue) : nextValue;
        continue;
      }
      if (!receiptValuesEqual(field, currentValue, nextValue)) {
        throw Object.assign(new Error(`step result field ${field} is immutable for the canonical attempt`), {
          code: 'STEP_RESULT_IMMUTABLE_CONFLICT',
          errorCode: 'STEP_RESULT_IMMUTABLE_CONFLICT',
          field,
        });
      }
    }
    return patch;
  };
  const canonicalIdentityRoot = (value) => {
    const resolved = path.resolve(String(value || ''));
    try {
      const real = fs.realpathSync(resolved).replaceAll('\\', '/');
      return process.platform === 'win32' ? real.toLowerCase() : real;
    } catch {
      const posix = resolved.replaceAll('\\', '/');
      return process.platform === 'win32' ? posix.toLowerCase() : posix;
    }
  };
  const deriveGitCommonDir = (root) => {
    try {
      const result = spawnSync('git', ['rev-parse', '--git-common-dir'], { cwd: root, encoding: 'utf8' });
      if (result.status !== 0 || !result.stdout?.trim()) return null;
      return canonicalIdentityRoot(path.resolve(root, result.stdout.trim()));
    } catch {
      return null;
    }
  };
  const mapProjectIdentity = (row, aliases = null) => row ? ({
    projectId: row.project_id || row.projectId,
    canonicalRoot: row.canonical_root || row.canonicalRoot,
    identitySource: row.identity_source || row.identitySource,
    identityDigest: row.identity_digest || row.identityDigest,
    aliases: aliases || safeJsonParse(row.aliases_json || row.aliasesJson, []),
    createdAt: row.created_at || row.createdAt,
    updatedAt: row.updated_at || row.updatedAt,
  }) : null;
  const findProjectIdentityByRoot = (root) => {
    const exact = db.prepare(`SELECT * FROM project_identities WHERE canonical_root=?`).get(root);
    if (exact) return exact;
    return db.prepare(`SELECT * FROM project_identities`).all()
      .find((candidate) => canonicalIdentityRoot(candidate.canonical_root) === root) || null;
  };
  const projectIdentityAlias = (value, type = null) => {
    const alias = String(value || '').trim();
    if (!alias) return null;
    return {
      alias,
      aliasType: type || (alias.startsWith('http') ? 'remote' : alias.startsWith('workspace:') ? 'workspace-root' : 'legacy-project-id'),
    };
  };
  const projectScopedTables = () => db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type='table' AND name NOT LIKE 'sqlite_%'
  `).all()
    .map((row) => row.name)
    .filter((name) => name !== 'project_identities')
    .filter((name) => db.prepare(`PRAGMA table_info("${String(name).replaceAll('"', '""')}")`).all().some((column) => column.name === 'project_id'));
  const hasProjectData = (projectId) => Boolean(
    db.prepare('SELECT 1 FROM project_identities WHERE project_id=? LIMIT 1').get(projectId)
      || projectScopedTables().some((table) => (
        Number(db.prepare(`SELECT COUNT(*) as count FROM "${String(table).replaceAll('"', '""')}" WHERE project_id=?`).get(projectId)?.count || 0) > 0
      ))
      || projectKnowledgeNamespaceHasData(projectId, { runtimeHome }),
  );
  const projectDataSummary = (projectId) => {
    const tables = projectScopedTables().map((table) => ({
      table,
      count: Number(db.prepare(`SELECT COUNT(*) as count FROM "${String(table).replaceAll('"', '""')}" WHERE project_id=?`).get(projectId)?.count || 0),
    })).filter((entry) => entry.count > 0);
    const knowledgeNamespace = projectKnowledgeNamespaceHasData(projectId, { runtimeHome });
    return {
      hasData: Boolean(tables.length || knowledgeNamespace),
      tables,
      knowledgeNamespace,
    };
  };
  const quoteIdentifier = (value) => `"${String(value).replaceAll('"', '""')}"`;
  const tableColumns = (table) => db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all();
  const jsonReferenceColumns = (table) => tableColumns(table)
    .map((column) => column.name)
    .filter((name) => /(?:_json|_coverage)$/.test(name));
  const projectIdKeys = new Set([
    'projectId',
    'project_id',
    'canonicalProjectId',
    'canonical_project_id',
    'legacyProjectId',
    'legacy_project_id',
  ]);
  const projectIdListKeys = new Set([
    'projectIds',
    'project_ids',
    'legacyProjectIds',
    'legacy_project_ids',
  ]);
  // Rewrite only fields whose schema says they carry project identity. A
  // project_id-bearing JSON column can contain free-form statements, prompts,
  // or evidence text; replacing every matching string would corrupt those
  // payloads and make a multi-legacy migration non-deterministic.
  const rewriteProjectIdJson = (value, legacyIds, canonicalId, key = null) => {
    if (typeof value === 'string') return key && projectIdKeys.has(key) && legacyIds.has(value) ? canonicalId : value;
    if (Array.isArray(value)) {
      return value.map((item) => {
        if (typeof item === 'string' && key && projectIdListKeys.has(key) && legacyIds.has(item)) return canonicalId;
        return rewriteProjectIdJson(item, legacyIds, canonicalId, key);
      });
    }
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([childKey, item]) => {
      if (typeof item === 'string' && projectIdKeys.has(childKey) && legacyIds.has(item)) return [childKey, canonicalId];
      if (Array.isArray(item) && projectIdListKeys.has(childKey)) {
        return [childKey, item.map((entry) => typeof entry === 'string' && legacyIds.has(entry) ? canonicalId : rewriteProjectIdJson(entry, legacyIds, canonicalId, childKey))];
      }
      return [childKey, rewriteProjectIdJson(item, legacyIds, canonicalId, childKey)];
    }));
  };
  const rewriteJsonColumnsForRows = (table, where, params, legacyIds, canonicalId) => {
    const columns = jsonReferenceColumns(table);
    if (columns.length === 0) return;
    const quotedTable = quoteIdentifier(table);
    const selectColumns = ['rowid AS __kernel_rowid', ...columns.map(quoteIdentifier)].join(', ');
    const rows = db.prepare(`SELECT ${selectColumns} FROM ${quotedTable} WHERE ${where}`).all(...params);
    for (const row of rows) {
      for (const column of columns) {
        if (row[column] === null || row[column] === undefined) continue;
        let parsed;
        try {
          parsed = JSON.parse(row[column]);
        } catch (error) {
          throw Object.assign(new Error(`project_identity_json_rewrite_invalid: ${table}.${column}: ${error.message}`), {
            code: 'project_identity_json_rewrite_invalid',
            table,
            column,
          });
        }
        const rewritten = rewriteProjectIdJson(parsed, legacyIds, canonicalId);
        if (JSON.stringify(rewritten) !== row[column]) {
          db.prepare(`UPDATE ${quotedTable} SET ${quoteIdentifier(column)}=? WHERE rowid=?`).run(JSON.stringify(rewritten), row.__kernel_rowid);
        }
      }
    }
  };
  const tablesWithColumn = (columnName, { excludeProjectScoped = false } = {}) => db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type='table' AND name NOT LIKE 'sqlite_%'
  `).all()
    .map((row) => row.name)
    .filter((name) => !excludeProjectScoped || !tableColumns(name).some((column) => column.name === 'project_id'))
    .filter((name) => tableColumns(name).some((column) => column.name === columnName));
  const rewriteProjectScopedJson = (fromProjectId, toProjectId) => {
    const legacyIds = new Set([String(fromProjectId)]);
    for (const table of projectScopedTables()) rewriteJsonColumnsForRows(table, `${quoteIdentifier('project_id')}=?`, [fromProjectId], legacyIds, toProjectId);
    const runIds = db.prepare('SELECT run_id FROM runs WHERE project_id=?').all(fromProjectId).map((row) => row.run_id);
    for (const table of tablesWithColumn('run_id', { excludeProjectScoped: true })) {
      for (const runId of runIds) rewriteJsonColumnsForRows(table, `${quoteIdentifier('run_id')}=?`, [runId], legacyIds, toProjectId);
    }
  };
  const workspaceReferenceColumns = ['workspace_id', 'execution_workspace_id', 'integration_workspace_id'];
  const sourceWorkspaceIdsForProject = (projectId) => db.prepare('SELECT workspace_id FROM project_workspaces WHERE project_id=?').all(projectId).map((row) => row.workspace_id);
  const rewriteWorkspaceScopedJson = (workspaceIds, legacyProjectId, canonicalProjectId) => {
    if (workspaceIds.length === 0) return;
    const legacyIds = new Set([String(legacyProjectId)]);
    const workspaceTables = [...new Set(workspaceReferenceColumns.flatMap((column) => tablesWithColumn(column)))];
    for (const table of workspaceTables) {
      const columns = tableColumns(table).map((column) => column.name).filter((name) => workspaceReferenceColumns.includes(name));
      for (const column of columns) {
        for (const workspaceId of workspaceIds) rewriteJsonColumnsForRows(table, `${quoteIdentifier(column)}=?`, [workspaceId], legacyIds, canonicalProjectId);
      }
    }
  };
  const migrateProjectId = (fromProjectId, toProjectId) => {
    if (!fromProjectId || !toProjectId || fromProjectId === toProjectId) return false;
    const sourceWorkspaceIds = sourceWorkspaceIdsForProject(fromProjectId);
    rewriteProjectScopedJson(fromProjectId, toProjectId);
    rewriteWorkspaceScopedJson(sourceWorkspaceIds, fromProjectId, toProjectId);
    migrateProjectWorkspaces(fromProjectId, toProjectId);
    for (const table of projectScopedTables()) {
      const quotedTable = `"${String(table).replaceAll('"', '""')}"`;
      if (table === 'project_workspaces') {
        continue;
      }
      if (table === 'knowledge_revisions') {
        const source = db.prepare(`SELECT revision, updated_at FROM ${quotedTable} WHERE project_id=?`).get(fromProjectId);
        if (!source) continue;
        const destination = db.prepare(`SELECT revision, updated_at FROM ${quotedTable} WHERE project_id=?`).get(toProjectId);
        if (destination) {
          const revision = Math.max(Number(source.revision || 1), Number(destination.revision || 1));
          const updatedAt = String(source.updated_at || '') >= String(destination.updated_at || '') ? source.updated_at : destination.updated_at;
          db.prepare(`UPDATE ${quotedTable} SET revision=?, updated_at=? WHERE project_id=?`).run(revision, updatedAt, toProjectId);
          db.prepare(`DELETE FROM ${quotedTable} WHERE project_id=?`).run(fromProjectId);
        } else {
          db.prepare(`UPDATE ${quotedTable} SET project_id=? WHERE project_id=?`).run(toProjectId, fromProjectId);
        }
        continue;
      }
      db.prepare(`UPDATE ${quotedTable} SET project_id=? WHERE project_id=?`).run(toProjectId, fromProjectId);
    }
    return true;
  };
  const legacyIdentityCandidates = (identity = {}) => {
    const raw = Array.isArray(identity.legacyAliases) && identity.legacyAliases.length > 0
      ? identity.legacyAliases
      : (Array.isArray(identity.legacyProjectIds) ? identity.legacyProjectIds.map((projectId) => ({ projectId, source: 'unknown' })) : []);
    const priority = { persisted: 0, 'path-hash': 1, origin: 2, package: 3, basename: 4, unknown: 5 };
    return [...new Map(raw.map((candidate) => {
      const normalized = typeof candidate === 'string' ? { projectId: candidate, source: 'unknown' } : candidate;
      const projectId = String(normalized?.projectId || '').trim();
      return [projectId, {
        projectId,
        source: String(normalized?.source || 'unknown'),
        aliasType: String(normalized?.aliasType || 'legacy-project-id'),
        canonicalRoot: normalized?.canonicalRoot ? canonicalIdentityRoot(normalized.canonicalRoot) : null,
      }];
    }).filter(([projectId]) => projectId)).values()]
      .sort((left, right) => (priority[left.source] ?? 9) - (priority[right.source] ?? 9));
  };
  const workspaceScopedTables = () => db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type='table' AND name NOT LIKE 'sqlite_%'
  `).all()
    .map((row) => row.name)
    .filter((name) => name !== 'project_workspaces')
    .filter((name) => tableColumns(name).some((column) => workspaceReferenceColumns.includes(column.name)));
  const migrateProjectWorkspaces = (fromProjectId, toProjectId) => {
    const sourceRows = db.prepare('SELECT * FROM project_workspaces WHERE project_id=?').all(fromProjectId);
    for (const source of sourceRows) {
      const target = db.prepare(`
        SELECT workspace_id FROM project_workspaces
        WHERE project_id=? AND canonical_root=?
      `).get(toProjectId, source.canonical_root);
      const sourceIdentity = safeJsonParse(source.identity_json, {});
      sourceIdentity.projectId = toProjectId;
      if (target && target.workspace_id !== source.workspace_id) {
        for (const table of workspaceScopedTables()) {
          const quotedTable = quoteIdentifier(table);
          for (const column of tableColumns(table).map((entry) => entry.name).filter((name) => workspaceReferenceColumns.includes(name))) {
            db.prepare(`UPDATE ${quotedTable} SET ${quoteIdentifier(column)}=? WHERE ${quoteIdentifier(column)}=?`).run(target.workspace_id, source.workspace_id);
          }
        }
        db.prepare('DELETE FROM project_workspaces WHERE workspace_id=?').run(source.workspace_id);
      } else {
        db.prepare(`UPDATE project_workspaces SET project_id=?, identity_json=?, last_seen_at=? WHERE workspace_id=?`)
          .run(toProjectId, persistentJson(sourceIdentity), now(), source.workspace_id);
      }
    }
  };
  const mapSessionBinding = (row) => row ? {
    bindingId: row.binding_id,
    sessionId: row.session_id,
    provider: row.provider,
    surface: row.surface,
    runId: row.run_id,
    projectId: row.project_id,
    workspaceId: row.workspace_id,
    workspaceRoot: row.workspace_root,
    accessMode: row.access_mode,
    status: row.status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    closedAt: row.closed_at,
    closeReason: row.close_reason,
    successorRunId: row.successor_run_id,
    updatedAt: row.updated_at,
  } : null;
  const terminalRunStatuses = new Set(['completed', 'blocked', 'abandoned']);
  const worktreeLeaseTerminalStatuses = new Set(['completed', 'abandoned']);
  const reconcileTerminalLifecycleInTransaction = ({
    projectId = null,
    runId = null,
    preserveSessionId = null,
    observedAt = now(),
  } = {}) => {
    const projectClause = projectId ? ' AND r.project_id=?' : '';
    const runClause = runId ? ' AND r.run_id=?' : '';
    const scopeArgs = [
      ...(projectId ? [projectId] : []),
      ...(runId ? [runId] : []),
    ];
    const activeOwnerForSession = (candidateRunId, candidateProjectId) => preserveSessionId
      ? db.prepare(`
          SELECT binding_id AS bindingId
          FROM session_bindings
          WHERE run_id=? AND project_id=? AND session_id=?
            AND status='active' AND access_mode='owner'
          LIMIT 1
        `).get(candidateRunId, candidateProjectId, preserveSessionId)
      : null;
    const deactivatedBindings = [];
    const terminalBindings = db.prepare(`
      SELECT b.binding_id AS bindingId, b.run_id AS runId, b.project_id AS projectId,
             b.session_id AS sessionId, r.status AS runStatus
      FROM session_bindings b
      JOIN runs r ON r.run_id=b.run_id
      WHERE b.status='active' AND b.access_mode='owner'
        AND r.status IN ('completed', 'blocked')
        ${projectClause}${runClause}
    `).all(...scopeArgs);
    for (const binding of terminalBindings) {
      if (preserveSessionId && binding.sessionId === preserveSessionId && binding.runStatus === 'completed') continue;
      const closedAt = now();
      const updated = db.prepare(`
        UPDATE session_bindings
        SET status='inactive', closed_at=?, close_reason=?, successor_run_id=NULL, updated_at=?
        WHERE binding_id=? AND project_id=? AND run_id=? AND status='active' AND access_mode='owner'
      `).run(
        closedAt,
        `terminal_${binding.runStatus}_cleanup`,
        closedAt,
        binding.bindingId,
        binding.projectId,
        binding.runId,
      );
      if (updated.changes === 1) deactivatedBindings.push({
        bindingId: binding.bindingId,
        runId: binding.runId,
        projectId: binding.projectId,
        sessionId: binding.sessionId,
        runStatus: binding.runStatus,
      });
    }

    const observedMs = Date.parse(observedAt);
    const releasedLocks = [];
    const worktreeLeases = db.prepare(`
      SELECT l.worktree_id AS worktreeId, l.project_id AS projectId,
             l.holder_run_id AS holderRunId, r.status AS runStatus
      FROM worktree_mutation_leases l
      JOIN runs r ON r.run_id=l.holder_run_id
      WHERE 1=1
        ${projectId ? ' AND l.project_id=?' : ''}
        ${runId ? ' AND l.holder_run_id=?' : ''}
    `).all(...scopeArgs);
    for (const lease of worktreeLeases) {
      if (!worktreeLeaseTerminalStatuses.has(lease.runStatus)) continue;
      const released = db.prepare(`
        DELETE FROM worktree_mutation_leases
        WHERE worktree_id=? AND project_id=? AND holder_run_id=?
      `).run(lease.worktreeId, lease.projectId, lease.holderRunId);
      if (released.changes === 1) releasedLocks.push({
        version: 3,
        worktreeId: lease.worktreeId,
        projectId: lease.projectId,
        holderRunId: lease.holderRunId,
        reason: `terminal_${lease.runStatus}`,
      });
    }
    const v2Locks = db.prepare(`
      SELECT workspace_id AS workspaceId, project_id AS projectId,
             holder_run_id AS holderRunId, session_token AS sessionToken,
             fencing_token AS fencingToken, expires_at AS expiresAt
      FROM workspace_mutation_locks_v2 l
      WHERE 1=1${projectId ? ' AND l.project_id=?' : ''}
    `).all(...(projectId ? [projectId] : []));
    for (const lock of v2Locks) {
      const run = db.prepare(`
        SELECT run_id AS runId, project_id AS projectId, workspace_id AS workspaceId, status
        FROM runs WHERE run_id=?
      `).get(lock.holderRunId);
      const activeOwner = run ? activeOwnerForSession(run.runId, run.projectId) : null;
      const expired = Number.isFinite(Date.parse(lock.expiresAt))
        ? Date.parse(lock.expiresAt) <= observedMs
        : true;
      const invalidOwner = !run
        || run.projectId !== lock.projectId
        || run.workspaceId !== lock.workspaceId;
      const terminal = run && terminalRunStatuses.has(run.status);
      const preserveCompletedHostLock = Boolean(
        activeOwner
        && run.status === 'completed'
        && !expired
        && !invalidOwner
        && (!runClause || run.runId === runId),
      );
      const shouldRelease = expired || invalidOwner || (terminal && !preserveCompletedHostLock);
      if (!shouldRelease) continue;
      const released = db.prepare(`
        DELETE FROM workspace_mutation_locks_v2
        WHERE workspace_id=? AND project_id=? AND holder_run_id=?
          AND session_token=? AND fencing_token=?
      `).run(
        lock.workspaceId,
        lock.projectId,
        lock.holderRunId,
        lock.sessionToken,
        Number(lock.fencingToken),
      );
      if (released.changes === 1) releasedLocks.push({
        version: 2,
        workspaceId: lock.workspaceId,
        projectId: lock.projectId,
        holderRunId: lock.holderRunId,
        reason: expired ? 'expired' : (invalidOwner ? 'invalid_owner' : `terminal_${run.status}`),
      });
    }

    const legacyLocks = db.prepare(`
      SELECT project_id AS projectId, holder_run_id AS holderRunId,
             session_token AS sessionToken, fencing_token AS fencingToken,
             expires_at AS expiresAt
      FROM workspace_mutation_locks l
      WHERE 1=1${projectId ? ' AND l.project_id=?' : ''}
    `).all(...(projectId ? [projectId] : []));
    for (const lock of legacyLocks) {
      const run = db.prepare(`
        SELECT run_id AS runId, project_id AS projectId, status
        FROM runs WHERE run_id=?
      `).get(lock.holderRunId);
      const activeOwner = run ? activeOwnerForSession(run.runId, run.projectId) : null;
      const expired = Number.isFinite(Date.parse(lock.expiresAt))
        ? Date.parse(lock.expiresAt) <= observedMs
        : true;
      const invalidOwner = !run || run.projectId !== lock.projectId;
      const terminal = run && terminalRunStatuses.has(run.status);
      const preserveCompletedHostLock = Boolean(activeOwner && run.status === 'completed' && !expired && !invalidOwner);
      const shouldRelease = expired || invalidOwner || (terminal && !preserveCompletedHostLock);
      if (!shouldRelease) continue;
      const released = db.prepare(`
        DELETE FROM workspace_mutation_locks
        WHERE project_id=? AND holder_run_id=? AND session_token=? AND fencing_token=?
      `).run(lock.projectId, lock.holderRunId, lock.sessionToken, Number(lock.fencingToken));
      if (released.changes === 1) releasedLocks.push({
        version: 1,
        projectId: lock.projectId,
        holderRunId: lock.holderRunId,
        reason: expired ? 'expired' : (invalidOwner ? 'invalid_owner' : `terminal_${run.status}`),
      });
    }

    return {
      deactivatedBindings,
      releasedLocks,
      preservedTerminalHostBindings: terminalBindings
        .filter((binding) => preserveSessionId && binding.sessionId === preserveSessionId && binding.runStatus === 'completed')
        .map((binding) => binding.bindingId),
    };
  };
  const bindingConflict = (error) => {
    if (String(error?.message || '').includes('UNIQUE constraint failed')) {
      throw Object.assign(new Error('successor_binding_conflict'), {
        code: 'successor_binding_conflict',
        errorCode: 'successor_binding_conflict',
        nextAction: 'inspect-active-owner-binding',
      });
    }
    throw error;
  };

  const claimWorktreeLeaseInTransaction = ({ worktreeId, projectId, runId }) => {
    let current = db.prepare(`
      SELECT worktree_id AS worktreeId, project_id AS projectId,
             holder_run_id AS holderRunId, acquired_at AS acquiredAt
      FROM worktree_mutation_leases WHERE worktree_id=?
    `).get(worktreeId);
    if (current?.holderRunId === runId && current.projectId === projectId) {
      return { acquired: true, created: false, lease: current };
    }
    if (current) {
      const holder = db.prepare(`SELECT status FROM runs WHERE run_id=?`).get(current.holderRunId);
      if (!holder || worktreeLeaseTerminalStatuses.has(holder.status)) {
        db.prepare(`DELETE FROM worktree_mutation_leases WHERE worktree_id=? AND holder_run_id=?`)
          .run(worktreeId, current.holderRunId);
        current = null;
      }
    }
    if (current) return { acquired: false, created: false, lease: current };

    const acquiredAt = now();
    db.prepare(`
      INSERT INTO worktree_mutation_leases(worktree_id, project_id, holder_run_id, acquired_at)
      VALUES(?, ?, ?, ?)
    `).run(worktreeId, projectId, runId, acquiredAt);
    return {
      acquired: true,
      created: true,
      lease: { worktreeId, projectId, holderRunId: runId, acquiredAt },
    };
  };

  const throwWorktreeRunConflict = (lease = null) => {
    throw Object.assign(new Error('worktree_run_conflict'), {
      code: 'worktree_run_conflict',
      errorCode: 'worktree_run_conflict',
      nextAction: 'resume-the-worktree-bound-run',
      details: lease ? { holderRunId: lease.holderRunId, worktreeId: lease.worktreeId } : {},
    });
  };

  return {
    dbPath,
    createRun({
      runId,
      objective,
      sourceIdentity,
      proofTier = 'T0',
      evidenceTier = 'E0',
      requiredObligations = [],
      acceptanceCriteria = [],
      requireReleaseEvidence = false,
      projectId = null,
      knowledgeRevisionStart = null,
      workspaceIdentity = null,
      projectMode = null,
      taskContract = null,
      contractRevision = 1,
      route = null,
      implementationContext = null,
      workspaceId = null,
      worktreeId = null,
      baselineChangedPaths = [],
      baselineWorkspaceEntries = [],
      reportBaselineChangedPaths = null,
      reportBaselineWorkspaceEntries = null,
      workspaceBaselineStatus = 'known',
      ownerBindingId = null,
      successorKey = null,
      withinTransaction = false,
    }) {
      if (!sourceIdentity || typeof sourceIdentity !== 'string' || !sourceIdentityRegex.test(sourceIdentity)) {
        throw new Error('sourceIdentity is required and must be a valid candidate identity string for Kernel run');
      }
      if (workspaceIdentity !== null && !sha256Regex.test(workspaceIdentity)) {
        throw new Error('workspaceIdentity must be a sha256:<hex> digest when provided');
      }
      const registeredWorkspace = workspaceId ? this.getProjectWorkspace(workspaceId) : null;
      if (registeredWorkspace && projectId && registeredWorkspace.projectId !== projectId) {
        throw Object.assign(new Error('run_project_mismatch'), { code: 'run_project_mismatch' });
      }
      if (worktreeId && registeredWorkspace?.worktreeId && worktreeId !== registeredWorkspace.worktreeId) {
        throw Object.assign(new Error('run_worktree_mismatch'), { code: 'run_worktree_mismatch' });
      }
      const effectiveWorktreeId = worktreeId || registeredWorkspace?.worktreeId || null;
      const persistRun = () => {
        db.prepare(`
          INSERT INTO runs(run_id, objective, state, status, revision, mutation_revision, source_identity, run_start_workspace_identity, current_workspace_identity, project_mode, proof_tier, evidence_tier, required_obligations, acceptance_criteria, release_evidence_required, project_id, knowledge_revision_start, knowledge_status, task_contract_json, contract_revision, finalization_status, route_json, implementation_context_json, workspace_id, worktree_id, baseline_changed_paths, baseline_workspace_entries, workspace_baseline_changed_paths, workspace_baseline_entries, workspace_baseline_status, owner_binding_id, successor_key, updated_at)
          VALUES(?, ?, 'FRAME', 'active', 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          runId,
          objective,
          sourceIdentity,
          workspaceIdentity,
          workspaceIdentity,
          projectMode || null,
          proofTier,
          evidenceTier,
          JSON.stringify(requiredObligations),
          JSON.stringify(acceptanceCriteria),
          requireReleaseEvidence ? 1 : 0,
          projectId || null,
          knowledgeRevisionStart !== undefined && knowledgeRevisionStart !== null ? String(knowledgeRevisionStart) : null,
          taskContract ? persistentJson(taskContract) : null,
          Number(contractRevision) || 1,
          route ? JSON.stringify(route) : null,
          implementationContext ? persistentJson(implementationContext) : null,
          workspaceId,
          effectiveWorktreeId,
          JSON.stringify(canonicalReceiptPaths(baselineChangedPaths)),
          persistentJson(baselineWorkspaceEntries),
          JSON.stringify(canonicalReceiptPaths(reportBaselineChangedPaths === null ? baselineChangedPaths : reportBaselineChangedPaths)),
          persistentJson(reportBaselineWorkspaceEntries === null ? baselineWorkspaceEntries : reportBaselineWorkspaceEntries),
          workspaceBaselineStatus,
          ownerBindingId,
          successorKey,
          now()
        );
        if (effectiveWorktreeId && projectId) {
          const lease = claimWorktreeLeaseInTransaction({
            worktreeId: effectiveWorktreeId,
            projectId,
            runId,
          });
          if (!lease.acquired) throwWorktreeRunConflict(lease.lease);
        }
      };
      if (withinTransaction) persistRun();
      else db.transaction(persistRun)();
      return this.getRun(runId);
    },

    // Remove only a Run that was created by a failed pre-dispatch bootstrap.
    // This is deliberately stricter than abandon: an initialized or mutated
    // Run is durable user history and must never be erased as cleanup. The
    // child-table order is derived from SQLite foreign keys so rollback remains
    // valid as lifecycle receipts gain new references.
    rollbackRunInitialization(runId, { projectId = null, sourceIdentity = null } = {}) {
      if (!runId) throw new Error('rollbackRunInitialization requires runId');
      return db.transaction(() => {
        const run = db.prepare(`
          SELECT run_id AS runId, project_id AS projectId, worktree_id AS worktreeId,
                 source_identity AS sourceIdentity, status, mutation_revision AS mutationRevision
          FROM runs WHERE run_id=?
        `).get(runId);
        if (!run) return { status: 'not-found', runId, rolledBack: false };
        if (projectId && run.projectId !== projectId) {
          throw Object.assign(new Error('run_project_mismatch'), { code: 'run_project_mismatch', errorCode: 'run_project_mismatch' });
        }
        if (sourceIdentity && run.sourceIdentity !== sourceIdentity) {
          throw Object.assign(new Error('run_source_identity_mismatch'), { code: 'run_source_identity_mismatch', errorCode: 'run_source_identity_mismatch' });
        }
        if (!['active', 'blocked'].includes(run.status) || Number(run.mutationRevision || 0) !== 0) {
          throw Object.assign(new Error('run_initialization_rollback_not_safe'), {
            code: 'run_initialization_rollback_not_safe',
            errorCode: 'run_initialization_rollback_not_safe',
            nextAction: 'preserve-run-and-resolve-lifecycle-state',
            details: { runId, status: run.status, mutationRevision: Number(run.mutationRevision || 0) },
          });
        }

        const quoteIdentifier = (value) => `"${String(value).replaceAll('"', '""')}"`;
        const tableRows = db.prepare(`
          SELECT name FROM sqlite_master
          WHERE type='table' AND name NOT LIKE 'sqlite_%'
        `).all();
        const tables = tableRows.map((row) => row.name).filter((name) => name !== 'runs').map((name) => {
          const quoted = quoteIdentifier(name);
          const columns = db.prepare(`PRAGMA table_info(${quoted})`).all().map((column) => column.name);
          const references = db.prepare(`PRAGMA foreign_key_list(${quoted})`).all().map((foreignKey) => foreignKey.table);
          return {
            name,
            hasRunId: columns.includes('run_id'),
            hasHolderRunId: columns.includes('holder_run_id'),
            references,
          };
        }).filter((table) => table.hasRunId || table.hasHolderRunId);

        const pending = new Map(tables.map((table) => [table.name, table]));
        while (pending.size > 0) {
          const deletable = [...pending.values()].find((candidate) => (
            ![...pending.values()].some((other) => other.name !== candidate.name && other.references.includes(candidate.name))
          ));
          const table = deletable || pending.values().next().value;
          const clauses = [];
          const values = [];
          if (table.hasRunId) {
            clauses.push('run_id=?');
            values.push(runId);
          }
          if (table.hasHolderRunId) {
            clauses.push('holder_run_id=?');
            values.push(runId);
          }
          db.prepare(`DELETE FROM ${quoteIdentifier(table.name)} WHERE ${clauses.join(' OR ')}`).run(...values);
          pending.delete(table.name);
        }
        const deleted = db.prepare('DELETE FROM runs WHERE run_id=? AND status IN (\'active\', \'blocked\') AND mutation_revision=0').run(runId);
        if (deleted.changes !== 1) {
          throw Object.assign(new Error('run_initialization_rollback_race'), {
            code: 'run_initialization_rollback_race',
            errorCode: 'run_initialization_rollback_race',
          });
        }
        return { status: 'rolled-back', runId, rolledBack: true };
      })();
    },

    abandonRun(runId) {
      const run = this.getRun(runId);
      if (!run) throw new Error(`Run ${runId} not found`);
      const abandon = db.transaction(() => {
        db.prepare(`UPDATE runs SET status='abandoned', updated_at=? WHERE run_id=?`).run(now(), runId);
        if (run.worktreeId) {
          db.prepare(`DELETE FROM worktree_mutation_leases WHERE worktree_id=? AND holder_run_id=?`)
            .run(run.worktreeId, runId);
        }
      });
      abandon();
      return this.getRun(runId);
    },

    // Task Contract is the run's authority; a revision bump records that the
    // model refined it (for example with an optional evidence plan) mid-run.
    updateTaskContract(runId, taskContract, { bumpRevision = true } = {}) {
      const run = this.getRun(runId);
      if (!run) throw new Error(`Run ${runId} not found`);
      const nextRevision = bumpRevision ? Number(run.contractRevision || 1) + 1 : Number(run.contractRevision || 1);
      db.prepare(`UPDATE runs SET task_contract_json=?, contract_revision=?, acceptance_criteria=?, revision=revision+1, updated_at=? WHERE run_id=?`)
        .run(persistentJson(taskContract), nextRevision, persistentJson((taskContract.acceptance || []).map((item) => item.statement).filter(Boolean)), now(), runId);
      return this.getRun(runId);
    },

    // Contract revisions change the binding authority for both plans and
    // persisted proof. Keep the contract, compiled obligations, and legacy
    // statement coverage in one SQLite transaction so a rebase cannot leave a
    // half-updated contract whose evidence points at a different AC namespace.
    reviseTaskContractAtomic(runId, taskContract, { obligations = [], bumpRevision = true } = {}) {
      const run = this.getRun(runId);
      if (!run) throw new Error(`Run ${runId} not found`);
      const nextRevision = bumpRevision
        ? Number(run.contractRevision || 1) + 1
        : Number(run.contractRevision || 1);
      const revise = db.transaction(() => {
        const compiledIds = [...new Set(obligations.map((obligation) => obligation.obligationId))];
        const previousObligationRows = new Map(this.getRunObligations(runId).map((obligation) => [obligation.obligationId, obligation]));
        const existingObligationIds = db.prepare(`
          SELECT obligation_id as obligationId FROM run_obligations WHERE run_id=?
        `).all(runId).map((row) => row.obligationId);
        const supersededObligationIds = existingObligationIds
          .filter((obligationId) => !compiledIds.includes(obligationId));
        // The compiled result is the complete current authority. Historical
        // rows remain queryable and are marked superseded below, but they must
        // not silently keep a removed requirement alive in the Run gate.
        const nextRequiredObligations = compiledIds;
        db.prepare(`UPDATE runs
          SET task_contract_json=?, contract_revision=?, acceptance_criteria=?, required_obligations=?, revision=revision+1, updated_at=?
          WHERE run_id=?`)
          .run(
            persistentJson(taskContract),
            nextRevision,
            persistentJson((taskContract.acceptance || []).map((item) => item.statement).filter(Boolean)),
            persistentJson(nextRequiredObligations),
            now(),
            runId,
          );

        if (supersededObligationIds.length > 0) {
          const placeholders = supersededObligationIds.map(() => '?').join(', ');
          db.prepare(`UPDATE run_obligations SET status='superseded', updated_at=? WHERE run_id=? AND obligation_id IN (${placeholders})`)
            .run(now(), runId, ...supersededObligationIds);
        }

        const upsertObligation = db.prepare(`
          INSERT INTO run_obligations(run_id, obligation_id, source_type, source_ref, status, evidence_class, verification_method, allowed_command_refs, rejected_command_refs, acceptance_ids, protected, contract_revision, metadata_json, created_at, updated_at)
          VALUES(?, ?, ?, ?, 'required', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(run_id, obligation_id) DO UPDATE SET
            source_type=excluded.source_type,
            source_ref=excluded.source_ref,
            status='required',
            evidence_class=excluded.evidence_class,
            verification_method=excluded.verification_method,
            allowed_command_refs=excluded.allowed_command_refs,
            rejected_command_refs=excluded.rejected_command_refs,
            acceptance_ids=excluded.acceptance_ids,
            protected=excluded.protected,
            contract_revision=excluded.contract_revision,
            metadata_json=excluded.metadata_json,
            updated_at=excluded.updated_at
        `);
        for (const obligation of obligations) {
          upsertObligation.run(
            runId,
            obligation.obligationId,
            obligation.sourceType || 'proof-policy',
            obligation.sourceRef || null,
            obligation.evidenceClass || 'hard',
            obligation.verificationMethod || null,
            JSON.stringify(obligation.allowedCommandRefs || []),
            JSON.stringify(obligation.rejectedCommandRefs || []),
            JSON.stringify(obligation.acceptanceIds || []),
            obligation.protected ? 1 : 0,
            nextRevision,
            JSON.stringify(obligation.metadata || {}),
            now(),
            now(),
          );
        }

        const obligationRows = new Map(this.getRunObligations(runId).map((obligation) => [obligation.obligationId, obligation]));
        for (const obligation of obligations) obligationRows.set(obligation.obligationId, obligation);
        const canonicalCoverage = (rawCoverage, obligationId) => {
          const coverage = safeJsonParse(rawCoverage, []);
          if (coverage.length === 0) return [];
          const previousObligation = previousObligationRows.get(obligationId) || null;
          // Once an obligation has been superseded it no longer participates
          // in the current completion authority. Its historical coverage is
          // retained for audit only and may refer to acceptance ids removed by
          // an earlier replacement, so do not validate it against the reduced
          // current contract on later revisions.
          if (previousObligation?.status === 'superseded' && !compiledIds.includes(obligationId)) {
            return coverage;
          }
          // Validate historical evidence against the old authority first. A
          // genuinely malformed old receipt still fails closed; a criterion
          // deliberately removed by the new contract becomes stale history.
          try {
            normalizeAcceptanceCoverage({
              contract: run.taskContract || {},
              acceptanceCriteria: run.acceptanceCriteria || [],
              obligation: previousObligation,
              coverage,
            });
          } catch (error) {
            throw Object.assign(new Error(`CONTRACT_COVERAGE_REBASE_FAILED: ${error.message}`), {
              code: 'CONTRACT_COVERAGE_REBASE_FAILED',
              detail: { obligationId, coverage, cause: error.code || 'ACCEPTANCE_COVERAGE_INVALID' },
            });
          }
          if (!compiledIds.includes(obligationId)) return coverage;
          try {
            return normalizeAcceptanceCoverage({
              contract: taskContract,
              acceptanceCriteria: (taskContract.acceptance || []).map((item) => item.statement).filter(Boolean),
              obligation: obligationRows.get(obligationId) || null,
              coverage,
            });
          } catch (error) {
            // Removal or rebinding of an acceptance criterion makes prior
            // proof stale, not a reason to abandon the Run. The old validation
            // above preserves the fail-closed check for corrupt history.
            if (error?.code === 'ACCEPTANCE_COVERAGE_UNKNOWN'
              || error?.code === 'ACCEPTANCE_COVERAGE_NOT_BOUND') return [];
            throw Object.assign(new Error(`CONTRACT_COVERAGE_REBASE_FAILED: ${error.message}`), {
              code: 'CONTRACT_COVERAGE_REBASE_FAILED',
              detail: { obligationId, coverage, cause: error.code || 'ACCEPTANCE_COVERAGE_INVALID' },
            });
          }
        };

        for (const row of db.prepare(`SELECT id, obligation_id, acceptance_coverage FROM verifications WHERE run_id=?`).all(runId)) {
          const canonical = canonicalCoverage(row.acceptance_coverage, row.obligation_id);
          db.prepare('UPDATE verifications SET acceptance_coverage=? WHERE id=?').run(JSON.stringify(canonical), row.id);
        }
        for (const row of db.prepare(`SELECT id, obligation_id, acceptance_coverage FROM waivers WHERE run_id=?`).all(runId)) {
          const canonical = canonicalCoverage(row.acceptance_coverage, row.obligation_id);
          db.prepare('UPDATE waivers SET acceptance_coverage=? WHERE id=?').run(JSON.stringify(canonical), row.id);
        }
        for (const row of db.prepare(`SELECT receipt_id, obligation_id, acceptance_coverage_json, receipt_json FROM review_receipts WHERE run_id=?`).all(runId)) {
          const canonical = canonicalCoverage(row.acceptance_coverage_json, row.obligation_id);
          const receipt = safeJsonParse(row.receipt_json, null);
          if (receipt && typeof receipt === 'object') {
            receipt.acceptanceCoverage = canonical;
          }
          db.prepare('UPDATE review_receipts SET acceptance_coverage_json=?, receipt_json=? WHERE receipt_id=?')
            .run(JSON.stringify(canonical), receipt ? persistentJson(receipt) : row.receipt_json, row.receipt_id);
        }
      });
      revise();
      return this.getRun(runId);
    },

    setRunRoute(runId, route) {
      db.prepare(`UPDATE runs SET route_json=?, revision=revision+1, updated_at=? WHERE run_id=?`).run(JSON.stringify(route), now(), runId);
      return this.getRun(runId);
    },

    // Finalization is tracked separately from completion (P0-7): an accepted
    // completion whose knowledge commit or Git closeout failed is NOT done.
    setFinalizationStatus(runId, finalizationStatus) {
      db.prepare(`UPDATE runs SET finalization_status=?, revision=revision+1, updated_at=? WHERE run_id=?`).run(String(finalizationStatus), now(), runId);
      return this.getRun(runId);
    },

    // Compiled obligations are the run's binding authority: which evidence
    // class and which project commands may satisfy each required obligation.
    declareRunObligations(runId, obligations = []) {
      for (const obligation of obligations) {
        db.prepare(`
          INSERT INTO run_obligations(run_id, obligation_id, source_type, source_ref, status, evidence_class, verification_method, allowed_command_refs, rejected_command_refs, acceptance_ids, protected, contract_revision, metadata_json, created_at, updated_at)
          VALUES(?, ?, ?, ?, 'required', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(run_id, obligation_id) DO UPDATE SET
            evidence_class=excluded.evidence_class,
            verification_method=excluded.verification_method,
            allowed_command_refs=excluded.allowed_command_refs,
            rejected_command_refs=excluded.rejected_command_refs,
            acceptance_ids=excluded.acceptance_ids,
            protected=excluded.protected,
            contract_revision=excluded.contract_revision,
            metadata_json=excluded.metadata_json,
            updated_at=excluded.updated_at
        `).run(
          runId,
          obligation.obligationId,
          obligation.sourceType || 'proof-policy',
          obligation.sourceRef || null,
          obligation.evidenceClass || 'hard',
          obligation.verificationMethod || null,
          JSON.stringify(obligation.allowedCommandRefs || []),
          JSON.stringify(obligation.rejectedCommandRefs || []),
          JSON.stringify(obligation.acceptanceIds || []),
          obligation.protected ? 1 : 0,
          Number(obligation.contractRevision) || 1,
          JSON.stringify(obligation.metadata || {}),
          now(),
          now(),
        );
      }
      return this.getRunObligations(runId);
    },

    // Within a run, route and tier may only be promoted, never demoted
    // (§13.5). Demotion requires a new run.
    escalateRun(runId, { proofTier, evidenceTier, addObligations = [] } = {}) {
      const run = this.getRun(runId);
      if (!run) throw new Error(`Run ${runId} not found`);
      if (run.status === 'completed') throw new Error(`Cannot escalate completed run ${runId}`);

      let nextTier = run.proofTier;
      if (proofTier) {
        if (TIER_RANK[proofTier] === undefined) throw new Error(`Unknown proof tier: ${proofTier}`);
        if (TIER_RANK[proofTier] < TIER_RANK[run.proofTier]) {
          throw new Error(`ROUTE_DEMOTION_FORBIDDEN: cannot demote ${run.proofTier} -> ${proofTier}; start a new run instead`);
        }
        nextTier = proofTier;
      }

      let nextEvidence = run.evidenceTier;
      if (evidenceTier) {
        if (EVIDENCE_RANK[evidenceTier] === undefined) throw new Error(`Unknown evidence tier: ${evidenceTier}`);
        if (EVIDENCE_RANK[evidenceTier] < EVIDENCE_RANK[run.evidenceTier]) {
          throw new Error(`ROUTE_DEMOTION_FORBIDDEN: cannot demote evidence ${run.evidenceTier} -> ${evidenceTier}`);
        }
        nextEvidence = evidenceTier;
      }

      const mergedObligations = [...new Set([...run.requiredObligations, ...addObligations])];
      db.prepare(`UPDATE runs SET proof_tier=?, evidence_tier=?, required_obligations=?, release_evidence_required=?, revision=revision+1, updated_at=? WHERE run_id=?`)
        .run(nextTier, nextEvidence, JSON.stringify(mergedObligations), nextEvidence === 'E2' ? 1 : (run.releaseEvidenceRequired ? 1 : 0), now(), runId);
      return this.getRun(runId);
    },

    setBaselineFailures(runId, failures = []) {
      if (!this.getRun(runId)) throw new Error(`Run ${runId} not found`);
      db.prepare(`UPDATE runs SET baseline_failures=?, updated_at=? WHERE run_id=?`).run(JSON.stringify(failures), now(), runId);
      return this.getRun(runId);
    },

    setBaselineStatus(runId, status) {
      if (!this.getRun(runId)) throw new Error(`Run ${runId} not found`);
      db.prepare(`UPDATE runs SET baseline_status=?, updated_at=? WHERE run_id=?`).run(String(status), now(), runId);
      return this.getRun(runId);
    },

    setKnowledgeStatus(runId, status) {
      if (!this.getRun(runId)) throw new Error(`Run ${runId} not found`);
      db.prepare(`UPDATE runs SET knowledge_status=?, updated_at=? WHERE run_id=?`).run(String(status || 'no_candidates_submitted'), now(), runId);
      return this.getRun(runId);
    },

    // A replan is a durable event; counting it keeps the measurement honest.
    incrementReplanCount(runId) {
      if (!this.getRun(runId)) throw new Error(`Run ${runId} not found`);
      db.prepare(`UPDATE runs SET replan_count=replan_count+1, revision=revision+1, updated_at=? WHERE run_id=?`).run(now(), runId);
      return this.getRun(runId);
    },

    markRunBlocked(runId, reason, blockingClass = null) {
      const run = this.getRun(runId);
      if (!run) throw new Error(`Run ${runId} not found`);
      if (run.status === 'completed') throw new Error(`Cannot block completed run ${runId}`);
      const normReason = String(reason || 'question');
      const resolvedClass = blockingClass
        || (normReason.includes('verification') || normReason.includes('obligation') || normReason.includes('dependency') || normReason.includes('question') || normReason.includes('permission') || normReason.includes('scope') ? 'completion' : 'safety');
      db.transaction(() => {
        db.prepare(`UPDATE runs SET status='blocked', blocked_reason=?, blocking_class=?, revision=revision+1, updated_at=? WHERE run_id=?`)
          .run(normReason, String(resolvedClass), now(), runId);
        reconcileTerminalLifecycleInTransaction({ projectId: run.projectId, runId });
      })();
      this.recordRunEfficiency(runId, { timestamps: { blockedAt: now() } });
      return this.getRun(runId);
    },

    // Each blocked->active resume is a user intervention; counting it here
    // keeps the measurement honest without a caller-held tally.
    resumeBlockedRun(runId) {
      const run = this.getRun(runId);
      if (!run) throw new Error(`Run ${runId} not found`);
      if (run.status !== 'blocked') return run;
      db.transaction(() => {
        if (run.worktreeId && run.projectId) {
          const lease = claimWorktreeLeaseInTransaction({
            worktreeId: run.worktreeId,
            projectId: run.projectId,
            runId,
          });
          if (!lease.acquired) throwWorktreeRunConflict(lease.lease);
        }
        db.prepare(`UPDATE runs SET status='active', blocked_reason=NULL, blocking_class=NULL, intervention_count=intervention_count+1, revision=revision+1, updated_at=? WHERE run_id=?`).run(now(), runId);
      })();
      return this.getRun(runId);
    },

    // A blocked run's owner is intentionally inactive. Resumption is the
    // explicit lifecycle transition that may reactivate that same binding;
    // another host/session cannot claim it as an unowned run.
    reactivateBlockedRunBinding(binding = {}) {
      if (!binding.bindingId || !binding.sessionId || !binding.runId || !binding.projectId) {
        throw Object.assign(new Error('host_binding_missing'), { code: 'host_binding_missing' });
      }
      const reactivate = db.transaction(() => {
        const run = db.prepare(`
          SELECT run_id AS runId, project_id AS projectId, workspace_id AS workspaceId,
                 owner_binding_id AS ownerBindingId, status
          FROM runs WHERE run_id=?
        `).get(binding.runId);
        if (!run || run.projectId !== binding.projectId || run.status !== 'blocked') return null;
        if (run.ownerBindingId !== binding.bindingId) return null;
        if (run.workspaceId && run.workspaceId !== (binding.workspaceId || null)) return null;
        const current = db.prepare(`SELECT * FROM session_bindings WHERE binding_id=?`).get(binding.bindingId);
        if (!current || current.status !== 'inactive' || current.project_id !== binding.projectId || current.run_id !== binding.runId) return null;
        if (current.session_id !== binding.sessionId || current.access_mode !== 'owner') return null;
        const conflict = db.prepare(`
          SELECT binding_id AS bindingId
          FROM session_bindings
          WHERE project_id=? AND session_id=? AND workspace_id=?
            AND status='active' AND access_mode='owner'
            AND binding_id<>?
          LIMIT 1
        `).get(binding.projectId, binding.sessionId, binding.workspaceId || null, binding.bindingId);
        if (conflict) {
          throw Object.assign(new Error('successor_binding_conflict'), {
            code: 'successor_binding_conflict',
            errorCode: 'successor_binding_conflict',
            nextAction: 'inspect-active-owner-binding',
          });
        }
        const updatedAt = now();
        const updated = db.prepare(`
          UPDATE session_bindings
          SET provider=?, surface=?, workspace_id=?, workspace_root=?, status='active',
              closed_at=NULL, close_reason=NULL, successor_run_id=NULL,
              expires_at=?, updated_at=?
          WHERE binding_id=? AND status='inactive' AND session_id=? AND project_id=? AND run_id=?
        `).run(
          binding.provider || current.provider,
          binding.surface ?? current.surface,
          binding.workspaceId || null,
          binding.workspaceRoot || null,
          binding.expiresAt || null,
          updatedAt,
          binding.bindingId,
          binding.sessionId,
          binding.projectId,
          binding.runId,
        );
        if (updated.changes !== 1) return null;
        db.prepare(`
          UPDATE runs
          SET status='active', blocked_reason=NULL, blocking_class=NULL, intervention_count=intervention_count+1,
              revision=revision+1, updated_at=?
          WHERE run_id=? AND status='blocked' AND owner_binding_id=?
        `).run(updatedAt, binding.runId, binding.bindingId);
        return mapSessionBinding(db.prepare('SELECT * FROM session_bindings WHERE binding_id=?').get(binding.bindingId));
      });
      return reactivate();
    },

    recordRunSignals(runId, signals = {}) {
      const run = this.getRun(runId);
      if (!run) throw new Error(`Run ${runId} not found`);
      const prior = run.runSignals && typeof run.runSignals === 'object' ? run.runSignals : {};
      const mergeSignals = (left = [], right = []) => [...left, ...right].filter(Boolean);
      const merged = {
        ...prior,
        ...signals,
        failures: mergeSignals(prior.failures, signals.failures),
        blockers: mergeSignals(prior.blockers, signals.blockers),
        architectureJudgments: mergeSignals(prior.architectureJudgments, signals.architectureJudgments),
        regressionVerifications: mergeSignals(prior.regressionVerifications, signals.regressionVerifications),
        invariantObservations: mergeSignals(prior.invariantObservations, signals.invariantObservations),
        supersessionEvidence: mergeSignals(prior.supersessionEvidence, signals.supersessionEvidence),
      };
      db.prepare(`UPDATE runs SET run_signals_json=?, updated_at=? WHERE run_id=?`).run(persistentJson(merged), now(), runId);
      return this.getRun(runId);
    },

    // Efficiency telemetry is an additive projection on the existing Run
    // signals ledger. It deliberately has no table of its own and does not
    // advance the lifecycle revision: timing/counter observations must not
    // invalidate evidence or create a second completion authority.
    recordRunEfficiency(runId, { timestamps = {}, increments = {}, counters = {} } = {}) {
      const run = this.getRun(runId);
      if (!run) throw new Error(`Run ${runId} not found`);
      const priorSignals = run.runSignals && typeof run.runSignals === 'object' && !Array.isArray(run.runSignals)
        ? run.runSignals
        : {};
      const prior = priorSignals.efficiency && typeof priorSignals.efficiency === 'object'
        && !Array.isArray(priorSignals.efficiency)
        ? priorSignals.efficiency
        : {};
      const firstTimestampFields = new Set([
        'runStartedAt', 'goalResolvedAt', 'readinessCompletedAt', 'firstRepositoryReadAt',
        'firstMutationAt', 'focusedVerificationStartedAt', 'goalRegressionStartedAt',
        'reviewRequestedAt', 'reviewSpawnedAt',
      ]);
      const timestampFields = [
        'runStartedAt', 'goalResolvedAt', 'readinessCompletedAt', 'firstRepositoryReadAt',
        'firstMutationAt', 'lastMutationAt', 'focusedVerificationStartedAt',
        'focusedVerificationFinishedAt', 'goalRegressionStartedAt', 'goalRegressionFinishedAt',
        'reviewRequestedAt', 'reviewSpawnedAt', 'reviewFinishedAt', 'blockedAt',
      ];
      const counterFields = [
        'reportCount', 'reportRejectedCount', 'contractRepairCount', 'scopeRejectedCount',
        'verificationTimeoutCount', 'waitTimeoutCount', 'contextCompactionCount',
        'repositorySearchCount', 'sameFileReadCount',
      ];
      const next = { ...prior };
      for (const field of timestampFields) {
        const incoming = timestamps[field];
        if (!incoming || !Number.isFinite(Date.parse(String(incoming)))) continue;
        const existing = next[field];
        if (!existing || !Number.isFinite(Date.parse(String(existing)))) {
          next[field] = String(incoming);
          continue;
        }
        const incomingMs = Date.parse(String(incoming));
        const existingMs = Date.parse(String(existing));
        next[field] = firstTimestampFields.has(field)
          ? (incomingMs < existingMs ? String(incoming) : String(existing))
          : (incomingMs > existingMs ? String(incoming) : String(existing));
      }
      for (const field of counterFields) {
        const increment = Number(increments[field] || 0);
        if (Number.isFinite(increment) && increment > 0) {
          next[field] = Math.max(0, Number(next[field] || 0)) + increment;
        }
        const absolute = Number(counters[field]);
        if (Number.isFinite(absolute) && absolute >= 0) {
          next[field] = Math.max(Number(next[field] || 0), absolute);
        }
        if (next[field] !== undefined) next[field] = Math.max(0, Math.trunc(Number(next[field]) || 0));
      }
      const merged = { ...priorSignals, efficiency: next };
      db.prepare(`UPDATE runs SET run_signals_json=?, updated_at=? WHERE run_id=?`)
        .run(persistentJson(merged), now(), runId);
      return this.getRun(runId);
    },

    getProjectRunSignals(projectId, { excludeRunId = null } = {}) {
      const rows = db.prepare(`SELECT run_id as runId, run_signals_json as runSignalsJson FROM runs WHERE project_id=? AND run_signals_json IS NOT NULL ${excludeRunId ? 'AND run_id<>?' : ''} ORDER BY updated_at ASC`)
        .all(...(excludeRunId ? [projectId, excludeRunId] : [projectId]));
      return rows.map((row) => ({ runId: row.runId, ...(safeJsonParse(row.runSignalsJson, {}) || {}) }));
    },

    // Mutation revision advances only when the observed workspace identity
    // actually changes, never on state transitions alone.
    observeWorkspaceIdentity(runId, identity) {
      if (!identity || !sha256Regex.test(identity)) {
        throw new Error('observeWorkspaceIdentity requires a sha256:<hex> workspace identity');
      }
      db.exec('BEGIN IMMEDIATE TRANSACTION');
      try {
        const run = this.getRun(runId);
        if (!run) throw new Error(`Run ${runId} not found`);
        if (run.currentWorkspaceIdentity === identity) {
          db.exec('COMMIT');
          return { changed: false, run };
        }
        const isInitialObservation = !run.currentWorkspaceIdentity;
        db.prepare(`
          UPDATE runs
          SET current_workspace_identity=?,
              run_start_workspace_identity=COALESCE(run_start_workspace_identity, ?),
              mutation_revision=mutation_revision+?,
              revision=revision+1,
              updated_at=?
          WHERE run_id=?
        `).run(identity, identity, isInitialObservation ? 0 : 1, now(), runId);
        db.exec('COMMIT');
        return { changed: !isInitialObservation, run: this.getRun(runId) };
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },

    // Delivery materialization uses the same observation route as ordinary
    // reports, but with an owner snapshot CAS. The workspace fence prevents
    // another Kernel owner from entering the critical section; this SQL CAS
    // also protects the revision/identity pair from a stale process that
    // observed the same workspace before its lock was lost.
    observeWorkspaceIdentityCAS(runId, {
      expectedMutationRevision,
      expectedWorkspaceIdentity,
      identity,
      provenance = null,
    } = {}) {
      if (!identity || !sha256Regex.test(identity)) {
        throw Object.assign(new Error('delivery_workspace_identity_invalid'), {
          code: 'delivery_workspace_identity_invalid',
          errorCode: 'delivery_workspace_identity_invalid',
        });
      }
      const fail = (code, message) => {
        throw Object.assign(new Error(`${code}: ${message}`), { code, errorCode: code });
      };
      db.exec('BEGIN IMMEDIATE TRANSACTION');
      try {
        const run = this.getRun(runId);
        if (!run || run.status !== 'active') fail('delivery_run_inactive', runId);
        if (expectedMutationRevision === null || expectedMutationRevision === undefined) {
          fail('delivery_mutation_revision_stale', 'expected mutation revision is required');
        }
        if (Number(run.mutationRevision) !== Number(expectedMutationRevision)) {
          fail('delivery_mutation_revision_stale', `Run mutation revision ${run.mutationRevision} does not match expected ${expectedMutationRevision}`);
        }
        if (expectedWorkspaceIdentity && run.currentWorkspaceIdentity !== expectedWorkspaceIdentity) {
          fail('delivery_workspace_drift', 'Run workspace identity no longer matches the Delivery CAS snapshot');
        }
        if (!run.currentWorkspaceIdentity || run.currentWorkspaceIdentity === identity) {
          fail('delivery_mutation_not_observed', 'Delivery identity did not advance from the expected owner identity');
        }
        const updated = db.prepare(`
          UPDATE runs
          SET current_workspace_identity=?,
              run_start_workspace_identity=COALESCE(run_start_workspace_identity, ?),
              mutation_revision=mutation_revision+1,
              revision=revision+1,
              updated_at=?
          WHERE run_id=? AND mutation_revision=? AND current_workspace_identity=?
        `).run(identity, identity, now(), runId, Number(expectedMutationRevision), expectedWorkspaceIdentity || run.currentWorkspaceIdentity);
        if (Number(updated.changes || 0) !== 1) {
          fail('delivery_mutation_revision_stale', 'Delivery identity CAS did not update exactly one Run');
        }
        if (provenance) this.recordMutationProvenance(runId, provenance);
        db.exec('COMMIT');
        return {
          changed: true,
          previousWorkspaceIdentity: run.currentWorkspaceIdentity,
          run: this.getRun(runId),
          provenance: provenance ? this.getMutationProvenance(runId) : null,
        };
      } catch (err) {
        try { db.exec('ROLLBACK'); } catch {}
        throw err;
      }
    },

    getRun(runId) {
      const row = db.prepare(`
        SELECT run_id as runId, objective, state, status, revision,
               mutation_revision as mutationRevision, source_identity as sourceIdentity,
               run_start_workspace_identity as runStartWorkspaceIdentity,
               current_workspace_identity as currentWorkspaceIdentity,
               blocked_reason as blockedReason,
               blocking_class as blockingClass,
               intervention_count as interventionCount,
               project_mode as projectMode,
               baseline_failures as baselineFailures,
               baseline_status as baselineStatus,
               replan_count as replanCount,
               proof_tier as proofTier, evidence_tier as evidenceTier,
               required_obligations as requiredObligations, acceptance_criteria as acceptanceCriteria,
               release_evidence_required as releaseEvidenceRequired,
                project_id as projectId, knowledge_revision_start as knowledgeRevisionStart,
                knowledge_revision_close as knowledgeRevisionClose, knowledge_status as knowledgeStatus,
                context_pack_ref as contextPackRef,
                baseline_changed_paths as baselineChangedPaths,
                baseline_workspace_entries as baselineWorkspaceEntries,
                workspace_baseline_changed_paths as reportBaselineChangedPaths,
                workspace_baseline_entries as reportBaselineWorkspaceEntries,
                workspace_baseline_status as workspaceBaselineStatus,
                task_contract_json as taskContractJson,
               contract_revision as contractRevision,
               finalization_status as finalizationStatus,
               route_json as routeJson,
               implementation_context_json as implementationContextJson,
               plan_revision as planRevision,
               workspace_id as workspaceId,
               worktree_id as worktreeId,
               owner_binding_id as ownerBindingId,
               successor_key as successorKey,
               run_signals_json as runSignalsJson,
               updated_at as updatedAt
        FROM runs WHERE run_id=?
      `).get(runId);

      if (!row) return null;

      return {
        schemaVersion: 1,
        runId: row.runId,
        objective: row.objective,
        currentState: row.state,
        state: row.state,
        status: row.status,
        revision: row.revision,
        mutationRevision: row.mutationRevision,
        sourceIdentity: row.sourceIdentity,
        runStartWorkspaceIdentity: row.runStartWorkspaceIdentity || null,
        currentWorkspaceIdentity: row.currentWorkspaceIdentity || null,
        blockedReason: row.blockedReason || null,
        blockingClass: row.blockingClass || (row.status === 'blocked' ? 'safety' : null),
        interventionCount: row.interventionCount || 0,
        projectMode: row.projectMode || null,
        baselineFailures: safeJsonParse(row.baselineFailures, []),
        baselineStatus: row.baselineStatus || 'pending',
        replanCount: row.replanCount || 0,
        proofTier: row.proofTier,
        evidenceTier: row.evidenceTier,
        requiredObligations: safeJsonParse(row.requiredObligations),
        acceptanceCriteria: safeJsonParse(row.acceptanceCriteria),
        releaseEvidenceRequired: Boolean(row.releaseEvidenceRequired),
        projectId: row.projectId || null,
        knowledgeRevisionStart: row.knowledgeRevisionStart || null,
        knowledgeRevisionClose: row.knowledgeRevisionClose || null,
        knowledgeStatus: row.knowledgeStatus || null,
        contextPackRef: row.contextPackRef || null,
        baselineChangedPaths: canonicalReceiptPaths(safeJsonParse(row.baselineChangedPaths, [])),
        baselineWorkspaceEntries: safeJsonParse(row.baselineWorkspaceEntries, []),
        reportBaselineChangedPaths: canonicalReceiptPaths(row.reportBaselineChangedPaths
          ? safeJsonParse(row.reportBaselineChangedPaths, [])
          : safeJsonParse(row.baselineChangedPaths, [])),
        reportBaselineWorkspaceEntries: row.reportBaselineWorkspaceEntries
          ? safeJsonParse(row.reportBaselineWorkspaceEntries, [])
          : safeJsonParse(row.baselineWorkspaceEntries, []),
        workspaceBaselineStatus: row.workspaceBaselineStatus || 'unknown',
        taskContract: row.taskContractJson ? safeJsonParse(row.taskContractJson, null) : null,
        contractRevision: Number(row.contractRevision || 1),
        finalizationStatus: row.finalizationStatus || 'pending',
        route: row.routeJson ? safeJsonParse(row.routeJson, null) : null,
        implementationContext: row.implementationContextJson ? safeJsonParse(row.implementationContextJson, null) : null,
        planRevision: Number(row.planRevision || 1),
        workspaceId: row.workspaceId || null,
        worktreeId: row.worktreeId || null,
        ownerBindingId: row.ownerBindingId || null,
        successorKey: row.successorKey || null,
        runSignals: row.runSignalsJson ? safeJsonParse(row.runSignalsJson, {}) : {},
        updatedAt: row.updatedAt,
      };
    },

    // The durable authority view intentionally omits Host policy, prompt/cache,
    // Git, and optional execution internals. Those tables remain queryable as
    // receipts for audit/recovery, but are not a second Kernel state machine.
    getKernelDurableState(runId) {
      const run = this.getRun(runId);
      if (!run) return null;
      return buildKernelDurableStateView({
        run,
        verifications: this.getVerifications(runId),
        obligations: this.getRunObligations(runId),
        completionDecision: this.getCompletionDecision(runId),
      });
    },

    // A report describes the delta since the last accepted mutable boundary.
    // Keep the original Run-start baseline immutable for user-change
    // protection, while advancing this observation baseline after a report
    // has been processed so the next step/report can claim only its own work.
    updateRunWorkspaceBaseline(runId, { changedPaths = [], entries = [] } = {}) {
      db.prepare(`
        UPDATE runs
        SET workspace_baseline_changed_paths=?, workspace_baseline_entries=?, updated_at=?
        WHERE run_id=?
      `).run(
        JSON.stringify(canonicalReceiptPaths(changedPaths)),
        persistentJson(entries),
        now(),
        runId,
      );
      return this.getRun(runId);
    },

    getRunMetadata(runId) {
      const row = db.prepare(`SELECT run_id as runId, project_id as projectId, workspace_id as workspaceId, worktree_id as worktreeId, owner_binding_id as ownerBindingId, status FROM runs WHERE run_id=?`).get(runId);
      return row || null;
    },

    getRunOwnerBinding(runId) {
      if (!runId) return null;
      return mapSessionBinding(db.prepare(`
        SELECT b.*
        FROM session_bindings b
        JOIN runs r ON r.owner_binding_id=b.binding_id
        WHERE r.run_id=? AND b.run_id=r.run_id AND b.access_mode='owner'
        ORDER BY b.updated_at DESC
        LIMIT 1
      `).get(runId));
    },

    createSessionBinding(binding) {
      const create = db.transaction(() => {
        const run = db.prepare(`
          SELECT project_id as projectId, workspace_id as workspaceId,
                 owner_binding_id as ownerBindingId
          FROM runs WHERE run_id=?
        `).get(binding.runId);
        if (!run) {
          throw Object.assign(new Error('run_access_denied'), {
            code: 'run_access_denied',
            errorCode: 'run_access_denied',
            nextAction: 'inspect-run-binding',
          });
        }
        if (run.projectId !== binding.projectId) {
          throw Object.assign(new Error('run_project_mismatch'), {
            code: 'run_project_mismatch',
            errorCode: 'run_project_mismatch',
            nextAction: 'relaunch-from-bound-project',
          });
        }
        if (run.workspaceId && run.workspaceId !== binding.workspaceId) {
          throw Object.assign(new Error('run_workspace_mismatch'), {
            code: 'run_workspace_mismatch',
            errorCode: 'run_workspace_mismatch',
            nextAction: 'return-to-bound-workspace',
          });
        }
        if (binding.accessMode === 'owner' && run.ownerBindingId) {
          throw Object.assign(new Error('successor_binding_conflict'), {
            code: 'successor_binding_conflict',
            errorCode: 'successor_binding_conflict',
            nextAction: 'inspect-active-owner-binding',
          });
        }

        db.prepare(`INSERT INTO session_bindings(binding_id, session_id, provider, surface, run_id, project_id, workspace_id, workspace_root, access_mode, status, created_at, expires_at, updated_at)
          VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          binding.bindingId, binding.sessionId, binding.provider, binding.surface, binding.runId,
          binding.projectId, binding.workspaceId, binding.workspaceRoot, binding.accessMode,
          binding.status, now(), binding.expiresAt, now(),
        );
        if (binding.accessMode === 'owner') {
          const updated = db.prepare(`
            UPDATE runs
            SET owner_binding_id=?, workspace_id=COALESCE(workspace_id, ?), updated_at=?
            WHERE run_id=? AND project_id=? AND owner_binding_id IS NULL
              AND (workspace_id IS NULL OR workspace_id=?)
          `).run(
            binding.bindingId,
            binding.workspaceId,
            now(),
            binding.runId,
            binding.projectId,
            binding.workspaceId,
          );
          if (updated.changes !== 1) {
            throw Object.assign(new Error('successor_binding_conflict'), {
              code: 'successor_binding_conflict',
              errorCode: 'successor_binding_conflict',
              nextAction: 'inspect-active-owner-binding',
            });
          }
        }
      });
      try {
        create();
      } catch (error) {
        bindingConflict(error);
      }
      return this.getActiveRunBinding({
        projectId: binding.projectId,
        sessionId: binding.sessionId,
        runId: binding.runId,
      });
    },

    createSuccessorRunAtomic({
      projectId,
      sessionId,
      predecessorRunId,
      predecessorBindingId,
      successorRun,
      successorBinding,
      obligations = [],
      steps = [],
      successorKey,
      predecessorLock = null,
    } = {}) {
      const taskContractDigest = successorRun?.taskContract?.digest;
      const expectedSuccessorKey = buildSuccessorKey({
        projectId,
        predecessorRunId,
        worktreeId: successorRun?.worktreeId,
        workspaceId: successorRun?.workspaceId,
        taskContractDigest,
      });
      if (
        !projectId
        || !predecessorRunId
        || !successorRun?.runId
        || successorKey !== expectedSuccessorKey
      ) {
        throw Object.assign(new Error('successor_creation_conflict'), {
          code: 'successor_creation_conflict',
          errorCode: 'successor_creation_conflict',
          nextAction: 'retry-successor-resolution',
        });
      }
      const create = db.transaction(() => {
        const existing = db.prepare(`
          SELECT run_id as runId, project_id as projectId,
                 workspace_id as workspaceId, worktree_id as worktreeId,
                 task_contract_json as taskContractJson
          FROM runs WHERE successor_key=?
        `).get(successorKey);
        if (existing) {
          const existingContract = safeJsonParse(existing.taskContractJson, null);
          if (
            existing.projectId !== projectId
            || (successorRun.worktreeId
              ? existing.worktreeId !== successorRun.worktreeId
              : existing.workspaceId !== successorRun.workspaceId)
            || existingContract?.digest !== taskContractDigest
          ) {
            throw Object.assign(new Error('successor_creation_conflict'), {
              code: 'successor_creation_conflict',
              errorCode: 'successor_creation_conflict',
              nextAction: 'inspect-successor-lineage',
            });
          }
          return { created: false, runId: existing.runId };
        }

        const predecessor = db.prepare(`
          SELECT run_id as runId, project_id as projectId,
                 workspace_id as workspaceId, worktree_id as worktreeId,
                 owner_binding_id as ownerBindingId,
                 status, finalization_status as finalizationStatus,
                 current_workspace_identity as currentWorkspaceIdentity
          FROM runs WHERE run_id=?
        `).get(predecessorRunId);
        const predecessorBinding = predecessorBindingId && sessionId
          ? db.prepare(`
              SELECT * FROM session_bindings
              WHERE binding_id=? AND run_id=? AND project_id=? AND session_id=?
                AND status='active' AND access_mode='owner'
            `).get(predecessorBindingId, predecessorRunId, projectId, sessionId)
          : null;
        const successorWorkspace = db.prepare(`
          SELECT project_id as projectId, worktree_id as worktreeId
          FROM project_workspaces
          WHERE workspace_id=?
        `).get(successorRun.workspaceId);
        const validPredecessor = predecessor
          && predecessor.projectId === projectId
          && (successorRun.worktreeId
            ? predecessor.worktreeId === successorRun.worktreeId
            : predecessor.workspaceId === successorRun.workspaceId)
          && predecessor.status === 'completed'
          && predecessor.finalizationStatus === 'completed';
        if (!validPredecessor) {
          throw Object.assign(new Error('successor_not_allowed'), {
            code: 'successor_not_allowed',
            errorCode: 'successor_not_allowed',
            nextAction: predecessor?.status === 'completed'
              && predecessor?.finalizationStatus !== 'completed'
              ? 'retry-finalization'
              : 'inspect-predecessor-binding',
          });
        }
        const predecessorFinalWorkspaceIdentity = predecessor.currentWorkspaceIdentity || null;
        const successorStartWorkspaceIdentity = successorRun.runStartWorkspaceIdentity
          || successorRun.workspaceIdentity
          || null;
        if (!predecessorFinalWorkspaceIdentity
          || !successorStartWorkspaceIdentity
          || predecessorFinalWorkspaceIdentity !== successorStartWorkspaceIdentity) {
          throw Object.assign(new Error('successor_workspace_continuity_mismatch'), {
            code: 'successor_workspace_continuity_mismatch',
            errorCode: 'successor_workspace_continuity_mismatch',
            nextAction: 'inspect-successor-workspace-continuity',
            details: {
              predecessorRunId,
              successorRunId: successorRun.runId,
              predecessorFinalWorkspaceIdentity,
              successorStartWorkspaceIdentity,
            },
          });
        }
        if (
          successorRun.projectId !== projectId
          || (successorRun.worktreeId && successorRun.worktreeId !== successorWorkspace?.worktreeId)
          || successorWorkspace?.projectId !== projectId
          || (successorBinding && (
            successorBinding.projectId !== projectId
            || successorBinding.sessionId !== sessionId
            || successorBinding.runId !== successorRun.runId
            || successorRun.workspaceId !== successorBinding.workspaceId
          ))
          || (successorBinding && predecessorBinding && successorBinding.provider !== predecessorBinding.provider)
          || successorRun.taskContract?.digest !== taskContractDigest
        ) {
          throw Object.assign(new Error('successor_creation_conflict'), {
            code: 'successor_creation_conflict',
            errorCode: 'successor_creation_conflict',
            nextAction: 'retry-successor-resolution',
          });
        }

        this.createRun({
          ...successorRun,
          ownerBindingId: null,
          successorKey,
          withinTransaction: true,
        });
        this.declareRunObligations(successorRun.runId, obligations);
        this.createRunSteps(successorRun.runId, steps);

        const closedAt = now();
        if (predecessorBinding) {
          const closed = db.prepare(`
            UPDATE session_bindings
            SET status='inactive', closed_at=?, close_reason='successor_started',
                successor_run_id=?, updated_at=?
            WHERE binding_id=? AND run_id=? AND project_id=? AND session_id=?
              AND status='active' AND access_mode='owner'
          `).run(
            closedAt,
            successorRun.runId,
            closedAt,
            predecessorBindingId,
            predecessorRunId,
            projectId,
            sessionId,
          );
          if (closed.changes !== 1) {
            throw Object.assign(new Error('successor_binding_conflict'), {
              code: 'successor_binding_conflict',
              errorCode: 'successor_binding_conflict',
              nextAction: 'inspect-active-owner-binding',
            });
          }
        }

        if (successorBinding) {
          db.prepare(`
            INSERT INTO session_bindings(
              binding_id, session_id, provider, surface, run_id, project_id,
              workspace_id, workspace_root, access_mode, status, created_at,
              expires_at, updated_at
            ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'owner', 'active', ?, ?, ?)
          `).run(
            successorBinding.bindingId,
            successorBinding.sessionId,
            successorBinding.provider,
            successorBinding.surface,
            successorBinding.runId,
            successorBinding.projectId,
            successorBinding.workspaceId,
            successorBinding.workspaceRoot,
            closedAt,
            successorBinding.expiresAt,
            closedAt,
          );
          const owned = db.prepare(`
            UPDATE runs SET owner_binding_id=?, updated_at=?
            WHERE run_id=? AND project_id=? AND owner_binding_id IS NULL
              AND workspace_id=?
          `).run(
            successorBinding.bindingId,
            closedAt,
            successorRun.runId,
            projectId,
            successorBinding.workspaceId,
          );
          if (owned.changes !== 1) {
            throw Object.assign(new Error('successor_creation_conflict'), {
              code: 'successor_creation_conflict',
              errorCode: 'successor_creation_conflict',
              nextAction: 'retry-successor-resolution',
            });
          }
        }

        if (predecessor.workspaceId) {
          const currentLock = db.prepare(`
            SELECT workspace_id as workspaceId, project_id as projectId,
                   holder_run_id as holderRunId, session_token as sessionToken,
                   fencing_token as fencingToken, expires_at as expiresAt
            FROM workspace_mutation_locks_v2
            WHERE workspace_id=?
          `).get(predecessor.workspaceId);
          const lockFailure = () => {
            throw Object.assign(new Error('workspace_lock_handoff_failed'), {
              code: 'workspace_lock_handoff_failed',
              errorCode: 'workspace_lock_handoff_failed',
              nextAction: 'reacquire-predecessor-workspace-lock',
            });
          };
          if (predecessorLock) {
            if (
              !currentLock
              || predecessorLock.workspaceId !== predecessor.workspaceId
              || predecessorLock.projectId !== projectId
              || predecessorLock.holderRunId !== predecessorRunId
              || predecessorLock.sessionToken !== currentLock.sessionToken
              || Number(predecessorLock.fencingToken) !== Number(currentLock.fencingToken)
              || currentLock.projectId !== projectId
              || currentLock.holderRunId !== predecessorRunId
            ) {
              lockFailure();
            }
            const released = db.prepare(`
              DELETE FROM workspace_mutation_locks_v2
              WHERE workspace_id=? AND project_id=? AND holder_run_id=?
                AND session_token=? AND fencing_token=?
            `).run(
              predecessor.workspaceId,
              projectId,
              predecessorRunId,
              predecessorLock.sessionToken,
              Number(predecessorLock.fencingToken),
            );
            if (released.changes !== 1) lockFailure();
          } else if (currentLock && Date.parse(currentLock.expiresAt) > Date.now()) {
            lockFailure();
          } else if (currentLock) {
            db.prepare(`
              DELETE FROM workspace_mutation_locks_v2
              WHERE workspace_id=? AND expires_at=?
            `).run(predecessor.workspaceId, currentLock.expiresAt);
          }
        }
        db.prepare(`
          DELETE FROM workspace_mutation_locks
          WHERE project_id=? AND holder_run_id=?
        `).run(projectId, predecessorRunId);
        return { created: true, runId: successorRun.runId };
      });

      let result;
      try {
        result = create();
      } catch (error) {
        bindingConflict(error);
      }
      const run = this.getRun(result.runId);
      const binding = sessionId ? this.getActiveRunBinding({
          projectId,
          sessionId,
          runId: result.runId,
        }) : null;
      if (!run || (successorBinding && !binding)) {
        throw Object.assign(new Error('successor_creation_conflict'), {
          code: 'successor_creation_conflict',
          errorCode: 'successor_creation_conflict',
          nextAction: 'inspect-successor-lineage',
        });
      }
      return {
        created: result.created,
        run,
        binding,
        predecessorBinding: predecessorBindingId ? mapSessionBinding(db.prepare(`
          SELECT * FROM session_bindings WHERE binding_id=?
        `).get(predecessorBindingId)) : null,
      };
    },

    adoptUnownedRunBinding(binding) {
      const adopt = db.transaction(() => {
        const claimed = db.prepare(`
          UPDATE runs
          SET owner_binding_id=?, workspace_id=COALESCE(workspace_id, ?), updated_at=?
          WHERE run_id=? AND project_id=? AND owner_binding_id IS NULL
            AND (workspace_id IS NULL OR workspace_id=?)
        `).run(
          binding.bindingId,
          binding.workspaceId,
          now(),
          binding.runId,
          binding.projectId,
          binding.workspaceId,
        );
        if (claimed.changes !== 1) return false;
        db.prepare(`
          INSERT INTO session_bindings(
            binding_id, session_id, provider, surface, run_id, project_id,
            workspace_id, workspace_root, access_mode, status, created_at,
            expires_at, updated_at
          ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          binding.bindingId, binding.sessionId, binding.provider, binding.surface, binding.runId,
          binding.projectId, binding.workspaceId, binding.workspaceRoot, binding.accessMode,
          binding.status, now(), binding.expiresAt, now(),
        );
        return true;
      });
      const adopted = adopt();
      return {
        adopted,
        binding: adopted ? this.getActiveRunBinding({
          projectId: binding.projectId,
          sessionId: binding.sessionId,
          runId: binding.runId,
        }) : null,
      };
    },

    getActiveOwnerBinding({ projectId, sessionId, workspaceId = null } = {}) {
      if (!projectId || !sessionId) return null;
      return mapSessionBinding(db.prepare(`
        SELECT * FROM session_bindings
        WHERE project_id=? AND session_id=? AND status='active' AND access_mode='owner'
          ${workspaceId ? 'AND workspace_id=?' : ''}
        ORDER BY updated_at DESC
        LIMIT 1
      `).get(projectId, sessionId, ...(workspaceId ? [workspaceId] : [])));
    },

    getActiveRunBinding({ projectId, sessionId, runId } = {}) {
      if (!projectId || !sessionId || !runId) return null;
      return mapSessionBinding(db.prepare(`
        SELECT * FROM session_bindings
        WHERE project_id=? AND session_id=? AND run_id=? AND status='active'
        ORDER BY updated_at DESC
        LIMIT 1
      `).get(projectId, sessionId, runId));
    },

    migrateLegacySessionBinding({
      projectId,
      legacySessionId,
      canonicalSessionId,
      provider,
    } = {}) {
      if (!projectId || !legacySessionId || !canonicalSessionId || !provider) {
        throw Object.assign(new Error('provider_session_invalid'), {
          code: 'provider_session_invalid',
          errorCode: 'provider_session_invalid',
          nextAction: 'reopen-from-correct-worktree',
        });
      }
      const migrate = db.transaction(() => {
        const canonical = db.prepare(`
          SELECT * FROM session_bindings
          WHERE project_id=? AND session_id=? AND status='active' AND access_mode='owner'
          LIMIT 1
        `).get(projectId, canonicalSessionId);
        if (canonical) return mapSessionBinding(canonical);

        const legacy = db.prepare(`
          SELECT * FROM session_bindings
          WHERE project_id=? AND session_id=? AND status='active' AND access_mode='owner'
          LIMIT 1
        `).get(projectId, legacySessionId);
        if (!legacy) return null;
        const inferredLegacyCodex = legacy.provider === 'unknown'
          && provider === 'codex'
          && legacy.run_id === `codex-${legacySessionId}`;
        if (legacy.provider !== provider && !inferredLegacyCodex) {
          throw Object.assign(new Error('provider_session_invalid'), {
            code: 'provider_session_invalid',
            errorCode: 'provider_session_invalid',
            nextAction: 'reopen-from-correct-worktree',
          });
        }
        try {
          const updated = db.prepare(`
            UPDATE session_bindings
            SET session_id=?, provider=?, surface=COALESCE(surface, ?), updated_at=?
            WHERE binding_id=? AND project_id=? AND session_id=?
              AND provider=? AND status='active' AND access_mode='owner'
          `).run(
            canonicalSessionId,
            provider,
            provider,
            now(),
            legacy.binding_id,
            projectId,
            legacySessionId,
            legacy.provider,
          );
          if (updated.changes !== 1) {
            throw Object.assign(new Error('successor_binding_conflict'), {
              code: 'successor_binding_conflict',
              errorCode: 'successor_binding_conflict',
              nextAction: 'inspect-active-owner-binding',
            });
          }
        } catch (error) {
          bindingConflict(error);
        }
        return mapSessionBinding(db.prepare(`
          SELECT * FROM session_bindings WHERE binding_id=?
        `).get(legacy.binding_id));
      });
      return migrate();
    },

    getActiveRunBindingScope({ sessionId, runId } = {}) {
      if (!sessionId || !runId) return null;
      const row = db.prepare(`
        SELECT project_id as projectId
        FROM session_bindings
        WHERE session_id=? AND run_id=? AND status='active'
        ORDER BY updated_at DESC
        LIMIT 1
      `).get(sessionId, runId);
      return row || null;
    },

    listActiveOwnerBindings({ projectId, sessionId } = {}) {
      if (!projectId || !sessionId) return [];
      return db.prepare(`
        SELECT * FROM session_bindings
        WHERE project_id=? AND session_id=? AND status='active' AND access_mode='owner'
        ORDER BY updated_at DESC
      `).all(projectId, sessionId).map(mapSessionBinding);
    },

    diagnoseLifecycleState({ projectId = null, observedAt = now() } = {}) {
      const findings = [];
      const projectClause = projectId ? ' AND project_id=?' : '';
      const projectArgs = projectId ? [projectId] : [];
      const ambiguous = db.prepare(`
        SELECT project_id as projectId, session_id as sessionId, COUNT(*) as count
        FROM session_bindings
        WHERE status='active' AND access_mode='owner'${projectClause}
        GROUP BY project_id, session_id
        HAVING COUNT(*) > 1
      `).all(...projectArgs);
      for (const row of ambiguous) {
        findings.push({
          code: 'ambiguous_session_binding',
          severity: 'error',
          projectId: row.projectId,
          sessionId: row.sessionId,
          count: Number(row.count),
        });
      }

      const terminal = db.prepare(`
        SELECT r.run_id as runId, r.project_id as projectId,
               b.binding_id as bindingId, b.session_id as sessionId
        FROM runs r
        JOIN session_bindings b ON b.run_id=r.run_id
        WHERE r.status='completed' AND b.status='active' AND b.access_mode='owner'
          ${projectId ? 'AND r.project_id=?' : ''}
      `).all(...projectArgs);
      for (const row of terminal) {
        findings.push({ code: 'terminal_run_active_binding', severity: 'warning', ...row });
      }

      const orphaned = db.prepare(`
        SELECT r.run_id as runId, r.project_id as projectId,
               r.owner_binding_id as ownerBindingId
        FROM runs r
        LEFT JOIN session_bindings b ON b.binding_id=r.owner_binding_id
        WHERE r.owner_binding_id IS NOT NULL
          AND (
            b.binding_id IS NULL OR b.run_id<>r.run_id OR b.project_id<>r.project_id
            OR b.access_mode<>'owner'
          )
          ${projectId ? 'AND r.project_id=?' : ''}
      `).all(...projectArgs);
      for (const row of orphaned) {
        findings.push({ code: 'orphaned_run_owner', severity: 'error', ...row });
      }

      const bindings = db.prepare(`
        SELECT binding_id as bindingId, session_id as sessionId, provider,
               run_id as runId, project_id as projectId, workspace_id as workspaceId
        FROM session_bindings
        WHERE 1=1${projectClause}
      `).all(...projectArgs);
      for (const binding of bindings) {
        const sessionProvider = String(binding.sessionId).match(/^([a-z][a-z0-9-]{0,31}):/)?.[1] || null;
        const workspace = binding.workspaceId
          ? db.prepare('SELECT project_id as projectId FROM project_workspaces WHERE workspace_id=?').get(binding.workspaceId)
          : null;
        const providerMismatch = sessionProvider
          && binding.provider !== 'unknown'
          && binding.provider !== 'unknown-host'
          && sessionProvider !== binding.provider;
        const workspaceMismatch = binding.workspaceId
          && (!workspace || workspace.projectId !== binding.projectId);
        if (providerMismatch || workspaceMismatch) {
          findings.push({
            code: 'binding_namespace_problem',
            severity: 'error',
            bindingId: binding.bindingId,
            runId: binding.runId,
            projectId: binding.projectId,
            providerMismatch: Boolean(providerMismatch),
            workspaceMismatch: Boolean(workspaceMismatch),
          });
        }
      }

      const locks = db.prepare(`
        SELECT l.workspace_id as workspaceId, l.project_id as projectId,
               l.holder_run_id as holderRunId, l.fencing_token as fencingToken,
               l.expires_at as expiresAt, r.run_id as resolvedRunId,
               r.project_id as runProjectId, r.workspace_id as runWorkspaceId,
               w.project_id as workspaceProjectId
        FROM workspace_mutation_locks_v2 l
        LEFT JOIN runs r ON r.run_id=l.holder_run_id
        LEFT JOIN project_workspaces w ON w.workspace_id=l.workspace_id
        WHERE 1=1${projectId ? ' AND l.project_id=?' : ''}
      `).all(...projectArgs);
      const observedMs = Date.parse(observedAt);
      for (const lock of locks) {
        const expired = Date.parse(lock.expiresAt) <= observedMs;
        const invalidOwner = !lock.resolvedRunId
          || lock.runProjectId !== lock.projectId
          || lock.runWorkspaceId !== lock.workspaceId
          || lock.workspaceProjectId !== lock.projectId;
        if (expired || invalidOwner) {
          findings.push({
            code: 'stale_workspace_lock',
            severity: 'warning',
            workspaceId: lock.workspaceId,
            projectId: lock.projectId,
            holderRunId: lock.holderRunId,
            fencingToken: Number(lock.fencingToken),
            expired,
            invalidOwner,
          });
        }
      }

      const staleBefore = new Date(observedMs - (24 * 60 * 60 * 1000)).toISOString();
      const staleRuns = db.prepare(`
        SELECT r.run_id as runId, r.project_id as projectId, r.workspace_id as workspaceId,
               r.state, r.updated_at as updatedAt,
               (SELECT COUNT(*) FROM run_step_attempts a WHERE a.run_id=r.run_id) as attemptCount,
               (SELECT COUNT(*) FROM run_capsules c WHERE c.run_id=r.run_id) as capsuleCount,
               (SELECT COUNT(*) FROM verifications v WHERE v.run_id=r.run_id) as verificationCount,
               (SELECT COUNT(*) FROM completion_decisions d WHERE d.run_id=r.run_id) as completionReceiptCount,
               (SELECT COUNT(*) FROM run_steps s WHERE s.run_id=r.run_id AND s.state='ready') as readyStepCount
        FROM runs r
        WHERE r.status='active' AND r.updated_at<=?
          ${projectId ? 'AND r.project_id=?' : ''}
      `).all(staleBefore, ...projectArgs);
      for (const run of staleRuns) {
        const provenance = {
          attemptCount: Number(run.attemptCount || 0),
          capsuleCount: Number(run.capsuleCount || 0),
          verificationCount: Number(run.verificationCount || 0),
          completionReceiptCount: Number(run.completionReceiptCount || 0),
        };
        if (Number(run.readyStepCount || 0) > 0 && Object.values(provenance).every((count) => count === 0)) {
          findings.push({
            code: 'stale_active_run',
            severity: 'warning',
            runId: run.runId,
            projectId: run.projectId,
            workspaceId: run.workspaceId,
            state: run.state,
            updatedAt: run.updatedAt,
            staleBefore,
            provenance,
            recoveryChoices: ['resume', 'replan', 'abort-and-successor'],
          });
        }
      }
      if (projectId) {
        const completedRuns = db.prepare(`SELECT COUNT(*) as count FROM runs WHERE project_id=? AND status='completed'`).get(projectId);
        const mutationRuns = db.prepare(`SELECT COUNT(*) as count FROM runs WHERE project_id=? AND status='completed' AND mutation_revision>0`).get(projectId);
        const candidateCount = db.prepare(`SELECT COUNT(*) as count FROM knowledge_candidates WHERE project_id=?`).get(projectId);
        const committedCount = db.prepare(`SELECT COUNT(*) as count FROM knowledge_records WHERE project_id=? AND status='committed'`).get(projectId);
        const doctorFinding = emptyKnowledgeDoctorFinding({
          completedRuns: Number(completedRuns?.count || 0),
          mutationRuns: Number(mutationRuns?.count || 0),
          knowledgeRevision: this.getProjectKnowledgeRevision(projectId),
          candidateCount: Number(candidateCount?.count || 0),
          committedCount: Number(committedCount?.count || 0),
        });
        if (doctorFinding) findings.push({ projectId, ...doctorFinding });
      }
      return {
        schemaVersion: 1,
        status: findings.some((finding) => finding.severity === 'error') ? 'degraded' : (
          findings.length > 0 ? 'warning' : 'ready'
        ),
        observedAt,
        projectId,
        findings,
        counts: findings.reduce((counts, finding) => ({
          ...counts,
          [finding.code]: (counts[finding.code] || 0) + 1,
        }), {}),
      };
    },

    // Lifecycle cleanup is Kernel-owned: terminal owner bindings are made
    // inactive and stale mutation locks are released in one transaction. A
    // completed binding for the current host is deliberately retained until a
    // successor handoff can atomically replace it; every other terminal owner
    // is safe to close here. This keeps cleanup project/session scoped without
    // selecting or terminating a host process.
    reconcileTerminalLifecycle({ projectId = null, runId = null, preserveSessionId = null, observedAt = now() } = {}) {
      return db.transaction(() => reconcileTerminalLifecycleInTransaction({
        projectId,
        runId,
        preserveSessionId,
        observedAt,
      }))();
    },

    deactivateSessionBinding({
      projectId,
      sessionId,
      bindingId,
      reason,
      successorRunId = null,
    } = {}) {
      if (!projectId || !sessionId || !bindingId || !reason) {
        throw Object.assign(new Error('host_binding_missing'), { code: 'host_binding_missing' });
      }
      const deactivate = db.transaction(() => {
        const row = db.prepare(`
          SELECT * FROM session_bindings
          WHERE binding_id=? AND project_id=? AND session_id=?
        `).get(bindingId, projectId, sessionId);
        if (!row) throw Object.assign(new Error('host_binding_missing'), { code: 'host_binding_missing' });
        if (row.status !== 'active') {
          throw Object.assign(new Error('binding_already_inactive'), {
            code: 'binding_already_inactive',
            errorCode: 'binding_already_inactive',
            nextAction: 'inspect-active-owner-binding',
          });
        }
        if (row.access_mode === 'owner') {
          const run = db.prepare('SELECT owner_binding_id FROM runs WHERE run_id=? AND project_id=?')
            .get(row.run_id, projectId);
          if (!run || run.owner_binding_id !== bindingId) {
            throw Object.assign(new Error('run_access_denied'), { code: 'run_access_denied' });
          }
        }
        const closedAt = now();
        const updated = db.prepare(`
          UPDATE session_bindings
          SET status='inactive', closed_at=?, close_reason=?, successor_run_id=?, updated_at=?
          WHERE binding_id=? AND project_id=? AND session_id=? AND status='active'
        `).run(closedAt, String(reason), successorRunId, closedAt, bindingId, projectId, sessionId);
        if (updated.changes !== 1) {
          throw Object.assign(new Error('binding_already_inactive'), { code: 'binding_already_inactive' });
        }
        return mapSessionBinding(db.prepare('SELECT * FROM session_bindings WHERE binding_id=?').get(bindingId));
      });
      return deactivate();
    },

    // Compatibility-only surface for legacy callers. Control-plane access uses
    // the project-scoped APIs above and never selects authority by session alone.
    getActiveSessionBinding({ sessionId, runId = null } = {}) {
      if (!sessionId) return null;
      const row = runId
        ? db.prepare(`SELECT * FROM session_bindings WHERE session_id=? AND run_id=? AND status='active' ORDER BY updated_at DESC LIMIT 1`).get(sessionId, runId)
        : db.prepare(`SELECT * FROM session_bindings WHERE session_id=? AND status='active' ORDER BY updated_at DESC LIMIT 1`).get(sessionId);
      return mapSessionBinding(row);
    },

    registerProjectIdentity(identity = {}) {
      const projectId = String(identity.projectId || '').trim();
      const canonicalRoot = canonicalIdentityRoot(identity.canonicalRoot || identity.projectRoot);
      const identitySource = String(identity.identitySource || 'workspace_root');
      const identityDigest = String(identity.identityDigest || '').trim();
      const derivedGitCommonDir = deriveGitCommonDir(canonicalRoot);
      const suppliedGitCommonDir = identity.gitCommonDir ? canonicalIdentityRoot(identity.gitCommonDir) : null;
      if (suppliedGitCommonDir && suppliedGitCommonDir !== derivedGitCommonDir) {
        throw Object.assign(new Error('project_identity_git_common_dir_unverified'), { code: 'project_identity_git_common_dir_unverified' });
      }
      if (!PROJECT_ID_PATTERN.test(projectId) || !canonicalRoot || !identityDigest) {
        throw Object.assign(new Error('project_identity_invalid'), { code: 'project_identity_invalid' });
      }

      const incomingAliases = [
        ...(Array.isArray(identity.aliases) ? identity.aliases : []),
        `workspace:${canonicalRoot}`,
      ].map((value) => projectIdentityAlias(value)).filter(Boolean);
      const incomingGitCommonDir = derivedGitCommonDir;

      const candidates = legacyIdentityCandidates(identity)
        .filter((candidate) => candidate.projectId && candidate.projectId !== projectId);
      let migration = null;
      const register = db.transaction(() => {
        let row = findProjectIdentityByRoot(canonicalRoot);
        if (!row) {
          const aliasMatches = incomingAliases
            .map(({ alias }) => db.prepare(`SELECT p.* FROM project_identity_aliases a JOIN project_identities p ON p.project_id=a.project_id WHERE a.alias=?`).get(alias))
            .filter(Boolean);
          const projectMatches = [...new Map(aliasMatches.map((match) => [match.project_id, match])).values()];
          const compatibleProjectMatches = projectMatches.filter((match) => {
            if (canonicalIdentityRoot(match.canonical_root) === canonicalRoot) return true;
            if (!incomingGitCommonDir) return false;
            return Boolean(db.prepare(`
              SELECT 1 FROM project_workspaces
              WHERE project_id=? AND git_common_dir=? LIMIT 1
            `).get(match.project_id, incomingGitCommonDir));
          });
          if (compatibleProjectMatches.length !== projectMatches.length) {
            throw Object.assign(new Error('project_identity_alias_ownership_unproven'), {
              code: 'project_identity_alias_ownership_unproven',
              nextAction: 'inspect-project-identity-candidates',
              aliases: incomingAliases.map(({ alias }) => alias),
              projectIds: projectMatches.map((match) => match.project_id),
              canonicalRoot,
              gitCommonDir: incomingGitCommonDir,
            });
          }
          if (compatibleProjectMatches.length > 1) {
            throw Object.assign(new Error('project_identity_alias_conflict'), {
              code: 'project_identity_alias_conflict',
              aliases: incomingAliases.map(({ alias }) => alias),
              projectIds: compatibleProjectMatches.map((match) => match.project_id),
            });
          }
          row = compatibleProjectMatches[0] || null;
        }

        // An explicit local identity or linked worktree sharing git_common_dir
        // is a logical project namespace that may be checked out in more than
        // one worktree. Reuse that immutable project row instead of attempting
        // a second row with the same project_id; project_workspaces remains
        // the per-root registry.
        if (!row) {
          const projectIdRow = db.prepare(`SELECT * FROM project_identities WHERE project_id=?`).get(projectId) || null;
          if (projectIdRow) {
            const sameRoot = canonicalIdentityRoot(projectIdRow.canonical_root) === canonicalRoot;
            const commonDirProof = incomingGitCommonDir && Boolean(db.prepare(`
              SELECT 1 FROM project_workspaces
              WHERE project_id=? AND git_common_dir=? LIMIT 1
            `).get(projectIdRow.project_id, incomingGitCommonDir));
            if (!sameRoot && !commonDirProof && identitySource !== 'workspace_root') {
              throw Object.assign(new Error('project_identity_alias_ownership_unproven'), {
                code: 'project_identity_alias_ownership_unproven',
                nextAction: 'inspect-project-identity-candidates',
                projectId,
                canonicalRoot,
                gitCommonDir: incomingGitCommonDir,
              });
            }
            if (sameRoot || commonDirProof) {
              row = projectIdRow;
            }
          }
        }

        let canonicalProjectId = row?.project_id || projectId;
        if (!row && canonicalProjectId !== projectId) {
          throw Object.assign(new Error('project_identity_conflict'), { code: 'project_identity_conflict' });
        }

        // A state created before immutable identity persistence may already use
        // a derived id. Only a candidate with proven ownership may be moved;
        // package and basename ids are common across repositories and therefore
        // cannot become global aliases merely because rows happen to exist.
        if (!row && canonicalProjectId === projectId) {
          const provenLegacyIds = [];
          for (const candidate of candidates) {
            const legacyId = candidate.projectId;
            const legacyIdentity = db.prepare('SELECT * FROM project_identities WHERE project_id=?').get(legacyId);
            const existingAlias = db.prepare('SELECT project_id FROM project_identity_aliases WHERE alias=?').get(`project-id:${legacyId}`);
            if (existingAlias && existingAlias.project_id !== projectId) {
              throw Object.assign(new Error('project_identity_alias_conflict'), {
                code: 'project_identity_alias_conflict',
                alias: `project-id:${legacyId}`,
                projectIds: [existingAlias.project_id, projectId],
              });
            }

            const hasData = hasProjectData(legacyId);
            if (!hasData) continue;

            const sameRootIdentity = legacyIdentity && canonicalIdentityRoot(legacyIdentity.canonical_root) === canonicalRoot;
            const sameRootWorkspace = Boolean(db.prepare(`
              SELECT 1 FROM project_workspaces WHERE project_id=? AND canonical_root=? LIMIT 1
            `).get(legacyId, canonicalRoot));
            const sameRootRun = Boolean(db.prepare(`
              SELECT 1
              FROM runs r JOIN project_workspaces w ON w.workspace_id=r.workspace_id
              WHERE r.project_id=? AND w.canonical_root=? LIMIT 1
            `).get(legacyId, canonicalRoot));
            // A remote/package/basename string is only a discovery hint. It is
            // not ownership evidence: two unrelated repositories can share
            // the same package or basename, and an origin URL can be copied
            // into a second checkout. Require a persisted identity/workspace or
            // a run tied to this root; caller-provided candidate paths are not
            // ownership evidence because they can be forged at registration.
            const proven = sameRootIdentity || sameRootWorkspace || sameRootRun;
            if (!proven) {
              throw Object.assign(new Error('project_identity_legacy_ownership_unproven'), {
                code: 'project_identity_legacy_ownership_unproven',
          nextAction: 'kernel identity approve --legacy-project-id <id> --approval-ref <operator-ref> --approved-by <operator> then kernel identity repair --legacy-project-id <id> --approval-ref <operator-ref>',
                remediation: 'kernel identity bootstrap --policy isolate preserves legacy state and starts a new namespace',
                legacyProjectId: legacyId,
                source: candidate.source,
                canonicalRoot,
              });
            }
            if (legacyIdentity && !sameRootIdentity) {
              throw Object.assign(new Error('project_identity_migration_conflict'), {
                code: 'project_identity_migration_conflict',
                legacyProjectId: legacyId,
                legacyCanonicalRoot: legacyIdentity.canonical_root,
                canonicalRoot,
              });
            }
            provenLegacyIds.push(legacyId);
          }

          migration = prepareProjectKnowledgeNamespaceMigration({
            runtimeHome,
            legacyProjectIds: provenLegacyIds,
            projectId,
            canonicalRoot,
            identityDigest,
          });

          for (const legacyId of provenLegacyIds) {
            const legacyIdentity = db.prepare('SELECT aliases_json FROM project_identities WHERE project_id=?').get(legacyId);
            for (const alias of safeJsonParse(legacyIdentity?.aliases_json, [])) {
              incomingAliases.push(projectIdentityAlias(alias));
            }
            migrateProjectId(legacyId, projectId);
            // project_identities is the one project_id table intentionally not
            // handled by the generic UPDATE because its primary key and unique
            // root constraints need the identity row to be rebuilt below.
            db.prepare('DELETE FROM project_identities WHERE project_id=?').run(legacyId);
            incomingAliases.push(projectIdentityAlias(`project-id:${legacyId}`));
          }
        }

        const previousAliases = row ? safeJsonParse(row.aliases_json, []) : [];
        const aliases = [...new Set([
          ...previousAliases,
          ...incomingAliases.map(({ alias }) => alias).filter((alias) => !alias.startsWith('workspace:') && !alias.startsWith('project-id:')),
        ])];
        const timestamp = now();
        if (!row) {
          db.prepare(`INSERT INTO project_identities(project_id, canonical_root, identity_source, identity_digest, aliases_json, created_at, updated_at)
            VALUES(?, ?, ?, ?, ?, ?, ?)`)
            .run(canonicalProjectId, canonicalRoot, identitySource, identityDigest, persistentJson(aliases), timestamp, timestamp);
          row = db.prepare(`SELECT * FROM project_identities WHERE project_id=?`).get(canonicalProjectId);
        } else {
          // project_id, canonical_root, and identity_digest are immutable. Only
          // newly observed aliases and last_seen metadata may advance.
          db.prepare(`UPDATE project_identities SET aliases_json=?, updated_at=? WHERE project_id=?`)
            .run(persistentJson(aliases), timestamp, row.project_id);
          row = db.prepare(`SELECT * FROM project_identities WHERE project_id=?`).get(row.project_id);
          canonicalProjectId = row.project_id;
        }

        for (const { alias, aliasType } of incomingAliases) {
          const existing = db.prepare(`SELECT project_id FROM project_identity_aliases WHERE alias=?`).get(alias);
          if (existing && existing.project_id !== canonicalProjectId) {
            throw Object.assign(new Error('project_identity_alias_conflict'), {
              code: 'project_identity_alias_conflict',
              alias,
              projectIds: [existing.project_id, canonicalProjectId],
            });
          }
          db.prepare(`INSERT INTO project_identity_aliases(alias, project_id, alias_type, created_at, updated_at)
            VALUES(?, ?, ?, ?, ?)
            ON CONFLICT(alias) DO UPDATE SET updated_at=excluded.updated_at`)
            .run(alias, canonicalProjectId, aliasType, timestamp, timestamp);
        }
        const persistedAliases = db.prepare(`SELECT alias FROM project_identity_aliases WHERE project_id=? AND alias_type='remote' ORDER BY alias`).all(canonicalProjectId).map(({ alias }) => alias);
        return mapProjectIdentity(row, persistedAliases);
      });
      try {
        const result = register();
        if (migration) {
          try { migration.finalize(); } catch { /* journal cleanup is recoverable; committed state remains authoritative */ }
        }
        return result;
      } catch (error) {
        if (migration) {
          try { migration.rollback(); } catch (rollbackError) {
            throw Object.assign(new Error(`${error.message}; identity filesystem rollback failed: ${rollbackError.message}`), {
              code: 'project_identity_migration_rollback_failed',
              cause: error,
              rollbackError,
            });
          }
        }
        throw error;
      }
    },

    getProjectIdentity({ projectId = null, canonicalRoot = null, alias = null } = {}) {
      let row = null;
      if (projectId) row = db.prepare(`SELECT * FROM project_identities WHERE project_id=?`).get(String(projectId));
      else if (canonicalRoot) row = findProjectIdentityByRoot(canonicalIdentityRoot(canonicalRoot));
      else if (alias) row = db.prepare(`SELECT p.* FROM project_identity_aliases a JOIN project_identities p ON p.project_id=a.project_id WHERE a.alias=?`).get(String(alias));
      if (!row) return null;
      const aliases = db.prepare(`SELECT alias FROM project_identity_aliases WHERE project_id=? AND alias_type='remote' ORDER BY alias`).all(row.project_id).map(({ alias: value }) => value);
      return mapProjectIdentity(row, aliases);
    },

    inspectProjectIdentity({ projectId = null, canonicalRoot = null, gitCommonDir = null, legacyCandidates = [] } = {}) {
      const rootIdentity = canonicalRoot
        ? this.getProjectIdentity({ canonicalRoot })
        : null;
      const projectIdentity = projectId
        ? this.getProjectIdentity({ projectId })
        : null;
      // A linked worktree has a distinct canonical root, but it is still the
      // same logical project when its project id and Git common directory both
      // match the persisted project identity. Do not fall back on project id
      // alone: a copied origin or caller-supplied identity is not ownership
      // evidence across unrelated repositories.
      const linkedIdentity = !rootIdentity && projectIdentity && canonicalRoot && gitCommonDir
        && deriveGitCommonDir(projectIdentity.canonicalRoot) === canonicalIdentityRoot(gitCommonDir)
        ? projectIdentity
        : null;
      const currentIdentity = rootIdentity || linkedIdentity || (
        !canonicalRoot ? projectIdentity : null
      );
      const candidates = [...new Map((Array.isArray(legacyCandidates) ? legacyCandidates : [])
        .filter((candidate) => candidate?.projectId)
        .map((candidate) => [String(candidate.projectId), candidate])).values()];
      return {
        currentIdentity,
        legacyCandidates: candidates.map((candidate) => {
          const candidateId = String(candidate.projectId);
          const identity = this.getProjectIdentity({ projectId: candidateId });
          const workspaces = db.prepare(`
            SELECT workspace_id as workspaceId, canonical_root as canonicalRoot, git_common_dir as gitCommonDir
            FROM project_workspaces WHERE project_id=? ORDER BY canonical_root
          `).all(candidateId);
          const data = projectDataSummary(candidateId);
          const sameRootEvidence = Boolean(
            (identity && canonicalIdentityRoot(identity.canonicalRoot) === canonicalIdentityRoot(canonicalRoot))
              || workspaces.some((workspace) => canonicalIdentityRoot(workspace.canonicalRoot) === canonicalIdentityRoot(canonicalRoot)),
          );
          return {
            projectId: candidateId,
            source: candidate.source || null,
            aliasType: candidate.aliasType || null,
            hasData: data.hasData,
            dataTables: data.tables,
            knowledgeNamespace: data.knowledgeNamespace,
            hasPersistedIdentity: Boolean(identity),
            identity,
            workspaceRoots: workspaces.map((workspace) => workspace.canonicalRoot),
            workspaces,
            sameRootEvidence,
          };
        }),
      };
    },

    registerProjectWorkspace(workspace) {
      const canonicalRoot = canonicalIdentityRoot(workspace.canonicalRoot || workspace.identity?.canonicalRoot);
      const derivedGitCommonDir = deriveGitCommonDir(canonicalRoot);
      const suppliedGitCommonDir = workspace.gitCommonDir ? canonicalIdentityRoot(workspace.gitCommonDir) : null;
      if (suppliedGitCommonDir && suppliedGitCommonDir !== derivedGitCommonDir) {
        throw Object.assign(new Error('project_workspace_git_common_dir_unverified'), { code: 'project_workspace_git_common_dir_unverified' });
      }
      const gitCommonDir = derivedGitCommonDir;
      const gitWorktreeDir = workspace.gitWorktreeDir ? canonicalIdentityRoot(workspace.gitWorktreeDir) : null;
      const identity = {
        ...(workspace.identity || {}),
        projectId: workspace.identity?.projectId || workspace.projectId,
        canonicalRoot,
      };
      const derivedWorktreeId = deriveKernelWorktreeId({
        projectId: identity.projectId,
        canonicalWorktreeRoot: canonicalRoot,
        canonicalGitDir: gitWorktreeDir,
      });
      if (workspace.worktreeId && String(workspace.worktreeId) !== derivedWorktreeId) {
        throw Object.assign(new Error('project_worktree_identity_mismatch'), { code: 'project_worktree_identity_mismatch' });
      }
      identity.worktreeId = derivedWorktreeId;
      const equivalentRows = db.prepare(`SELECT workspace_id as workspaceId, canonical_root as canonicalRoot, worktree_id as worktreeId FROM project_workspaces WHERE project_id=?`)
        .all(identity.projectId)
        .filter((candidate) => canonicalIdentityRoot(candidate.canonicalRoot) === canonicalRoot);
      const referencedWorkspaceIds = new Set([
        ...db.prepare(`SELECT workspace_id as workspaceId FROM runs WHERE project_id=? AND workspace_id IS NOT NULL`).all(identity.projectId).map(({ workspaceId }) => workspaceId),
        ...db.prepare(`SELECT workspace_id as workspaceId FROM session_bindings WHERE project_id=? AND workspace_id IS NOT NULL`).all(identity.projectId).map(({ workspaceId }) => workspaceId),
        ...db.prepare(`SELECT workspace_id as workspaceId FROM workspace_mutation_locks_v2 WHERE project_id=?`).all(identity.projectId).map(({ workspaceId }) => workspaceId),
      ]);
      const existing = equivalentRows.find((candidate) => referencedWorkspaceIds.has(candidate.workspaceId))
        || equivalentRows.find((candidate) => candidate.canonicalRoot === canonicalRoot)
        || equivalentRows[0]
        || null;
      if (existing) {
        for (const duplicate of equivalentRows.filter((candidate) => candidate.workspaceId !== existing.workspaceId)) {
          for (const table of workspaceScopedTables().filter((table) => table !== 'project_workspaces')) {
            const quotedTable = quoteIdentifier(table);
            for (const column of tableColumns(table).map((entry) => entry.name).filter((name) => workspaceReferenceColumns.includes(name))) {
              db.prepare(`UPDATE ${quotedTable} SET ${quoteIdentifier(column)}=? WHERE ${quoteIdentifier(column)}=?`)
                .run(existing.workspaceId, duplicate.workspaceId);
            }
          }
          db.prepare(`UPDATE session_bindings SET workspace_root=? WHERE workspace_id=?`).run(canonicalRoot, duplicate.workspaceId);
          db.prepare(`DELETE FROM project_workspaces WHERE workspace_id=?`).run(duplicate.workspaceId);
        }
        db.prepare(`UPDATE project_workspaces SET canonical_root=?, git_common_dir=?, git_worktree_dir=?, worktree_id=?, last_seen_at=?, identity_json=? WHERE workspace_id=?`)
          .run(canonicalRoot, gitCommonDir, gitWorktreeDir, derivedWorktreeId, now(), persistentJson(identity), existing.workspaceId);
        db.prepare(`UPDATE runs SET worktree_id=? WHERE project_id=? AND workspace_id=? AND worktree_id IS NULL`)
          .run(derivedWorktreeId, identity.projectId, existing.workspaceId);
        return this.getProjectWorkspace(existing.workspaceId);
      }
      db.prepare(`INSERT INTO project_workspaces(workspace_id, project_id, canonical_root, git_common_dir, git_worktree_dir, worktree_id, identity_json, created_at, last_seen_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(workspace_id) DO UPDATE SET worktree_id=excluded.worktree_id, last_seen_at=excluded.last_seen_at, identity_json=excluded.identity_json`)
        .run(workspace.workspaceId, identity.projectId, canonicalRoot, gitCommonDir, gitWorktreeDir, derivedWorktreeId, persistentJson(identity), now(), now());
      return this.getProjectWorkspace(workspace.workspaceId);
    },

    getProjectWorkspace(workspaceId) {
      const row = db.prepare(`SELECT workspace_id as workspaceId, project_id as projectId, canonical_root as canonicalRoot, git_common_dir as gitCommonDir, git_worktree_dir as gitWorktreeDir, worktree_id as worktreeId, identity_json as identityJson, created_at as createdAt, last_seen_at as lastSeenAt FROM project_workspaces WHERE workspace_id=?`).get(workspaceId);
      return row ? { ...row, identity: safeJsonParse(row.identityJson, null) } : null;
    },

    listActiveRuns({ projectId = null, worktreeId = null, workspaceId = null } = {}) {
      const values = [];
      const clauses = ["status='active'"];
      if (projectId) { clauses.push('project_id=?'); values.push(projectId); }
      if (worktreeId) { clauses.push('worktree_id=?'); values.push(worktreeId); }
      else if (workspaceId) { clauses.push('workspace_id=?'); values.push(workspaceId); }
      const rows = db.prepare(`SELECT run_id as runId FROM runs WHERE ${clauses.join(' AND ')} ORDER BY updated_at DESC`).all(...values);
      return rows.map((row) => this.getRun(row.runId)).filter(Boolean);
    },

    acquireWorktreeMutationLease({ worktreeId, projectId, runId } = {}) {
      if (!worktreeId || !projectId || !runId) {
        throw Object.assign(new Error('worktree_mutation_lease_identity_missing'), {
          code: 'worktree_mutation_lease_identity_missing',
          errorCode: 'worktree_mutation_lease_identity_missing',
          nextAction: 'resolve-run-worktree-binding',
        });
      }
      return db.transaction(() => {
        const run = db.prepare(`
          SELECT run_id AS runId, project_id AS projectId,
                 worktree_id AS worktreeId, status
          FROM runs WHERE run_id=?
        `).get(runId);
        if (!run || run.projectId !== projectId || run.worktreeId !== worktreeId) {
          throw Object.assign(new Error('run_worktree_mismatch'), {
            code: 'run_worktree_mismatch',
            errorCode: 'run_worktree_mismatch',
            nextAction: 'return-to-bound-worktree',
          });
        }
        if (run.status !== 'active') {
          throw Object.assign(new Error('terminal_run_cannot_acquire_worktree_lease'), {
            code: 'terminal_run_cannot_acquire_worktree_lease',
            errorCode: 'terminal_run_cannot_acquire_worktree_lease',
            nextAction: 'start-a-successor-run',
          });
        }
        return claimWorktreeLeaseInTransaction({ worktreeId, projectId, runId });
      })();
    },

    getWorktreeMutationLease(worktreeId) {
      if (!worktreeId) return null;
      return db.prepare(`
        SELECT worktree_id AS worktreeId, project_id AS projectId,
               holder_run_id AS holderRunId, acquired_at AS acquiredAt
        FROM worktree_mutation_leases WHERE worktree_id=?
      `).get(worktreeId) || null;
    },

    releaseWorktreeMutationLease({ worktreeId, runId } = {}) {
      if (!worktreeId || !runId) {
        throw Object.assign(new Error('worktree_mutation_lease_identity_missing'), {
          code: 'worktree_mutation_lease_identity_missing',
          errorCode: 'worktree_mutation_lease_identity_missing',
        });
      }
      const release = db.transaction(() => {
        const current = db.prepare(`
          SELECT worktree_id AS worktreeId, project_id AS projectId,
                 holder_run_id AS holderRunId, acquired_at AS acquiredAt
          FROM worktree_mutation_leases WHERE worktree_id=?
        `).get(worktreeId);
        if (!current) return { released: false, lease: null };
        if (current.holderRunId !== runId) {
          throw Object.assign(new Error('worktree_mutation_lease_conflict'), {
            code: 'worktree_mutation_lease_conflict',
            errorCode: 'worktree_mutation_lease_conflict',
            nextAction: 'resume-the-lease-holder-run',
          });
        }
        const holder = db.prepare(`SELECT status FROM runs WHERE run_id=?`).get(runId);
        if (!holder || !worktreeLeaseTerminalStatuses.has(holder.status)) {
          throw Object.assign(new Error('worktree_mutation_lease_release_requires_terminal_run'), {
            code: 'worktree_mutation_lease_release_requires_terminal_run',
            errorCode: 'worktree_mutation_lease_release_requires_terminal_run',
            nextAction: 'complete-the-run',
          });
        }
        const deleted = db.prepare(`DELETE FROM worktree_mutation_leases WHERE worktree_id=? AND holder_run_id=?`)
          .run(worktreeId, runId);
        return { released: deleted.changes === 1, lease: current };
      });
      return release();
    },

    abandonRun(runId, { reason = 'user_requested' } = {}) {
      if (!runId) throw new Error('abandonRun requires runId');
      return db.transaction(() => {
        const run = db.prepare('SELECT run_id AS runId, project_id AS projectId, worktree_id AS worktreeId, workspace_id AS workspaceId, status FROM runs WHERE run_id=?').get(runId);
        if (!run) throw Object.assign(new Error('run_not_found'), { code: 'run_not_found' });
        if (['completed', 'abandoned'].includes(run.status)) {
          return { status: run.status, runId, alreadyTerminal: true };
        }
        const observed = now();
        db.prepare(`UPDATE runs SET status='abandoned', updated_at=? WHERE run_id=?`).run(observed, runId);
        // Deactivate active owner bindings
        db.prepare(`
          UPDATE session_bindings
          SET status='inactive', closed_at=?, close_reason=?
          WHERE run_id=? AND status='active'
        `).run(observed, `abandoned:${reason}`, runId);
        // Release worktree mutation lease if held
        if (run.worktreeId) {
          db.prepare('DELETE FROM worktree_mutation_leases WHERE worktree_id=? AND holder_run_id=?').run(run.worktreeId, runId);
        }
        // Release workspace mutation lock if held
        if (run.workspaceId) {
          db.prepare('DELETE FROM workspace_mutation_locks_v2 WHERE workspace_id=? AND holder_run_id=?').run(run.workspaceId, runId);
        }
        return { status: 'abandoned', runId, alreadyTerminal: false };
      })();
    },

    listRuns({ projectId = null, worktreeId = null, workspaceId = null, statuses = null } = {}) {
      const values = [];
      const clauses = [];
      if (projectId) { clauses.push('project_id=?'); values.push(projectId); }
      if (worktreeId) { clauses.push('worktree_id=?'); values.push(worktreeId); }
      else if (workspaceId) { clauses.push('workspace_id=?'); values.push(workspaceId); }
      if (Array.isArray(statuses) && statuses.length > 0) {
        clauses.push(`status IN (${statuses.map(() => '?').join(',')})`);
        values.push(...statuses.map(String));
      }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      return db.prepare(`SELECT run_id as runId FROM runs ${where} ORDER BY updated_at DESC`).all(...values)
        .map((row) => this.getRun(row.runId)).filter(Boolean);
    },

    // Read the existing successor edge stored on session_bindings. This is a
    // derived view only: no Goal/lineage table is introduced. The walk is
    // deliberately fail-closed when two predecessor edges or a cross-scope
    // edge are present.
    resolveSuccessorLineage(runId) {
      if (!runId) throw new Error('resolveSuccessorLineage requires runId');
      const seen = new Set();
      const runs = [];
      const edges = [];
      let cursor = String(runId);
      let terminalSuccessor = db.prepare(`
        SELECT DISTINCT successor_run_id as successorRunId
        FROM session_bindings
        WHERE run_id=? AND successor_run_id IS NOT NULL
      `).all(cursor).map((row) => row.successorRunId).filter(Boolean);
      if (terminalSuccessor.length > 1) {
        throw Object.assign(new Error('SUCCESSOR_LINEAGE_AMBIGUOUS'), {
          code: 'SUCCESSOR_LINEAGE_AMBIGUOUS',
          errorCode: 'SUCCESSOR_LINEAGE_AMBIGUOUS',
          details: { runId: cursor, successorRunIds: terminalSuccessor },
        });
      }
      const isTerminal = terminalSuccessor.length === 0;

      while (cursor) {
        if (seen.has(cursor)) {
          throw Object.assign(new Error('SUCCESSOR_LINEAGE_CYCLE'), {
            code: 'SUCCESSOR_LINEAGE_CYCLE',
            errorCode: 'SUCCESSOR_LINEAGE_CYCLE',
            details: { runId: cursor },
          });
        }
        seen.add(cursor);
        const current = this.getRun(cursor);
        if (!current) {
          throw Object.assign(new Error('SUCCESSOR_LINEAGE_RUN_MISSING'), {
            code: 'SUCCESSOR_LINEAGE_RUN_MISSING',
            errorCode: 'SUCCESSOR_LINEAGE_RUN_MISSING',
            details: { runId: cursor },
          });
        }
        runs.unshift(current);
        const predecessors = db.prepare(`
          SELECT * FROM session_bindings
          WHERE successor_run_id=?
          ORDER BY updated_at DESC
        `).all(cursor);
        if (predecessors.length === 0) break;
        const ownerPredecessors = predecessors.filter((row) => row.access_mode === 'owner');
        if (ownerPredecessors.length !== 1) {
          throw Object.assign(new Error('SUCCESSOR_LINEAGE_AMBIGUOUS'), {
            code: 'SUCCESSOR_LINEAGE_AMBIGUOUS',
            errorCode: 'SUCCESSOR_LINEAGE_AMBIGUOUS',
            details: { runId: cursor, predecessorBindingIds: ownerPredecessors.map((row) => row.binding_id) },
          });
        }
        const edge = ownerPredecessors[0];
        const predecessor = this.getRun(edge.run_id);
        if (!predecessor
          || predecessor.projectId !== current.projectId
          || predecessor.workspaceId !== current.workspaceId
          || !predecessor.worktreeId
          || !current.worktreeId
          || predecessor.worktreeId !== current.worktreeId) {
          throw Object.assign(new Error('SUCCESSOR_LINEAGE_SCOPE_MISMATCH'), {
            code: 'SUCCESSOR_LINEAGE_SCOPE_MISMATCH',
            errorCode: 'SUCCESSOR_LINEAGE_SCOPE_MISMATCH',
            details: { predecessorRunId: edge.run_id, successorRunId: cursor },
          });
        }
        const predecessorFinalWorkspaceIdentity = predecessor.currentWorkspaceIdentity || null;
        const successorStartWorkspaceIdentity = current.runStartWorkspaceIdentity || null;
        if (!predecessorFinalWorkspaceIdentity
          || !successorStartWorkspaceIdentity
          || predecessorFinalWorkspaceIdentity !== successorStartWorkspaceIdentity) {
          throw Object.assign(new Error('SUCCESSOR_WORKSPACE_CONTINUITY_MISMATCH'), {
            code: 'SUCCESSOR_WORKSPACE_CONTINUITY_MISMATCH',
            errorCode: 'SUCCESSOR_WORKSPACE_CONTINUITY_MISMATCH',
            details: {
              predecessorRunId: edge.run_id,
              successorRunId: cursor,
              predecessorFinalWorkspaceIdentity,
              successorStartWorkspaceIdentity,
            },
          });
        }
        edges.unshift({
          predecessorRunId: edge.run_id,
          successorRunId: cursor,
          binding: mapSessionBinding(edge),
          predecessorFinalWorkspaceIdentity,
          successorStartWorkspaceIdentity,
        });
        cursor = edge.run_id;
        terminalSuccessor = [];
      }
      return {
        runIds: runs.map((run) => run.runId),
        runs,
        edges,
        terminalRunId: String(runId),
        isTerminal,
      };
    },

    getLatestRunForWorktree({ projectId, worktreeId, workspaceId = null } = {}) {
      if (!projectId || (!worktreeId && !workspaceId)) return null;
      return this.listRuns({ projectId, worktreeId, workspaceId })[0] || null;
    },

    acquireWorkspaceMutationLock({ projectId, runId, sessionToken, ttlMs = 60000 } = {}) {
      if (!projectId || !runId || !sessionToken) throw new Error('workspace mutation lock requires projectId, runId, and sessionToken');
      const acquiredAt = now();
      const expiresAt = new Date(Date.now() + ttlMs).toISOString();
      db.exec('BEGIN IMMEDIATE');
      try {
        const current = db.prepare(`SELECT project_id as projectId, holder_run_id as holderRunId, session_token as sessionToken, fencing_token as fencingToken, acquired_at as acquiredAt, expires_at as expiresAt FROM workspace_mutation_locks WHERE project_id=?`).get(projectId);
        if (current && Date.parse(current.expiresAt) > Date.now() && (current.holderRunId !== runId || current.sessionToken !== sessionToken)) {
          db.exec('ROLLBACK');
          return { acquired: false, lock: current };
        }
        const fencingToken = Number(current?.fencingToken || 0) + 1;
        db.prepare(`
          INSERT INTO workspace_mutation_locks(project_id, holder_run_id, session_token, fencing_token, acquired_at, expires_at)
          VALUES(?, ?, ?, ?, ?, ?)
          ON CONFLICT(project_id) DO UPDATE SET holder_run_id=excluded.holder_run_id, session_token=excluded.session_token, fencing_token=excluded.fencing_token, acquired_at=excluded.acquired_at, expires_at=excluded.expires_at
        `).run(projectId, runId, sessionToken, fencingToken, acquiredAt, expiresAt);
        db.exec('COMMIT');
        return { acquired: true, lock: { projectId, holderRunId: runId, sessionToken, fencingToken, acquiredAt, expiresAt } };
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch {}
        throw error;
      }
    },

    acquireWorkspaceMutationLockV2({ workspaceId, projectId, runId, sessionToken, ttlMs = 60000 } = {}) {
      if (!workspaceId || !projectId || !runId || !sessionToken) throw new Error('workspace mutation lock requires workspaceId, projectId, runId, and sessionToken');
      const workspace = this.getProjectWorkspace(workspaceId);
      const run = this.getRunMetadata(runId);
      if (!workspace || workspace.projectId !== projectId || !run || run.projectId !== projectId) {
        throw Object.assign(new Error('run_project_mismatch'), {
          code: 'run_project_mismatch',
          errorCode: 'run_project_mismatch',
          nextAction: 'register-a-project-worktree',
        });
      }
      const isBoundWorkerWorkspace = run.workspaceId !== workspaceId
        && this.getRunSteps(runId).some((step) => step.executionWorkspaceId === workspaceId);
      if (run.workspaceId && run.workspaceId !== workspaceId && !isBoundWorkerWorkspace) {
        throw Object.assign(new Error('run_workspace_mismatch'), {
          code: 'run_workspace_mismatch',
          errorCode: 'run_workspace_mismatch',
          nextAction: 'return-to-bound-workspace',
        });
      }
      const acquiredAt = now();
      const expiresAt = new Date(Date.now() + ttlMs).toISOString();
      db.exec('BEGIN IMMEDIATE');
      try {
        const current = db.prepare(`SELECT workspace_id as workspaceId, project_id as projectId, holder_run_id as holderRunId, session_token as sessionToken, fencing_token as fencingToken, acquired_at as acquiredAt, expires_at as expiresAt FROM workspace_mutation_locks_v2 WHERE workspace_id=?`).get(workspaceId);
        if (current && Date.parse(current.expiresAt) > Date.now() && (current.holderRunId !== runId || current.sessionToken !== sessionToken)) {
          db.exec('ROLLBACK');
          return { acquired: false, lock: current };
        }
        const fencingToken = Number(current?.fencingToken || 0) + 1;
        db.prepare(`INSERT INTO workspace_mutation_locks_v2(workspace_id, project_id, holder_run_id, session_token, fencing_token, acquired_at, expires_at)
          VALUES(?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(workspace_id) DO UPDATE SET holder_run_id=excluded.holder_run_id, session_token=excluded.session_token, fencing_token=excluded.fencing_token, acquired_at=excluded.acquired_at, expires_at=excluded.expires_at`)
          .run(workspaceId, projectId, runId, sessionToken, fencingToken, acquiredAt, expiresAt);
        db.exec('COMMIT');
        return { acquired: true, lock: { workspaceId, projectId, holderRunId: runId, sessionToken, fencingToken, acquiredAt, expiresAt } };
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch {}
        throw error;
      }
    },

    getWorkspaceMutationLockV2(workspaceId) {
      const row = db.prepare(`SELECT workspace_id as workspaceId, project_id as projectId, holder_run_id as holderRunId, session_token as sessionToken, fencing_token as fencingToken, acquired_at as acquiredAt, expires_at as expiresAt FROM workspace_mutation_locks_v2 WHERE workspace_id=?`).get(workspaceId);
      return !row || Date.parse(row.expiresAt) <= Date.now() ? null : row;
    },

    renewWorkspaceMutationLockV2({ workspaceId, projectId, runId, sessionToken, fencingToken, ttlMs = 120000 } = {}) {
      if (!workspaceId || !projectId || !runId || !sessionToken || fencingToken === null || fencingToken === undefined) {
        throw new Error('renewWorkspaceMutationLockV2 requires workspaceId, projectId, runId, sessionToken, and fencingToken');
      }
      const expiresAt = new Date(Date.now() + ttlMs).toISOString();
      db.exec('BEGIN IMMEDIATE');
      try {
        const current = db.prepare(`SELECT workspace_id as workspaceId, project_id as projectId, holder_run_id as holderRunId, session_token as sessionToken, fencing_token as fencingToken, acquired_at as acquiredAt, expires_at as expiresAt FROM workspace_mutation_locks_v2 WHERE workspace_id=?`).get(workspaceId);
        if (!current
          || current.projectId !== projectId
          || current.holderRunId !== runId
          || current.sessionToken !== sessionToken
          || Number(current.fencingToken) !== Number(fencingToken)
          || Date.parse(current.expiresAt) <= Date.now()) {
          db.exec('ROLLBACK');
          return { renewed: false, lock: current || null };
        }
        const updated = db.prepare(`UPDATE workspace_mutation_locks_v2 SET expires_at=? WHERE workspace_id=? AND project_id=? AND holder_run_id=? AND session_token=? AND fencing_token=? AND expires_at>?`)
          .run(expiresAt, workspaceId, projectId, runId, sessionToken, Number(fencingToken), new Date().toISOString());
        if (Number(updated.changes || 0) !== 1) {
          db.exec('ROLLBACK');
          return { renewed: false, lock: current };
        }
        db.exec('COMMIT');
        return { renewed: true, lock: { ...current, expiresAt } };
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch {}
        throw error;
      }
    },

    releaseWorkspaceMutationLockV2({
      workspaceId,
      runId,
      sessionToken,
      fencingToken,
    } = {}) {
      const fail = () => {
        throw Object.assign(new Error('workspace_lock_handoff_failed'), {
          code: 'workspace_lock_handoff_failed',
          errorCode: 'workspace_lock_handoff_failed',
          nextAction: 'reacquire-workspace-lock',
        });
      };
      if (!workspaceId || !runId || !sessionToken || !Number.isInteger(Number(fencingToken))) {
        fail();
      }
      const release = db.transaction(() => {
        const current = db.prepare(`
          SELECT workspace_id as workspaceId, holder_run_id as holderRunId,
                 session_token as sessionToken, fencing_token as fencingToken
          FROM workspace_mutation_locks_v2
          WHERE workspace_id=?
        `).get(workspaceId);
        if (
          !current
          || current.holderRunId !== runId
          || current.sessionToken !== sessionToken
          || Number(current.fencingToken) !== Number(fencingToken)
        ) {
          fail();
        }
        const released = db.prepare(`
          DELETE FROM workspace_mutation_locks_v2
          WHERE workspace_id=? AND holder_run_id=? AND session_token=?
            AND fencing_token=?
        `).run(workspaceId, runId, sessionToken, Number(fencingToken));
        if (released.changes !== 1) fail();
        return { released: true, lock: current };
      });
      return release();
    },

    getWorkspaceMutationLock(projectId) {
      const row = db.prepare(`SELECT project_id as projectId, holder_run_id as holderRunId, session_token as sessionToken, fencing_token as fencingToken, acquired_at as acquiredAt, expires_at as expiresAt FROM workspace_mutation_locks WHERE project_id=?`).get(projectId);
      if (!row || Date.parse(row.expiresAt) <= Date.now()) return null;
      return row;
    },

    releaseWorkspaceMutationLock({ projectId, runId, sessionToken } = {}) {
      const result = db.prepare(`UPDATE workspace_mutation_locks SET expires_at=? WHERE project_id=? AND holder_run_id=? AND session_token=?`)
        .run('1970-01-01T00:00:00.000Z', projectId, runId, sessionToken);
      return Number(result.changes || 0) > 0;
    },

    renewWorkspaceMutationLock({ projectId, runId, sessionToken, fencingToken, ttlMs = 60000 } = {}) {
      if (!projectId || !runId || !sessionToken || fencingToken === null || fencingToken === undefined) {
        throw new Error('renewWorkspaceMutationLock requires projectId, runId, sessionToken, and fencingToken');
      }
      const expiresAt = new Date(Date.now() + ttlMs).toISOString();
      db.exec('BEGIN IMMEDIATE');
      try {
        const current = db.prepare(`SELECT project_id as projectId, holder_run_id as holderRunId, session_token as sessionToken, fencing_token as fencingToken, acquired_at as acquiredAt, expires_at as expiresAt FROM workspace_mutation_locks WHERE project_id=?`).get(projectId);
        if (!current || current.holderRunId !== runId || current.sessionToken !== sessionToken || current.fencingToken !== fencingToken) {
          db.exec('ROLLBACK');
          return { renewed: false, lock: current || null };
        }
        db.prepare(`UPDATE workspace_mutation_locks SET expires_at=? WHERE project_id=? AND holder_run_id=? AND session_token=? AND fencing_token=?`)
          .run(expiresAt, projectId, runId, sessionToken, fencingToken);
        db.exec('COMMIT');
        return { renewed: true, lock: { ...current, expiresAt } };
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch {}
        throw error;
      }
    },

    recordKnowledgeContextReceipt(runId, { stage, knowledgeRevision, digest, receiptJson }) {
      db.prepare(`
        INSERT INTO knowledge_context_receipts(run_id, stage, knowledge_revision, digest, receipt_json, created_at)
        VALUES(?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id, stage) DO UPDATE SET knowledge_revision=excluded.knowledge_revision, digest=excluded.digest, receipt_json=excluded.receipt_json, created_at=excluded.created_at
      `).run(runId, stage, knowledgeRevision, digest, persistentJson(receiptJson), now());
      db.prepare(`UPDATE runs SET context_pack_ref=?, updated_at=? WHERE run_id=?`).run(`context-packs/${runId}/${stage}.json`, now(), runId);
    },

    getKnowledgeContextReceipt(runId, stage) {
      const row = db.prepare(`SELECT run_id as runId, stage, knowledge_revision as knowledgeRevision, digest, receipt_json as receiptJson, created_at as createdAt FROM knowledge_context_receipts WHERE run_id=? AND stage=?`).get(runId, stage);
      if (!row) return null;
      return { ...row, receiptJson: safeJsonParse(row.receiptJson, {}) };
    },

    recordKnowledgeCandidate(candidateId, runId, { projectId, proposedType = 'semantic_fact', status = 'pending', candidateJson }) {
      db.prepare(`
        INSERT INTO knowledge_candidates(candidate_id, run_id, project_id, proposed_type, status, candidate_json, created_at)
        VALUES(?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(candidate_id) DO UPDATE SET status=excluded.status, candidate_json=excluded.candidate_json, created_at=excluded.created_at
      `).run(candidateId, runId, projectId, proposedType, status, persistentJson(candidateJson), now());
    },

    getKnowledgeCandidates(runId) {
      return db.prepare(`SELECT candidate_id as candidateId, run_id as runId, project_id as projectId, proposed_type as proposedType, status, candidate_json as candidateJson, created_at as createdAt FROM knowledge_candidates WHERE run_id=?`).all(runId).map((row) => ({ ...row, candidateJson: safeJsonParse(row.candidateJson, {}) }));
    },

    // Standalone project-memory imports deliberately have no Kernel Run or
    // completion-decision foreign key. Their authority is the explicit
    // userApprovalRef carried by the import transaction itself.
    createKnowledgeImport({
      importId = `import-${randomUUID()}`,
      projectId,
      sourceType,
      sourceIdentity,
      sourceDigest,
      sourceSnapshotRef = null,
      status = 'discovered',
      candidateCount = 0,
      approvalRef = null,
    } = {}) {
      if (!projectId || !sourceType || !sourceIdentity || !sourceDigest) {
        throw new Error('createKnowledgeImport requires projectId, sourceType, sourceIdentity, and sourceDigest');
      }
      const existing = this.findKnowledgeImportByDigest({ projectId, sourceType, sourceIdentity, sourceDigest });
      if (existing) return existing;
      db.prepare(`
        INSERT INTO knowledge_imports(import_id, project_id, source_type, source_identity, source_digest, source_snapshot_ref, status, candidate_count, approval_ref, created_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(importId, projectId, sourceType, sourceIdentity, sourceDigest, sourceSnapshotRef, status, Number(candidateCount || 0), approvalRef, now());
      return this.getKnowledgeImport(importId);
    },

    updateKnowledgeImport(importId, fields = {}) {
      const current = this.getKnowledgeImport(importId);
      if (!current) throw new Error(`KNOWLEDGE_IMPORT_NOT_FOUND: ${importId}`);
      const allowed = {
        status: fields.status,
        candidateCount: fields.candidateCount,
        acceptedCount: fields.acceptedCount,
        rejectedCount: fields.rejectedCount,
        approvalRef: fields.approvalRef,
        revisionBefore: fields.revisionBefore,
        revisionAfter: fields.revisionAfter,
        receiptJson: fields.receiptJson,
        completedAt: fields.completedAt,
        sourceSnapshotRef: fields.sourceSnapshotRef,
      };
      const assignments = [];
      const values = [];
      const columnMap = {
        candidateCount: 'candidate_count',
        acceptedCount: 'accepted_count',
        rejectedCount: 'rejected_count',
        approvalRef: 'approval_ref',
        revisionBefore: 'revision_before',
        revisionAfter: 'revision_after',
        receiptJson: 'receipt_json',
        completedAt: 'completed_at',
        sourceSnapshotRef: 'source_snapshot_ref',
      };
      if (allowed.status !== undefined) { assignments.push('status=?'); values.push(String(allowed.status)); }
      for (const [key, column] of Object.entries(columnMap)) {
        if (allowed[key] === undefined) continue;
        assignments.push(`${column}=?`);
        values.push(key === 'receiptJson' && typeof allowed[key] !== 'string' ? persistentJson(allowed[key]) : allowed[key]);
      }
      if (assignments.length === 0) return current;
      values.push(importId);
      db.prepare(`UPDATE knowledge_imports SET ${assignments.join(', ')} WHERE import_id=?`).run(...values);
      return this.getKnowledgeImport(importId);
    },

    getKnowledgeImport(importId) {
      const row = db.prepare(`
        SELECT import_id as importId, project_id as projectId, source_type as sourceType,
          source_identity as sourceIdentity, source_digest as sourceDigest,
          source_snapshot_ref as sourceSnapshotRef, status,
          candidate_count as candidateCount, accepted_count as acceptedCount,
          rejected_count as rejectedCount, approval_ref as approvalRef,
          revision_before as revisionBefore, revision_after as revisionAfter,
          receipt_json as receiptJson, created_at as createdAt, completed_at as completedAt
        FROM knowledge_imports WHERE import_id=?
      `).get(importId);
      if (!row) return null;
      return { ...row, receiptJson: safeJsonParse(row.receiptJson, {}) };
    },

    listKnowledgeImports({ projectId, statuses = null } = {}) {
      const where = ['project_id=?'];
      const values = [projectId];
      if (Array.isArray(statuses) && statuses.length > 0) {
        where.push(`status IN (${statuses.map(() => '?').join(',')})`);
        values.push(...statuses);
      }
      return db.prepare(`SELECT import_id as importId, project_id as projectId, source_type as sourceType, source_identity as sourceIdentity, source_digest as sourceDigest, source_snapshot_ref as sourceSnapshotRef, status, candidate_count as candidateCount, accepted_count as acceptedCount, rejected_count as rejectedCount, approval_ref as approvalRef, revision_before as revisionBefore, revision_after as revisionAfter, receipt_json as receiptJson, created_at as createdAt, completed_at as completedAt FROM knowledge_imports WHERE ${where.join(' AND ')} ORDER BY created_at DESC`).all(...values).map((row) => ({ ...row, receiptJson: safeJsonParse(row.receiptJson, {}) }));
    },

    findKnowledgeImportByDigest({ projectId, sourceType, sourceIdentity, sourceDigest } = {}) {
      const row = db.prepare(`SELECT import_id as importId FROM knowledge_imports WHERE project_id=? AND source_type=? AND source_identity=? AND source_digest=?`).get(projectId, sourceType, sourceIdentity, sourceDigest);
      return row ? this.getKnowledgeImport(row.importId) : null;
    },

    appendKnowledgeEvidence({ projectId, recordId, evidenceRefs = [], expectedKnowledgeRevision = null } = {}) {
      const refs = [...new Set((Array.isArray(evidenceRefs) ? evidenceRefs : [evidenceRefs]).filter(Boolean).map(String))];
      if (!projectId || !recordId || refs.length === 0) return { status: 'no_op', revisionBefore: this.getProjectKnowledgeRevision(projectId), revisionAfter: this.getProjectKnowledgeRevision(projectId) };
      db.exec('BEGIN IMMEDIATE TRANSACTION');
      try {
        const currentRevision = this.getProjectKnowledgeRevision(projectId);
        if (expectedKnowledgeRevision !== null && Number(expectedKnowledgeRevision) !== Number(currentRevision)) throw new Error(`STALE_KNOWLEDGE_REVISION: Expected revision ${expectedKnowledgeRevision} but found ${currentRevision}`);
        const row = db.prepare(`SELECT record_json as recordJson FROM knowledge_records WHERE project_id=? AND record_id=?`).get(projectId, recordId);
        if (!row) throw new Error(`KNOWLEDGE_RECORD_NOT_FOUND: ${recordId}`);
        const record = safeJsonParse(row.recordJson, {});
        const oldRefs = Array.isArray(record.evidence?.refs) ? record.evidence.refs : Array.isArray(record.evidence) ? record.evidence : [];
        const merged = [...new Set([...oldRefs, ...refs])];
        if (merged.length === oldRefs.length) { db.exec('COMMIT'); return { status: 'no_op', revisionBefore: currentRevision, revisionAfter: currentRevision }; }
        const nextRevision = currentRevision + 1;
        const updated = { ...record, evidence: { ...(record.evidence && !Array.isArray(record.evidence) ? record.evidence : {}), refs: merged }, revision: nextRevision, updatedAt: now() };
        db.prepare(`UPDATE knowledge_records SET record_json=?, revision=?, updated_at=? WHERE project_id=? AND record_id=?`).run(persistentJson(updated), nextRevision, now(), projectId, recordId);
        if (!this.updateProjectKnowledgeRevision(projectId, currentRevision, nextRevision)) throw new Error(`STALE_KNOWLEDGE_REVISION: Revision CAS increment failed for ${projectId}`);
        db.exec('COMMIT');
        return { status: 'committed', revisionBefore: currentRevision, revisionAfter: nextRevision, recordId };
      } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
    },

    commitImportedKnowledgeTransaction({
      importId = `import-${randomUUID()}`,
      projectId,
      expectedKnowledgeRevision = null,
      candidates = [],
      supersessionProposals = [],
      sourceReceipt = {},
      userApprovalRef = null,
    } = {}) {
      if (!projectId) throw new Error('PROJECT_ID_REQUIRED');
      if (!userApprovalRef || typeof userApprovalRef !== 'string') throw new Error('USER_APPROVAL_REQUIRED');
      const sourceType = String(sourceReceipt.sourceType || 'manual_statement');
      const sourceIdentity = String(sourceReceipt.sourceIdentity || sourceReceipt.sourceIdentityDigest || '');
      const sourceDigest = String(sourceReceipt.sourceDigest || '');
      if (!sourceIdentity || !sourceDigest) throw new Error('SOURCE_RECEIPT_REQUIRED');
      const prior = this.findKnowledgeImportByDigest({ projectId, sourceType, sourceIdentity, sourceDigest });
      if (prior && ['committed', 'no_op'].includes(prior.status)) return { status: 'no_op', import: prior, receipt: prior.receiptJson };

      const importRow = prior || this.createKnowledgeImport({ importId, projectId, sourceType, sourceIdentity, sourceDigest, sourceSnapshotRef: sourceReceipt.sourceSnapshotRef || null, status: 'approved', candidateCount: candidates.length, approvalRef: userApprovalRef });
      db.exec('BEGIN IMMEDIATE TRANSACTION');
      try {
        const currentRevision = this.getProjectKnowledgeRevision(projectId);
        if (expectedKnowledgeRevision !== null && Number(expectedKnowledgeRevision) !== Number(currentRevision)) throw new Error(`STALE_KNOWLEDGE_REVISION: Expected revision ${expectedKnowledgeRevision} but found ${currentRevision}`);
        const existing = this.listKnowledgeRecords({ projectId, statuses: ['committed', 'verified'] });
        const byKey = new Map(existing.map((record) => [`${record.type || record.recordType}|${String(record.statement || '').trim().toLowerCase()}|${JSON.stringify([...(record.scope || [])].sort())}`, record]));
        const records = [];
        const evidenceUpdates = [];
        const conflicts = [];
        let rejectedCount = 0;
        for (const candidate of Array.isArray(candidates) ? candidates : []) {
          if (!candidate || candidate.status === 'rejected' || candidate.selected === false) { rejectedCount++; continue; }
          const statement = String(candidate.statement || '').trim();
          if (!statement || /(?:api[_ -]?key|secret|credential|system prompt|developer prompt|raw transcript)/i.test(statement)) { rejectedCount++; continue; }
          const type = String(candidate.type || candidate.proposedType || 'semantic_fact');
          const scope = Array.isArray(candidate.scope) ? candidate.scope.map(String) : [];
          const key = `${type}|${statement.toLowerCase()}|${JSON.stringify([...scope].sort())}`;
          const priorRecord = byKey.get(key);
          const refs = [...new Set([sourceDigest, ...(candidate.evidenceRefs || []), ...(candidate.sourceRefs || [])].filter(Boolean).map(String))];
          if (priorRecord) {
            evidenceUpdates.push({ record: priorRecord, refs });
            continue;
          }
          const conflicting = existing.find((record) => String(record.type || record.recordType) === type && JSON.stringify([...(record.scope || [])].sort()) === JSON.stringify([...scope].sort()) && String(record.statement || '').trim().toLowerCase() !== statement.toLowerCase());
          if (conflicting) { conflicts.push({ candidateId: candidate.candidateId || candidate.id || null, recordId: conflicting.id, statement }); rejectedCount++; continue; }
          const recordId = String(candidate.recordId || candidate.candidateId || `rec-import-${createHash('sha256').update(`${projectId}:${sourceIdentity}:${type}:${statement}:${JSON.stringify(scope)}`).digest('hex').slice(0, 24)}`);
          records.push({
            id: recordId,
            candidateId: candidate.candidateId || candidate.id || recordId,
            projectId,
            type,
            statement,
            scope,
            status: 'committed',
            trustTier: ['authoritative', 'verified'].includes(candidate.trustTier) ? candidate.trustTier : 'verified',
            evidence: { refs },
            provenance: { sourceType, sourceIdentity, sourceDigest, importId },
            createdAt: now(),
            updatedAt: now(),
          });
        }
        const validSupersessions = [];
        for (const proposal of Array.isArray(supersessionProposals) ? supersessionProposals : []) {
          const targetId = String(proposal?.targetId || proposal?.id || proposal || '');
          const target = existing.find((record) => record.id === targetId);
          if (target && target.projectId === projectId) validSupersessions.push(targetId);
          else rejectedCount++;
        }
        const nextRevision = records.length > 0 || evidenceUpdates.some(({ record, refs }) => refs.some((ref) => !(record.evidence?.refs || []).includes(ref))) || validSupersessions.length > 0 ? currentRevision + 1 : currentRevision;
        for (const record of records) {
          const payload = { ...record, revision: nextRevision };
          db.prepare(`INSERT INTO knowledge_records(project_id, record_id, record_type, status, trust_tier, record_json, revision, created_at, updated_at) VALUES(?, ?, ?, 'committed', ?, ?, ?, ?, ?) ON CONFLICT(project_id, record_id) DO UPDATE SET record_type=excluded.record_type, status='committed', trust_tier=excluded.trust_tier, record_json=excluded.record_json, revision=excluded.revision, updated_at=excluded.updated_at`).run(projectId, record.id, record.type, record.trustTier, persistentJson(payload), nextRevision, now(), now());
        }
        for (const { record, refs } of evidenceUpdates) {
          const oldRefs = Array.isArray(record.evidence?.refs) ? record.evidence.refs : [];
          const merged = [...new Set([...oldRefs, ...refs])];
          if (merged.length !== oldRefs.length) {
            const updated = { ...record, evidence: { ...(record.evidence || {}), refs: merged }, revision: nextRevision, updatedAt: now() };
            db.prepare(`UPDATE knowledge_records SET record_json=?, revision=?, updated_at=? WHERE project_id=? AND record_id=?`).run(persistentJson(updated), nextRevision, now(), projectId, record.id);
          }
        }
        for (const targetId of validSupersessions) db.prepare(`UPDATE knowledge_records SET status='superseded', updated_at=? WHERE project_id=? AND record_id=?`).run(now(), projectId, targetId);
        if (nextRevision !== currentRevision && !this.updateProjectKnowledgeRevision(projectId, currentRevision, nextRevision)) throw new Error(`STALE_KNOWLEDGE_REVISION: Revision CAS increment failed for ${projectId}`);
        const acceptedCount = records.length + evidenceUpdates.filter(({ record, refs }) => refs.some((ref) => !(record.evidence?.refs || []).includes(ref))).length;
        const status = acceptedCount > 0 || validSupersessions.length > 0 ? (conflicts.length > 0 ? 'partial' : 'committed') : 'no_op';
        const receipt = { schemaVersion: 1, importId: importRow.importId, projectId, authorityType: 'user_approved_import', sourceType, sourceIdentityDigest: sourceIdentity, sourceDigest, candidateCount: candidates.length, acceptedCount, rejectedCount: rejectedCount + conflicts.length, supersededCount: validSupersessions.length, conflictCount: conflicts.length, knowledgeRevisionBefore: currentRevision, knowledgeRevisionAfter: nextRevision, approvalRef: userApprovalRef, status, createdAt: now(), conflicts };
        this.updateKnowledgeImport(importRow.importId, { status, candidateCount: candidates.length, acceptedCount, rejectedCount: rejectedCount + conflicts.length, approvalRef: userApprovalRef, revisionBefore: currentRevision, revisionAfter: nextRevision, receiptJson: receipt, completedAt: now() });
        db.exec('COMMIT');
        return { status, import: this.getKnowledgeImport(importRow.importId), receipt };
      } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
    },

    recordKnowledgeReviewReceipt(runId, { projectId, status, candidateCount = 0, verifiedCount = 0, rejectedCount = 0, waitingApprovalCount = 0, waitingVerificationCount = 0, reviewDigest, receiptJson }) {
      db.prepare(`
        INSERT INTO knowledge_review_receipts(run_id, project_id, status, candidate_count, verified_count, rejected_count, waiting_approval_count, waiting_verification_count, review_digest, receipt_json, created_at, updated_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET status=excluded.status, candidate_count=excluded.candidate_count, verified_count=excluded.verified_count, rejected_count=excluded.rejected_count, waiting_approval_count=excluded.waiting_approval_count, waiting_verification_count=excluded.waiting_verification_count, review_digest=excluded.review_digest, receipt_json=excluded.receipt_json, updated_at=excluded.updated_at
      `).run(runId, projectId, status, candidateCount, verifiedCount, rejectedCount, waitingApprovalCount, waitingVerificationCount, reviewDigest, persistentJson(receiptJson || {}), now(), now());
    },

    getKnowledgeReviewReceipt(runId) {
      const row = db.prepare(`SELECT run_id as runId, project_id as projectId, status, candidate_count as candidateCount, verified_count as verifiedCount, rejected_count as rejectedCount, waiting_approval_count as waitingApprovalCount, waiting_verification_count as waitingVerificationCount, review_digest as reviewDigest, receipt_json as receiptJson, created_at as createdAt, updated_at as updatedAt FROM knowledge_review_receipts WHERE run_id=?`).get(runId);
      if (!row) return null;
      return { ...row, receiptJson: safeJsonParse(row.receiptJson, {}) };
    },

    recordCandidateEvidenceBinding({ candidateId, runId, evidenceDigest, obligationId = 'default', sourceIdentity, mutationRevision, bindingType = 'verification' }) {
      db.prepare(`
        INSERT INTO candidate_evidence_bindings(candidate_id, run_id, evidence_digest, obligation_id, source_identity, mutation_revision, binding_type, created_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(candidate_id, evidence_digest) DO NOTHING
      `).run(candidateId, runId, evidenceDigest, obligationId, sourceIdentity, mutationRevision, bindingType, now());
    },

    getCandidateEvidenceBindings(runId, candidateId = null) {
      if (candidateId) {
        return db.prepare(`SELECT candidate_id as candidateId, run_id as runId, evidence_digest as evidenceDigest, obligation_id as obligationId, source_identity as sourceIdentity, mutation_revision as mutationRevision, binding_type as bindingType, created_at as createdAt FROM candidate_evidence_bindings WHERE run_id=? AND candidate_id=?`).all(runId, candidateId);
      }
      return db.prepare(`SELECT candidate_id as candidateId, run_id as runId, evidence_digest as evidenceDigest, obligation_id as obligationId, source_identity as sourceIdentity, mutation_revision as mutationRevision, binding_type as bindingType, created_at as createdAt FROM candidate_evidence_bindings WHERE run_id=?`).all(runId);
    },

    ensureRunObligation(runId, { obligationId, sourceType = 'ontology_constraint', sourceRef = null, evidenceClass = 'hard', verificationMethod = null, allowedCommandRefs = [], acceptanceIds = [], status = 'required' }) {
      const run = this.getRun(runId);
      db.prepare(`
        INSERT INTO run_obligations(run_id, obligation_id, source_type, source_ref, status, evidence_class, verification_method, allowed_command_refs, acceptance_ids, protected, contract_revision, created_at, updated_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id, obligation_id) DO NOTHING
      `).run(
        runId,
        obligationId,
        sourceType,
        sourceRef || null,
        status,
        evidenceClass,
        verificationMethod,
        JSON.stringify(allowedCommandRefs),
        JSON.stringify(acceptanceIds),
        isProtectedObligation(obligationId) ? 1 : 0,
        Number(run?.contractRevision || 1),
        now(),
        now(),
      );
    },

    markRunObligationPassed(runId, obligationId) {
      db.prepare(`UPDATE run_obligations SET status='passed', updated_at=? WHERE run_id=? AND obligation_id=?`).run(now(), runId, obligationId);
    },

    getRunObligations(runId) {
      return db.prepare(`SELECT run_id as runId, obligation_id as obligationId, source_type as sourceType, source_ref as sourceRef, status, evidence_class as evidenceClass, verification_method as verificationMethod, allowed_command_refs as allowedCommandRefs, rejected_command_refs as rejectedCommandRefs, acceptance_ids as acceptanceIds, protected, contract_revision as contractRevision, metadata_json as metadataJson, created_at as createdAt, updated_at as updatedAt FROM run_obligations WHERE run_id=?`).all(runId).map((row) => {
        const allowed = safeJsonParse(row.allowedCommandRefs, []);
        const evidenceClass = row.evidenceClass;
        return {
          ...row,
          allowedCommandRefs: allowed,
          rejectedCommandRefs: safeJsonParse(row.rejectedCommandRefs, []),
          acceptanceIds: safeJsonParse(row.acceptanceIds, []),
          metadata: safeJsonParse(row.metadataJson, {}),
          protected: Boolean(row.protected),
          satisfiable: evidenceClass === 'judgment' || allowed.length > 0,
        };
      });
    },

    getRunObligation(runId, obligationId) {
      return this.getRunObligations(runId).find((obligation) => obligation.obligationId === obligationId) || null;
    },

    recordKnowledgeCommitReceipt(runId, { projectId, revisionBefore, revisionAfter, status = 'committed', receiptJson }) {
      db.prepare(`
        INSERT INTO knowledge_commit_receipts(run_id, project_id, revision_before, revision_after, status, receipt_json, created_at)
        VALUES(?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET revision_before=excluded.revision_before, revision_after=excluded.revision_after, status=excluded.status, receipt_json=excluded.receipt_json, created_at=excluded.created_at
      `).run(runId, projectId, revisionBefore, revisionAfter, status, persistentJson(receiptJson), now());
      db.prepare(`UPDATE runs SET knowledge_revision_close=?, knowledge_status=?, updated_at=? WHERE run_id=?`).run(revisionAfter, status, now(), runId);
    },

    getKnowledgeCommitReceipt(runId) {
      const row = db.prepare(`SELECT run_id as runId, project_id as projectId, revision_before as revisionBefore, revision_after as revisionAfter, status, receipt_json as receiptJson, created_at as createdAt FROM knowledge_commit_receipts WHERE run_id=?`).get(runId);
      if (!row) return null;
      return { ...row, receiptJson: safeJsonParse(row.receiptJson, {}) };
    },

    recordCompletionDecision(runId, { decision, sourceIdentity, mutationRevision, evidenceDigest, decisionJson }) {
      db.prepare(`
        INSERT INTO completion_decisions(run_id, decision, source_identity, mutation_revision, evidence_digest, decision_json, created_at)
        VALUES(?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET decision=excluded.decision, source_identity=excluded.source_identity, mutation_revision=excluded.mutation_revision, evidence_digest=excluded.evidence_digest, decision_json=excluded.decision_json, created_at=excluded.created_at
      `).run(runId, decision, sourceIdentity, mutationRevision, evidenceDigest, persistentJson(decisionJson), now());
    },

    getCompletionDecision(runId) {
      const row = db.prepare(`SELECT run_id as runId, decision, source_identity as sourceIdentity, mutation_revision as mutationRevision, evidence_digest as evidenceDigest, decision_json as decisionJson, created_at as createdAt FROM completion_decisions WHERE run_id=?`).get(runId);
      if (!row) return null;
      return { ...row, decisionJson: safeJsonParse(row.decisionJson, {}) };
    },

    recordGitCloseoutReceipt(runId, { projectId, mode, commitSha, branch, remote = 'origin', pushStatus, parity, status = 'completed', beforeHeadSha = null, selectedPaths = [], errorCode = null, errorMessage = null, receiptJson }) {
      db.prepare(`
        INSERT INTO git_closeout_receipts(run_id, project_id, mode, commit_sha, branch, remote, push_status, parity, status, before_head_sha, selected_paths_json, error_code, error_message, receipt_json, created_at, updated_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET mode=excluded.mode, commit_sha=excluded.commit_sha, branch=excluded.branch, remote=excluded.remote, push_status=excluded.push_status, parity=excluded.parity, status=excluded.status, before_head_sha=excluded.before_head_sha, selected_paths_json=excluded.selected_paths_json, error_code=excluded.error_code, error_message=excluded.error_message, receipt_json=excluded.receipt_json, updated_at=excluded.updated_at
      `).run(runId, projectId, mode, commitSha || null, branch || null, remote, pushStatus, parity, status, beforeHeadSha || null, JSON.stringify(selectedPaths), errorCode || null, errorMessage || null, typeof receiptJson === 'string' ? receiptJson : JSON.stringify(receiptJson || {}), now(), now());
    },

    getGitCloseoutReceipt(runId) {
      const row = db.prepare(`SELECT run_id as runId, project_id as projectId, mode, commit_sha as commitSha, branch, remote, push_status as pushStatus, parity, status, before_head_sha as beforeHeadSha, selected_paths_json as selectedPathsJson, error_code as errorCode, error_message as errorMessage, receipt_json as receiptJson, created_at as createdAt, updated_at as updatedAt FROM git_closeout_receipts WHERE run_id=?`).get(runId);
      if (!row) return null;
      return { ...row, receiptJson: safeJsonParse(row.receiptJson, {}), selectedPaths: safeJsonParse(row.selectedPathsJson, []) };
    },

    recordMutationProvenance(runId, { projectId, workspaceId = null, sourceIdentity, baseSourceIdentity = null, mutationRevision, changedPaths = [], workspaceIdentity, mutationDigest, attemptId = null } = {}) {
      if (!runId || !projectId || !sourceIdentity || !workspaceIdentity || !mutationDigest) throw new Error('mutation_provenance_incomplete');
      db.prepare(`
        INSERT INTO mutation_provenance(run_id, project_id, workspace_id, source_identity, base_source_identity, mutation_revision, changed_paths_json, workspace_identity, mutation_digest, attempt_id, created_at, updated_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET project_id=excluded.project_id, workspace_id=excluded.workspace_id, source_identity=excluded.source_identity, base_source_identity=excluded.base_source_identity, mutation_revision=excluded.mutation_revision, changed_paths_json=excluded.changed_paths_json, workspace_identity=excluded.workspace_identity, mutation_digest=excluded.mutation_digest, attempt_id=excluded.attempt_id, updated_at=excluded.updated_at
      `).run(runId, projectId, workspaceId, sourceIdentity, baseSourceIdentity, Number(mutationRevision), JSON.stringify(canonicalReceiptPaths(changedPaths)), workspaceIdentity, mutationDigest, attemptId, now(), now());
      return this.getMutationProvenance(runId);
    },

    getMutationProvenance(runId) {
      const row = db.prepare(`SELECT run_id as runId, project_id as projectId, workspace_id as workspaceId, source_identity as sourceIdentity, base_source_identity as baseSourceIdentity, mutation_revision as mutationRevision, changed_paths_json as changedPathsJson, workspace_identity as workspaceIdentity, mutation_digest as mutationDigest, attempt_id as attemptId, created_at as createdAt, updated_at as updatedAt FROM mutation_provenance WHERE run_id=?`).get(runId);
      if (!row) return null;
      return {
        ...row,
        changedPaths: canonicalReceiptPaths(safeJsonParse(row.changedPathsJson, [])),
      };
    },

    recordFinalizationReceipt(runId, receipt = {}) {
      const { projectId, completionStatus, knowledgeStatus, projectionStatus, gitCloseoutStatus, finalizationStatus, receiptJson } = receipt;
      const jsonStr = persistentJson(receiptJson || receipt || {});
      db.prepare(`
        INSERT INTO finalization_receipts(run_id, project_id, completion_status, knowledge_status, projection_status, git_closeout_status, finalization_status, receipt_json, created_at, updated_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET completion_status=excluded.completion_status, knowledge_status=excluded.knowledge_status, projection_status=excluded.projection_status, git_closeout_status=excluded.git_closeout_status, finalization_status=excluded.finalization_status, receipt_json=excluded.receipt_json, updated_at=excluded.updated_at
      `).run(runId, projectId || 'unknown', completionStatus || 'unknown', knowledgeStatus || 'unknown', projectionStatus || 'completed', gitCloseoutStatus || 'skipped', finalizationStatus || 'unknown', jsonStr, now(), now());
    },

    getFinalizationReceipt(runId) {
      const row = db.prepare(`SELECT run_id as runId, project_id as projectId, completion_status as completionStatus, knowledge_status as knowledgeStatus, projection_status as projectionStatus, git_closeout_status as gitCloseoutStatus, finalization_status as finalizationStatus, receipt_json as receiptJson, created_at as createdAt, updated_at as updatedAt FROM finalization_receipts WHERE run_id=?`).get(runId);
      if (!row) return null;
      return { ...row, receiptJson: safeJsonParse(row.receiptJson, {}) };
    },

    // Model routing evidence (§7). The decision is written BEFORE the Host
    // dispatches, so a crashed turn leaves an interrupted decision rather than
    // an invisible one; the receipt is what proves the Host actually complied.
    recordModelRouteDecision(runId, decision) {
      const normalized = normalizeModelRouteDecision(decision);
      if (normalized.runId !== runId) throw new Error(`model route decision runId ${normalized.runId} does not match run ${runId}`);
      if (!this.getRun(runId)) throw new Error(`Run ${runId} not found`);
      db.prepare(`
        INSERT INTO model_route_decisions(decision_id, run_id, attempt_number, replan_count, plan_revision, obligation_id, action_kind, role, model_class, risk_tier, independent_context_required, permissions, reason_codes_json, policy_revision, decision_json, created_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(decision_id) DO UPDATE SET decision_json=excluded.decision_json, reason_codes_json=excluded.reason_codes_json, model_class=excluded.model_class, action_kind=excluded.action_kind, independent_context_required=excluded.independent_context_required
      `).run(
        normalized.decisionId, runId, normalized.attemptNumber, normalized.replanCount, normalized.planRevision,
        normalized.obligationId, normalized.actionKind, normalized.role, normalized.modelClass, normalized.riskTier,
        normalized.independentContextRequired ? 1 : 0, normalized.permissions, JSON.stringify(normalized.reasonCodes),
        normalized.policyRevision, persistentJson(normalized), normalized.createdAt,
      );
      return normalized;
    },

    getModelRouteDecision(decisionId, { runId = null } = {}) {
      const row = db.prepare(`SELECT run_id as runId, decision_json as decisionJson FROM model_route_decisions WHERE decision_id=?`).get(decisionId);
      if (!row) return null;
      if (runId && row.runId !== runId) return null;
      return safeJsonParse(row.decisionJson, null);
    },

    listModelRouteDecisions(runId) {
      return db.prepare(`SELECT decision_json as decisionJson FROM model_route_decisions WHERE run_id=? ORDER BY rowid ASC`).all(runId)
        .map((row) => safeJsonParse(row.decisionJson, null)).filter(Boolean);
    },

    recordModelUsageReceipt(runId, receipt) {
      const normalized = normalizeModelUsageReceipt(receipt);
      if (normalized.runId !== runId) throw new Error(`model usage receipt runId ${normalized.runId} does not match run ${runId}`);
      const decision = this.getModelRouteDecision(normalized.decisionId, { runId });
      if (!decision) throw new Error(`model usage receipt references decision ${normalized.decisionId}, which does not belong to run ${runId}`);
      const attempt = normalized.attemptId ? this.getStepAttemptByAttemptId(normalized.attemptId, { runId }) : null;
      if (normalized.attemptId && !attempt) throw new Error(`model usage receipt references attempt ${normalized.attemptId}, which does not belong to run ${runId}`);
      if (attempt) {
        assertAttemptLineage(attempt, {
          runId,
          stepId: normalized.stepId,
          bindingId: normalized.bindingId,
          capsuleId: normalized.capsuleId,
          admissionId: normalized.admissionId,
          planRevision: decision.planRevision,
        });
      }
      db.prepare(`
        INSERT INTO model_usage_receipts(receipt_id, decision_id, run_id, attempt_id, binding_id, host_surface, actor_session_id, parent_session_id, resolved_model, resolved_effort, enforcement_status, input_tokens, cached_input_tokens, output_tokens, cost_micros, wall_clock_ms, result_status, capsule_id, capsule_digest, admission_id, admission_digest, step_id, provider, surface, speed_mode, reasoning_context, reasoning_mode, delegation_mode, session_lineage_id, previous_response_id_digest, prompt_prefix_digest, prompt_cache_key_digest, cache_mode, cache_ttl, cache_miss_reason, model_escalation_reason, eligible_prefix_tokens, uncached_input_tokens, cache_read_input_tokens, cache_write_input_tokens, reasoning_tokens, receipt_json, created_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(receipt_id) DO UPDATE SET attempt_id=excluded.attempt_id, binding_id=excluded.binding_id, enforcement_status=excluded.enforcement_status, resolved_model=excluded.resolved_model, resolved_effort=excluded.resolved_effort, input_tokens=excluded.input_tokens, cached_input_tokens=excluded.cached_input_tokens, output_tokens=excluded.output_tokens, cost_micros=excluded.cost_micros, wall_clock_ms=excluded.wall_clock_ms, result_status=excluded.result_status, capsule_id=excluded.capsule_id, capsule_digest=excluded.capsule_digest, admission_id=excluded.admission_id, admission_digest=excluded.admission_digest, step_id=excluded.step_id, provider=excluded.provider, surface=excluded.surface, speed_mode=excluded.speed_mode, reasoning_context=excluded.reasoning_context, reasoning_mode=excluded.reasoning_mode, delegation_mode=excluded.delegation_mode, session_lineage_id=excluded.session_lineage_id, previous_response_id_digest=excluded.previous_response_id_digest, prompt_prefix_digest=excluded.prompt_prefix_digest, prompt_cache_key_digest=excluded.prompt_cache_key_digest, cache_mode=excluded.cache_mode, cache_ttl=excluded.cache_ttl, cache_miss_reason=excluded.cache_miss_reason, model_escalation_reason=excluded.model_escalation_reason, eligible_prefix_tokens=excluded.eligible_prefix_tokens, uncached_input_tokens=excluded.uncached_input_tokens, cache_read_input_tokens=excluded.cache_read_input_tokens, cache_write_input_tokens=excluded.cache_write_input_tokens, reasoning_tokens=excluded.reasoning_tokens, receipt_json=excluded.receipt_json
      `).run(
        normalized.receiptId, normalized.decisionId, runId, normalized.attemptId, normalized.bindingId, normalized.hostSurface, normalized.actorSessionId,
        normalized.parentSessionId, normalized.resolvedModel, normalized.resolvedEffort, normalized.enforcementStatus,
        normalized.inputTokens, normalized.cachedInputTokens, normalized.outputTokens, normalized.costMicros,
        normalized.wallClockMs, normalized.resultStatus,
        normalized.capsuleId, normalized.capsuleDigest, normalized.admissionId, normalized.admissionDigest, normalized.stepId,
        normalized.provider, normalized.surface, normalized.speedMode, normalized.reasoningContext, normalized.reasoningMode,
        normalized.delegationMode, normalized.sessionLineageId, normalized.previousResponseIdDigest,
        normalized.promptPrefixDigest, normalized.promptCacheKeyDigest, normalized.cacheMode, normalized.cacheTtl,
        normalized.cacheMissReason, normalized.modelEscalationReason,
        normalized.eligiblePrefixTokens, normalized.uncachedInputTokens, normalized.cacheReadInputTokens,
        normalized.cacheWriteInputTokens, normalized.reasoningTokens,
        persistentJson(normalized), normalized.createdAt,
      );
      if (attempt) {
        this.attachAttemptLineage(attempt.attemptId, {
          usageReceiptId: normalized.receiptId,
          actorSessionId: normalized.actorSessionId,
          status: normalized.resultStatus === 'failed' ? 'interrupted' : undefined,
          failureCategory: normalized.resultStatus === 'failed' ? 'provider/infrastructure' : undefined,
        });
      }
      return normalized;
    },

    getModelUsageReceipt(receiptId, { runId = null } = {}) {
      const row = db.prepare(`SELECT run_id as runId, receipt_json as receiptJson FROM model_usage_receipts WHERE receipt_id=?`).get(receiptId);
      if (!row) return null;
      if (runId && row.runId !== runId) return null;
      return safeJsonParse(row.receiptJson, null);
    },

    listModelUsageReceipts(runId) {
      return db.prepare(`SELECT receipt_json as receiptJson FROM model_usage_receipts WHERE run_id=? ORDER BY rowid ASC`).all(runId)
        .map((row) => safeJsonParse(row.receiptJson, null)).filter(Boolean);
    },

    // Route admissions (K3). Recorded whatever the outcome: a blocked admission
    // is the evidence that a dispatch was refused, and losing it would make a
    // refusal indistinguishable from a turn that never happened.
    recordRouteAdmission(runId, admission) {
      if (!admission?.admissionId) throw new Error('recordRouteAdmission requires a built admission');
      if (admission.runId !== runId) throw new Error(`route admission runId ${admission.runId} does not match run ${runId}`);
      if (!this.getRun(runId)) throw new Error(`Run ${runId} not found`);
      const attempt = admission.attemptId ? this.getStepAttemptByAttemptId(admission.attemptId, { runId }) : null;
      if (admission.attemptId && !attempt) throw new Error(`route admission references attempt ${admission.attemptId}, which does not belong to run ${runId}`);
      if (attempt) assertAttemptLineage(attempt, { runId, stepId: admission.stepId, capsuleId: admission.capsuleId, planRevision: admission.planRevision });
      db.prepare(`
        INSERT INTO route_admissions(admission_id, run_id, attempt_id, step_id, decision_id, capsule_id, requested_json, resolved_json, policy_json, economics_json, decision, rejection_code, digest, admission_json, created_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(admission_id) DO NOTHING
      `).run(
        admission.admissionId, runId, admission.attemptId || null, admission.stepId || null, admission.decisionId, admission.capsuleId || null,
        JSON.stringify(admission.requested), JSON.stringify(admission.resolved), JSON.stringify(admission.policy),
        JSON.stringify(admission.economics), admission.decision, admission.rejectionCode || null,
        admission.digest, persistentJson(admission), admission.createdAt,
      );
      if (attempt) {
        this.attachAttemptLineage(attempt.attemptId, {
          admissionId: admission.admissionId,
          status: admission.decision === 'blocked' || admission.decision === 'redecision_required' ? 'interrupted' : undefined,
          failureCategory: admission.rejectionCode || undefined,
        });
      }
      return admission;
    },

    getRouteAdmission(admissionId, { runId = null } = {}) {
      const row = db.prepare(`SELECT run_id as runId, admission_json as admissionJson FROM route_admissions WHERE admission_id=?`).get(admissionId);
      if (!row) return null;
      if (runId && row.runId !== runId) return null;
      return safeJsonParse(row.admissionJson, null);
    },

    listRouteAdmissions(runId, { decisionId = null } = {}) {
      const rows = decisionId
        ? db.prepare(`SELECT admission_json as admissionJson FROM route_admissions WHERE run_id=? AND decision_id=? ORDER BY rowid ASC`).all(runId, decisionId)
        : db.prepare(`SELECT admission_json as admissionJson FROM route_admissions WHERE run_id=? ORDER BY rowid ASC`).all(runId);
      return rows.map((row) => safeJsonParse(row.admissionJson, null)).filter(Boolean);
    },

    // A worker result is an execution fact attached to the Step and its
    // canonical attempt. It does not open a second lifecycle or require a
    // group identity to become recoverable. Once an attempt has a result,
    // replay is exact-only: a different worker receipt cannot overwrite the
    // bytes or lineage that the recovery path relies on.
    recordStepResult(runId, stepId, result = {}) {
      const step = this.getRunStep(runId, stepId);
      if (!step) throw Object.assign(new Error('step-not-found'), { code: 'STEP_NOT_FOUND' });

      const attempts = this.getStepAttempts(runId, { stepId });
      const attempt = result.attemptId
        ? this.getStepAttemptByAttemptId(result.attemptId, { runId })
        : this.getActiveStepAttempt(runId, { stepId }) || attempts.at(-1) || null;
      if (result.attemptId && (!attempt || attempt.stepId !== stepId)) {
        throw Object.assign(new Error(`worker result attempt ${result.attemptId} does not belong to step ${stepId}`), {
          code: 'STEP_RESULT_ATTEMPT_MISMATCH',
          errorCode: 'STEP_RESULT_ATTEMPT_MISMATCH',
        });
      }
      const latestAttempt = attempts.at(-1) || null;
      if (result.attemptId && latestAttempt && attempt.id !== latestAttempt.id) {
        throw Object.assign(new Error(`worker result attempt ${result.attemptId} is not the current canonical attempt`), {
          code: 'STEP_RESULT_IMMUTABLE_CONFLICT',
          errorCode: 'STEP_RESULT_IMMUTABLE_CONFLICT',
          field: 'attemptId',
        });
      }

      const resultDigest = result.receiptDigest || result.resultDigest;
      const attemptResult = {
        changedPaths: result.changedPaths,
        mutationRevision: result.mutationRevision,
        workspaceIdentityEnd: result.resultWorkspaceIdentity,
        resultWorkspaceIdentity: result.resultWorkspaceIdentity,
        resultCommitSha: result.resultCommitSha,
        patchDigest: result.patchDigest,
        resultDigest,
        verificationRefs: result.verificationRefs,
        knowledgeObservationRefs: result.knowledgeObservationRefs,
        workerReport: result.workerReport,
      };
      const canonicalAttemptId = result.attemptId || attempt?.attemptId || null;
      const replacingStepReceipt = Boolean(
        canonicalAttemptId
        && step.resultAttemptId
        && step.resultAttemptId !== canonicalAttemptId,
      );
      if (replacingStepReceipt && step.state === 'passed') {
        throw Object.assign(new Error(`step ${stepId} already has an immutable passed result`), {
          code: 'STEP_RESULT_IMMUTABLE_CONFLICT',
          errorCode: 'STEP_RESULT_IMMUTABLE_CONFLICT',
          field: 'resultAttemptId',
        });
      }
      let updatedAttempt = attempt;
      if (attempt) {
        const attemptPatch = mergeImmutableReceiptFields(attempt, attemptResult, [
          'changedPaths',
          'mutationRevision',
          'workspaceIdentityEnd',
          'resultWorkspaceIdentity',
          'resultCommitSha',
          'patchDigest',
          'resultDigest',
          'verificationRefs',
          'knowledgeObservationRefs',
          'workerReport',
        ]);
        updatedAttempt = Object.keys(attemptPatch).length > 0
          ? this.updateStepAttempt(attempt.id, attemptPatch)
          : attempt;
      }

      const stepResult = {
        resultAttemptId: canonicalAttemptId,
        resultWorkspaceIdentity: result.resultWorkspaceIdentity,
        resultCommitSha: result.resultCommitSha,
        patchDigest: result.patchDigest,
        resultDigest,
        workspaceIdentityEnd: result.resultWorkspaceIdentity,
      };
      const stepPatch = replacingStepReceipt
        ? Object.fromEntries(Object.entries(stepResult).filter(([, value]) => value !== null && value !== undefined))
        : mergeImmutableReceiptFields(step, stepResult, [
          'resultAttemptId',
          'resultWorkspaceIdentity',
          'resultCommitSha',
          'patchDigest',
          'resultDigest',
          'workspaceIdentityEnd',
        ]);
      const updated = Object.keys(stepPatch).length > 0
        ? this.updateRunStep(runId, stepId, stepPatch)
        : step;

      if (result.recordMutationProvenance !== false
        && updatedAttempt && Array.isArray(updatedAttempt.changedPaths) && updatedAttempt.changedPaths.length > 0 && updatedAttempt.resultWorkspaceIdentity) {
        const run = this.getRun(runId);
        const mutationRevision = result.mutationRevision ?? updatedAttempt.mutationRevision ?? run?.mutationRevision ?? 0;
        this.recordMutationProvenance(runId, {
          projectId: run?.projectId,
          workspaceId: result.executionWorkspaceId || updatedAttempt.workspaceId || run?.workspaceId || null,
          sourceIdentity: run?.sourceIdentity,
          baseSourceIdentity: run?.sourceIdentity,
          mutationRevision,
          changedPaths: updatedAttempt.changedPaths,
          workspaceIdentity: updatedAttempt.resultWorkspaceIdentity,
          mutationDigest: result.patchDigest || result.receiptDigest || result.resultDigest || updatedAttempt.resultWorkspaceIdentity,
          attemptId: updatedAttempt.attemptId || null,
        });
      }
      return updated;
    },

    // Run Step Ledger (K2). The work cursor is state, not chat context: which
    // unit is running, what it may touch, what it must prove, and how many times
    // it has already failed all survive a process restart.
    createRunSteps(runId, steps = []) {
      if (!this.getRun(runId)) throw new Error(`Run ${runId} not found`);
      // Step ids are unique per run. A replacement plan that reuses an id from a
      // superseded revision would be swallowed by the upsert and vanish, leaving
      // the run pointing at a plan that is missing steps — so it fails loudly.
      const existing = new Map(this.getRunSteps(runId).map((step) => [step.stepId, step.planRevision]));
      for (const step of steps) {
        const collidesWith = existing.get(step.stepId);
        if (collidesWith !== undefined && collidesWith !== Number(step.planRevision || 1)) {
          throw new Error(`STEP_ID_COLLISION: step "${step.stepId}" already exists at plan revision ${collidesWith}; a replacement plan needs its own ids`);
        }
      }
      const insert = db.prepare(`
        INSERT INTO run_steps(step_id, run_id, sequence, objective, state, plan_revision, dependency_ids_json, allowed_paths_json, forbidden_paths_json, acceptance_ids_json, obligation_ids_json, expected_outputs_json, assigned_role, synthetic, migration_origin, execution_workspace_id, base_workspace_identity, result_workspace_identity, result_commit_sha, patch_digest, created_at, updated_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id, step_id) DO NOTHING
      `);
      for (const step of steps) {
        insert.run(
          step.stepId, runId, Number(step.sequence) || 1, String(step.objective || ''), String(step.state || 'planned'),
          Number(step.planRevision) || 1,
          JSON.stringify(step.dependencyIds || []), JSON.stringify(step.allowedPaths || []), JSON.stringify(step.forbiddenPaths || []),
          JSON.stringify(step.acceptanceIds || []), JSON.stringify(step.obligationIds || []), JSON.stringify(step.expectedOutputs || []),
          String(step.assignedRole || 'implementer'), step.synthetic ? 1 : 0, step.migrationOrigin || null,
          step.executionWorkspaceId || null, step.baseWorkspaceIdentity || null,
          step.resultWorkspaceIdentity || null, step.resultCommitSha || null, step.patchDigest || null,
          now(), now(),
        );
      }
      return this.getRunSteps(runId);
    },

    getRunSteps(runId, { planRevision = null } = {}) {
      const rows = planRevision === null
        ? db.prepare(`SELECT * FROM run_steps WHERE run_id=? ORDER BY plan_revision ASC, sequence ASC`).all(runId)
        : db.prepare(`SELECT * FROM run_steps WHERE run_id=? AND plan_revision=? ORDER BY sequence ASC`).all(runId, planRevision);
      return rows.map((row) => ({
        stepId: row.step_id,
        runId: row.run_id,
        sequence: row.sequence,
        objective: row.objective,
        state: row.state,
        planRevision: row.plan_revision,
        dependencyIds: safeJsonParse(row.dependency_ids_json, []),
        allowedPaths: safeJsonParse(row.allowed_paths_json, []),
        forbiddenPaths: safeJsonParse(row.forbidden_paths_json, []),
        acceptanceIds: safeJsonParse(row.acceptance_ids_json, []),
        obligationIds: safeJsonParse(row.obligation_ids_json, []),
        expectedOutputs: safeJsonParse(row.expected_outputs_json, []),
        assignedRole: row.assigned_role,
        synthetic: Boolean(row.synthetic),
        migrationOrigin: row.migration_origin || null,
        attemptCount: row.attempt_count,
        capsuleDigest: row.capsule_digest || null,
        resultDigest: row.result_digest || null,
        workspaceIdentityStart: row.workspace_identity_start || null,
        workspaceIdentityEnd: row.workspace_identity_end || null,
        blockedReason: row.blocked_reason || null,
        executionWorkspaceId: row.execution_workspace_id || null,
        baseWorkspaceIdentity: row.base_workspace_identity || null,
        resultWorkspaceIdentity: row.result_workspace_identity || null,
        resultCommitSha: row.result_commit_sha || null,
        patchDigest: row.patch_digest || null,
        resultAttemptId: row.result_attempt_id || null,
        createdAt: row.created_at,
        startedAt: row.started_at || null,
        completedAt: row.completed_at || null,
        updatedAt: row.updated_at,
      }));
    },

    getRunStep(runId, stepId) {
      return this.getRunSteps(runId).find((step) => step.stepId === stepId) || null;
    },

    updateRunStep(runId, stepId, patch = {}) {
      const columns = {
        state: 'state',
        attemptCount: 'attempt_count',
        capsuleDigest: 'capsule_digest',
        resultDigest: 'result_digest',
        workspaceIdentityStart: 'workspace_identity_start',
        workspaceIdentityEnd: 'workspace_identity_end',
        blockedReason: 'blocked_reason',
        executionWorkspaceId: 'execution_workspace_id',
        baseWorkspaceIdentity: 'base_workspace_identity',
        resultWorkspaceIdentity: 'result_workspace_identity',
        resultCommitSha: 'result_commit_sha',
        patchDigest: 'patch_digest',
        resultAttemptId: 'result_attempt_id',
        startedAt: 'started_at',
        completedAt: 'completed_at',
      };
      const assignments = [];
      const values = [];
      for (const [key, column] of Object.entries(columns)) {
        if (patch[key] === undefined) continue;
        assignments.push(`${column}=?`);
        values.push(patch[key]);
      }
      if (assignments.length === 0) return this.getRunStep(runId, stepId);
      db.prepare(`UPDATE run_steps SET ${assignments.join(', ')}, updated_at=? WHERE run_id=? AND step_id=?`).run(...values, now(), runId, stepId);
      return this.getRunStep(runId, stepId);
    },

    // A replan never edits an attempted step; it supersedes it, so what was tried
    // stays readable at its own plan revision.
    supersedeRunSteps(runId, { planRevision }) {
      db.prepare(`UPDATE run_steps SET state='superseded', updated_at=? WHERE run_id=? AND plan_revision=? AND state NOT IN ('passed','superseded','cancelled')`)
        .run(now(), runId, planRevision);
      return this.getRunSteps(runId);
    },

    setPlanRevision(runId, planRevision) {
      db.prepare(`UPDATE runs SET plan_revision=?, revision=revision+1, updated_at=? WHERE run_id=?`).run(Number(planRevision), now(), runId);
      return this.getRun(runId);
    },

    replaceRunPlanAtomic(runId, {
      currentPlanRevision,
      nextPlanRevision,
      steps = [],
      resumeBlockedReason = null,
    } = {}) {
      const replace = db.transaction(() => {
        const run = db.prepare(`
          SELECT plan_revision as planRevision, status, blocked_reason as blockedReason
          FROM runs WHERE run_id=?
        `).get(runId);
        if (!run) throw new Error(`Run ${runId} not found`);
        if (Number(run.planRevision) !== Number(currentPlanRevision)) {
          throw new Error(`PLAN_REVISION_CONFLICT: expected ${currentPlanRevision}, found ${run.planRevision}`);
        }
        const existingIds = new Set(db.prepare(`SELECT step_id as stepId FROM run_steps WHERE run_id=?`).all(runId).map((row) => row.stepId));
        for (const step of steps) {
          if (existingIds.has(step.stepId)) throw new Error(`STEP_ID_COLLISION: step "${step.stepId}" already exists`);
        }
        db.prepare(`
          UPDATE run_steps SET state='superseded', updated_at=?
          WHERE run_id=? AND plan_revision=? AND state NOT IN ('passed','superseded','cancelled')
        `).run(now(), runId, currentPlanRevision);
        const insert = db.prepare(`
          INSERT INTO run_steps(
            step_id, run_id, sequence, objective, state, plan_revision,
            dependency_ids_json, allowed_paths_json, forbidden_paths_json,
            acceptance_ids_json, obligation_ids_json, expected_outputs_json,
            assigned_role, synthetic, migration_origin, created_at, updated_at
          ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const step of steps) {
          insert.run(
            step.stepId, runId, Number(step.sequence) || 1, String(step.objective || ''),
            String(step.state || 'planned'), Number(step.planRevision) || nextPlanRevision,
            JSON.stringify(step.dependencyIds || []), JSON.stringify(step.allowedPaths || []),
            JSON.stringify(step.forbiddenPaths || []), JSON.stringify(step.acceptanceIds || []),
            JSON.stringify(step.obligationIds || []), JSON.stringify(step.expectedOutputs || []),
            String(step.assignedRole || 'implementer'), step.synthetic ? 1 : 0,
            step.migrationOrigin || null, now(), now(),
          );
        }
        db.prepare(`
          UPDATE runs
          SET plan_revision=?,
              replan_count=replan_count+1,
              intervention_count=intervention_count + CASE
                WHEN ? IS NOT NULL AND status='blocked' AND blocked_reason=? THEN 1 ELSE 0 END,
              status=CASE
                WHEN ? IS NOT NULL AND status='blocked' AND blocked_reason=? THEN 'active' ELSE status END,
              blocked_reason=CASE
                WHEN ? IS NOT NULL AND status='blocked' AND blocked_reason=? THEN NULL ELSE blocked_reason END,
              blocking_class=CASE
                WHEN ? IS NOT NULL AND status='blocked' AND blocked_reason=? THEN NULL ELSE blocking_class END,
              revision=revision+1,
              updated_at=?
          WHERE run_id=?
        `).run(
          nextPlanRevision,
          resumeBlockedReason, resumeBlockedReason,
          resumeBlockedReason, resumeBlockedReason,
          resumeBlockedReason, resumeBlockedReason,
          resumeBlockedReason, resumeBlockedReason,
          now(), runId,
        );
      });
      replace();
      return {
        run: this.getRun(runId),
        steps: this.getRunSteps(runId, { planRevision: nextPlanRevision }),
      };
    },

    recordStepAttempt(runId, {
      stepId,
      attemptId = null,
      bindingId = null,
      actorSessionId = null,
      capsuleDigest = null,
      capsuleId = null,
      admissionId = null,
      routeDecisionId = null,
      usageReceiptId = null,
      parentAttemptId = null,
      provenanceKind = 'owner-session',
      planRevision = null,
      mutationRevision = null,
      retryReason = null,
      failureCategory = null,
      workspaceIdentityStart = null,
      summary = null,
      changedPaths = [],
      workspaceId = null,
      workspaceRootHash = null,
      baseWorkspaceIdentity = null,
      verificationRefs = [],
      knowledgeObservationRefs = [],
      reportDigest = null,
    }) {
      const run = this.getRun(runId);
      if (!run) throw new Error(`Run ${runId} not found`);
      const step = stepId ? this.getRunStep(runId, stepId) : null;
      if (!step) throw new Error(`Run ${runId} step ${stepId || '<missing>'} not found`);
      const provenance = normalizeAttemptProvenance({
        attemptId,
        bindingId,
        capsuleId,
        capsuleDigest,
        admissionId,
        parentAttemptId,
        provenanceKind,
        planRevision: provenanceKind === 'legacy-unattributed'
          ? null
          : planRevision ?? step?.planRevision ?? run.planRevision ?? 1,
        mutationRevision: provenanceKind === 'legacy-unattributed'
          ? null
          : mutationRevision ?? run.mutationRevision ?? 0,
        retryReason,
        failureCategory,
      });
      const attemptNumber = this.nextStepAttemptNumber(runId, stepId);
      const result = db.prepare(`
        INSERT INTO run_step_attempts(attempt_id, run_id, step_id, attempt_number, binding_id, actor_session_id, capsule_id, capsule_digest, admission_id, route_decision_id, usage_receipt_id, parent_attempt_id, provenance_kind, plan_revision, mutation_revision, retry_reason, failure_category, report_digest, status, workspace_identity_start, summary, changed_paths_json, workspace_id, workspace_root_hash, base_workspace_identity, verification_refs_json, knowledge_observation_refs_json, started_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'started', ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        provenance.attemptId, runId, stepId, attemptNumber, provenance.bindingId, hashSessionId(actorSessionId), provenance.capsuleId,
        provenance.capsuleDigest, provenance.admissionId, routeDecisionId, usageReceiptId, provenance.parentAttemptId,
        provenance.provenanceKind, provenance.planRevision, provenance.mutationRevision, provenance.retryReason,
        provenance.failureCategory, reportDigest, workspaceIdentityStart, summary, JSON.stringify(changedPaths), workspaceId,
        workspaceRootHash, baseWorkspaceIdentity, JSON.stringify(verificationRefs), JSON.stringify(knowledgeObservationRefs), now(),
      );
      db.prepare(`UPDATE run_steps SET attempt_count=attempt_count+1, updated_at=? WHERE run_id=? AND step_id=?`).run(now(), runId, stepId);
      return this.getStepAttempt(result.lastInsertRowid);
    },

    finishStepAttempt(attemptId, { status = 'passed', workspaceIdentityEnd = null, resultWorkspaceIdentity = null, resultCommitSha = null, patchDigest = null, verificationRefs = null, knowledgeObservationRefs = null, resultDigest = null, failureReasons = [], failureCategory = null, retryReason = null, changedPaths = null } = {}) {
      const current = this.getStepAttempt(attemptId);
      if (!current) return null;
      const immutableResult = mergeImmutableReceiptFields(current, {
        workspaceIdentityEnd,
        resultWorkspaceIdentity: resultWorkspaceIdentity || workspaceIdentityEnd,
        resultCommitSha,
        patchDigest,
        resultDigest,
        changedPaths,
        verificationRefs,
        knowledgeObservationRefs,
      }, [
        'workspaceIdentityEnd',
        'resultWorkspaceIdentity',
        'resultCommitSha',
        'patchDigest',
        'resultDigest',
        'changedPaths',
        'verificationRefs',
        'knowledgeObservationRefs',
      ]);
      const assignments = ['status=?', 'finished_at=?', 'failure_reasons_json=?'];
      const values = [status, now(), JSON.stringify(failureReasons)];
      const immutableColumns = {
        workspaceIdentityEnd: 'workspace_identity_end',
        resultWorkspaceIdentity: 'result_workspace_identity',
        resultCommitSha: 'result_commit_sha',
        patchDigest: 'patch_digest',
        resultDigest: 'result_digest',
        changedPaths: 'changed_paths_json',
        verificationRefs: 'verification_refs_json',
        knowledgeObservationRefs: 'knowledge_observation_refs_json',
      };
      for (const [key, column] of Object.entries(immutableColumns)) {
        if (immutableResult[key] === undefined) continue;
        assignments.push(`${column}=?`);
        values.push(column.endsWith('_json') ? JSON.stringify(immutableResult[key]) : immutableResult[key]);
      }
      if (failureCategory !== null) { assignments.push('failure_category=?'); values.push(failureCategory); }
      if (retryReason !== null) { assignments.push('retry_reason=?'); values.push(retryReason); }
      db.prepare(`UPDATE run_step_attempts SET ${assignments.join(', ')} WHERE id=?`).run(...values, attemptId);
      const finished = this.getStepAttempt(attemptId);
      const run = finished ? this.getRun(finished.runId) : null;
      // A parallel worker finishes against its execution workspace after the
      // owner Delivery CAS has already advanced the Run. Its execution-time
      // revision is intentionally historical, so it must not overwrite the
      // single canonical owner mutation provenance row with worker paths or
      // worker identity. Direct owner reports either carry the current
      // revision or use a legacy null revision and retain the old behavior.
      const attemptOwnsCurrentRevision = finished
        && (finished.mutationRevision === null
          || finished.mutationRevision === undefined
          || Number(finished.mutationRevision) === Number(run?.mutationRevision));
      if (finished && attemptOwnsCurrentRevision && status === 'passed' && Array.isArray(finished.changedPaths) && finished.changedPaths.length > 0 && workspaceIdentityEnd) {
        this.recordMutationProvenance(finished.runId, {
          projectId: run?.projectId,
          workspaceId: finished.workspaceId || run?.workspaceId || null,
          sourceIdentity: run?.sourceIdentity,
          baseSourceIdentity: run?.sourceIdentity,
          mutationRevision: run?.mutationRevision || finished.mutationRevision || 0,
          changedPaths: finished.changedPaths,
          workspaceIdentity: finished.workspaceIdentityEnd || finished.resultWorkspaceIdentity,
          mutationDigest: finished.patchDigest || finished.resultDigest || finished.workspaceIdentityEnd || finished.resultWorkspaceIdentity,
          attemptId: finished.attemptId || null,
        });
      }
      return finished;
    },

    // Canonical attempt settlement and the exact report result are one durable
    // fact. Keep them in the same SQLite transaction so a process exit cannot
    // leave a passed attempt that can only replay as a synthetic result.
    finishStepAttemptWithReportResult(attemptId, finishOptions = {}, reportResult = null) {
      if (!attemptId || !reportResult) return null;
      return db.transaction(() => {
        const current = this.getStepAttemptByAttemptId(attemptId) || this.getStepAttempt(attemptId);
        if (!current) return null;
        const serialized = JSON.stringify(reportResult);
        if (current.reportResult) {
          if (JSON.stringify(current.reportResult) !== serialized) {
            throw Object.assign(new Error('canonical report result changed concurrently'), {
              code: 'STEP_REPORT_RESULT_IMMUTABLE_CONFLICT',
              errorCode: 'STEP_REPORT_RESULT_IMMUTABLE_CONFLICT',
            });
          }
          if (!['started', 'reported', 'verifying'].includes(current.status)) return current;
          return this.finishStepAttempt(current.id, finishOptions);
        }

        const finished = this.finishStepAttempt(current.id, finishOptions);
        if (!finished) return null;
        const persisted = db.prepare(`
          UPDATE run_step_attempts
          SET report_result_json=?
          WHERE id=? AND report_result_json IS NULL
        `).run(serialized, current.id);
        if (persisted.changes !== 1) {
          throw Object.assign(new Error('canonical report result changed concurrently'), {
            code: 'STEP_REPORT_RESULT_IMMUTABLE_CONFLICT',
            errorCode: 'STEP_REPORT_RESULT_IMMUTABLE_CONFLICT',
          });
        }
        return this.getStepAttempt(current.id);
      })();
    },

    updateStepAttempt(attemptId, patch = {}) {
      const current = this.getStepAttempt(attemptId);
      if (!current) return null;
      const columns = {
        actorSessionId: 'actor_session_id',
        bindingId: 'binding_id',
        capsuleId: 'capsule_id',
        capsuleDigest: 'capsule_digest',
        admissionId: 'admission_id',
        routeDecisionId: 'route_decision_id',
        usageReceiptId: 'usage_receipt_id',
        parentAttemptId: 'parent_attempt_id',
        provenanceKind: 'provenance_kind',
        planRevision: 'plan_revision',
        mutationRevision: 'mutation_revision',
        retryReason: 'retry_reason',
        failureCategory: 'failure_category',
        status: 'status',
        finishedAt: 'finished_at',
        workspaceId: 'workspace_id',
        workspaceRootHash: 'workspace_root_hash',
        baseWorkspaceIdentity: 'base_workspace_identity',
        workspaceIdentityEnd: 'workspace_identity_end',
        changedPaths: 'changed_paths_json',
        resultWorkspaceIdentity: 'result_workspace_identity',
        resultCommitSha: 'result_commit_sha',
        patchDigest: 'patch_digest',
        resultDigest: 'result_digest',
        workerReport: 'worker_report_json',
        verificationRefs: 'verification_refs_json',
        knowledgeObservationRefs: 'knowledge_observation_refs_json',
      };
      // Worker execution facts are write-once at the State Store boundary.
      // `recordStepResult` is the normal writer, but generic lineage/update
      // callers must not be able to rewrite a receipt after a Delivery CAS or
      // make an old attempt appear current during recovery.
      const immutableFields = [
        'mutationRevision',
        'workspaceId',
        'workspaceRootHash',
        'baseWorkspaceIdentity',
        'workspaceIdentityEnd',
        'changedPaths',
        'resultWorkspaceIdentity',
        'resultCommitSha',
        'patchDigest',
        'resultDigest',
        'workerReport',
        'verificationRefs',
        'knowledgeObservationRefs',
      ];
      // An owner-session report may be created before its direct workspace
      // observation advances the Run revision. That one pre-receipt binding is
      // lifecycle metadata, not a worker result replay. Routed attempts always
      // retain their execution-time revision, and every attempt becomes
      // write-once for it once a result identity/receipt exists.
      const hasExecutionReceipt = [
        'workspaceIdentityEnd',
        'resultWorkspaceIdentity',
        'resultCommitSha',
        'patchDigest',
        'resultDigest',
        'workerReport',
      ].some((field) => !receiptValueIsMissing(field, current[field]));
      const ownerPreReceiptRevisionAttach = patch.mutationRevision !== undefined
        && current.provenanceKind !== 'routed'
        && !hasExecutionReceipt;
      const immutableInput = { ...patch };
      if (ownerPreReceiptRevisionAttach) delete immutableInput.mutationRevision;
      const immutablePatch = mergeImmutableReceiptFields(current, immutableInput, immutableFields);
      const normalizedPatch = { ...patch };
      for (const field of immutableFields) delete normalizedPatch[field];
      if (ownerPreReceiptRevisionAttach) normalizedPatch.mutationRevision = patch.mutationRevision;
      Object.assign(normalizedPatch, immutablePatch);
      const assignments = [];
      const values = [];
      for (const [key, column] of Object.entries(columns)) {
        if (normalizedPatch[key] === undefined) continue;
        assignments.push(`${column}=?`);
        values.push(column.endsWith('_json') ? JSON.stringify(normalizedPatch[key]) : key === 'actorSessionId' ? hashSessionId(normalizedPatch[key]) : normalizedPatch[key]);
      }
      if (assignments.length === 0) return this.getStepAttempt(attemptId);
      db.prepare(`UPDATE run_step_attempts SET ${assignments.join(', ')} WHERE id=?`).run(...values, attemptId);
      return this.getStepAttempt(attemptId);
    },

    // A direct owner report can observe and advance the Run after its
    // pre-report attempt was opened. This narrowly-scoped transition binds
    // that owner-session lifecycle row before any execution receipt exists;
    // it cannot be used once result identity or worker evidence is present,
    // and it is intentionally not part of the generic updater.
    updateOwnerAttemptMutationRevision(attemptId, { expectedMutationRevision, mutationRevision } = {}) {
      // Callers hold the stable external attempt id; accept the integer row id
      // only as a compatibility fallback for older internal callers.
      const current = this.getStepAttemptByAttemptId(attemptId) || this.getStepAttempt(attemptId);
      if (!current) return null;
      const hasExecutionReceipt = [
        'workspaceIdentityEnd',
        'resultWorkspaceIdentity',
        'resultCommitSha',
        'patchDigest',
        'resultDigest',
        'workerReport',
      ].some((field) => !receiptValueIsMissing(field, current[field]));
      if (hasExecutionReceipt || Number(current.mutationRevision) !== Number(expectedMutationRevision)) {
        throw Object.assign(new Error('step result field mutationRevision is immutable for the canonical attempt'), {
          code: 'STEP_RESULT_IMMUTABLE_CONFLICT',
          errorCode: 'STEP_RESULT_IMMUTABLE_CONFLICT',
          field: 'mutationRevision',
        });
      }
      if (!Number.isInteger(Number(mutationRevision)) || Number(mutationRevision) < Number(expectedMutationRevision)) {
        throw Object.assign(new Error('owner attempt mutation revision must advance monotonically'), {
          code: 'STEP_RESULT_IMMUTABLE_CONFLICT',
          errorCode: 'STEP_RESULT_IMMUTABLE_CONFLICT',
          field: 'mutationRevision',
        });
      }
      const updated = db.prepare(`UPDATE run_step_attempts SET mutation_revision=? WHERE id=? AND mutation_revision=?`)
        .run(Number(mutationRevision), current.id, Number(expectedMutationRevision));
      if (updated.changes !== 1) {
        throw Object.assign(new Error('owner attempt mutation revision changed concurrently'), {
          code: 'STEP_RESULT_IMMUTABLE_CONFLICT',
          errorCode: 'STEP_RESULT_IMMUTABLE_CONFLICT',
          field: 'mutationRevision',
        });
      }
      return this.getStepAttempt(current.id);
    },

    // Canonical lineage attachment points. They address the stable external
    // attempt id; the integer row id remains an internal compatibility handle.
    attachAttemptLineage(attemptId, patch = {}) {
      const attempt = this.getStepAttemptByAttemptId(attemptId) || this.getStepAttempt(attemptId);
      if (!attempt) throw new Error(`attempt ${attemptId} not found`);
      return this.updateStepAttempt(attempt.id, patch);
    },

    getStepAttempt(id) {
      const row = db.prepare(`SELECT * FROM run_step_attempts WHERE id=?`).get(id);
      if (!row) return null;
      const provenanceKind = row.attempt_id && ATTEMPT_PROVENANCE_KINDS.includes(row.provenance_kind)
        ? row.provenance_kind
        : 'legacy-unattributed';
      const legacy = provenanceKind === 'legacy-unattributed';
      return {
        id: row.id,
        attemptId: row.attempt_id || null,
        runId: row.run_id,
        stepId: row.step_id,
        attemptNumber: row.attempt_number,
        bindingId: row.binding_id || null,
        actorSessionId: row.actor_session_id || null,
        capsuleId: row.capsule_id || null,
        capsuleDigest: row.capsule_digest || null,
        admissionId: row.admission_id || null,
        routeDecisionId: row.route_decision_id || null,
        usageReceiptId: row.usage_receipt_id || null,
        parentAttemptId: row.parent_attempt_id || null,
        provenanceKind,
        planRevision: legacy || row.plan_revision === null ? null : Number(row.plan_revision),
        mutationRevision: legacy || row.mutation_revision === null ? null : Number(row.mutation_revision),
        retryReason: row.retry_reason || null,
        failureCategory: row.failure_category || null,
        reportDigest: row.report_digest || null,
        reportResult: row.report_result_json ? safeJsonParse(row.report_result_json, null) : null,
        reviewClaimKey: row.review_claim_key || null,
        reviewClaimHolder: row.review_claim_holder || null,
        reviewClaimExpiresAt: row.review_claim_expires_at || null,
        status: row.status,
        workspaceIdentityStart: row.workspace_identity_start || null,
        workspaceIdentityEnd: row.workspace_identity_end || null,
        summary: row.summary || null,
        changedPaths: safeJsonParse(row.changed_paths_json, []),
        resultDigest: row.result_digest || null,
        failureReasons: safeJsonParse(row.failure_reasons_json, []),
        workspaceId: row.workspace_id || null,
        workspaceRootHash: row.workspace_root_hash || null,
        baseWorkspaceIdentity: row.base_workspace_identity || null,
        resultWorkspaceIdentity: row.result_workspace_identity || null,
        resultCommitSha: row.result_commit_sha || null,
        patchDigest: row.patch_digest || null,
        workerReport: row.worker_report_json ? safeJsonParse(row.worker_report_json, null) : null,
        verificationRefs: safeJsonParse(row.verification_refs_json, []),
        knowledgeObservationRefs: safeJsonParse(row.knowledge_observation_refs_json, []),
        startedAt: row.started_at,
        finishedAt: row.finished_at || null,
      };
    },

    getStepAttemptByAttemptId(attemptId, { runId = null } = {}) {
      if (!attemptId) return null;
      const row = runId
        ? db.prepare(`SELECT id FROM run_step_attempts WHERE attempt_id=? AND run_id=? LIMIT 1`).get(String(attemptId), runId)
        : db.prepare(`SELECT id FROM run_step_attempts WHERE attempt_id=? LIMIT 1`).get(String(attemptId));
      return row ? this.getStepAttempt(row.id) : null;
    },

    findStepAttemptByReportDigest(runId, reportDigest) {
      if (!runId || !reportDigest) return null;
      const row = db.prepare(`SELECT id FROM run_step_attempts WHERE run_id=? AND report_digest=? ORDER BY id DESC LIMIT 1`).get(runId, reportDigest);
      return row ? this.getStepAttempt(row.id) : null;
    },

    claimReviewAttempt({ runId, stepId, claimKey, holder, expiresAt, role = null, actionKind = null, obligationId = null, planRevision = null, mutationRevision = null } = {}) {
      if (!runId || !stepId || !claimKey || !holder || !expiresAt) return { claimed: false, reason: 'invalid-claim' };
      if (role !== 'reviewer' || !['review', 'review_engineering', 'review_contract'].includes(String(actionKind)) || !obligationId) return { claimed: false, reason: 'review-route-required' };
      try {
        return db.transaction(() => {
          const nowIso = now();
          const run = db.prepare('SELECT plan_revision, mutation_revision FROM runs WHERE run_id=?').get(runId);
          const subjectPlanRevision = Number(planRevision ?? run?.plan_revision);
          const subjectMutationRevision = Number(mutationRevision ?? run?.mutation_revision);
          if (!run || Number(run.plan_revision) !== subjectPlanRevision || Number(run.mutation_revision) !== subjectMutationRevision) return { claimed: false, reason: 'review-subject-stale' };

          const existing = db.prepare(`
            SELECT a.*
            FROM run_step_attempts a
            JOIN model_route_decisions d ON d.decision_id=a.route_decision_id
            WHERE a.run_id=? AND a.step_id=?
              AND a.plan_revision=? AND a.mutation_revision=?
              AND a.review_claim_key=?
              AND d.run_id=? AND d.role='reviewer'
              AND d.action_kind IN ('review','review_engineering','review_contract')
              AND d.obligation_id=? AND d.plan_revision=?
            LIMIT 1
          `).get(runId, stepId, subjectPlanRevision, subjectMutationRevision, claimKey, runId, obligationId, subjectPlanRevision);
          if (existing && existing.review_claim_holder === holder) return { claimed: true, existing: this.getStepAttempt(existing.id) };
          if (existing && existing.review_claim_expires_at > nowIso) return { claimed: false, existing: this.getStepAttempt(existing.id), reason: 'already-claimed' };

          // Reclaim expired rows inside the same transaction before choosing a
          // candidate. The old implementation selected only NULL claims first,
          // so an expired row made the dispatch report no-review-attempt and
          // could never be recovered after a crashed Host process.
          db.prepare(`
            UPDATE run_step_attempts
            SET review_claim_key=NULL, review_claim_holder=NULL, review_claim_expires_at=NULL
            WHERE id IN (
              SELECT a.id
              FROM run_step_attempts a
              JOIN model_route_decisions d ON d.decision_id=a.route_decision_id
              WHERE a.run_id=? AND a.step_id=?
                AND a.plan_revision=? AND a.mutation_revision=?
                AND a.review_claim_key IS NOT NULL
                AND a.review_claim_expires_at IS NOT NULL
                AND a.review_claim_expires_at<=?
                AND d.run_id=? AND d.role='reviewer'
                AND d.action_kind IN ('review','review_engineering','review_contract')
                AND d.obligation_id=? AND d.plan_revision=?
            )
          `).run(runId, stepId, subjectPlanRevision, subjectMutationRevision, nowIso, runId, obligationId, subjectPlanRevision);

          const candidate = db.prepare(`
            SELECT a.id
            FROM run_step_attempts a
            JOIN model_route_decisions d ON d.decision_id=a.route_decision_id
            WHERE a.run_id=? AND a.step_id=?
              AND a.plan_revision=? AND a.mutation_revision=?
              AND a.provenance_kind='routed'
              AND a.status IN ('started','verifying','reported')
              AND a.review_claim_key IS NULL
              AND d.run_id=? AND d.role='reviewer'
              AND d.action_kind IN ('review','review_engineering','review_contract')
              AND d.obligation_id=? AND d.plan_revision=?
            ORDER BY a.id ASC
            LIMIT 1
          `).get(runId, stepId, subjectPlanRevision, subjectMutationRevision, runId, obligationId, subjectPlanRevision);
          if (!candidate) return { claimed: false, reason: 'no-review-attempt' };

          const updated = db.prepare(`
            UPDATE run_step_attempts
            SET review_claim_key=?, review_claim_holder=?, review_claim_expires_at=?
            WHERE id=? AND run_id=? AND step_id=? AND plan_revision=? AND mutation_revision=? AND review_claim_key IS NULL
          `).run(claimKey, holder, expiresAt, candidate.id, runId, stepId, subjectPlanRevision, subjectMutationRevision);
          if (updated.changes !== 1) return { claimed: false, existing: this.getStepAttempt(candidate.id), reason: 'already-claimed' };
          return { claimed: true, existing: this.getStepAttempt(candidate.id) };
        })();
      } catch (error) {
        if (String(error?.message || '').includes('review_claim')) {
          const currentPlanRevision = Number(planRevision ?? db.prepare('SELECT plan_revision FROM runs WHERE run_id=?').get(runId)?.plan_revision);
          const row = db.prepare(`
            SELECT id FROM run_step_attempts
            WHERE run_id=? AND step_id=? AND plan_revision=? AND review_claim_key=?
            LIMIT 1
          `).get(runId, stepId, currentPlanRevision, claimKey);
          return { claimed: false, existing: row ? this.getStepAttempt(row.id) : null, reason: 'already-claimed' };
        }
        throw error;
      }
    },

    releaseReviewClaim(claimKey, holder, { runId = null, stepId = null, planRevision = null } = {}) {
      if (!claimKey || !holder) return false;
      const scope = [
        runId ? 'run_id=?' : null,
        stepId ? 'step_id=?' : null,
        planRevision === null || planRevision === undefined ? null : 'plan_revision=?',
      ].filter(Boolean);
      const values = [claimKey, holder, ...(runId ? [runId] : []), ...(stepId ? [stepId] : []), ...(planRevision === null || planRevision === undefined ? [] : [Number(planRevision)])];
      return db.prepare(`UPDATE run_step_attempts SET review_claim_key=NULL, review_claim_holder=NULL, review_claim_expires_at=NULL WHERE review_claim_key=? AND review_claim_holder=?${scope.length ? ` AND ${scope.join(' AND ')}` : ''}`).run(...values).changes === 1;
    },

    bindStepAttemptReportDigest(attemptId, reportDigest) {
      if (!attemptId || !reportDigest) return null;
      db.prepare(`UPDATE run_step_attempts SET report_digest=? WHERE attempt_id=? AND (report_digest IS NULL OR report_digest=?)`).run(reportDigest, String(attemptId), reportDigest);
      return this.getStepAttemptByAttemptId(attemptId);
    },

    setStepAttemptReportResult(attemptId, reportResult) {
      if (!attemptId || !reportResult) return null;
      const serialized = JSON.stringify(reportResult);
      const persisted = db.prepare(`
        UPDATE run_step_attempts
        SET report_result_json=?
        WHERE attempt_id=? AND (report_result_json IS NULL OR report_result_json=?)
      `).run(serialized, String(attemptId), serialized);
      if (persisted.changes !== 1) {
        const current = this.getStepAttemptByAttemptId(attemptId);
        if (current?.reportResult && JSON.stringify(current.reportResult) === serialized) return current;
        throw Object.assign(new Error('canonical report result changed concurrently'), {
          code: 'STEP_REPORT_RESULT_IMMUTABLE_CONFLICT',
          errorCode: 'STEP_REPORT_RESULT_IMMUTABLE_CONFLICT',
        });
      }
      return this.getStepAttemptByAttemptId(attemptId);
    },

    getActiveStepAttempt(runId, { stepId = null, attemptId = null, capsuleId = null } = {}) {
      const activeStatuses = ['started', 'reported', 'verifying'];
      if (attemptId) {
        const requested = this.getStepAttemptByAttemptId(attemptId, { runId });
        return requested && activeStatuses.includes(requested.status) ? requested : null;
      }
      const candidates = this.getStepAttempts(runId, { stepId })
        .filter((attempt) => !capsuleId || (attempt.capsuleId || attempt.capsuleDigest) === capsuleId)
        .filter((attempt) => activeStatuses.includes(attempt.status));
      return candidates.at(-1) || null;
    },

    getLatestImplementationAttempt(runId, { stepId = null } = {}) {
      return this.getStepAttempts(runId, { stepId })
        .filter((attempt) => attempt.provenanceKind !== 'legacy-unattributed')
        .filter((attempt) => {
          if (attempt.provenanceKind === 'owner-session') return true;
          if (attempt.provenanceKind !== 'routed') return false;
          // Routed reviewer turns use the same canonical attempt table as
          // implementations. Only the route decision's role can distinguish
          // those rows; legacy routed rows without a decision remain eligible
          // for backward-compatible implementation provenance.
          const decision = attempt.routeDecisionId
            ? this.getModelRouteDecision(attempt.routeDecisionId, { runId })
            : null;
          return !decision || decision.role === 'implementer';
        })
        .at(-1) || null;
    },

    getStepAttempts(runId, { stepId = null } = {}) {
      const rows = stepId
        ? db.prepare(`SELECT id FROM run_step_attempts WHERE run_id=? AND step_id=? ORDER BY id ASC`).all(runId, stepId)
        : db.prepare(`SELECT id FROM run_step_attempts WHERE run_id=? ORDER BY id ASC`).all(runId);
      return rows.map((row) => this.getStepAttempt(row.id));
    },

    nextStepAttemptNumber(runId, stepId) {
      const row = db.prepare(`SELECT MAX(attempt_number) as maxAttempt FROM run_step_attempts WHERE run_id=? AND step_id=?`).get(runId, stepId);
      return (row?.maxAttempt || 0) + 1;
    },

    // Execution capsules (K1). The capsule a worker actually received is
    // persisted, so a resumed process can hand out the same bounded context and
    // a report can be checked against the capsule it claims to answer.
    recordExecutionCapsule(runId, capsule) {
      if (!capsule?.capsuleId) throw new Error('recordExecutionCapsule requires a normalized capsule');
      if (capsule.runId !== runId) throw new Error(`capsule runId ${capsule.runId} does not match run ${runId}`);
      if (!this.getRun(runId)) throw new Error(`Run ${runId} not found`);
      db.prepare(`
        INSERT INTO run_capsules(capsule_id, run_id, step_id, role, plan_revision, mutation_revision, workspace_identity, route_decision_id, digest, capsule_json, created_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(capsule_id) DO NOTHING
      `).run(
        capsule.capsuleId, runId, capsule.stepId || null, capsule.role,
        Number(capsule.planRevision || 1),
        Number(capsule.mutationRevision ?? capsule.subject?.mutationRevision ?? 0),
        capsule.provenance.workspaceIdentity, capsule.provenance.routeDecisionId || null,
        capsule.provenance.capsuleDigest, persistentJson(capsule), capsule.createdAt,
      );
      return capsule;
    },

    getExecutionCapsule(capsuleId, { runId = null } = {}) {
      const row = db.prepare(`SELECT run_id as runId, capsule_json as capsuleJson FROM run_capsules WHERE capsule_id=?`).get(capsuleId);
      if (!row) return null;
      if (runId && row.runId !== runId) return null;
      return safeJsonParse(row.capsuleJson, null);
    },

    latestExecutionCapsule(runId, { role = 'implementer', stepId = null } = {}) {
      const row = stepId
        ? db.prepare(`SELECT capsule_json as capsuleJson FROM run_capsules WHERE run_id=? AND role=? AND step_id=? ORDER BY rowid DESC LIMIT 1`).get(runId, role, stepId)
        : db.prepare(`SELECT capsule_json as capsuleJson FROM run_capsules WHERE run_id=? AND role=? ORDER BY rowid DESC LIMIT 1`).get(runId, role);
      return row ? safeJsonParse(row.capsuleJson, null) : null;
    },

    listExecutionCapsules(runId) {
      return db.prepare(`SELECT capsule_json as capsuleJson FROM run_capsules WHERE run_id=? ORDER BY rowid ASC`).all(runId)
        .map((row) => safeJsonParse(row.capsuleJson, null)).filter(Boolean);
    },

    // Review receipts (K0). A judgment obligation is proven by a receipt whose
    // reviewer lineage and reviewed subject are both persisted, so a later
    // completion check can re-derive whether the review still holds.
    recordReviewReceipt(runId, receipt) {
      const normalized = normalizeReviewReceipt(sanitizePersistentPayload({ ...receipt, runId: receipt?.runId || runId }));
      if (normalized.runId !== runId) throw new Error(`review receipt runId ${normalized.runId} does not match run ${runId}`);
      if (!this.getRun(runId)) throw new Error(`Run ${runId} not found`);
      const implementerAttempt = normalized.implementerAttemptId
        ? this.getStepAttemptByAttemptId(normalized.implementerAttemptId, { runId })
        : null;
      if (normalized.implementerAttemptId && !implementerAttempt) {
        throw new Error(`review receipt references implementer attempt ${normalized.implementerAttemptId}, which does not belong to run ${runId}`);
      }
      if (implementerAttempt && normalized.stepId && implementerAttempt.stepId !== normalized.stepId) {
        throw new Error(`review receipt step ${normalized.stepId} does not match implementer attempt step ${implementerAttempt.stepId}`);
      }
      const reviewerUsage = normalized.reviewer.usageReceiptId
        ? this.getModelUsageReceipt(normalized.reviewer.usageReceiptId, { runId })
        : null;
      if (reviewerUsage?.stepId && normalized.stepId && reviewerUsage.stepId !== normalized.stepId) {
        throw new Error(`review receipt step ${normalized.stepId} does not match reviewer usage step ${reviewerUsage.stepId || '<legacy>'}`);
      }
      if (reviewerUsage?.bindingId && normalized.reviewerBindingId && reviewerUsage.bindingId !== normalized.reviewerBindingId) {
        throw new Error(`review receipt reviewer binding ${normalized.reviewerBindingId} does not match reviewer usage binding ${reviewerUsage.bindingId || '<missing>'}`);
      }
      db.prepare(`
        INSERT INTO review_receipts(receipt_id, run_id, obligation_id, step_id, reviewer_binding_id, implementer_attempt_id, review_stage, verdict, finding_class, plan_revision, reviewer_usage_receipt_id, implementer_usage_receipt_id, reviewer_session_id, implementer_session_id, route_decision_id, model_class, resolved_model, enforcement_status, workspace_identity, mutation_revision, changed_paths_digest, evidence_digest, acceptance_coverage_json, findings_json, rationale, digest, receipt_json, created_by_version, migration_origin, created_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(receipt_id) DO NOTHING
      `).run(
        normalized.receiptId, runId, normalized.obligationId, normalized.stepId, normalized.reviewerBindingId, normalized.implementerAttemptId, normalized.reviewStage, normalized.verdict,
        normalized.findingClass, normalized.planRevision,
        normalized.reviewer.usageReceiptId, normalized.implementer.usageReceiptId,
        normalized.reviewer.actorSessionId, normalized.implementer.actorSessionId,
        normalized.reviewer.routeDecisionId, normalized.reviewer.modelClass, normalized.reviewer.resolvedModel,
        normalized.reviewer.enforcementStatus,
        normalized.subject.workspaceIdentity, normalized.subject.mutationRevision,
        normalized.subject.changedPathsDigest, normalized.subject.evidenceDigest,
        JSON.stringify(normalized.acceptanceCoverage), JSON.stringify(normalized.findings),
        sanitizePersistentText(normalized.rationale), normalized.digest, persistentJson(normalized),
        normalized.createdByVersion, normalized.migrationOrigin, normalized.createdAt,
      );
      return normalized;
    },

    getReviewReceipt(receiptId, { runId = null } = {}) {
      const row = db.prepare(`SELECT run_id as runId, receipt_json as receiptJson FROM review_receipts WHERE receipt_id=?`).get(receiptId);
      if (!row) return null;
      if (runId && row.runId !== runId) return null;
      return safeJsonParse(row.receiptJson, null);
    },

    listReviewReceipts(runId, { obligationId = null } = {}) {
      const rows = obligationId
        ? db.prepare(`SELECT receipt_json as receiptJson FROM review_receipts WHERE run_id=? AND obligation_id=? ORDER BY rowid ASC`).all(runId, obligationId)
        : db.prepare(`SELECT receipt_json as receiptJson FROM review_receipts WHERE run_id=? ORDER BY rowid ASC`).all(runId);
      return rows.map((row) => safeJsonParse(row.receiptJson, null)).filter(Boolean);
    },

    // Reviewer independence at T3 is checked against the session that actually
    // implemented, not against a caller-supplied string (§9.2).
    getLatestImplementationSession(runId) {
      const row = db.prepare(`
        SELECT u.receipt_id as receiptId, u.actor_session_id as actorSessionId, u.decision_id as decisionId,
               u.attempt_id as attemptId, u.binding_id as bindingId,
               u.step_id as stepId,
               u.capsule_id as capsuleId, u.capsule_digest as capsuleDigest, u.resolved_model as resolvedModel,
               d.model_class as modelClass, d.action_kind as actionKind
        FROM model_usage_receipts u JOIN model_route_decisions d ON d.decision_id = u.decision_id
        WHERE u.run_id=? AND d.role='implementer' ORDER BY u.rowid DESC LIMIT 1
      `).get(runId);
      return row || null;
    },

    // The two-command CLI path has no provider usage receipt for the model
    // that owns and reports the mutation. Its Host-created owner binding is
    // nevertheless durable implementation provenance: every mutating report
    // is preflighted against this exact binding. Use it only as a fallback;
    // a routed implementation receipt remains the stronger authority.
    getImplementationPrincipal(runId) {
      const routed = this.getLatestImplementationSession(runId);
      if (routed) return routed;
      const owner = db.prepare(`
        SELECT b.binding_id as bindingId, b.session_id as sessionId
        FROM runs r
        JOIN session_bindings b ON b.binding_id=r.owner_binding_id
        WHERE r.run_id=? AND b.run_id=r.run_id
          AND b.access_mode='owner' AND b.status='active'
        LIMIT 1
      `).get(runId);
      if (!owner?.sessionId) return null;
      return {
        receiptId: null,
        actorSessionId: `sha256:${createHash('sha256').update(String(owner.sessionId)).digest('hex')}`,
        decisionId: null,
        attemptId: null,
        capsuleId: null,
        capsuleDigest: null,
        resolvedModel: null,
        modelClass: 'owner-session',
        actionKind: 'manual-implementation',
        bindingId: owner.bindingId,
      };
    },

    listKnowledgeRecords({ projectId, statuses = ['verified', 'committed'] } = {}) {
      if (!projectId) return [];
      const placeholders = statuses.map(() => '?').join(',');
      const rows = db.prepare(`SELECT record_json as recordJson FROM knowledge_records WHERE project_id=? AND status IN (${placeholders})`).all(projectId, ...statuses);
      return rows.map((r) => safeJsonParse(r.recordJson, null)).filter(Boolean);
    },

    commitKnowledgeTransaction({ transactionId, runId, projectId, expectedRevision = null, records = null, supersessions = [], provenance = {}, faultInjection = null, noChange = false }) {
      db.exec('BEGIN IMMEDIATE TRANSACTION');
      try {
        const run = this.getRun(runId);
        if (!run) {
          throw new Error(`RUN_NOT_FOUND: Run ${runId} not found`);
        }
        const completion = this.getCompletionDecision(runId);
        if (!completion || completion.decision !== 'accepted') {
          throw new Error('COMPLETION_NOT_ACCEPTED: Transaction commit requires accepted completion decision');
        }
        if (run.projectId !== projectId) {
          throw new Error(`PROJECT_ID_MISMATCH: Run project ${run.projectId} != ${projectId}`);
        }

        const reviewReceipt = this.getKnowledgeReviewReceipt(runId);
        if (reviewReceipt && !['passed', 'no_candidates'].includes(reviewReceipt.status)) {
          throw new Error(`KNOWLEDGE_REVIEW_NOT_PASSED: Cannot commit knowledge when review status is ${reviewReceipt.status}`);
        }

        const currentRev = this.getProjectKnowledgeRevision(projectId);
        if (expectedRevision !== null && expectedRevision !== undefined && Number(expectedRevision) !== Number(currentRev)) {
          throw new Error(`STALE_KNOWLEDGE_REVISION: Expected revision ${expectedRevision} but found ${currentRev}`);
        }

        if (faultInjection === 'after_records_before_revision') {
          throw new Error('FAULT_INJECTION_AFTER_RECORDS');
        }

        // If records parameter is omitted, query verified candidates from DB (Task 10.3)
        let recordsToCommit = records;
        if (recordsToCommit === null || recordsToCommit === undefined) {
          const rawCandidates = this.getKnowledgeCandidates(runId);
          recordsToCommit = rawCandidates
            .filter((c) => c.status === 'verified')
            .map((c) => mapCandidateToCanonicalRecord(c.candidateJson || c, { runId, projectId, revision: currentRev + 1 }));
        }

        const existingRecords = db.prepare(`SELECT record_id, record_type, record_json FROM knowledge_records WHERE project_id=? AND status='committed'`).all(projectId);
        const existingIdentities = new Set(existingRecords.map((r) => {
          try {
            const parsed = JSON.parse(r.record_json);
            return canonicalKnowledgeIdentity({
              recordType: r.record_type,
              statement: parsed.statement,
              scope: parsed.scope,
            });
          } catch {
            return null;
          }
        }).filter(Boolean));

        const seenBatchIdentities = new Set();
        const deduplicatedRecords = [];
        for (const rec of (recordsToCommit || [])) {
          const recType = rec.type || rec.record_type || rec.proposedType;
          const identity = canonicalKnowledgeIdentity({
            recordType: recType,
            statement: rec.statement,
            scope: rec.scope,
          });
          if (seenBatchIdentities.has(identity) || existingIdentities.has(identity)) {
            continue;
          }
          seenBatchIdentities.add(identity);
          deduplicatedRecords.push(rec);
        }
        recordsToCommit = deduplicatedRecords;

        let activeSupersessions = [];
        if (Array.isArray(supersessions) && supersessions.length > 0) {
          const placeholders = supersessions.map(() => '?').join(',');
          const supRows = db.prepare(`SELECT record_id FROM knowledge_records WHERE project_id=? AND record_id IN (${placeholders}) AND status='committed'`).all(projectId, ...supersessions);
          activeSupersessions = supRows.map((r) => r.record_id);
        }

        const isNoChange = noChange || (recordsToCommit.length === 0 && activeSupersessions.length === 0);

        if (isNoChange) {
          const receiptPayload = {
            runId,
            projectId,
            revisionBefore: String(currentRev),
            revisionAfter: String(currentRev),
            status: 'no_change',
            committedCount: 0,
            completionDecisionRef: completion.evidenceDigest || null,
            knowledgeReviewRef: reviewReceipt?.reviewDigest || null,
          };

          db.prepare(`
            INSERT INTO knowledge_commit_receipts(run_id, project_id, revision_before, revision_after, status, receipt_json, created_at)
            VALUES(?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(run_id) DO UPDATE SET revision_before=excluded.revision_before, revision_after=excluded.revision_after, status=excluded.status, receipt_json=excluded.receipt_json, created_at=excluded.created_at
          `).run(runId, projectId, String(currentRev), String(currentRev), 'no_change', JSON.stringify(receiptPayload), now());

          db.prepare(`UPDATE runs SET knowledge_revision_close=?, knowledge_status=?, updated_at=? WHERE run_id=?`).run(String(currentRev), 'no_change', now(), runId);

          db.exec('COMMIT');
          return { revisionBefore: String(currentRev), revisionAfter: String(currentRev), status: 'no_change', receipt: receiptPayload };
        }

        const nextRev = currentRev + 1;

        for (const rec of recordsToCommit) {
          const recId = rec.id || rec.candidateId;
          const recType = rec.type || rec.proposedType || 'semantic_fact';
          const recPayload = { ...rec, status: 'committed', revision: nextRev };
          db.prepare(`
            INSERT INTO knowledge_records(project_id, record_id, record_type, status, trust_tier, record_json, revision, created_at, updated_at)
            VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(project_id, record_id) DO UPDATE SET record_type=excluded.record_type, status=excluded.status, trust_tier=excluded.trust_tier, record_json=excluded.record_json, revision=excluded.revision, updated_at=excluded.updated_at
          `).run(projectId, recId, recType, 'committed', rec.trustTier || 'verified', JSON.stringify(recPayload), nextRev, now(), now());
        }

        for (const supId of activeSupersessions) {
          db.prepare(`UPDATE knowledge_records SET status='superseded', updated_at=? WHERE project_id=? AND record_id=?`).run(now(), projectId, supId);
        }

        const casSuccess = this.updateProjectKnowledgeRevision(projectId, currentRev, nextRev);
        if (!casSuccess) {
          throw new Error(`STALE_KNOWLEDGE_REVISION: Revision CAS increment failed for ${projectId}`);
        }

        const txJson = JSON.stringify({ transactionId, runId, projectId, expectedRevision: currentRev, targetRevision: nextRev, recordsCount: recordsToCommit.length, provenance });
        db.prepare(`
          INSERT INTO knowledge_transactions(transaction_id, project_id, run_id, expected_revision, target_revision, status, transaction_json, created_at, completed_at)
          VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(transaction_id) DO UPDATE SET status='completed', completed_at=excluded.completed_at
        `).run(transactionId, projectId, runId, currentRev, nextRev, 'completed', txJson, now(), now());

        const receiptPayload = {
          runId,
          projectId,
          revisionBefore: String(currentRev),
          revisionAfter: String(nextRev),
          status: 'committed',
          committedCount: recordsToCommit.length,
          completionDecisionRef: completion.evidenceDigest || null,
          knowledgeReviewRef: reviewReceipt?.reviewDigest || null,
        };

        db.prepare(`
          INSERT INTO knowledge_commit_receipts(run_id, project_id, revision_before, revision_after, status, receipt_json, created_at)
          VALUES(?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(run_id) DO UPDATE SET revision_before=excluded.revision_before, revision_after=excluded.revision_after, status=excluded.status, receipt_json=excluded.receipt_json, created_at=excluded.created_at
        `).run(runId, projectId, String(currentRev), String(nextRev), 'committed', JSON.stringify(receiptPayload), now());

        db.prepare(`UPDATE runs SET knowledge_revision_close=?, knowledge_status=?, updated_at=? WHERE run_id=?`).run(String(nextRev), 'committed', now(), runId);

        db.exec('COMMIT');
        return { revisionBefore: String(currentRev), revisionAfter: String(nextRev), status: 'committed', receipt: receiptPayload };
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },

    getProjectKnowledgeRevision(projectId) {
      const row = db.prepare(`SELECT revision FROM knowledge_revisions WHERE project_id=?`).get(projectId);
      return row ? Number(row.revision) : 1;
    },

    updateProjectKnowledgeRevision(projectId, expectedRevision, nextRevision) {
      const existing = db.prepare(`SELECT revision FROM knowledge_revisions WHERE project_id=?`).get(projectId);
      if (!existing) {
        db.prepare(`INSERT INTO knowledge_revisions(project_id, revision, updated_at) VALUES(?, ?, ?)`).run(projectId, nextRevision, now());
        return true;
      }
      const res = db.prepare(`UPDATE knowledge_revisions SET revision=?, updated_at=? WHERE project_id=? AND revision=?`).run(nextRevision, now(), projectId, expectedRevision);
      return res.changes === 1;
    },

    saveKnowledgeRecord(projectId, recordId, { recordType = 'semantic_fact', status = 'committed', trustTier = 'verified', recordJson = {}, revision = 1 } = {}) {
      db.prepare(`
        INSERT INTO knowledge_records(project_id, record_id, record_type, status, trust_tier, record_json, revision, created_at, updated_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id, record_id) DO UPDATE SET record_type=excluded.record_type, status=excluded.status, trust_tier=excluded.trust_tier, record_json=excluded.record_json, revision=excluded.revision, updated_at=excluded.updated_at
      `).run(projectId, recordId, recordType, status, trustTier, typeof recordJson === 'string' ? recordJson : JSON.stringify(recordJson), revision, now(), now());
    },

    saveKnowledgeTransaction(transactionId, { projectId, runId, expectedRevision, targetRevision, status, transactionJson }) {
      db.prepare(`
        INSERT INTO knowledge_transactions(transaction_id, project_id, run_id, expected_revision, target_revision, status, transaction_json, created_at, completed_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(transaction_id) DO UPDATE SET status=excluded.status, completed_at=excluded.completed_at
      `).run(transactionId, projectId, runId, expectedRevision, targetRevision, status, typeof transactionJson === 'string' ? transactionJson : JSON.stringify(transactionJson), now(), now());
    },

    recordKnowledgeApproval(approvalId, { runId, candidateId, approvedBy, approvalReceipt }) {
      if (!runId || !candidateId || !approvedBy || !approvalReceipt) {
        throw new Error('recordKnowledgeApproval requires runId, candidateId, approvedBy, and approvalReceipt');
      }
      db.prepare(`
        INSERT INTO knowledge_approvals(approval_id, run_id, candidate_id, approved_by, approval_receipt, created_at)
        VALUES(?, ?, ?, ?, ?, ?)
        ON CONFLICT(approval_id) DO UPDATE SET approved_by=excluded.approved_by, approval_receipt=excluded.approval_receipt
      `).run(approvalId, runId, candidateId, approvedBy, approvalReceipt, now());
    },

    getKnowledgeApproval(runId, candidateId) {
      return db.prepare(`SELECT approval_id as approvalId, run_id as runId, candidate_id as candidateId, approved_by as approvedBy, approval_receipt as approvalReceipt, created_at as createdAt FROM knowledge_approvals WHERE run_id=? AND candidate_id=?`).get(runId, candidateId) || null;
    },

    getKnowledgeApprovals(runId) {
      return db.prepare(`SELECT approval_id as approvalId, run_id as runId, candidate_id as candidateId, approved_by as approvedBy, approval_receipt as approvalReceipt, created_at as createdAt FROM knowledge_approvals WHERE run_id=?`).all(runId);
    },

    getDeferredKnowledgeRuns(projectId, { limit = 1, excludeRunId = null, retryableOnly = false } = {}) {
      if (!projectId) return [];
      let query = `SELECT run_id as runId, project_id as projectId, receipt_json as receiptJson, created_at as createdAt FROM knowledge_commit_receipts WHERE project_id=? AND status='deferred'`;
      const params = [projectId];
      if (excludeRunId) {
        query += ` AND run_id != ?`;
        params.push(excludeRunId);
      }
      query += ` ORDER BY created_at ASC`;
      if (!retryableOnly) {
        query += ` LIMIT ?`;
        params.push(limit);
      } else {
        query += ` LIMIT ?`;
        params.push(Math.max(limit * 32, 64));
      }
      const rows = db.prepare(query).all(...params);
      const mapped = rows.map((r) => ({
        runId: r.runId,
        projectId: r.projectId,
        receipt: safeJsonParse(r.receiptJson, null),
        createdAt: r.createdAt,
      }));

      if (!retryableOnly) return mapped;

      const RETRYABLE_REASONS = new Set([
        'cas_retry_exhausted',
        'concurrent_lock_timeout',
        'stale_revision',
      ]);
      const filtered = mapped.filter((r) => {
        const reason = r.receipt?.reason;
        return RETRYABLE_REASONS.has(reason) || (typeof reason === 'string' && (reason.includes('conflict') || reason.includes('exhausted')));
      });
      return filtered.slice(0, limit);
    },

    transition(runId, nextState, { expectedState, expectedRevision } = {}) {
      db.exec('BEGIN IMMEDIATE TRANSACTION');
      try {
        const run = this.getRun(runId);
        if (!run) throw new Error(`Run ${runId} not found`);
        if (run.status === 'completed') throw new Error(`Cannot transition run ${runId} in completed state`);

        if (expectedState && run.state !== expectedState) {
          throw new Error(`STATE_CONFLICT: Expected state ${expectedState} but found ${run.state} for run ${runId}`);
        }
        if (expectedRevision !== undefined && run.revision !== expectedRevision) {
          throw new Error(`STALE_RUN_REVISION: Expected revision ${expectedRevision} but found ${run.revision} for run ${runId}`);
        }

        if (!canTransition(run.state, nextState)) {
          throw new Error(`Invalid Kernel transition ${run.state} -> ${nextState}`);
        }

        const res = db.prepare(`
          UPDATE runs
          SET state=?, revision=revision+1, updated_at=?
          WHERE run_id=? AND state=? AND revision=?
        `).run(nextState, now(), runId, run.state, run.revision);

        if (res.changes !== 1) {
          throw new Error(`STATE_CONFLICT: Concurrent state or revision modification for run ${runId}`);
        }

        db.exec('COMMIT');
        return this.getRun(runId);
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },

    recordVerification(runId, { obligationId = 'default', status, evidenceRef, sourceIdentity, command, commandRef = null, exitCode = 0, evidenceDigest, acceptanceCoverage = [], verifiedSourceIdentity = null, executor = 'caller-attested', networkIsolation = null, evidenceClass = null, evidenceIdentity = null, reuseOfVerificationId = null, reuseReceipt = null }) {
      const run = this.getRun(runId);
      if (!run) throw new Error(`Run ${runId} not found`);
      if (run.status === 'completed') throw new Error(`Cannot add verification to completed run ${runId}`);
      if (run.state !== 'PROVE') throw new Error(`Verification can only be recorded in PROVE state for run ${runId}`);
      if (!['passed', 'failed'].includes(status)) throw new Error(`Invalid verification status: ${status}`);
      sourceIdentity = sourceIdentity || run.sourceIdentity;
      if (!sourceIdentity || typeof sourceIdentity !== 'string' || !sourceIdentityRegex.test(sourceIdentity) || sourceIdentity !== run.sourceIdentity) {
        throw new Error('sourceIdentity is required and must be a valid candidate identity string for verification');
      }
      if (verifiedSourceIdentity !== null && !sha256Regex.test(verifiedSourceIdentity)) {
        throw new Error('verifiedSourceIdentity must be a sha256:<hex> workspace identity when provided');
      }
      if (!['kernel-runtime', 'caller-attested'].includes(executor)) {
        throw new Error(`Invalid verification executor: ${executor}`);
      }
      if (executor === 'kernel-runtime' && !verifiedSourceIdentity) {
        throw new Error('kernel-runtime verification requires the verifiedSourceIdentity it was executed against');
      }

      // Obligation binding (P0-2). A declared obligation fixes HOW it may be
      // satisfied; a Kernel execution may only be recorded against it when the
      // command it ran is bound to that obligation. Undeclared obligation names
      // are recorded as ad-hoc evidence that can never satisfy a required one.
      const declared = this.getRunObligation(runId, obligationId);
      const normalizedAcceptanceCoverage = normalizeAcceptanceCoverage({
        contract: run.taskContract || {},
        acceptanceCriteria: run.acceptanceCriteria || [],
        obligation: declared,
        coverage: acceptanceCoverage,
      });
      if (declared && declared.sourceType !== 'ad-hoc' && executor === 'kernel-runtime') {
        assertCommandBinding(declared, commandRef);
      }
      if (!declared) {
        this.ensureRunObligation(runId, {
          obligationId,
          sourceType: 'ad-hoc',
          sourceRef: 'reported-verification',
          evidenceClass: executor === 'kernel-runtime' ? 'hard' : 'attested',
          status: 'optional',
        });
      }
      // The class is a fact about how this evidence was produced, never a
      // caller assertion: only the Kernel running a bound command is `hard`.
      const resolvedEvidenceClass = executor === 'kernel-runtime'
        ? 'hard'
        : (evidenceClass === 'judgment' ? 'judgment' : 'attested');

      db.exec('BEGIN IMMEDIATE TRANSACTION');
      try {
        db.prepare(`
          INSERT INTO verifications(run_id, obligation_id, status, evidence_ref, verified_runtime_revision, verified_mutation_revision, source_identity, verified_source_identity, executor, network_isolation, command_ref, command, exit_code, evidence_digest, acceptance_coverage, evidence_class, contract_revision, evidence_identity_json, reuse_of_verification_id, reuse_receipt_json, observed_at)
          VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(runId, obligationId, status, evidenceRef || null, run.revision, run.mutationRevision, sourceIdentity, verifiedSourceIdentity, executor, networkIsolation, commandRef || null, command || null, exitCode, evidenceDigest || null, JSON.stringify(normalizedAcceptanceCoverage), resolvedEvidenceClass, Number(run.contractRevision || 1), persistentJson(evidenceIdentity || {}), reuseOfVerificationId || null, reuseReceipt ? persistentJson(reuseReceipt) : null, now());

        if (evidenceDigest && sha256Regex.test(evidenceDigest)) {
          db.prepare(`INSERT INTO evidence_lineage(run_id, evidence_digest, created_at) VALUES(?, ?, ?)`).run(runId, evidenceDigest, now());
        }

        if (status === 'passed') {
          db.prepare(`UPDATE run_obligations SET status='passed', updated_at=? WHERE run_id=? AND obligation_id=?`).run(now(), runId, obligationId);
        }

        db.prepare('UPDATE runs SET revision=revision+1, updated_at=? WHERE run_id=?').run(now(), runId);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }

      return this.getRun(runId);
    },

    recordEvidencePack(runId, { tier, pack, digest, mutationRevision }) {
      const run = this.getRun(runId);
      if (!run) throw new Error(`Run ${runId} not found`);
      if (!tier || !pack || !digest || !sha256Regex.test(digest) || mutationRevision !== run.mutationRevision) throw new Error('Evidence pack requires a tier, pack, sha256 digest, and current mutation revision');
      if (tier === 'E2' && !Array.isArray(pack.qaReport?.checks)) throw new Error('E2 release evidence must persist its QA checks');
      db.prepare(`INSERT INTO evidence_packs(run_id, tier, digest, pack_json, mutation_revision, created_at) VALUES(?, ?, ?, ?, ?, ?)`)
        .run(runId, tier, digest, JSON.stringify(pack), mutationRevision, now());
      return { runId, tier, digest, mutationRevision };
    },

    getVerifications(runId) {
      return db.prepare(`SELECT id, run_id as runId, obligation_id as obligationId, status, evidence_ref as evidenceRef, verified_runtime_revision as verifiedRuntimeRevision, verified_mutation_revision as verifiedMutationRevision, source_identity as sourceIdentity, verified_source_identity as verifiedSourceIdentity, executor, network_isolation as networkIsolation, command_ref as commandRef, command, exit_code as exitCode, evidence_digest as evidenceDigest, acceptance_coverage as acceptanceCoverage, evidence_class as evidenceClass, contract_revision as contractRevision, evidence_identity_json as evidenceIdentityJson, reuse_of_verification_id as reuseOfVerificationId, reuse_receipt_json as reuseReceiptJson, observed_at as observedAt FROM verifications WHERE run_id=? AND id IN (SELECT MAX(v2.id) FROM verifications v2 WHERE v2.run_id=? GROUP BY v2.obligation_id) ORDER BY id ASC`).all(runId, runId).map((v) => ({ ...v, acceptanceCoverage: safeJsonParse(v.acceptanceCoverage), evidenceIdentity: safeJsonParse(v.evidenceIdentityJson, {}), reuseReceipt: v.reuseReceiptJson ? safeJsonParse(v.reuseReceiptJson, null) : null }));
    },

    // Review capsules need the complete current-revision evidence trail, not
    // only the latest row per obligation. The completion gate continues to use
    // getVerifications()'s latest-row projection; this history is presentation
    // evidence for an independent reviewer and is never itself authoritative.
    getVerificationHistory(runId) {
      return db.prepare(`SELECT id, run_id as runId, obligation_id as obligationId, status, evidence_ref as evidenceRef, verified_runtime_revision as verifiedRuntimeRevision, verified_mutation_revision as verifiedMutationRevision, source_identity as sourceIdentity, verified_source_identity as verifiedSourceIdentity, executor, network_isolation as networkIsolation, command_ref as commandRef, command, exit_code as exitCode, evidence_digest as evidenceDigest, acceptance_coverage as acceptanceCoverage, evidence_class as evidenceClass, contract_revision as contractRevision, evidence_identity_json as evidenceIdentityJson, reuse_of_verification_id as reuseOfVerificationId, reuse_receipt_json as reuseReceiptJson, observed_at as observedAt FROM verifications WHERE run_id=? ORDER BY id ASC`).all(runId).map((v) => ({ ...v, acceptanceCoverage: safeJsonParse(v.acceptanceCoverage), evidenceIdentity: safeJsonParse(v.evidenceIdentityJson, {}), reuseReceipt: v.reuseReceiptJson ? safeJsonParse(v.reuseReceiptJson, null) : null }));
    },

    findExactReusableVerification({ projectId, obligationId, evidenceIdentity, contractRevision = null } = {}) {
      if (!projectId || !obligationId || !evidenceIdentity) return null;
      const contractClause = contractRevision === null || contractRevision === undefined
        ? ''
        : ' AND v.contract_revision=?';
      const params = contractRevision === null || contractRevision === undefined
        ? [projectId, obligationId]
        : [projectId, obligationId, Number(contractRevision)];
      const rows = db.prepare(`
        SELECT v.id, v.run_id as runId, v.obligation_id as obligationId, v.status,
               v.evidence_ref as evidenceRef, v.verified_mutation_revision as verifiedMutationRevision,
               v.source_identity as sourceIdentity, v.verified_source_identity as verifiedSourceIdentity,
               v.executor, v.command, v.exit_code as exitCode, v.evidence_digest as evidenceDigest,
               v.evidence_identity_json as evidenceIdentityJson, v.contract_revision as contractRevision,
               v.observed_at as observedAt,
               r.project_id as projectId
        FROM verifications v
        JOIN runs r ON r.run_id=v.run_id
        WHERE r.project_id=? AND v.obligation_id=? AND v.status='passed' AND v.exit_code=0
          AND v.evidence_digest IS NOT NULL
          ${contractClause}
          AND v.id IN (
            SELECT MAX(v2.id) FROM verifications v2
            WHERE v2.run_id=v.run_id AND v2.obligation_id=v.obligation_id
          )
        ORDER BY v.id DESC
      `).all(...params);
      for (const row of rows) {
        const candidate = { ...row, evidenceIdentity: safeJsonParse(row.evidenceIdentityJson, {}) };
        if (exactEvidenceIdentityMatch(candidate.evidenceIdentity, evidenceIdentity)) return candidate;
      }
      return null;
    },

    addWaiver(runId, { obligationId, approvedBy, reason, approvalReceipt, acceptanceCoverage = [] }) {
      if (!this.getRun(runId)) throw new Error(`Run ${runId} not found`);
      if (!obligationId || !approvedBy || !reason || !approvalReceipt) throw new Error('Waiver requires obligation, approver, reason, and approval receipt');
      if (isProtectedObligation(obligationId)) {
        throw new Error(`PROTECTED_OBLIGATION_WAIVER_FORBIDDEN: ${obligationId} (auth/payment/migration/data-loss/security/core-scenario) requires real evidence and cannot be waived`);
      }
      db.prepare(`INSERT INTO waivers(run_id, obligation_id, approved_by, reason, approved_at, approval_receipt, acceptance_coverage) VALUES(?, ?, ?, ?, ?, ?, ?)`)
        .run(runId, obligationId, approvedBy, reason, now(), approvalReceipt, JSON.stringify(acceptanceCoverage));
      return this.getWaivers(runId).at(-1);
    },

    getWaivers(runId) {
      return db.prepare(`SELECT id, run_id as runId, obligation_id as obligationId, approved_by as approvedBy, reason, approved_at as approvedAt, approval_receipt as approvalReceipt, acceptance_coverage as acceptanceCoverage FROM waivers WHERE run_id=? ORDER BY id ASC`).all(runId).map((row) => ({ ...row, acceptanceCoverage: safeJsonParse(row.acceptanceCoverage) }));
    },

    recordLease(runId, { holder, expiresAt, fencingToken, ownerPid = process.pid }) {
      if (!this.getRun(runId)) throw new Error(`Run ${runId} not found`);
      db.prepare(`INSERT INTO leases(run_id, holder, acquired_at, expires_at, fencing_token, owner_pid) VALUES(?, ?, ?, ?, ?, ?) ON CONFLICT(run_id) DO UPDATE SET holder=excluded.holder, acquired_at=excluded.acquired_at, expires_at=excluded.expires_at, fencing_token=excluded.fencing_token, owner_pid=excluded.owner_pid`)
        .run(runId, holder, now(), expiresAt, Number(fencingToken) || 1, Number(ownerPid) || null);
      return this.getLease(runId);
    },

    getLease(runId) {
      const row = db.prepare(`SELECT run_id as runId, holder, acquired_at as acquiredAt, expires_at as expiresAt, fencing_token as fencingToken, owner_pid as ownerPid FROM leases WHERE run_id=?`).get(runId);
      return row ? { ...row, fencingToken: Number(row.fencingToken || 0), ownerPid: row.ownerPid ? Number(row.ownerPid) : null } : null;
    },

    // Detects a still-valid lease held by a different runner, so a resumed
    // session does not silently stomp another live process's run. Each
    // acquisition mints a monotonically increasing fencing token, so a runner
    // that was superseded while paused can be rejected even if it still holds
    // the same holder string (P0-6).
    acquireLease(runId, { holder, ttlMs = 15 * 60 * 1000 } = {}) {
      const existing = this.getLease(runId);
      const nowMs = Date.now();
      const live = Boolean(existing?.expiresAt && Date.parse(existing.expiresAt) > nowMs);
      if (existing && existing.holder !== holder && live) {
        return { acquired: false, lease: existing, conflict: true };
      }
      // Two sessions in the same project share the fallback holder when the
      // host exports no session id. Matching holders are therefore not enough
      // to prove same-owner: a live lease whose owning process is still running
      // and is not us belongs to a genuinely concurrent runner.
      if (existing && existing.holder === holder && live && existing.ownerPid && existing.ownerPid !== process.pid && isProcessAlive(existing.ownerPid)) {
        return { acquired: false, lease: existing, conflict: true };
      }
      const lease = this.recordLease(runId, {
        holder,
        expiresAt: new Date(nowMs + ttlMs).toISOString(),
        fencingToken: (existing?.fencingToken || 0) + 1,
      });
      return { acquired: true, lease, conflict: false };
    },

    // A command that finishes releases its lease, so the next CLI invocation
    // (a new process) is never blocked by a lease its predecessor abandoned.
    releaseLease(runId, { holder, fencingToken = null } = {}) {
      const existing = this.getLease(runId);
      if (!existing || existing.holder !== holder) return false;
      if (fencingToken !== null && existing.fencingToken !== Number(fencingToken)) return false;
      db.prepare(`DELETE FROM leases WHERE run_id=? AND holder=?`).run(runId, holder);
      return true;
    },

    // True when the caller still owns the lease it acquired; a superseded
    // holder must not be allowed to finalize.
    isLeaseHeld(runId, { holder, fencingToken = null } = {}) {
      const existing = this.getLease(runId);
      if (!existing) return false;
      if (existing.holder !== holder) return false;
      if (fencingToken !== null && existing.fencingToken !== Number(fencingToken)) return false;
      return Date.parse(existing.expiresAt) > Date.now();
    },

    recordAttempt(runId, { attemptNumber, state, status = 'started', finishedAt = null }) {
      if (!this.getRun(runId)) throw new Error(`Run ${runId} not found`);
      const result = db.prepare(`INSERT INTO attempts(run_id, attempt_number, state, started_at, finished_at, status) VALUES(?, ?, ?, ?, ?, ?)`).run(runId, attemptNumber, state, now(), finishedAt, status);
      return db.prepare(`SELECT id, run_id as runId, attempt_number as attemptNumber, state, started_at as startedAt, finished_at as finishedAt, status FROM attempts WHERE id=?`).get(result.lastInsertRowid);
    },

    getAttempts(runId) {
      return db.prepare(`SELECT id, run_id as runId, attempt_number as attemptNumber, state, started_at as startedAt, finished_at as finishedAt, status FROM attempts WHERE run_id=? ORDER BY id ASC`).all(runId);
    },

    // Next attempt number is derived from persisted rows, so retry counting
    // survives process restarts without a caller-held counter.
    nextAttemptNumber(runId) {
      const row = db.prepare(`SELECT MAX(attempt_number) as maxAttempt FROM attempts WHERE run_id=?`).get(runId);
      return (row?.maxAttempt || 0) + 1;
    },

    finishAttempt(attemptId, status = 'finished') {
      db.prepare(`UPDATE attempts SET status=?, finished_at=? WHERE id=?`).run(status, now(), attemptId);
      return db.prepare(`SELECT id, run_id as runId, attempt_number as attemptNumber, state, started_at as startedAt, finished_at as finishedAt, status FROM attempts WHERE id=?`).get(attemptId);
    },

    getEvidenceLineage(runId) {
      return db.prepare(`SELECT id, run_id as runId, evidence_digest as evidenceDigest, parent_digest as parentDigest, created_at as createdAt FROM evidence_lineage WHERE run_id=? ORDER BY id ASC`).all(runId);
    },

    evaluateCompletion(runId, { expectedSourceIdentity = null, verificationScopeIdentities = null } = {}) {
      const run = this.getRun(runId);
      if (!run) {
        return { decision: 'blocked', run: null, verifications: [] };
      }

      const verifications = db.prepare(`
        SELECT id, obligation_id as obligationId, status, evidence_ref as evidenceRef,
               verified_runtime_revision as verifiedRuntimeRevision,
               verified_mutation_revision as verifiedMutationRevision,
               source_identity as sourceIdentity,
               verified_source_identity as verifiedSourceIdentity,
               executor, network_isolation as networkIsolation, command_ref as commandRef, command, exit_code as exitCode,
               evidence_digest as evidenceDigest, acceptance_coverage as acceptanceCoverage,
               evidence_class as evidenceClass, contract_revision as contractRevision,
               evidence_identity_json as evidenceIdentityJson, observed_at as observedAt
        FROM verifications WHERE run_id=? AND id IN (
          SELECT MAX(v2.id) FROM verifications v2 WHERE v2.run_id=? GROUP BY v2.obligation_id
        ) ORDER BY id ASC
      `).all(runId, runId).map((v) => ({
        ...v,
        acceptanceCoverage: safeJsonParse(v.acceptanceCoverage),
        evidenceIdentity: safeJsonParse(v.evidenceIdentityJson, {}),
      }));

      const isClosed = Boolean(run.state === 'CLOSE');

      const normalizedCoverageFor = (v) => {
        try {
          return normalizeAcceptanceCoverage({
            contract: run.taskContract || {},
            acceptanceCriteria: run.acceptanceCriteria || [],
            obligation: this.getRunObligation(runId, v?.obligationId),
            coverage: v?.acceptanceCoverage || [],
          });
        } catch {
          return null;
        }
      };

      const isVerificationValid = (v) => {
        if (!v) return false;
        if (v.status !== 'passed') return false;
        if (Number(v.exitCode) !== 0) return false;
        if (!v.command) return false;
        if (!v.evidenceRef) return false;
        // Historical builds briefly allowed operator approval to mint synthetic
        // executable proof. Preserve those rows for audit, but never let them
        // satisfy a hard-evidence gate during inspection or reevaluation.
        if (v.command === 'operator-override' || String(v.evidenceRef).startsWith('operator-override://')) return false;
        if (!v.evidenceDigest || !sha256Regex.test(v.evidenceDigest)) return false;

        if (!v.sourceIdentity || v.sourceIdentity !== run.sourceIdentity) return false;
        if (expectedSourceIdentity && v.sourceIdentity !== expectedSourceIdentity) return false;

        // A scoped proof is fresh only when the authoritative verification
        // scope still hashes to the same file contents. The full workspace
        // identity may change for an unrelated Step, so it is deliberately not
        // used for this case. Missing scope observations fail closed.
        const scopedDigest = v.evidenceIdentity?.values?.verificationScopeDigest || null;
        if (scopedDigest) {
          const currentScope = verificationScopeIdentities?.[v.obligationId];
          const currentScopeDigest = typeof currentScope === 'string' ? currentScope : currentScope?.identity;
          if (!currentScopeDigest || currentScopeDigest !== scopedDigest) return false;
        } else {
          const verifiedMutation = v.verifiedMutationRevision ?? v.verifiedRuntimeRevision;
          if (verifiedMutation !== run.mutationRevision) return false;
        }
        if (!scopedDigest && v.verifiedSourceIdentity && run.currentWorkspaceIdentity && v.verifiedSourceIdentity !== run.currentWorkspaceIdentity) {
          // Evidence proven against a different full workspace state is stale.
          return false;
        }

        // A contract revision changes the evidence authority. Proof recorded
        // before a plan/binding revision must be rerun, even when its other
        // receipt fields still look fresh.
        if (Number(v.contractRevision || 1) !== Number(run.contractRevision || 1)) return false;

        // Revalidate the persisted command against the CURRENT obligation. A
        // plan may have narrowed or changed its command after an older proof
        // was written; that older row cannot be reused at finalization. Legacy
        // rows without commandRef are accepted only for broad, non-explicit
        // obligations where the old contract did not specify a command.
        const declared = this.getRunObligation(runId, v.obligationId);
        const explicitCommandBinding = declared?.metadata?.evidencePlanCommandBinding === true;
        if (declared && declared.evidenceClass !== 'judgment') {
          if (explicitCommandBinding && !v.commandRef) return false;
          if (v.commandRef) {
            try {
              assertCommandBinding(declared, v.commandRef);
            } catch {
              return false;
            }
          }
        }

        // Re-derive coverage at completion as well as at write time. This keeps
        // legacy or directly-mutated rows from turning an unrelated passing
        // command into proof for a different acceptance criterion.
        if (normalizedCoverageFor(v) === null) return false;

        return true;
      };

      const requiredObligations = run.requiredObligations.length > 0 ? run.requiredObligations : ['default'];
      const declaredObligations = this.getRunObligations(runId);
      const declaredById = new Map(declaredObligations.map((obligation) => [obligation.obligationId, obligation]));
      const dynamicObligationRows = declaredObligations.filter((obligation) => obligation.status === 'required' && obligation.sourceType !== 'ad-hoc');

      const waivers = this.getWaivers(runId);
      const waivedObligations = new Set(waivers.filter((w) => w.approvalReceipt).map((w) => w.obligationId));
      const latestByObligation = new Map(verifications.map((v) => [v.obligationId, v]));

      // Evidence class is not substitutable (P0-3): a `hard` obligation needs
      // executable evidence, a `judgment` obligation needs a structured
      // verdict, and neither can stand in for the other. A run that actually
      // mutated the workspace tightens `hard` further — only the Kernel
      // executing the bound command counts. A protected obligation can never
      // be waived.
      const runMutatedWorkspace = run.mutationRevision > 0;

      // K0: a judgment that stands in for a protected obligation, or any
      // judgment in a T3 run, must be backed by a Review Receipt whose reviewer
      // lineage and reviewed subject still hold. Two different reviewer strings
      // are not evidence that an independent review happened.
      const reviewLineageFor = (obligationId, verification, declared) => {
        const protectedObligation = Boolean(declared?.protected || isProtectedObligation(obligationId));
        const independenceRequired = run.proofTier === 'T3';
        if (!protectedObligation && !independenceRequired) {
          return { required: false, usable: true, receiptId: null, reasons: [] };
        }
        const parsed = parseReviewEvidenceRef(verification?.evidenceRef);
        if (!parsed || parsed.runId !== runId) {
          return { required: true, usable: false, receiptId: null, reasons: ['review-receipt-not-referenced'] };
        }
        const receipt = this.getReviewReceipt(parsed.receiptId, { runId });
        const reasons = [];
        if (receipt) {
          if (receipt.obligationId !== obligationId) reasons.push('review-receipt-obligation-mismatch');
          if (verification.evidenceDigest !== receipt.digest) reasons.push('review-receipt-digest-mismatch');
        }
        const evaluation = evaluateReviewReceipt({
          receipt,
          run,
          requireIndependentSession: independenceRequired,
          requireFrontierClass: independenceRequired,
          requireTrustedEnforcement: true,
          // The verdict must describe the evidence set the run has NOW; a check
          // rerun after the review changes nothing about the workspace.
          currentEvidenceDigest: digestOfEvidence(verifications, { excludeObligationId: obligationId }),
        });
        const allReasons = [...reasons, ...evaluation.reasons];
        return { required: true, usable: allReasons.length === 0, receiptId: parsed.receiptId, reasons: allReasons };
      };

      const obligationSatisfied = (obligationId) => {
        const declared = declaredById.get(obligationId);
        const expectedClass = declared?.evidenceClass || 'hard';
        const verification = latestByObligation.get(obligationId);
        if (verification && isVerificationValid(verification)) {
          if (expectedClass === 'judgment') {
            if (verification.evidenceClass === 'judgment') return reviewLineageFor(obligationId, verification, declared).usable;
          } else if (verification.executor === 'kernel-runtime' && verification.evidenceClass === 'hard') {
            return true;
          } else if (!runMutatedWorkspace && verification.evidenceClass !== 'judgment') {
            // Nothing changed, so attested evidence is still an honest record;
            // a judgment verdict is never accepted for an executable obligation.
            return true;
          }
        }
        if (waivedObligations.has(obligationId) && !(declared?.protected || isProtectedObligation(obligationId))) return true;
        return false;
      };

      const obligationStatuses = [...new Set([...requiredObligations, ...dynamicObligationRows.map((row) => row.obligationId)])]
        .map((obligationId) => {
          const declared = declaredById.get(obligationId);
          const verification = latestByObligation.get(obligationId);
          const requiredEvidenceClass = declared?.evidenceClass || 'hard';
          const reviewLineage = requiredEvidenceClass === 'judgment' && verification
            ? reviewLineageFor(obligationId, verification, declared)
            : null;
          return {
            obligationId,
            requiredEvidenceClass,
            observedEvidenceClass: verification?.evidenceClass || null,
            executor: verification?.executor || null,
            reviewLineage,
            satisfied: obligationSatisfied(obligationId),
            waived: waivedObligations.has(obligationId),
          };
        });

      const staticPassed = requiredObligations.every((ob) => obligationSatisfied(ob));
      const dynamicPassed = dynamicObligationRows.every((row) => row.status === 'passed' || row.status === 'waived' || obligationSatisfied(row.obligationId));

      const coveredAcceptance = new Set([
        ...verifications.filter(isVerificationValid).flatMap((v) => normalizedCoverageFor(v) || []),
        ...waivers.flatMap((w) => w.acceptanceCoverage || []),
      ]);
      // Coverage may be declared by acceptance id (AC-1) or by statement.
      const contractAcceptance = Array.isArray(run.taskContract?.acceptance) ? run.taskContract.acceptance : [];
      // Completion must not trust a legacy verification row merely because it
      // contains coverage. The persisted acceptance statement still has to
      // match the current contract, while an explicit evidence plan remains
      // optional and unplanned criteria use the compiled policy obligation.
      const persistedAcceptance = Array.isArray(run.acceptanceCriteria) ? run.acceptanceCriteria : [];
      const evidencePlansComplete = persistedAcceptance.length === 0
        ? true
        : Boolean(run.taskContract)
          && contractAcceptance.length === persistedAcceptance.length
          && contractAcceptance.every((criterion, index) => (
            Boolean(criterion?.statement)
            && criterion.statement === persistedAcceptance[index]
          ));
      const acceptanceCovered = evidencePlansComplete && persistedAcceptance.every((criterion, index) => {
        const declared = contractAcceptance[index];
        return coveredAcceptance.has(criterion) || (declared?.id && coveredAcceptance.has(declared.id));
      });
      const releaseEvidence = db.prepare(`SELECT tier, digest, mutation_revision as mutationRevision, pack_json as packJson FROM evidence_packs WHERE run_id=? ORDER BY id DESC LIMIT 1`).get(runId);
      
      const releaseEvidencePresent = !run.releaseEvidenceRequired || (releaseEvidence?.tier === 'E2' && releaseEvidence.mutationRevision === run.mutationRevision && sha256Regex.test(releaseEvidence.digest));

      // A run that actually mutated the workspace cannot complete on
      // caller-attested proofs alone; at least one verification must have been
      // executed by the Kernel runtime itself.
      const hardEvidenceRequired = run.mutationRevision > 0;
      const hardEvidenceCount = verifications.filter((v) => isVerificationValid(v) && v.executor === 'kernel-runtime').length;
      const hardEvidenceSatisfied = !hardEvidenceRequired || hardEvidenceCount > 0;

      const requiredLifecycleOutcomes = new Set(run.taskContract?.completionPredicate?.requiredOutcomes || []);
      const outcomesFor = (obligation) => new Set([
        ...(Array.isArray(obligation?.metadata?.outcomes) ? obligation.metadata.outcomes : []),
        ...(obligation?.metadata?.outcome ? [obligation.metadata.outcome] : []),
      ]);
      const lifecycleOutcomes = [...requiredLifecycleOutcomes].map((outcome) => {
        if (outcome === 'implemented') {
          return { outcome, satisfied: run.mutationRevision > 0, obligationIds: [] };
        }
        const matching = dynamicObligationRows.filter((obligation) => outcomesFor(obligation).has(outcome));
        return {
          outcome,
          satisfied: matching.length > 0 && matching.every((obligation) => obligationSatisfied(obligation.obligationId)),
          obligationIds: matching.map((obligation) => obligation.obligationId),
        };
      });
      const lifecycleOutcomesSatisfied = lifecycleOutcomes.every((outcome) => outcome.satisfied);

      // All completion gates except the CLOSE-state requirement. Callers use
      // this to decide whether it is SAFE to transition to CLOSE, so a run is
      // never closed into an unrecoverable blocked state.
      const readyExceptClose = staticPassed && dynamicPassed && evidencePlansComplete && acceptanceCovered && releaseEvidencePresent && hardEvidenceSatisfied && lifecycleOutcomesSatisfied;
      const gates = { isClosed, staticPassed, dynamicPassed, evidencePlansComplete, acceptanceCovered, releaseEvidencePresent, hardEvidenceSatisfied, lifecycleOutcomesSatisfied };
      const unsatisfiedObligations = obligationStatuses.filter((entry) => !entry.satisfied);

      const accepted = isClosed && readyExceptClose;

      const decision = accepted ? 'accepted' : 'blocked';
      // A run that leaned on any waiver to pass is completed but degraded
      // (§17.5), never silently clean.
      const completionQuality = accepted && waivers.length > 0 ? 'degraded' : (accepted ? 'clean' : 'none');
      const decisionPayload = {
        runId,
        decision,
        completionQuality,
        sourceIdentity: run.sourceIdentity,
        currentWorkspaceIdentity: run.currentWorkspaceIdentity,
        mutationRevision: run.mutationRevision,
        hardEvidence: { required: hardEvidenceRequired, count: hardEvidenceCount },
        lifecycleOutcomes,
        evidenceDigest: releaseEvidence?.digest || verifications[0]?.evidenceDigest || `sha256:${'0'.repeat(64)}`,
        verifications,
      };
      const decisionDigest = `sha256:${createHash('sha256').update(JSON.stringify(decisionPayload)).digest('hex')}`;

      return {
        decision,
        completionQuality,
        digest: decisionDigest,
        run,
        verifications,
        waivers,
        releaseEvidence: releaseEvidence || null,
        evidencePlansComplete,
        acceptanceCovered: [...coveredAcceptance],
        hardEvidence: { required: hardEvidenceRequired, count: hardEvidenceCount },
        lifecycleOutcomes,
        obligationStatuses,
        unsatisfiedObligations,
        gates,
        readyExceptClose,
        decisionPayload,
      };
    },

    persistCompletionDecision(runId, evaluation) {
      if (!evaluation || !evaluation.run) {
        throw new Error(`Cannot persist completion decision for missing evaluation/run: ${runId}`);
      }
      const { decision, digest, run, decisionPayload } = evaluation;
      db.exec('BEGIN IMMEDIATE TRANSACTION');
      try {
        db.prepare(`
          INSERT INTO completion_decisions(run_id, decision, source_identity, mutation_revision, evidence_digest, decision_json, created_at)
          VALUES(?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(run_id) DO UPDATE SET decision=excluded.decision, source_identity=excluded.source_identity, mutation_revision=excluded.mutation_revision, evidence_digest=excluded.evidence_digest, decision_json=excluded.decision_json, created_at=excluded.created_at
        `).run(runId, decision, run.sourceIdentity, run.mutationRevision, digest, JSON.stringify({ ...(decisionPayload || {}), digest }), now());

        db.prepare('UPDATE runs SET status=?, revision=revision+1, updated_at=? WHERE run_id=?')
          .run(decision === 'accepted' ? 'completed' : 'blocked', now(), runId);

        reconcileTerminalLifecycleInTransaction({ projectId: run.projectId, runId });

        db.exec('COMMIT');
        return this.getRun(runId);
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },

    assessCompletion(runId, options = {}) {
      return this.evaluateCompletion(runId, options);
    },


    close() {
      db.close();
    },
  };
};
