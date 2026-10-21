import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  analyzeHistoricalActionHotspots,
  classifyHistoricalActionCommand,
  loadHistoricalActionSessions,
} from '../src/host-tooling/kernel-eval/historical-actions.js';
import {
  analyzeHistoricalKnowledgeSupply,
  classifyGenerationRelevance,
  loadHistoricalWorkCases,
  type HistoricalKnowledgeAnalysis,
  type HistoricalWorkCase,
} from '../src/host-tooling/kernel-eval/historical-improvement.js';
import {
  analyzeHistoricalReplanCauses,
  classifyHistoricalReplanEvidence,
  loadHistoricalReplanEvents,
  type HistoricalReplanEvent,
} from '../src/host-tooling/kernel-eval/historical-replans.js';
import {
  buildHistoricalReplayQueue,
  compareHistoricalReplayCandidate,
} from '../src/host-tooling/kernel-eval/historical-replay.js';
import {
  captureModelPromptReplayAttempt,
  type ModelPromptReplayProtocol,
} from '../src/host-tooling/kernel-eval/model-prompt-replay.js';
import { buildGitWorkspaceIdentity } from '../src/host/kernel/workspace/workspace-identity.js';

const digest = (value: Buffer): string => createHash('sha256').update(value).digest('hex');

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

const commit = async (cwd: string, name: string): Promise<string> => {
  await writeFile(path.join(cwd, 'history.txt'), `${name}\n`, { flag: 'a' });
  git(cwd, 'add', 'history.txt');
  git(cwd, 'commit', '-m', name);
  return git(cwd, 'rev-parse', 'HEAD');
};

const cleanWorkspaceIdentity = (cwd: string, commitSha: string): string => (
  buildGitWorkspaceIdentity({
    headCommit: commitSha,
    headTree: git(cwd, 'show', '-s', '--format=%T', commitSha),
    changeEntries: [],
  })
);

