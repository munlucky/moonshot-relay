import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { canonicalKnowledgeIdentity } from '../../kernel/knowledge/identity.js';
import { buildGitWorkspaceIdentity } from '../../host/kernel/workspace/workspace-identity.js';
import {
  attributeExecutionUsage,
  projectExecutionEvidence,
  type ExecutionEvidenceAttempt,
  type ExecutionEvidenceRun,
  type ExecutionEvidenceUsageReceipt,
} from './execution-evidence.js';

type UnknownRecord = Record<string, unknown>;
type GenerationRelevance = 'current' | 'resolved' | 'stale' | 'insufficient';
export type HistoricalFindingStatus = 'RESOLVED' | 'DEFERRED' | 'CANDIDATE' | 'INSUFFICIENT';

export interface HistoricalWorkCase {
  schemaVersion: 'kernel-historical-work-case.v1';
  caseId: string;
  runId: string;
  lineageRunIds: string[];
  projectId: string | null;
  explicitSessionBinding: string | null;
  sessionBindingStatus: 'explicit' | 'missing' | 'ambiguous';
  provenanceKind: string;
  contractRevision: number | null;
  planRevision: number | null;
  mutationRevision: number | null;
  observedSourceIdentity: string | null;
  currentSourceIdentity: string | null;
  workspaceIdentity: string | null;
  verificationSummary: {
    total: number;
    passed: number;
    failed: number;
    currentPassed: number;
  };
  knowledgeContextSummary: {
    receiptCount: number;
    selectedCount: number;
    emptySelectionCount: number;
    duplicateSelectedCount: number;
    staleCount: number;
    deepVerifyCount: number;
  };
  knowledgeObservationPromotionSummary: {
    candidateCount: number;
    verifiedCount: number;
    rejectedCount: number;
    explicitRejectedCount: number;
    explicitRejectionReasons: Record<string, number>;
    genericBlockerCount: number;
    durableGenericBlockerCount: number;
  };
  usageReceiptPresence: boolean;
  attributableUsage: {
    inputTokens: number | null;
    cachedInputTokens: number | null;
    outputTokens: number | null;
  } | null;
  completionStatus: string | null;
  gitRevision: string | null;
  objectiveDigest: string | null;
  generationRelevance: GenerationRelevance;
  identityEvidence: {
    successorRunIds: string[];
    attemptParentRunIds: string[];
    workspaceIds: string[];
    sourceIdentities: string[];
    gitRevisions: string[];
  };
  promotionAuthority: false;
}

export interface HistoricalKnowledgeFinding {
  id: 'knowledge-duplicate-context' | 'knowledge-stage-empty' | 'knowledge-stale-ratio' | 'knowledge-explicit-rejection' | 'knowledge-generic-blocker-durable';
  status: HistoricalFindingStatus;
  count: number;
  denominator: number | null;
  ratio: number | null;
  fixingSeamRevision: string | null;
  currentComparableEvidenceCount: number;
  evidenceRunIds: string[];
  reason: string;
  promotionAuthority: false;
}

export interface HistoricalKnowledgeAnalysis {
  schemaVersion: 'kernel-historical-knowledge-analysis.v1';
  projectId: string | null;
  caseCount: number;
  metrics: {
    duplicateSelectedCount: number;
    selectedCount: number;
    stageEmptyCount: number;
    contextReceiptCount: number;
    staleCount: number;
    deepVerifyCount: number;
    explicitRejectedCount: number;
    genericBlockerCount: number;
    durableGenericBlockerCount: number;
  };
  findings: HistoricalKnowledgeFinding[];
  promotionAuthority: false;
}

interface RunRow extends UnknownRecord {
  run_id: string;
  objective?: string;
  status?: string;
  state?: string;
  contract_revision?: number | null;
  plan_revision?: number | null;
  mutation_revision?: number | null;
  source_identity?: string | null;
  run_start_git_commit_sha?: string | null;
  run_start_workspace_identity?: string | null;
  current_workspace_identity?: string | null;
  baseline_workspace_entries?: string | null;
  workspace_id?: string | null;
  project_id?: string | null;
  updated_at?: string | null;
}

