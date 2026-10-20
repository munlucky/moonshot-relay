type TokenField = 'inputTokens' | 'cachedInputTokens' | 'outputTokens';

export interface ExecutionEvidenceAttempt {
  runId: string;
  attemptId?: string | null;
  provenanceKind?: string | null;
  actorSessionId?: string | null;
  usageReceiptId?: string | null;
  contractRevision?: number | null;
  planRevision?: number | null;
  mutationRevision?: number | null;
  status?: string | null;
  workspaceId?: string | null;
  workspaceIdentityStart?: string | null;
  workspaceIdentityEnd?: string | null;
}

export interface ExecutionEvidenceRun {
  runId: string;
  contractRevision?: number | null;
  sourceIdentity?: string | null;
  workspaceId?: string | null;
  currentWorkspaceIdentity?: string | null;
}

export interface ExecutionEvidenceUsageReceipt {
  receiptId?: string | null;
  runId?: string | null;
  actorSessionId?: string | null;
  inputTokens?: number | null;
  cachedInputTokens?: number | null;
  outputTokens?: number | null;
}

export interface SessionUsageTotal {
  actorSessionId: string;
  runId?: string | null;
  inputTokens?: number | null;
  cachedInputTokens?: number | null;
  outputTokens?: number | null;
}

export type UsageAttributionStatus =
  | 'receipt-attributed'
  | 'owner-session-unattributed-cost'
  | 'legacy-unattributed'
  | 'shared-session-unattributed'
  | 'explicit-session-run-binding';

export interface ExecutionEvidenceView {
  runId: string;
  attemptId: string | null;
  provenanceKind: string;
  actorSessionId: string | null;
  actorSessionIdPresent: boolean;
  usageReceiptId: string | null;
  usageAttributionStatus: UsageAttributionStatus;
  contractRevision: number | null;
  planRevision: number | null;
  mutationRevision: number | null;
  sourceIdentity: string | null;
  workspaceId: string | null;
  workspaceIdentity: string | null;
  status: string | null;
  executionIdentity: string | null;
}

const finiteRevision = (value: unknown): number | null => (
  Number.isInteger(value) && Number(value) >= 0 ? Number(value) : null
);

const stringOrNull = (value: unknown): string | null => (
  typeof value === 'string' && value.length > 0 ? value : null
);

const buildExecutionIdentity = ({
  runId,
  contractRevision,
  planRevision,
  mutationRevision,
}: Pick<ExecutionEvidenceView, 'runId' | 'contractRevision' | 'planRevision' | 'mutationRevision'>): string | null => {
  if (contractRevision === null || planRevision === null || mutationRevision === null) return null;
  return `${runId}:contract-${contractRevision}:plan-${planRevision}:mutation-${mutationRevision}`;
};

const usageStatus = (attempt: ExecutionEvidenceAttempt): UsageAttributionStatus => {
  if (stringOrNull(attempt.usageReceiptId)) return 'receipt-attributed';
  if (attempt.provenanceKind === 'owner-session') return 'owner-session-unattributed-cost';
  return 'legacy-unattributed';
};

/**
 * Read-only projection over the canonical Step ledger. Missing lineage stays
 * missing; the evaluator never backfills it from legacy attempts or guesses.
 */
export const projectExecutionEvidence = ({
  attempts = [],
  runs = [],
}: {
  attempts?: ExecutionEvidenceAttempt[];
  runs?: ExecutionEvidenceRun[];
}): ExecutionEvidenceView[] => {
  const runsById = new Map(runs.map((run) => [run.runId, run]));
  return attempts.map((attempt) => {
    const run = runsById.get(attempt.runId);
    const actorSessionId = stringOrNull(attempt.actorSessionId);
    const view: ExecutionEvidenceView = {
      runId: attempt.runId,
      attemptId: stringOrNull(attempt.attemptId),
      provenanceKind: stringOrNull(attempt.provenanceKind) || 'legacy-unattributed',
      actorSessionId,
      actorSessionIdPresent: Boolean(actorSessionId),
      usageReceiptId: stringOrNull(attempt.usageReceiptId),
      usageAttributionStatus: usageStatus(attempt),
      // Historical attempts do not currently persist contractRevision. Never
      // stamp them with the Run's current revision; accept only authoritative
      // lineage supplied by the caller, otherwise keep the fence unknown.
      contractRevision: finiteRevision(attempt.contractRevision),
      planRevision: finiteRevision(attempt.planRevision),
      mutationRevision: finiteRevision(attempt.mutationRevision),
      sourceIdentity: stringOrNull(run?.sourceIdentity),
      workspaceId: stringOrNull(attempt.workspaceId) || stringOrNull(run?.workspaceId),
      workspaceIdentity: stringOrNull(attempt.workspaceIdentityEnd)
        || stringOrNull(attempt.workspaceIdentityStart)
        || stringOrNull(run?.currentWorkspaceIdentity),
      status: stringOrNull(attempt.status),
      executionIdentity: null,
    };
    view.executionIdentity = buildExecutionIdentity(view);
    return view;
  });
};

const normalizedTokens = (source: Partial<Record<TokenField, number | null | undefined>>) => ({
  inputTokens: Number.isInteger(source.inputTokens) ? Number(source.inputTokens) : null,
  cachedInputTokens: Number.isInteger(source.cachedInputTokens) ? Number(source.cachedInputTokens) : null,
  outputTokens: Number.isInteger(source.outputTokens) ? Number(source.outputTokens) : null,
});

/**
 * Provider receipts are already Run-scoped and remain authoritative. A raw
 * session total is attributed only when an explicit Run binding exists or all
 * canonical attempts for that session belong to exactly one Run.
 */
export const attributeExecutionUsage = ({
  evidence = [],
  usageReceipts = [],
  sessionTotals = [],
}: {
  evidence?: ExecutionEvidenceView[];
  usageReceipts?: ExecutionEvidenceUsageReceipt[];
  sessionTotals?: SessionUsageTotal[];
}) => {
  const receiptRows = usageReceipts.map((receipt) => ({
    status: 'receipt-attributed' as const,
    runId: stringOrNull(receipt.runId),
    actorSessionId: stringOrNull(receipt.actorSessionId),
    receiptId: stringOrNull(receipt.receiptId),
    ...normalizedTokens(receipt),
  }));

  const runsBySession = new Map<string, Set<string>>();
  for (const item of evidence) {
    if (!item.actorSessionId) continue;
    const runIds = runsBySession.get(item.actorSessionId) || new Set<string>();
    runIds.add(item.runId);
    runsBySession.set(item.actorSessionId, runIds);
  }

  const sessionRows = sessionTotals.map((total) => {
    const explicitRunId = stringOrNull(total.runId);
    const runIds = runsBySession.get(total.actorSessionId) || new Set<string>();
    const singleRunId = runIds.size === 1 ? [...runIds][0]! : null;
    const runId = explicitRunId || singleRunId;
    return {
      status: explicitRunId
        ? 'explicit-session-run-binding' as const
        : runId
          ? 'owner-session-unattributed-cost' as const
          : 'shared-session-unattributed' as const,
      runId,
      actorSessionId: total.actorSessionId,
      receiptId: null,
      ...normalizedTokens(total),
    };
  });

  return [...receiptRows, ...sessionRows];
};