const createFixtureDb = (dbPath: string, revisions: { base: string; seam: string; head: string }) => {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE project_identities (
      project_id TEXT PRIMARY KEY, canonical_root TEXT, identity_source TEXT,
      identity_digest TEXT, aliases_json TEXT, created_at TEXT, updated_at TEXT
    );
    CREATE TABLE project_workspaces (
      workspace_id TEXT PRIMARY KEY, project_id TEXT, canonical_root TEXT,
      git_common_dir TEXT, git_worktree_dir TEXT, identity_json TEXT,
      created_at TEXT, last_seen_at TEXT, worktree_id TEXT, mutation_epoch INTEGER
    );
    CREATE TABLE runs (
      run_id TEXT PRIMARY KEY, objective TEXT, status TEXT, state TEXT,
      contract_revision INTEGER, plan_revision INTEGER, mutation_revision INTEGER,
      source_identity TEXT, run_start_workspace_identity TEXT, current_workspace_identity TEXT,
      baseline_workspace_entries TEXT, workspace_id TEXT,
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

  db.prepare(`INSERT INTO project_identities VALUES (?,?,?,?,?,?,?)`).run(
    'project-a', 'c:/dev/project-a', 'fixture', 'sha256:project-a', '[]',
    '2026-10-01T00:00:00Z', '2026-10-03T00:00:00Z',
  );
  db.prepare(`INSERT INTO project_workspaces VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
    'ws-current', 'project-a', 'c:/dev/project-a', null, null, '{}',
    '2026-10-01T00:00:00Z', '2026-10-03T00:00:00Z', null, 0,
  );

  const insertRun = db.prepare(`INSERT INTO runs(
    run_id,objective,status,state,contract_revision,plan_revision,mutation_revision,
    source_identity,current_workspace_identity,workspace_id,project_id,updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
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
    assert.equal(historical.gitRevision, base, 'git closeout remains available when run-start source evidence is absent');
    assert.equal(current.gitRevision, head);
    assert.deepEqual(current.identityEvidence.gitRevisions, [head]);
    assert.equal(historical.objectiveDigest, current.objectiveDigest, 'weak objective identity is preserved only as evidence');
    assert.notEqual(historical.caseId, current.caseId, 'weak objective identity cannot merge cases');

    assert.equal(classifyGenerationRelevance({ gitRevision: base, currentGitRevision: head, fixingSeamRevision: seam, gitRoot: root }), 'resolved');
    assert.equal(classifyGenerationRelevance({ gitRevision: head, currentGitRevision: head, fixingSeamRevision: seam, gitRoot: root }), 'current');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('W6: run-start workspace identity recovers an exact historical Git revision without new persisted state', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kernel-historical-workspace-'));
  try {
    git(root, 'init');
    git(root, 'config', 'user.email', 'fixture@example.com');
    git(root, 'config', 'user.name', 'Fixture');
    const base = await commit(root, 'base');
    const seam = await commit(root, 'seam');
    const head = await commit(root, 'head');
    const dbPath = path.join(root, 'runtime-state.sqlite');
    createFixtureDb(dbPath, { base, seam, head });

    const db = new DatabaseSync(dbPath);
    db.prepare(`DELETE FROM git_closeout_receipts WHERE run_id=?`).run('run-current');
    db.prepare(`UPDATE runs
      SET run_start_workspace_identity=?, baseline_workspace_entries=?
      WHERE run_id=?`).run(cleanWorkspaceIdentity(root, head), '[]', 'run-current');
    db.close();

    const cases = loadHistoricalWorkCases({ dbPath, projectId: 'project-a', currentGitRevision: head, gitRoot: root });
    const current = cases.find((item) => item.runId === 'run-current')!;
    assert.equal(current.gitRevision, head);
    assert.equal(current.generationRelevance, 'current');
    assert.deepEqual(current.identityEvidence.gitRevisions, [head]);

    const corruptDb = new DatabaseSync(dbPath);
    corruptDb.prepare(`UPDATE runs SET baseline_workspace_entries=? WHERE run_id=?`).run('{invalid-json', 'run-current');
    corruptDb.close();
    const corruptedCases = loadHistoricalWorkCases({ dbPath, projectId: 'project-a', currentGitRevision: head, gitRoot: root });
    const corruptedCurrent = corruptedCases.find((item) => item.runId === 'run-current')!;
    assert.equal(corruptedCurrent.gitRevision, null, 'corrupt baseline evidence must not be treated as an empty clean workspace');
    assert.equal(corruptedCurrent.generationRelevance, 'insufficient');
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

test('C7: action classifier preserves read/mutation boundaries and reuses verification semantics', () => {
  assert.equal(classifyHistoricalActionCommand('rg needle src'), 'search');
  assert.equal(classifyHistoricalActionCommand('Get-Content src/a.ts'), 'read');
  assert.equal(classifyHistoricalActionCommand('Set-Content src/a.ts value'), 'modify');
  assert.equal(classifyHistoricalActionCommand('npm test'), 'full-verification');
  assert.equal(classifyHistoricalActionCommand('node --test tests/a.test.mjs'), 'focused-verification');
  assert.equal(classifyHistoricalActionCommand('git status --short'), 'git-read');
  assert.equal(classifyHistoricalActionCommand('git branch --show-current'), 'git-read');
  assert.equal(classifyHistoricalActionCommand('git worktree list'), 'git-read');
  assert.equal(classifyHistoricalActionCommand('git commit -m test'), 'git-mutation');
  assert.equal(classifyHistoricalActionCommand('npm install'), 'environment-setup');
  assert.equal(classifyHistoricalActionCommand('docker run app'), 'unclassified');
  assert.equal(classifyHistoricalActionCommand('kernel.ps1 report'), 'kernel-lifecycle');
});

test('C7: action hotspot mining is read-only, exact-linked, redacted to aggregates, and non-authoritative', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kernel-historical-actions-'));
  try {
    git(root, 'init');
    git(root, 'config', 'user.email', 'fixture@example.com');
    git(root, 'config', 'user.name', 'Fixture');
    const base = await commit(root, 'base');
    const seam = await commit(root, 'seam');
    const head = await commit(root, 'head');
    const dbPath = path.join(root, 'runtime-state.sqlite');
    createFixtureDb(dbPath, { base, seam, head });
    const sessionsRoot = path.join(root, 'codex-sessions');
    await mkdir(sessionsRoot, { recursive: true });

    const itemCompleted = (item: Record<string, unknown>) => JSON.stringify({
      type: 'event_msg',
      payload: { type: 'item_completed', item },
    });
    const command = (cmd: string, exitCode = 0, cwd = 'C:/dev/project-a') => itemCompleted({
      type: 'CommandExecution',
      status: exitCode === 0 ? 'completed' : 'failed',
      exit_code: exitCode,
      cwd,
      parsed_cmd: [{ type: 'unknown', cmd }],
      command: ['pwsh.exe', '-Command', cmd],
    });
    const currentLines = [
      JSON.stringify({
        type: 'session_meta',
        payload: {
          session_id: 'session-current',
          id: 'session-current',
          cwd: 'file:///C:/dev/project-a',
          git: { commit_hash: head },
        },
      }),
      command('rg needle-do-not-return src'),
      command('rg needle-do-not-return src'),
      command('Get-Content src/a.ts'),
      command('Set-Content src/a.ts value'),
      command('npm test'),
      command('node --test tests/a.test.mjs'),
      command('git status --short'),
      command('git branch --show-current'),
      command('git worktree list'),
      command('git commit -m fixture'),
      command('npm install'),
      command('kernel.ps1 report'),
      command('unknown-tool needle-do-not-return', 1),
      command('rg cross-project-do-not-count src', 0, 'C:/dev/other-project'),
      itemCompleted({ type: 'FileChange', status: 'completed' }),
      itemCompleted({ type: 'McpToolCall', status: 'completed', name: 'get_work_context', arguments: {} }),
    ];
    const unlinkedLines = [
      JSON.stringify({
        type: 'session_meta',
        payload: { session_id: 'session-unlinked', cwd: 'C:/dev/project-a' },
      }),
      command('Get-Content src/b.ts'),
    ];
    const foreignLines = [
      JSON.stringify({
        type: 'session_meta',
        payload: { session_id: 'session-foreign', cwd: 'C:/dev/other-project', git: { commit_hash: head } },
      }),
      command('rg foreign-do-not-count src', 0, 'C:/dev/other-project'),
    ];
    const currentPath = path.join(sessionsRoot, 'session-current.jsonl');
    const unlinkedPath = path.join(sessionsRoot, 'session-unlinked.jsonl');
    const foreignPath = path.join(sessionsRoot, 'session-foreign.jsonl');
    await writeFile(currentPath, `${currentLines.join('\n')}\n`);
    await writeFile(unlinkedPath, `${unlinkedLines.join('\n')}\n`);
    await writeFile(foreignPath, `${foreignLines.join('\n')}\n`);

    const beforeDb = digest(await readFile(dbPath));
    const beforeSession = digest(await readFile(currentPath));
    const cases = loadHistoricalWorkCases({
      dbPath,
      projectId: 'project-a',
      currentGitRevision: head,
      gitRoot: root,
    });
    const sessions = await loadHistoricalActionSessions({
      dbPath,
      projectId: 'project-a',
      cases,
      currentGitRevision: head,
      gitRoot: root,
      env: { ...process.env, CODEX_SESSION_ROOT: sessionsRoot },
    });
    const afterDb = digest(await readFile(dbPath));
    const afterSession = digest(await readFile(currentPath));

    assert.equal(beforeDb, afterDb, 'action mining must not mutate the runtime DB');
    assert.equal(beforeSession, afterSession, 'action mining must not mutate Codex session history');
    assert.equal(sessions.length, 2, 'foreign project sessions are excluded by persisted project roots');

    const current = sessions.find((item) => item.sessionId === 'session-current')!;
    const unlinked = sessions.find((item) => item.sessionId === 'session-unlinked')!;
    assert.equal(current.caseLinkStatus, 'exact');
    assert.equal(current.linkedCompletionStatus, 'complete');
    assert.equal(current.generationRelevance, 'current');
    assert.equal(unlinked.caseLinkStatus, 'unlinked');
    assert.equal(unlinked.generationRelevance, 'insufficient');
    assert.equal(current.actionCount, 15);
    assert.equal(current.commandCount, 13);
    assert.equal(current.exactDuplicateCommandCount, 1);
    assert.equal(current.failedActionCount, 1);
    assert.equal(current.classifiedActionCount, 14);
    assert.deepEqual(current.categories, {
      search: { count: 2, failedCount: 0 },
      read: { count: 1, failedCount: 0 },
      modify: { count: 2, failedCount: 0 },
      'focused-verification': { count: 1, failedCount: 0 },
      'full-verification': { count: 1, failedCount: 0 },
      'kernel-lifecycle': { count: 2, failedCount: 0 },
      'git-read': { count: 3, failedCount: 0 },
      'git-mutation': { count: 1, failedCount: 0 },
      'environment-setup': { count: 1, failedCount: 0 },
      unclassified: { count: 1, failedCount: 1 },
    });
    assert.equal(JSON.stringify(sessions).includes('needle-do-not-return'), false, 'raw command text must not escape aggregate analysis');
    assert.equal(JSON.stringify(sessions).includes('foreign-do-not-count'), false);
    assert.equal(JSON.stringify(sessions).includes('cross-project-do-not-count'), false);

    const analysis = analyzeHistoricalActionHotspots(sessions);
    assert.equal(analysis.sessionCount, 2);
    assert.equal(analysis.linkedSessionCount, 1);
    assert.equal(analysis.currentLinkedSessionCount, 1);
    assert.equal(analysis.actionCount, 16);
    assert.equal(analysis.commandCount, 14);
    assert.equal(analysis.exactDuplicateCommandCount, 1);
    assert.equal(analysis.productionRecommendation, 'DEFER');
    assert.equal(analysis.promotionAuthority, false);
    assert.ok((analysis.classificationCoverage || 0) > 0.9);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('C8: replan cause classifier uses only explicit structured evidence and preserves ambiguity', () => {
  assert.deepEqual(classifyHistoricalReplanEvidence({ contractRevised: true }), {
    cause: 'requirement-correction',
    candidateCauses: ['requirement-correction'],
    evidenceKinds: ['contract-revised'],
    evidenceStatus: 'classified',
  });
  assert.equal(classifyHistoricalReplanEvidence({ failureCategories: ['provider/infrastructure'] }).cause, 'environment-failure');
  assert.equal(classifyHistoricalReplanEvidence({ failureCategories: ['proof'] }).cause, 'verification-failure');
  assert.equal(classifyHistoricalReplanEvidence({ failureCategories: ['delivery_workspace_drift'] }).cause, 'workspace/source-drift');
  assert.equal(classifyHistoricalReplanEvidence({ routeReasonCodes: ['PLAN_INVALID_REPLAN'] }).cause, 'contract-repair');
  assert.equal(classifyHistoricalReplanEvidence({
    reviewFindings: [{ category: 'architecture', requiredAction: 'replan', summary: 'raw summary must not drive classification' }],
  }).cause, 'contract-repair');
  assert.equal(classifyHistoricalReplanEvidence({ operatorScopeChange: true }).cause, 'operator-scope-change');

  const conflict = classifyHistoricalReplanEvidence({
    failureCategories: ['provider/infrastructure'],
    verificationFailed: true,
  });
  assert.equal(conflict.cause, 'insufficient');
  assert.equal(conflict.evidenceStatus, 'conflicting');
  assert.deepEqual(conflict.candidateCauses, ['environment-failure', 'verification-failure']);
  assert.ok(conflict.evidenceKinds.includes('conflicting-evidence'));

  const missing = classifyHistoricalReplanEvidence({});
  assert.equal(missing.cause, 'insufficient');
  assert.equal(missing.evidenceStatus, 'missing');
  assert.deepEqual(missing.evidenceKinds, ['no-causal-evidence']);

  const missingBoundary = classifyHistoricalReplanEvidence({ contractRevised: true, boundaryAvailable: false });
  assert.equal(missingBoundary.cause, 'insufficient');
  assert.deepEqual(missingBoundary.evidenceKinds, ['missing-plan-boundary']);
});

test('C8: replan mining reconstructs revision boundaries read-only and emits only causal labels', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kernel-historical-replans-'));
  try {
    const dbPath = path.join(root, 'runtime-state.sqlite');
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE runs (
        run_id TEXT PRIMARY KEY, project_id TEXT, replan_count INTEGER,
        plan_revision INTEGER, updated_at TEXT
      );
      CREATE TABLE run_steps (
        run_id TEXT, plan_revision INTEGER, created_at TEXT
      );
      CREATE TABLE run_step_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, plan_revision INTEGER,
        failure_category TEXT, started_at TEXT
      );
      CREATE TABLE model_route_decisions (
        run_id TEXT, plan_revision INTEGER, reason_codes_json TEXT, created_at TEXT
      );
      CREATE TABLE review_receipts (
        run_id TEXT, plan_revision INTEGER, findings_json TEXT, created_at TEXT
      );
      CREATE TABLE verifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, status TEXT,
        exit_code INTEGER, observed_at TEXT
      );
      CREATE TABLE run_journal (
        id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, kind TEXT, created_at TEXT
      );
    `);
    db.prepare('INSERT INTO runs VALUES (?,?,?,?,?)').run(
      'run-sensitive-id', 'project-a', 3, 4, '2026-10-01T04:00:00Z',
    );
    const step = db.prepare('INSERT INTO run_steps VALUES (?,?,?)');
    step.run('run-sensitive-id', 1, '2026-10-01T00:00:00Z');
    step.run('run-sensitive-id', 2, '2026-10-01T01:00:00Z');
    step.run('run-sensitive-id', 3, '2026-10-01T02:00:00Z');
    step.run('run-sensitive-id', 4, '2026-10-01T03:00:00Z');
    db.prepare('INSERT INTO run_step_attempts(run_id,plan_revision,failure_category,started_at) VALUES (?,?,?,?)').run(
      'run-sensitive-id', 1, 'proof', '2026-10-01T00:30:00Z',
    );
    db.prepare('INSERT INTO verifications(run_id,status,exit_code,observed_at) VALUES (?,?,?,?)').run(
      'run-sensitive-id', 'failed', 1, '2026-10-01T01:00:00Z',
    );
    db.prepare('INSERT INTO run_journal(run_id,kind,created_at) VALUES (?,?,?)').run(
      'run-sensitive-id', 'contract-revised', '2026-10-01T01:30:00Z',
    );
    db.prepare('INSERT INTO run_step_attempts(run_id,plan_revision,failure_category,started_at) VALUES (?,?,?,?)').run(
      'run-sensitive-id', 3, 'provider/infrastructure', '2026-10-01T02:30:00Z',
    );
    db.prepare('INSERT INTO verifications(run_id,status,exit_code,observed_at) VALUES (?,?,?,?)').run(
      'run-sensitive-id', 'failed', 1, '2026-10-01T02:45:00Z',
    );
    db.close();

    const beforeDb = digest(await readFile(dbPath));
    const events = loadHistoricalReplanEvents({ dbPath, projectId: 'project-a' });
    const afterDb = digest(await readFile(dbPath));

    assert.equal(beforeDb, afterDb, 'replan mining must not mutate the runtime DB');
    assert.equal(events.length, 3);
    assert.equal(events.find((event) => event.targetPlanRevision === 2)?.cause, 'verification-failure');
    assert.equal(events.find((event) => event.targetPlanRevision === 3)?.cause, 'requirement-correction');
    const conflicting = events.find((event) => event.targetPlanRevision === 4)!;
    assert.equal(conflicting.cause, 'insufficient');
    assert.equal(conflicting.evidenceStatus, 'conflicting');
    assert.ok(conflicting.evidenceKinds.includes('attempt-environment'));
    assert.ok(conflicting.evidenceKinds.includes('verification-failed'));
    assert.equal(events.every((event) => event.promotionAuthority === false), true);
    assert.equal(JSON.stringify(events).includes('run-sensitive-id'), false, 'raw run identity must not escape replan analysis');
    assert.equal(JSON.stringify(events).includes('provider/infrastructure'), false, 'raw failure categories must not escape replan analysis');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('C8: repeated current-generation causes stay diagnostic and never auto-promote', () => {
  const event = (eventId: string, cause: HistoricalReplanEvent['cause'], generationRelevance: HistoricalReplanEvent['generationRelevance']): HistoricalReplanEvent => ({
    schemaVersion: 'kernel-historical-replan-event.v1',
    eventId,
    caseId: 'history-current',
    targetPlanRevision: Number(eventId.replace(/\D/gu, '')) + 1,
    cause,
    evidenceStatus: cause === 'insufficient' ? 'missing' : 'classified',
    evidenceKinds: cause === 'insufficient' ? ['no-causal-evidence'] : ['fixture-evidence'],
    generationRelevance,
    completionStatus: 'complete',
    promotionAuthority: false,
  });
  const analysis = analyzeHistoricalReplanCauses([
    event('e1', 'verification-failure', 'current'),
    event('e2', 'verification-failure', 'current'),
    event('e3', 'requirement-correction', 'current'),
    event('e4', 'verification-failure', 'stale'),
    event('e5', 'insufficient', 'current'),
  ]);

  assert.equal(analysis.eventCount, 5);
  assert.equal(analysis.classifiedEventCount, 4);
  assert.equal(analysis.currentGenerationEventCount, 4);
  assert.deepEqual(analysis.repeatedCurrentCauses, ['verification-failure']);
  assert.equal(analysis.productionRecommendation, 'DEFER');
  assert.equal(analysis.promotionAuthority, false);
});

test('C10: only current supported historical candidates enter the single-variable replay queue', () => {
  const head = git(process.cwd(), 'rev-parse', 'HEAD');
  const currentCase: HistoricalWorkCase = {
    schemaVersion: 'kernel-historical-work-case.v1',
    caseId: 'history-current',
    runId: 'run-current',
    lineageRunIds: ['run-current'],
    projectId: 'project-a',
    explicitSessionBinding: 'session-current',
    sessionBindingStatus: 'explicit',
    provenanceKind: 'owner-session',
    contractRevision: 1,
    planRevision: 1,
    mutationRevision: 1,
    observedSourceIdentity: 'source-current',
    currentSourceIdentity: 'source-current',
    workspaceIdentity: 'workspace-current',
    verificationSummary: { total: 1, passed: 1, failed: 0, currentPassed: 1 },
    knowledgeContextSummary: {
      receiptCount: 1,
      selectedCount: 2,
      emptySelectionCount: 0,
      duplicateSelectedCount: 1,
      staleCount: 0,
      deepVerifyCount: 0,
    },
    knowledgeObservationPromotionSummary: {
      candidateCount: 1,
      verifiedCount: 1,
      rejectedCount: 0,
      explicitRejectedCount: 0,
      explicitRejectionReasons: {},
      genericBlockerCount: 0,
      durableGenericBlockerCount: 0,
    },
    usageReceiptPresence: true,
    attributableUsage: { inputTokens: 10, cachedInputTokens: 8, outputTokens: 2 },
    completionStatus: 'complete',
    gitRevision: head,
    objectiveDigest: 'sha256:' + 'a'.repeat(64),
    generationRelevance: 'current',
    identityEvidence: {
      successorRunIds: [],
      attemptParentRunIds: [],
      workspaceIds: ['workspace-current'],
      sourceIdentities: ['source-current'],
      gitRevisions: [head],
    },
    promotionAuthority: false,
  };
  const analysis: HistoricalKnowledgeAnalysis = {
    schemaVersion: 'kernel-historical-knowledge-analysis.v1',
    projectId: 'project-a',
    caseCount: 1,
    metrics: {
      duplicateSelectedCount: 1,
      selectedCount: 2,
      stageEmptyCount: 1,
      contextReceiptCount: 1,
      staleCount: 0,
      deepVerifyCount: 0,
      explicitRejectedCount: 1,
      genericBlockerCount: 0,
      durableGenericBlockerCount: 0,
    },
    findings: [
      {
        id: 'knowledge-duplicate-context',
        status: 'CANDIDATE',
        count: 1,
        denominator: 2,
        ratio: 0.5,
        fixingSeamRevision: null,
        currentComparableEvidenceCount: 1,
        evidenceRunIds: ['run-current'],
        reason: 'fixture current duplicate',
        promotionAuthority: false,
      },
      {
        id: 'knowledge-explicit-rejection',
        status: 'CANDIDATE',
        count: 1,
        denominator: 1,
        ratio: 1,
        fixingSeamRevision: null,
        currentComparableEvidenceCount: 1,
        evidenceRunIds: ['run-current'],
        reason: 'fixture unsupported seam',
        promotionAuthority: false,
      },
      {
        id: 'knowledge-stage-empty',
        status: 'DEFERRED',
        count: 1,
        denominator: 1,
        ratio: 1,
        fixingSeamRevision: null,
        currentComparableEvidenceCount: 0,
        evidenceRunIds: ['run-current'],
        reason: 'fixture deferred',
        promotionAuthority: false,
      },
    ],
    promotionAuthority: false,
  };

  const queue = buildHistoricalReplayQueue({
    analysis,
    cases: [currentCase],
    currentGitRevision: head,
    gitRoot: process.cwd(),
  });

  assert.equal(queue.candidates.length, 1);
  assert.equal(queue.blocked.length, 2);
  const candidate = queue.candidates[0]!;
  assert.equal(candidate.findingId, 'knowledge-duplicate-context');
  assert.equal(candidate.seam, 'knowledge-dedupe');
  assert.deepEqual(candidate.caseIds, ['history-current']);
  assert.deepEqual(candidate.allowedDifferences, ['providerMessageDigest']);
  assert.equal(candidate.singleVariable, true);
  assert.deepEqual(candidate.decisionOrder, ['quality', 'rework', 'efficiency']);
  assert.equal(candidate.productionMutationAllowed, false);
  assert.equal(candidate.promotionAuthority, false);
  assert.equal(queue.productionMutationAllowed, false);
  assert.equal(queue.promotionAuthority, false);
  assert.deepEqual(
    queue.blocked.map((item) => [item.findingId, item.reason]),
    [
      ['knowledge-explicit-rejection', 'unsupported-replay-seam'],
      ['knowledge-stage-empty', 'finding-not-candidate'],
    ],
  );
  assert.equal(JSON.stringify(candidate).includes('run-current'), false, 'raw historical run ids must not escape the replay candidate');
});

test('C10: historical replay delegates quality-rework-efficiency scoring to the existing replay contract', () => {
  const candidate = {
    schemaVersion: 'kernel-historical-replay-candidate.v1' as const,
    candidateId: 'historical-replay-fixture',
    findingId: 'knowledge-duplicate-context' as const,
    seam: 'knowledge-dedupe' as const,
    caseIds: ['history-current'],
    allowedDifferences: ['providerMessageDigest'] as const,
    currentComparableEvidenceCount: 1,
    singleVariable: true as const,
    decisionOrder: ['quality', 'rework', 'efficiency'] as const,
    productionMutationAllowed: false as const,
    promotionAuthority: false as const,
  };
  const protocol: ModelPromptReplayProtocol = {
    execution: {
      runsPerArmPerCase: 2,
      armOrder: ['baseline', 'candidate', 'candidate', 'baseline'],
      maxRetriesPerRun: 1,
      includeIncompleteRuns: true,
      maxProviderCallsPerCase: 8,
    },
    gates: {
      criticalAuthorityViolationMax: 0,
      efficiencyImprovement: {
        anyOf: [{ metric: 'unnecessaryActionCount', absoluteDecreaseAtLeast: 1 }],
      },
    },
    cases: [{ id: 'history-current' }],
  };
  const evaluation = (candidateArm: boolean, quality = true) => ({
    taskSuccess: quality,
    acceptanceSatisfied: quality,
    criticalAuthorityViolationCount: 0,
    scopeViolationCount: 0,
    hardcodedSolutionCount: 0,
    fallbackAbstractionGrowthCount: 0,
    regressionCount: 0,
    reworkCount: 0,
    unnecessaryToolCalls: candidateArm ? 0 : 1,
    unnecessarySubagentCalls: 0,
    unnecessaryClarificationBeforeAction: 0,
    verificationDuplicationCount: 0,
  });
  const receipt = () => ({
    hostSurface: 'codex',
    requestedModel: 'gpt-5.6-luna',
    resolvedModel: 'gpt-5.6-luna',
    observedModel: 'gpt-5.6-luna',
    requestedEffort: 'high',
    resolvedEffort: 'high',
    observedEffort: 'high',
    executionProfileRevision: 'host-execution-profile.v1:sha256:' + 'a'.repeat(64),
    promptPrefixDigest: 'sha256:' + 'b'.repeat(64),
    enforcementStatus: 'enforced',
    inputTokens: 100,
    outputTokens: 20,
    wallClockMs: 1000,
  });
  const attempts = ({ missingCandidateDigest = false, quality = true } = {}) => {
    const repetitions = { baseline: 0, candidate: 0 };
    return protocol.execution.armOrder.map((arm, order) => {
      repetitions[arm] += 1;
      const candidateArm = arm === 'candidate';
      return captureModelPromptReplayAttempt({
        caseId: 'history-current',
        arm,
        order,
        repetition: repetitions[arm],
        hostResult: {
          receipt: receipt(),
          promptMeasurement: candidateArm && missingCandidateDigest
            ? {}
            : { providerMessageDigest: 'sha256:' + (candidateArm ? '2' : '1').repeat(64) },
        },
        evaluation: evaluation(candidateArm, candidateArm ? quality : true),
      });
    });
  };

  const promoted = compareHistoricalReplayCandidate({ candidate: { ...candidate, allowedDifferences: [...candidate.allowedDifferences] }, protocol, attempts: attempts() });
  assert.equal(promoted.decision, 'PROMOTE');
  assert.equal(promoted.replay.status, 'eligible');
  assert.equal(promoted.productionMutationAllowed, false);
  assert.equal(promoted.promotionAuthority, false);

  const insufficient = compareHistoricalReplayCandidate({ candidate: { ...candidate, allowedDifferences: [...candidate.allowedDifferences] }, protocol, attempts: attempts({ missingCandidateDigest: true }) });
  assert.equal(insufficient.decision, 'INSUFFICIENT_EVIDENCE');
  assert.equal(insufficient.replay.status, 'not-ready');

  const keepBaseline = compareHistoricalReplayCandidate({ candidate: { ...candidate, allowedDifferences: [...candidate.allowedDifferences] }, protocol, attempts: attempts({ quality: false }) });
  assert.equal(keepBaseline.decision, 'KEEP_BASELINE');
  assert.equal(keepBaseline.replay.status, 'rejected-quality');

  assert.throws(
    () => compareHistoricalReplayCandidate({
      candidate: { ...candidate, allowedDifferences: [...candidate.allowedDifferences] },
      protocol: { ...protocol, cases: [{ id: 'unrelated-case' }] },
      attempts: attempts(),
    }),
    /protocol cases must exactly match the candidate cases/,
  );
});