interface LoadOptions {
  dbPath: string;
  projectId?: string | null;
  currentSourceIdentity?: string | null;
  currentGitRevision?: string | null;
  gitRoot?: string | null;
}

interface KnowledgeAnalysisOptions {
  cases: HistoricalWorkCase[];
  currentGitRevision?: string | null;
  gitRoot?: string | null;
  seamRevisions?: Partial<Record<'canonicalDuplicate' | 'freshnessBoundary' | 'verificationBinding' | 'genericBlockerPromotion', string | null>>;
}

const record = (value: unknown): UnknownRecord => (
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : {}
);

const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const strings = (value: unknown): string[] => array(value).map(String).map((entry) => entry.trim()).filter(Boolean);
const text = (value: unknown): string | null => (
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
);
const gitCommitSha = (value: unknown): string | null => {
  const normalized = text(value);
  return normalized && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/iu.test(normalized)
    ? normalized.toLowerCase()
    : null;
};
const revision = (value: unknown): number | null => (
  Number.isInteger(value) && Number(value) >= 0 ? Number(value) : null
);
const parseJson = (value: unknown): UnknownRecord => {
  if (typeof value !== 'string' || value.length === 0) return {};
  try {
    return record(JSON.parse(value));
  } catch {
    return {};
  }
};
const sha256 = (value: string): string => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const normalizedObjectiveDigest = (value: unknown): string | null => {
  const normalized = text(value)?.toLowerCase().replace(/\s+/gu, ' ') || '';
  return normalized ? sha256(normalized) : null;
};
const unique = (values: Array<string | null | undefined>): string[] => [...new Set(values.filter((value): value is string => Boolean(value)))].sort();

const select = <T extends UnknownRecord>(db: DatabaseSync, sql: string, params: string[] = []): T[] => (
  db.prepare(sql).all(...params) as T[]
);

const placeholders = (count: number): string => Array.from({ length: count }, () => '?').join(',');

const gitAncestor = (gitRoot: string, ancestor: string, descendant: string): boolean | null => {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
      cwd: gitRoot,
      stdio: 'ignore',
    });
    return true;
  } catch (error) {
    const status = Number((error as { status?: unknown })?.status);
    if (status === 1) return false;
    return null;
  }
};

interface GitCommitTree {
  commit: string;
  tree: string;
}

const gitCommitTrees = (gitRoot: string | null): GitCommitTree[] => {
  if (!gitRoot) return [];
  try {
    const output = execFileSync('git', ['log', '--all', '--format=%H %T'], {
      cwd: gitRoot,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
    return String(output)
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [commit, tree] = line.split(/\s+/u);
        return commit && tree ? { commit, tree } : null;
      })
      .filter((entry): entry is GitCommitTree => entry !== null);
  } catch {
    return [];
  }
};

const workspaceIdentityChangeEntries = (
  value: unknown,
): Array<{ path: string; digest: string }> | null => {
  if (typeof value !== 'string' || value.length === 0) return null;
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return null;
    const entries: Array<{ path: string; digest: string }> = [];
    for (const item of parsed) {
      const entry = record(item);
      if (typeof entry.path !== 'string' || typeof entry.digest !== 'string') return null;
      entries.push({ path: entry.path, digest: entry.digest });
    }
    return entries;
  } catch {
    return null;
  }
};

const recoverGitRevisionFromWorkspaceIdentity = ({
  run,
  commits,
}: {
  run: RunRow;
  commits: GitCommitTree[];
}): string | null => {
  const workspaceIdentity = text(run.run_start_workspace_identity);
  if (!workspaceIdentity || commits.length === 0) return null;
  const changeEntries = workspaceIdentityChangeEntries(run.baseline_workspace_entries);
  if (!changeEntries) return null;
  const matches: string[] = [];
  for (const { commit, tree } of commits) {
    const candidate = buildGitWorkspaceIdentity({
      headCommit: commit,
      headTree: tree,
      changeEntries,
    });
    if (candidate !== workspaceIdentity) continue;
    matches.push(commit);
    if (matches.length > 1) return null;
  }
  return matches.length === 1 ? matches[0]! : null;
};

