import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  analyzeHistoricalKnowledgeSupply,
  classifyGenerationRelevance,
  loadHistoricalWorkCases,
} from '../src/host-tooling/kernel-eval/historical-improvement.js';

const digest = (value: Buffer): string => createHash('sha256').update(value).digest('hex');

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

const commit = async (cwd: string, name: string): Promise<string> => {
  await writeFile(path.join(cwd, 'history.txt'), `${name}\n`, { flag: 'a' });
  git(cwd, 'add', 'history.txt');
  git(cwd, 'commit', '-m', name);
  return git(cwd, 'rev-parse', 'HEAD');
};

const createFixtureDb = (dbPath: string, revisions: { base: string; seam: string; head: string }) => {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE runs (
      run_id TEXT PRIMARY KEY, objective TEXT, status TEXT, state TEXT,
      contract_revision INTEGER, plan_revision INTEGER, mutation_revision INTEGER,
      source_identity TEXT, current_workspace_identity TEXT, workspace_id TEXT,
      project_id TEXT, updated_at TEXT
    );
    CREATE TABLE session_bindings (
      binding_id TEXT PRIMARY KEY, session_id TEXT, provider TEXT, surface TEXT,
      run_id TEXT, project_id TEXT, workspace_id TEXT, access_mode TEXT, status TEXT,
      successor_run_id TEXT
    );
    CREATE TABLE run_step_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, attempt_id TEXT, run_id TEXT,
      parent_attempt_id TEXT, provenance_kind TEXT, actor_session_id TEXT,
      usage_receipt_id TEXT, plan_revision INTEGER, mutation_revision INTEGER,
      status TEXT, workspace_id TEXT, workspace_identity_start TEXT,
      workspace_identity_end TEXT, result_commit_sha TEXT, started_at TEXT
    );
    CREATE TABLE verifications (
      run_id TEXT, status TEXT, exit_code INTEGER, evidence_digest TEXT,
      source_identity TEXT, verified_source_identity TEXT, verified_mutation_revision INTEGER
    );
    CREATE TABLE knowledge_context_receipts (run_id TEXT, stage TEXT, receipt_json TEXT);
    CREATE TABLE knowledge_candidates (
      candidate_id TEXT PRIMARY KEY, run_id TEXT, project_id TEXT,
      proposed_type TEXT, status TEXT, candidate_json TEXT
    );
    CREATE TABLE model_usage_receipts (
      receipt_id TEXT PRIMARY KEY, run_id TEXT, attempt_id TEXT, binding_id TEXT,
      actor_session_id TEXT, input_tokens INTEGER, cached_input_tokens INTEGER, output_tokens INTEGER
    );
    CREATE TABLE completion_decisions (run_id TEXT PRIMARY KEY, decision TEXT);
    CREATE TABLE git_closeout_receipts (run_id TEXT PRIMARY KEY, commit_sha TEXT);
  `);

  const insertRun = db.prepare(`INSERT INTO runs VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  insertRun.run('run-old-a', 'same objective text', 'completed', 'CLOSE', 1, 1, 0, 'cand-old-a', 'workspace-old-a', 'ws-old', 'project-a', '2026-10-01T00:00:00Z');
  insertRun.run('run-old-b', 'same objective text', 'completed', 'CLOSE', 2, 2, 1, 'cand-old-b', 'workspace-old-b', 'ws-old', 'project-a', '2026-10-02T00:00:00Z');
  insertRun.run('run-current', 'same objective text', 'completed', 'CLOSE', 3, 3, 1, 'cand-current', 'workspace-current', 'ws-current', 'project-a', '2026-10-03T00:00:00Z');

  const binding = db.prepare(`INSERT INTO session_bindings VALUES (?,?,?,?,?,?,?,?,?,?)`);
  binding.run('bind-old-a', 'codex:session-old', 'codex', null, 'run-old-a', 'project-a', 'ws-old', 'owner', 'inactive', 'run-old-b');
  binding.run('bind-old-b', 'codex:session-old', 'codex', null, 'run-old-b', 'project-a', 'ws-old', 'owner', 'inactive', null);
  binding.run('bind-current', 'codex:session-current', 'codex', null, 'run-current', 'project-a', 'ws-current', 'owner', 'inactive', null);

  const attempt = db.prepare(`INSERT INTO run_step_attempts(
    attempt_id,run_id,parent_attempt_id,provenance_kind,actor_session_id,usage_receipt_id,
    plan_revision,mutation_revision,status,workspace_id,workspace_identity_start,
    workspace_identity_end,result_commit_sha,started_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  attempt.run('attempt-old-a', 'run-old-a', null, 'owner-session', 'session-old', null, 1, 0, 'passed', 'ws-old', 'workspace-old-a', 'workspace-old-a', null, '2026-10-01T00:00:00Z');
  attempt.run('attempt-old-b', 'run-old-b', 'attempt-old-a', 'owner-session', 'session-old', 'usage-old', 2, 1, 'passed', 'ws-old', 'workspace-old-a', 'workspace-old-b', null, '2026-10-02T00:00:00Z');
  attempt.run('attempt-current', 'run-current', null, 'owner-session', 'session-current', null, 3, 1, 'passed', 'ws-current', 'workspace-current', 'workspace-current', null, '2026-10-03T00:00:00Z');

  db.prepare(`INSERT INTO verifications VALUES (?,?,?,?,?,?,?)`).run('run-old-b', 'passed', 0, 'sha256:proof', 'cand-old-b', 'cand-old-b', 1);

  const oldContext = {
    status: 'stale',
    semanticFacts: [
      { id: 'dup-a', type: 'semantic_fact', statement: 'Duplicate fact.', scope: ['src/**'] },
      { id: 'dup-b', type: 'semantic_fact', statement: 'Duplicate fact.', scope: ['src/**'] },
    ],
    staleOrUnavailable: [
      { id: 'stale-a', reason: 'freshness_stale' },
      { id: 'deep-a', reason: 'freshness_needs_deep_verify' },
    ],
  };
  const emptyContext = { status: 'stale', semanticFacts: [], staleOrUnavailable: [{ id: 'stale-b', reason: 'freshness_stale' }] };
  const currentContext = { status: 'ready-populated', semanticFacts: [{ id: 'fact-current', type: 'semantic_fact', statement: 'Current fact.', scope: ['src/**'] }], staleOrUnavailable: [] };
  const contextInsert = db.prepare(`INSERT INTO knowledge_context_receipts VALUES (?,?,?)`);
  contextInsert.run('run-old-a', 'FRAME', JSON.stringify(oldContext));
  contextInsert.run('run-old-b', 'EXECUTE', JSON.stringify(emptyContext));
  contextInsert.run('run-current', 'EXECUTE', JSON.stringify(currentContext));

  const candidateInsert = db.prepare(`INSERT INTO knowledge_candidates VALUES (?,?,?,?,?,?)`);
  candidateInsert.run('candidate-explicit-old', 'run-old-b', 'project-a', 'semantic_fact', 'rejected', JSON.stringify({
    sourceKind: 'explicit', rejectionReasons: ['MISSING_VERIFICATION_EVIDENCE'], statement: 'Rejected historical lesson.',
  }));
  candidateInsert.run('candidate-blocker-old', 'run-old-b', 'project-a', 'known_failure_pattern', 'verified', JSON.stringify({
    sourceKind: 'auto', signalKind: 'blocker', statement: 'unsupported-verification',
  }));
  candidateInsert.run('candidate-current', 'run-current', 'project-a', 'semantic_fact', 'verified', JSON.stringify({
    sourceKind: 'explicit', statement: 'Current verified lesson.',
  }));

  db.prepare(`INSERT INTO model_usage_receipts VALUES (?,?,?,?,?,?,?,?)`).run(
    'usage-old', 'run-old-b', 'attempt-old-b', 'bind-old-b', 'session-old', null, null, null,
  );
  db.prepare(`INSERT INTO completion_decisions VALUES (?,?)`).run('run-old-b', 'complete');
  db.prepare(`INSERT INTO completion_decisions VALUES (?,?)`).run('run-current', 'complete');
  db.prepare(`INSERT INTO git_closeout_receipts VALUES (?,?)`).run('run-old-b', revisions.base);
  db.prepare(`INSERT INTO git_closeout_receipts VALUES (?,?)`).run('run-current', revisions.head);
  db.close();
};

test('W6: HistoricalWorkCase loader is read-only, deterministic, lineage-safe, and keeps missing telemetry unknown', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kernel-historical-improvement-'));
  try {
    git(root, 'init');
    git(root, 'config', 'user.email', 'fixture@example.com');
    git(root, 'config', 'user.name', 'Fixture');
    const base = await commit(root, 'base');
    const seam = await commit(root, 'seam');
    const head = await commit(root, 'head');
    const dbPath = path.join(root, 'runtime-state.sqlite');
    createFixtureDb(dbPath, { base, seam, head });
    const before = digest(await readFile(dbPath));

    const options = {
      dbPath,
      projectId: 'project-a',
      currentSourceIdentity: 'cand-current',
      currentGitRevision: head,
      gitRoot: root,
    };
    const first = loadHistoricalWorkCases(options);
    const second = loadHistoricalWorkCases(options);
    const after = digest(await readFile(dbPath));

    assert.equal(before, after, 'read-only historical analysis must not mutate the runtime DB');
    assert.deepEqual(first, second, 'case identity and summaries must be deterministic');
    assert.equal(first.length, 2, 'successor/attempt lineage merges old runs but objective digest alone does not merge current work');

    const historical = first.find((item) => item.lineageRunIds.includes('run-old-a'))!;
    const current = first.find((item) => item.runId === 'run-current')!;
    assert.deepEqual(historical.lineageRunIds, ['run-old-a', 'run-old-b']);
    assert.equal(historical.explicitSessionBinding, 'codex:session-old');
    assert.equal(historical.provenanceKind, 'owner-session');
    assert.equal(historical.knowledgeContextSummary.duplicateSelectedCount, 1);
    assert.equal(historical.knowledgeContextSummary.emptySelectionCount, 1);
    assert.equal(historical.knowledgeContextSummary.staleCount, 2);
    assert.equal(historical.knowledgeContextSummary.deepVerifyCount, 1);
    assert.equal(historical.knowledgeObservationPromotionSummary.explicitRejectionReasons.MISSING_VERIFICATION_EVIDENCE, 1);
    assert.equal(historical.knowledgeObservationPromotionSummary.durableGenericBlockerCount, 1);
    assert.equal(historical.usageReceiptPresence, true);
    assert.deepEqual(historical.attributableUsage, { inputTokens: null, cachedInputTokens: null, outputTokens: null });
    assert.equal(current.usageReceiptPresence, false);
    assert.equal(current.attributableUsage, null);
    assert.equal(current.generationRelevance, 'current');
    assert.equal(historical.generationRelevance, 'stale');
    assert.equal(historical.objectiveDigest, current.objectiveDigest, 'weak objective identity is preserved only as evidence');
    assert.notEqual(historical.caseId, current.caseId, 'weak objective identity cannot merge cases');

    assert.equal(classifyGenerationRelevance({ gitRevision: base, currentGitRevision: head, fixingSeamRevision: seam, gitRoot: root }), 'resolved');
    assert.equal(classifyGenerationRelevance({ gitRevision: head, currentGitRevision: head, fixingSeamRevision: seam, gitRoot: root }), 'current');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('W6: Knowledge supply analysis classifies fixed historical seams without promotion authority', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kernel-historical-analysis-'));
  try {
    git(root, 'init');
    git(root, 'config', 'user.email', 'fixture@example.com');
    git(root, 'config', 'user.name', 'Fixture');
    const base = await commit(root, 'base');
    const seam = await commit(root, 'seam');
    const head = await commit(root, 'head');
    const dbPath = path.join(root, 'runtime-state.sqlite');
    createFixtureDb(dbPath, { base, seam, head });
    const cases = loadHistoricalWorkCases({ dbPath, projectId: 'project-a', currentGitRevision: head, gitRoot: root });
    const result = analyzeHistoricalKnowledgeSupply({
      cases,
      currentGitRevision: head,
      gitRoot: root,
      seamRevisions: {
        canonicalDuplicate: seam,
        freshnessBoundary: seam,
        verificationBinding: seam,
        genericBlockerPromotion: seam,
      },
    });

    assert.equal(result.promotionAuthority, false);
    assert.equal(result.metrics.duplicateSelectedCount, 1);
    assert.equal(result.metrics.selectedCount, 3);
    assert.equal(result.metrics.explicitRejectedCount, 1);
    assert.equal(result.metrics.genericBlockerCount, 1);
    assert.equal(result.metrics.durableGenericBlockerCount, 1);
    assert.equal(result.findings.find((item) => item.id === 'knowledge-duplicate-context')?.status, 'RESOLVED');
    assert.equal(result.findings.find((item) => item.id === 'knowledge-explicit-rejection')?.status, 'RESOLVED');
    assert.equal(result.findings.find((item) => item.id === 'knowledge-generic-blocker-durable')?.status, 'RESOLVED');
    assert.equal(result.findings.find((item) => item.id === 'knowledge-stage-empty')?.status, 'DEFERRED');
    assert.equal(result.findings.find((item) => item.id === 'knowledge-stale-ratio')?.status, 'DEFERRED');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('W6: current-generation recurrence becomes CANDIDATE while missing generation evidence stays INSUFFICIENT', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kernel-historical-current-'));
  try {
    git(root, 'init');
    git(root, 'config', 'user.email', 'fixture@example.com');
    git(root, 'config', 'user.name', 'Fixture');
    const seam = await commit(root, 'seam');
    const head = await commit(root, 'head');
    const baseCase = {
      schemaVersion: 'kernel-historical-work-case.v1' as const,
      caseId: 'history-current',
      runId: 'run-current',
      lineageRunIds: ['run-current'],
      projectId: 'project-a',
      explicitSessionBinding: 'codex:current',
      sessionBindingStatus: 'explicit' as const,
      provenanceKind: 'owner-session',
      contractRevision: 1,
      planRevision: 1,
      mutationRevision: 1,
      observedSourceIdentity: 'cand-current',
      currentSourceIdentity: 'cand-current',
      workspaceIdentity: 'workspace-current',
      verificationSummary: { total: 1, passed: 1, failed: 0, currentPassed: 1 },
      knowledgeContextSummary: { receiptCount: 1, selectedCount: 2, emptySelectionCount: 0, duplicateSelectedCount: 1, staleCount: 0, deepVerifyCount: 0 },
      knowledgeObservationPromotionSummary: { candidateCount: 0, verifiedCount: 0, rejectedCount: 0, explicitRejectedCount: 0, explicitRejectionReasons: {}, genericBlockerCount: 0, durableGenericBlockerCount: 0 },
      usageReceiptPresence: false,
      attributableUsage: null,
      completionStatus: 'complete',
      gitRevision: head,
      objectiveDigest: 'sha256:objective',
      generationRelevance: 'current' as const,
      identityEvidence: { successorRunIds: [], attemptParentRunIds: [], workspaceIds: ['ws-current'], sourceIdentities: ['cand-current'], gitRevisions: [head] },
      promotionAuthority: false as const,
    };

    const current = analyzeHistoricalKnowledgeSupply({
      cases: [baseCase],
      currentGitRevision: head,
      gitRoot: root,
      seamRevisions: { canonicalDuplicate: seam },
    });
    assert.equal(current.findings.find((item) => item.id === 'knowledge-duplicate-context')?.status, 'CANDIDATE');
    assert.equal(current.findings.find((item) => item.id === 'knowledge-duplicate-context')?.currentComparableEvidenceCount, 1);

    const insufficient = analyzeHistoricalKnowledgeSupply({
      cases: [{ ...baseCase, gitRevision: null, generationRelevance: 'insufficient' as const }],
      currentGitRevision: head,
      gitRoot: root,
      seamRevisions: { canonicalDuplicate: seam },
    });
    assert.equal(insufficient.findings.find((item) => item.id === 'knowledge-duplicate-context')?.status, 'INSUFFICIENT');
    assert.equal(insufficient.promotionAuthority, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