export const classifyGenerationRelevance = ({
  gitRevision,
  currentGitRevision,
  fixingSeamRevision = null,
  gitRoot = null,
}: {
  gitRevision?: string | null;
  currentGitRevision?: string | null;
  fixingSeamRevision?: string | null;
  gitRoot?: string | null;
}): GenerationRelevance => {
  const observed = text(gitRevision);
  const current = text(currentGitRevision);
  const seam = text(fixingSeamRevision);
  if (!observed || !current || !gitRoot) return 'insufficient';
  if (observed === current) return 'current';

  const observedToCurrent = gitAncestor(gitRoot, observed, current);
  if (observedToCurrent !== true) return observedToCurrent === false ? 'stale' : 'insufficient';
  if (!seam) return 'stale';
  if (observed === seam) return 'current';

  const seamToCurrent = gitAncestor(gitRoot, seam, current);
  if (seamToCurrent !== true) return seamToCurrent === false ? 'stale' : 'insufficient';
  const observedToSeam = gitAncestor(gitRoot, observed, seam);
  if (observedToSeam === true) return 'resolved';
  const seamToObserved = gitAncestor(gitRoot, seam, observed);
  if (seamToObserved === true) return 'current';
  return observedToSeam === null || seamToObserved === null ? 'insufficient' : 'stale';
};

class UnionFind {
  private readonly parent = new Map<string, string>();
  add(value: string) { if (!this.parent.has(value)) this.parent.set(value, value); }
  find(value: string): string {
    const parent = this.parent.get(value) || value;
    if (parent === value) return value;
    const root = this.find(parent);
    this.parent.set(value, root);
    return root;
  }
  union(left: string, right: string) {
    this.add(left);
    this.add(right);
    const a = this.find(left);
    const b = this.find(right);
    if (a === b) return;
    const root = a < b ? a : b;
    const child = a < b ? b : a;
    this.parent.set(child, root);
  }
}

const lineageGroups = ({
  runs,
  bindings,
  attempts,
  gitRows,
}: {
  runs: RunRow[];
  bindings: UnknownRecord[];
  attempts: UnknownRecord[];
  gitRows: UnknownRecord[];
}): Map<string, string[]> => {
  const runIds = new Set(runs.map((run) => String(run.run_id)));
  const uf = new UnionFind();
  for (const runId of runIds) uf.add(runId);

  for (const binding of bindings) {
    const runId = text(binding.run_id);
    const successor = text(binding.successor_run_id);
    if (runId && successor && runIds.has(runId) && runIds.has(successor)) uf.union(runId, successor);
  }

  const runByAttempt = new Map<string, string>();
  for (const attempt of attempts) {
    const attemptId = text(attempt.attempt_id);
    const runId = text(attempt.run_id);
    if (attemptId && runId) runByAttempt.set(attemptId, runId);
  }
  for (const attempt of attempts) {
    const runId = text(attempt.run_id);
    const parentRunId = runByAttempt.get(text(attempt.parent_attempt_id) || '');
    if (runId && parentRunId && runId !== parentRunId) uf.union(runId, parentRunId);
  }

  const ownerSessionByRun = new Map<string, string>();
  for (const binding of bindings) {
    if (binding.access_mode !== 'owner') continue;
    const runId = text(binding.run_id); const sessionId = text(binding.session_id);
    if (runId && sessionId && !ownerSessionByRun.has(runId)) ownerSessionByRun.set(runId, sessionId);
  }
  const gitByRun = new Map(gitRows.map((row) => [String(row.run_id), text(row.commit_sha)]));
  const tupleGroups = new Map<string, string[]>();
  for (const run of runs) {
    const runId = String(run.run_id);
    const session = ownerSessionByRun.get(runId);
    const workspace = text(run.workspace_id);
    const source = text(run.source_identity);
    const git = gitByRun.get(runId);
    for (const tuple of [
      session && workspace && source ? `session-workspace-source:${session}:${workspace}:${source}` : null,
      session && workspace && git ? `session-workspace-git:${session}:${workspace}:${git}` : null,
    ]) {
      if (!tuple) continue;
      const values = tupleGroups.get(tuple) || [];
      values.push(runId);
      tupleGroups.set(tuple, values);
    }
  }
  for (const values of tupleGroups.values()) {
    for (let index = 1; index < values.length; index += 1) uf.union(values[0]!, values[index]!);
  }

  const groups = new Map<string, string[]>();
  for (const runId of runIds) {
    const root = uf.find(runId);
    const values = groups.get(root) || [];
    values.push(runId);
    groups.set(root, values);
  }
  for (const values of groups.values()) values.sort();
  return groups;
};

const summedUsage = (rows: ReturnType<typeof attributeExecutionUsage>) => {
  if (rows.length === 0) return null;
  const fields = ['inputTokens', 'cachedInputTokens', 'outputTokens'] as const;
  return Object.fromEntries(fields.map((field) => {
    const values = rows.map((row) => row[field]).filter((value): value is number => Number.isInteger(value));
    return [field, values.length > 0 ? values.reduce((sum, value) => sum + value, 0) : null];
  })) as { inputTokens: number | null; cachedInputTokens: number | null; outputTokens: number | null };
};

const selectedDuplicateCount = (receiptJson: UnknownRecord): number => {
  const selected = array(receiptJson.semanticFacts).map(record);
  const identities = selected.map((entry) => canonicalKnowledgeIdentity({
    recordType: entry.type || entry.recordType,
    statement: entry.statement,
    scope: entry.scope,
    practiceJson: entry.practiceJson,
    verification: entry.verification,
    obligation: entry.obligation,
    obligationId: entry.obligationId,
    obligationIds: entry.obligationIds,
  }));
  return identities.length - new Set(identities).size;
};

export const loadHistoricalWorkCases = ({
  dbPath,
  projectId = null,
  currentSourceIdentity = null,
  currentGitRevision = null,
  gitRoot = null,
}: LoadOptions): HistoricalWorkCase[] => {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const where = projectId ? 'WHERE project_id=?' : '';
    const params = projectId ? [projectId] : [];
    const runs = select<RunRow>(db, `SELECT run_id,objective,status,state,contract_revision,plan_revision,mutation_revision,source_identity,run_start_git_commit_sha,run_start_workspace_identity,current_workspace_identity,baseline_workspace_entries,workspace_id,project_id,updated_at FROM runs ${where} ORDER BY updated_at,run_id`, params);
    if (runs.length === 0) return [];
    const runIds = runs.map((run) => String(run.run_id));
    const inRuns = placeholders(runIds.length);
    const bindings = select(db, `SELECT binding_id,session_id,provider,surface,run_id,project_id,workspace_id,access_mode,status,successor_run_id FROM session_bindings WHERE run_id IN (${inRuns})`, runIds);
    const attempts = select(db, `SELECT attempt_id,run_id,parent_attempt_id,provenance_kind,actor_session_id,usage_receipt_id,plan_revision,mutation_revision,status,workspace_id,workspace_identity_start,workspace_identity_end FROM run_step_attempts WHERE run_id IN (${inRuns}) ORDER BY run_id,started_at,id`, runIds);
    const verifications = select(db, `SELECT run_id,status,exit_code,evidence_digest,source_identity,verified_source_identity,verified_mutation_revision FROM verifications WHERE run_id IN (${inRuns})`, runIds);
    const contexts = select(db, `SELECT run_id,stage,receipt_json FROM knowledge_context_receipts WHERE run_id IN (${inRuns})`, runIds);
    const candidates = select(db, `SELECT candidate_id,run_id,project_id,proposed_type,status,candidate_json FROM knowledge_candidates WHERE run_id IN (${inRuns})`, runIds);
    const usageReceipts = select(db, `SELECT receipt_id,run_id,attempt_id,binding_id,actor_session_id,input_tokens,cached_input_tokens,output_tokens FROM model_usage_receipts WHERE run_id IN (${inRuns})`, runIds);
    const completions = select(db, `SELECT run_id,decision FROM completion_decisions WHERE run_id IN (${inRuns})`, runIds);
    const gitRows = select(db, `SELECT run_id,commit_sha FROM git_closeout_receipts WHERE run_id IN (${inRuns})`, runIds);

    const runMap = new Map(runs.map((run) => [String(run.run_id), run]));
    const groups = lineageGroups({ runs, bindings, attempts, gitRows });
    const attemptRunById = new Map(attempts.map((row) => [text(row.attempt_id), text(row.run_id)]));
    const gitByRun = new Map(gitRows.map((row) => [String(row.run_id), text(row.commit_sha)]));
    const gitCommits = gitCommitTrees(gitRoot);
    const gitRevisionForRun = (runId: string): string | null => {
      const run = runMap.get(runId);
      const explicitRunStartRevision = gitCommitSha(run?.run_start_git_commit_sha);
      if (explicitRunStartRevision) return explicitRunStartRevision;
      const workspaceRevision = run
        ? recoverGitRevisionFromWorkspaceIdentity({ run, commits: gitCommits })
        : null;
      return workspaceRevision || gitByRun.get(runId) || null;
    };
    const completionByRun = new Map(completions.map((row) => [String(row.run_id), text(row.decision)]));

    return [...groups.values()].map((lineageRunIds) => {
      const lineageRuns = lineageRunIds.map((runId) => runMap.get(runId)!).filter(Boolean);
      const primary = [...lineageRuns].sort((left, right) => (
        String(right.updated_at || '').localeCompare(String(left.updated_at || '')) || String(left.run_id).localeCompare(String(right.run_id))
      ))[0]!;
      const runSet = new Set(lineageRunIds);
      const groupAttempts = attempts.filter((row) => runSet.has(String(row.run_id)));
      const groupBindings = bindings.filter((row) => runSet.has(String(row.run_id)));
      const groupVerifications = verifications.filter((row) => runSet.has(String(row.run_id)));
      const groupContexts = contexts.filter((row) => runSet.has(String(row.run_id)));
      const groupCandidates = candidates.filter((row) => runSet.has(String(row.run_id)));
      const groupUsage = usageReceipts.filter((row) => runSet.has(String(row.run_id)));

      const executionEvidence = projectExecutionEvidence({
        attempts: groupAttempts.map((row) => ({
          runId: String(row.run_id),
          attemptId: text(row.attempt_id),
          provenanceKind: text(row.provenance_kind),
          actorSessionId: text(row.actor_session_id),
          usageReceiptId: text(row.usage_receipt_id),
          planRevision: revision(row.plan_revision),
          mutationRevision: revision(row.mutation_revision),
          status: text(row.status),
          workspaceId: text(row.workspace_id),
          workspaceIdentityStart: text(row.workspace_identity_start),
          workspaceIdentityEnd: text(row.workspace_identity_end),
        } satisfies ExecutionEvidenceAttempt)),
        runs: lineageRuns.map((run) => ({
          runId: String(run.run_id),
          contractRevision: revision(run.contract_revision),
          sourceIdentity: text(run.source_identity),
          workspaceId: text(run.workspace_id),
          currentWorkspaceIdentity: text(run.current_workspace_identity),
        } satisfies ExecutionEvidenceRun)),
      });
      const usageRows = attributeExecutionUsage({
        evidence: executionEvidence,
        usageReceipts: groupUsage.map((row) => ({
          receiptId: text(row.receipt_id),
          runId: text(row.run_id),
          actorSessionId: text(row.actor_session_id),
          inputTokens: revision(row.input_tokens),
          cachedInputTokens: revision(row.cached_input_tokens),
          outputTokens: revision(row.output_tokens),
        } satisfies ExecutionEvidenceUsageReceipt)),
      });

      const ownerSessions = unique(groupBindings.filter((row) => row.access_mode === 'owner').map((row) => text(row.session_id)));
      const provenanceKinds = unique(executionEvidence.map((row) => row.provenanceKind));
      const contextRecords = groupContexts.map((row) => parseJson(row.receipt_json));
      const candidateRecords = groupCandidates.map((row) => ({ row, body: parseJson(row.candidate_json) }));
      const rejectionReasons: Record<string, number> = {};
      for (const candidate of candidateRecords) {
        if (candidate.body.sourceKind !== 'explicit' || candidate.row.status !== 'rejected') continue;
        for (const reason of strings(candidate.body.rejectionReasons)) rejectionReasons[reason] = (rejectionReasons[reason] || 0) + 1;
      }
      const genericBlockers = candidateRecords.filter(({ body }) => body.signalKind === 'blocker');
      const durableGenericBlockers = genericBlockers.filter(({ row }) => row.proposed_type === 'known_failure_pattern');
      const gitRevisions = unique(lineageRunIds.map((runId) => gitRevisionForRun(runId)));
      const primaryGitRevision = gitRevisionForRun(String(primary.run_id)) || (gitRevisions.length === 1 ? gitRevisions[0]! : null);
      const parentRunIds = unique(groupAttempts.map((attempt) => attemptRunById.get(text(attempt.parent_attempt_id)) || null).filter((runId) => Boolean(runId) && !runSet.has(runId!)));
      const primarySource = text(primary.source_identity);
      const primaryMutation = revision(primary.mutation_revision);
      const passed = groupVerifications.filter((row) => row.status === 'passed' && Number(row.exit_code) === 0 && text(row.evidence_digest));

      return {
        schemaVersion: 'kernel-historical-work-case.v1',
        caseId: `history-${sha256(lineageRunIds.join('|')).slice('sha256:'.length, 'sha256:'.length + 24)}`,
        runId: String(primary.run_id),
        lineageRunIds,
        projectId: text(primary.project_id),
        explicitSessionBinding: ownerSessions.length === 1 ? ownerSessions[0]! : null,
        sessionBindingStatus: ownerSessions.length === 1 ? 'explicit' : ownerSessions.length === 0 ? 'missing' : 'ambiguous',
        provenanceKind: provenanceKinds.length === 1 ? provenanceKinds[0]! : provenanceKinds.length === 0 ? 'legacy-unattributed' : 'mixed',
        contractRevision: revision(primary.contract_revision),
        planRevision: revision(primary.plan_revision),
        mutationRevision: primaryMutation,
        observedSourceIdentity: primarySource,
        currentSourceIdentity: text(currentSourceIdentity),
        workspaceIdentity: text(primary.current_workspace_identity),
        verificationSummary: {
          total: groupVerifications.length,
          passed: passed.length,
          failed: groupVerifications.filter((row) => row.status === 'failed' || Number(row.exit_code) !== 0).length,
          currentPassed: passed.filter((row) => (
            primarySource !== null
            && primaryMutation !== null
            && (text(row.verified_source_identity) || text(row.source_identity)) === primarySource
            && revision(row.verified_mutation_revision) === primaryMutation
          )).length,
        },
        knowledgeContextSummary: {
          receiptCount: groupContexts.length,
          selectedCount: contextRecords.reduce((sum, body) => sum + array(body.semanticFacts).length, 0),
          emptySelectionCount: contextRecords.filter((body) => array(body.semanticFacts).length === 0).length,
          duplicateSelectedCount: contextRecords.reduce((sum, body) => sum + selectedDuplicateCount(body), 0),
          staleCount: contextRecords.reduce((sum, body) => sum + array(body.staleOrUnavailable).filter((entry) => record(entry).reason === 'freshness_stale').length, 0),
          deepVerifyCount: contextRecords.reduce((sum, body) => sum + array(body.staleOrUnavailable).filter((entry) => record(entry).reason === 'freshness_needs_deep_verify').length, 0),
        },
        knowledgeObservationPromotionSummary: {
          candidateCount: candidateRecords.length,
          verifiedCount: groupCandidates.filter((row) => row.status === 'verified').length,
          rejectedCount: groupCandidates.filter((row) => row.status === 'rejected').length,
          explicitRejectedCount: candidateRecords.filter(({ row, body }) => body.sourceKind === 'explicit' && row.status === 'rejected').length,
          explicitRejectionReasons: Object.fromEntries(Object.entries(rejectionReasons).sort(([a], [b]) => a.localeCompare(b))),
          genericBlockerCount: genericBlockers.length,
          durableGenericBlockerCount: durableGenericBlockers.length,
        },
        usageReceiptPresence: groupUsage.length > 0,
        attributableUsage: summedUsage(usageRows),
        completionStatus: completionByRun.get(String(primary.run_id)) || text(primary.status),
        gitRevision: primaryGitRevision,
        objectiveDigest: normalizedObjectiveDigest(primary.objective),
        generationRelevance: classifyGenerationRelevance({
          gitRevision: primaryGitRevision,
          currentGitRevision,
          gitRoot,
        }),
        identityEvidence: {
          successorRunIds: unique(groupBindings.map((row) => text(row.successor_run_id))),
          attemptParentRunIds: parentRunIds,
          workspaceIds: unique(lineageRuns.map((run) => text(run.workspace_id))),
          sourceIdentities: unique(lineageRuns.map((run) => text(run.source_identity))),
          gitRevisions,
        },
        promotionAuthority: false,
      } satisfies HistoricalWorkCase;
    }).sort((left, right) => left.caseId.localeCompare(right.caseId));
  } finally {
    db.close();
  }
};

const findingStatus = ({
  evidenceCases,
  seam,
  currentGitRevision,
  gitRoot,
}: {
  evidenceCases: HistoricalWorkCase[];
  seam?: string | null;
  currentGitRevision?: string | null;
  gitRoot?: string | null;
}): { status: HistoricalFindingStatus; currentComparableEvidenceCount: number } => {
  if (evidenceCases.length === 0) return { status: 'INSUFFICIENT', currentComparableEvidenceCount: 0 };
  const relevance = evidenceCases.map((item) => classifyGenerationRelevance({
    gitRevision: item.gitRevision,
    currentGitRevision: currentGitRevision ?? null,
    fixingSeamRevision: seam ?? null,
    gitRoot: gitRoot ?? null,
  }));
  const currentCount = relevance.filter((value) => value === 'current').length;
  if (currentCount > 0) return { status: 'CANDIDATE', currentComparableEvidenceCount: currentCount };
  if (seam && relevance.every((value) => value === 'resolved')) return { status: 'RESOLVED', currentComparableEvidenceCount: 0 };
  if (relevance.some((value) => value === 'insufficient')) return { status: 'INSUFFICIENT', currentComparableEvidenceCount: 0 };
  return { status: 'DEFERRED', currentComparableEvidenceCount: 0 };
};

export const analyzeHistoricalKnowledgeSupply = ({
  cases,
  currentGitRevision = null,
  gitRoot = null,
  seamRevisions = {},
}: KnowledgeAnalysisOptions): HistoricalKnowledgeAnalysis => {
  const duplicateCases = cases.filter((item) => item.knowledgeContextSummary.duplicateSelectedCount > 0);
  const emptyCases = cases.filter((item) => item.knowledgeContextSummary.emptySelectionCount > 0);
  const staleCases = cases.filter((item) => item.knowledgeContextSummary.staleCount + item.knowledgeContextSummary.deepVerifyCount > 0);
  const explicitRejectionCases = cases.filter((item) => item.knowledgeObservationPromotionSummary.explicitRejectedCount > 0);
  const blockerCases = cases.filter((item) => item.knowledgeObservationPromotionSummary.durableGenericBlockerCount > 0);
  const selectedCount = cases.reduce((sum, item) => sum + item.knowledgeContextSummary.selectedCount, 0);
  const duplicateSelectedCount = cases.reduce((sum, item) => sum + item.knowledgeContextSummary.duplicateSelectedCount, 0);
  const contextReceiptCount = cases.reduce((sum, item) => sum + item.knowledgeContextSummary.receiptCount, 0);
  const stageEmptyCount = cases.reduce((sum, item) => sum + item.knowledgeContextSummary.emptySelectionCount, 0);
  const staleCount = cases.reduce((sum, item) => sum + item.knowledgeContextSummary.staleCount, 0);
  const deepVerifyCount = cases.reduce((sum, item) => sum + item.knowledgeContextSummary.deepVerifyCount, 0);
  const explicitRejectedCount = cases.reduce((sum, item) => sum + item.knowledgeObservationPromotionSummary.explicitRejectedCount, 0);
  const genericBlockerCount = cases.reduce((sum, item) => sum + item.knowledgeObservationPromotionSummary.genericBlockerCount, 0);
  const durableGenericBlockerCount = cases.reduce((sum, item) => sum + item.knowledgeObservationPromotionSummary.durableGenericBlockerCount, 0);

  const buildFinding = ({
    id,
    count,
    denominator,
    evidenceCases,
    seam,
    reason,
    diagnosticOnly = false,
  }: {
    id: HistoricalKnowledgeFinding['id'];
    count: number;
    denominator: number | null;
    evidenceCases: HistoricalWorkCase[];
    seam?: string | null;
    reason: string;
    diagnosticOnly?: boolean;
  }): HistoricalKnowledgeFinding => {
    const classified = diagnosticOnly
      ? { status: (evidenceCases.length > 0 ? 'DEFERRED' : 'INSUFFICIENT') as HistoricalFindingStatus, currentComparableEvidenceCount: 0 }
      : findingStatus({
          evidenceCases,
          seam: seam ?? null,
          currentGitRevision,
          gitRoot,
        });
    return {
      id,
      status: classified.status,
      count,
      denominator,
      ratio: denominator && denominator > 0 ? count / denominator : null,
      fixingSeamRevision: text(seam),
      currentComparableEvidenceCount: classified.currentComparableEvidenceCount,
      evidenceRunIds: unique(evidenceCases.flatMap((item) => item.lineageRunIds)),
      reason,
      promotionAuthority: false,
    };
  };

  return {
    schemaVersion: 'kernel-historical-knowledge-analysis.v1',
    projectId: unique(cases.map((item) => item.projectId)).length === 1 ? unique(cases.map((item) => item.projectId))[0]! : null,
    caseCount: cases.length,
    metrics: {
      duplicateSelectedCount,
      selectedCount,
      stageEmptyCount,
      contextReceiptCount,
      staleCount,
      deepVerifyCount,
      explicitRejectedCount,
      genericBlockerCount,
      durableGenericBlockerCount,
    },
    findings: [
      buildFinding({ id: 'knowledge-duplicate-context', count: duplicateSelectedCount, denominator: selectedCount, evidenceCases: duplicateCases, seam: seamRevisions.canonicalDuplicate ?? null, reason: 'canonical duplicate selected into historical Knowledge context' }),
      buildFinding({ id: 'knowledge-stage-empty', count: stageEmptyCount, denominator: contextReceiptCount, evidenceCases: emptyCases, reason: 'empty stage selection is diagnostic only until its cause is identified', diagnosticOnly: true }),
      buildFinding({ id: 'knowledge-stale-ratio', count: staleCount + deepVerifyCount, denominator: selectedCount + staleCount + deepVerifyCount, evidenceCases: staleCases, seam: seamRevisions.freshnessBoundary ?? null, reason: 'stale/deep-verify ratio alone does not distinguish true stale from historical false stale', diagnosticOnly: true }),
      buildFinding({ id: 'knowledge-explicit-rejection', count: explicitRejectedCount, denominator: cases.reduce((sum, item) => sum + item.knowledgeObservationPromotionSummary.candidateCount, 0), evidenceCases: explicitRejectionCases, seam: seamRevisions.verificationBinding ?? null, reason: 'explicit Knowledge rejection persists only when comparable current-generation evidence reproduces it' }),
      buildFinding({ id: 'knowledge-generic-blocker-durable', count: durableGenericBlockerCount, denominator: genericBlockerCount, evidenceCases: blockerCases, seam: seamRevisions.genericBlockerPromotion ?? null, reason: 'generic blocker durable promotion persists only when comparable current-generation evidence reproduces it' }),
    ],
    promotionAuthority: false,
  };
};
