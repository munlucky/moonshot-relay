import path from 'node:path';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolveRunArtifactPaths } from './artifact-paths.js';
import { computeCompletionView } from './proof/completion-view.js';
import { buildKernelDurableStateView } from './persistence/durable-state.js';
import type { WorkAuthorityView } from './run/work-authority.js';

type UnknownRecord = Record<string, unknown>;

interface RunLike extends UnknownRecord {
  runId: string;
  revision?: number | null;
  mutationRevision?: number | null;
  status?: string | null;
  state?: string | null;
  currentState?: string | null;
  currentWorkspaceIdentity?: string | null;
  blockedReason?: string | null;
  blockingClass?: string | null;
  finalizationStatus?: string | null;
  projectId?: string | null;
  workspaceId?: string | null;
  worktreeId?: string | null;
  objective?: string | null;
  planRevision?: number | null;
  contractRevision?: number | null;
  acceptanceCriteria?: unknown[];
  knowledgeRevisionStart?: string | number | null;
  knowledgeRevisionClose?: string | number | null;
  knowledgeStatus?: string | null;
  taskContract?: {
    completionPredicate?: {
      requiredOutcomes?: string[];
    } | null;
    taskClass?: unknown;
    constraints?: unknown[];
    nonGoals?: unknown[];
    [key: string]: unknown;
  } | null;
}

interface StepLike extends UnknownRecord {
  state?: string | null;
}

interface ReviewSubjectLike extends UnknownRecord {
  mutationRevision?: number;
  workspaceIdentity?: string | null;
}

interface ReviewerLike extends UnknownRecord {
  usageReceiptId?: string | null;
  routeDecisionId?: string | null;
}

interface ReviewLike {
  obligationId?: string | null;
  reviewStage?: string | null;
  stage?: string | null;
  verdict?: string | null;
  subject?: ReviewSubjectLike | null;
  reviewer?: ReviewerLike | null;
  createdAt?: string | null;
}

interface RouteDecisionLike extends UnknownRecord {
  role?: string | null;
  decisionId?: string | null;
}

interface UsageReceiptLike extends UnknownRecord {
  role?: string | null;
  decisionId?: string | null;
  receiptId?: string | null;
  createdAt?: string | null;
  resultStatus?: string | null;
}

interface GitCloseoutLike extends UnknownRecord {
  requested?: boolean;
  status?: string | null;
  pushStatus?: string | null;
  parity?: string | null;
  commitSha?: string | null;
  gitCloseoutRequest?: {
    requested?: boolean;
    [key: string]: unknown;
  } | null;
}

interface FinalizationReceiptLike extends UnknownRecord {
  finalizationStatus?: string | null;
  gitCloseoutStatus?: string | null;
  gitCloseoutRequest?: {
    requested?: boolean;
    [key: string]: unknown;
  } | null;
  gitCloseoutReceipt?: GitCloseoutLike | null;
}

interface ContextQualityLike extends UnknownRecord {
  status?: string | null;
  selectedCounts?: Record<string, unknown> | null;
  omittedCounts?: Record<string, unknown> | null;
  usableRecordCount?: unknown;
}

interface ContextLike extends UnknownRecord {
  status?: string | null;
  quality?: ContextQualityLike | null;
  policyAnchors?: unknown[];
  semanticFacts?: unknown[];
  ontologyConstraints?: unknown[];
  graphSynopsis?: unknown[];
  staleOrUnavailable?: unknown[];
  degradedContext?: boolean;
}

interface ObligationLike extends UnknownRecord {
  obligationId: string;
  status?: string | null;
  evidenceClass?: string | null;
  acceptanceIds?: unknown[];
  metadata?: {
    outcomes?: unknown[];
    outcome?: unknown;
    [key: string]: unknown;
  } | null;
}

interface VerificationLike extends UnknownRecord {
  obligationId: string;
  status?: string | null;
  evidenceDigest?: unknown;
  acceptanceCoverage?: unknown[];
  verifiedMutationRevision?: unknown;
  verifiedRuntimeRevision?: unknown;
}

interface CompletionDecisionLike extends UnknownRecord {
  decision?: string | null;
}

interface CompletionProjection extends UnknownRecord {
  decision?: unknown;
  overall: string;
  implementation: string;
  verification: string;
  review: string;
  kernelAcceptance?: string | null;
}

interface BuildResumeViewInput {
  run?: (RunLike | null) | undefined;
  step?: StepLike | null;
  verifications?: VerificationLike[];
  obligations?: ObligationLike[];
  reviews?: ReviewLike[];
  completionDecision?: CompletionDecisionLike | null;
  finalizationReceipt?: FinalizationReceiptLike | null;
  gitCloseout?: GitCloseoutLike | null;
  routeDecisions?: RouteDecisionLike[];
  usageReceipts?: UsageReceiptLike[];
  completion?: Partial<CompletionProjection> | null;
  context?: ContextLike | null;
  workAuthority?: WorkAuthorityView | null;
}

interface ProjectionBundle {
  schemaVersion: number;
  bundleId: string;
  json: UnknownRecord & { bundleId?: unknown };
  markdown?: string;
}

const digest = (value: unknown): string => (
  createHash('sha256').update(JSON.stringify(value)).digest('hex')
);

export const buildProjection = (run: RunLike) => ({
  schemaVersion: 1,
  runId: run.runId,
  runtimeRevision: run.revision,
  mutationRevision: run.mutationRevision,
  status: run.status,
  currentState: run.state,
  sourceDigest: digest(run),
  bundleId: `${run.runId}:${String(run.revision)}:${run.mutationRevision ?? 0}`,
});

const reviewMatchesRun = (
  review: ReviewLike,
  run: RunLike | null,
): boolean => {
  if (!review.subject || !run) return false;
  if (
    Number(review.subject.mutationRevision)
    !== Number(run.mutationRevision)
  ) {
    return false;
  }
  return !run.currentWorkspaceIdentity
    || review.subject.workspaceIdentity === run.currentWorkspaceIdentity;
};

const latestReviewExecution = ({
  run = null,
  reviews = [],
  routeDecisions = [],
  usageReceipts = [],
}: {
  run?: RunLike | null;
  reviews?: ReviewLike[];
  routeDecisions?: RouteDecisionLike[];
  usageReceipts?: UsageReceiptLike[];
} = {}): string => {
  const currentReviews = reviews.filter(
    (review) => reviewMatchesRun(review, run),
  );
  const reviewerDecisionIds = new Set(
    routeDecisions
      .filter((decision) => decision.role === 'reviewer')
      .map((decision) => decision.decisionId)
      .filter((id): id is string => Boolean(id)),
  );
  const reviewerUsage = usageReceipts.filter((receipt) => (
    receipt.role === 'reviewer'
    || (
      Boolean(receipt.decisionId)
      && reviewerDecisionIds.has(String(receipt.decisionId))
    )
  ));
  const reviewedUsageIds = new Set(
    currentReviews
      .map((review) => review.reviewer?.usageReceiptId)
      .filter((id): id is string => Boolean(id)),
  );
  const reviewedRouteIds = new Set(
    currentReviews
      .map((review) => review.reviewer?.routeDecisionId)
      .filter((id): id is string => Boolean(id)),
  );
  const routeIndexes = new Map<string, number>();
  routeDecisions.forEach((decision, index) => {
    if (decision.decisionId) {
      routeIndexes.set(decision.decisionId, index);
    }
  });
  const reviewedIndexes = currentReviews
    .map((review) => (
      review.reviewer?.routeDecisionId
        ? routeIndexes.get(review.reviewer.routeDecisionId)
        : undefined
    ))
    .filter((index): index is number => Number.isInteger(index));
  const latestReviewedRouteIndex = Math.max(-1, ...reviewedIndexes);
  const latestReview = currentReviews.at(-1);
  const latestReviewAt = latestReview
    ? Date.parse(latestReview.createdAt || '')
    : Number.NaN;

  const usageAfterCurrentReview = reviewerUsage.filter((receipt) => {
    if (
      receipt.receiptId
      && reviewedUsageIds.has(receipt.receiptId)
    ) {
      return false;
    }
    if (
      receipt.decisionId
      && reviewedRouteIds.has(receipt.decisionId)
    ) {
      return false;
    }
    const usageAt = Date.parse(receipt.createdAt || '');
    if (
      Number.isFinite(usageAt)
      && Number.isFinite(latestReviewAt)
    ) {
      return usageAt > latestReviewAt;
    }
    const routeIndex = receipt.decisionId
      ? routeIndexes.get(receipt.decisionId)
      : undefined;
    return latestReviewedRouteIndex < 0
      || (
        Number.isInteger(routeIndex)
        && Number(routeIndex) > latestReviewedRouteIndex
      );
  });

  if (
    usageAfterCurrentReview.some(
      (receipt) => (
        receipt.resultStatus === 'interrupted'
        || receipt.resultStatus === 'abandoned'
      ),
    )
  ) {
    return 'interrupted';
  }
  if (
    usageAfterCurrentReview.some(
      (receipt) => receipt.resultStatus === 'failed',
    )
  ) {
    return 'transport_failed';
  }
  if (
    usageAfterCurrentReview.some(
      (receipt) => receipt.resultStatus === 'completed',
    )
  ) {
    return 'ingest_failed';
  }
  if (currentReviews.length > 0) return 'completed';
  return 'never-started';
};

const gitResumeState = (
  gitCloseout: GitCloseoutLike | null = null,
  finalizationReceipt: FinalizationReceiptLike | null = null,
) => {
  const requested = Boolean(
    finalizationReceipt?.gitCloseoutRequest?.requested
      || gitCloseout?.gitCloseoutRequest?.requested
      || gitCloseout?.requested,
  );
  const receipt = gitCloseout
    || finalizationReceipt?.gitCloseoutReceipt
    || null;

  if (!receipt || receipt.status === 'skipped') {
    return {
      status: requested
        ? (
          finalizationReceipt?.gitCloseoutStatus === 'failed'
            ? 'failed'
            : 'pending'
        )
        : 'not-requested',
      head: receipt?.commitSha || null,
      receiptStatus: receipt?.status
        || finalizationReceipt?.gitCloseoutStatus
        || null,
      requested,
    };
  }
  if (receipt.status === 'completed') {
    if (
      receipt.pushStatus === 'completed'
      && receipt.parity === 'matched'
    ) {
      return {
        status: 'pushed',
        head: receipt.commitSha || null,
        receiptStatus: receipt.status,
        requested,
      };
    }
    return {
      status: 'committed',
      head: receipt.commitSha || null,
      receiptStatus: receipt.status,
      requested,
    };
  }
  return {
    status: 'failed',
    head: receipt.commitSha || null,
    receiptStatus: receipt.status,
    requested,
  };
};

const contextStatus = (
  context: ContextLike | null = null,
): string | null => {
  if (!context) return null;
  const explicit = context.status || context.quality?.status || null;
  if (
    explicit
    && ['ready-populated', 'ready-empty', 'stale', 'unavailable']
      .includes(explicit)
  ) {
    return explicit;
  }

  const selectedCounts = context.quality?.selectedCounts || {
    policy: Array.isArray(context.policyAnchors)
      ? context.policyAnchors.length
      : 0,
    facts: Array.isArray(context.semanticFacts)
      ? context.semanticFacts.length
      : 0,
    constraints: Array.isArray(context.ontologyConstraints)
      ? context.ontologyConstraints.length
      : 0,
    graph: Array.isArray(context.graphSynopsis)
      ? context.graphSynopsis.length
      : 0,
  };
  const usableRecordCount = Number.isFinite(
    Number(context.quality?.usableRecordCount),
  )
    ? Number(context.quality?.usableRecordCount)
    : Object.values(selectedCounts).reduce<number>(
      (sum, count) => sum + (Number(count) || 0),
      0,
    );

  if (usableRecordCount > 0) return 'ready-populated';

  const omittedCounts = context.quality?.omittedCounts || {};
  if (
    (Number(omittedCounts.stale) || 0) > 0
    || (Number(omittedCounts.unavailable) || 0) > 0
    || (
      Array.isArray(context.staleOrUnavailable)
      && context.staleOrUnavailable.length > 0
    )
  ) {
    return 'stale';
  }
  return 'ready-empty';
};

const obligationsForCompletionProjection = (
  obligations: ObligationLike[] = [],
): ObligationLike[] => obligations.map((obligation) => (
  obligation.status === 'passed'
    ? { ...obligation, status: 'required' }
    : obligation
));

const resumeActionFor = ({
  run,
  step,
  completion,
  reviewExecution,
  gitCloseout,
}: {
  run: RunLike;
  step: StepLike | null;
  completion: CompletionProjection;
  reviewExecution: string;
  gitCloseout: ReturnType<typeof gitResumeState>;
}): string => {
  if (
    gitCloseout.requested
    && !['committed', 'pushed'].includes(gitCloseout.status)
  ) {
    return 'retry-finalization';
  }
  if (completion.overall === 'done') return 'none';
  if (
    run.status === 'completed'
    || completion.kernelAcceptance === 'accepted'
  ) {
    return 'retry-finalization';
  }
  if (run.blockedReason) {
    if (
      run.blockedReason === 'security-review'
      || reviewExecution === 'interrupted'
    ) {
      return 'resume-independent-review';
    }
    if (run.blockedReason === 'unsupported-verification') {
      return 'add-supported-verification';
    }
    return 'resolve-blocker';
  }
  if (completion.review === 'failed') {
    return 'address-review-findings';
  }
  if (completion.verification === 'failed') {
    return 'fix-failing-verification';
  }
  if (
    completion.review === 'pending'
    && ['failed', 'blocked'].includes(String(step?.state || ''))
  ) {
    return reviewExecution === 'interrupted'
      ? 'resume-independent-review'
      : 'start-independent-review';
  }
  if (completion.implementation !== 'complete') {
    return 'continue-implementation';
  }
  if (completion.verification === 'pending') {
    return 'run-verification';
  }
  if (completion.review === 'pending') {
    return reviewExecution === 'interrupted'
      ? 'resume-independent-review'
      : 'start-independent-review';
  }
  return 'submit-kernel-report';
};

// A read-only projection assembled from the existing Run and receipt
// authorities. None of these display fields are lifecycle state; a fresh
// process can derive the same answer after reopening SQLite.
export const buildResumeView = ({
  run = null,
  step = null,
  verifications = [],
  obligations = [],
  reviews = [],
  completionDecision = null,
  finalizationReceipt = null,
  gitCloseout = null,
  routeDecisions = [],
  usageReceipts = [],
  completion = null,
  context = null,
  workAuthority = null,
}: BuildResumeViewInput = {}) => {
  if (!run) return null;

  const resolvedCompletion: CompletionProjection = completion?.overall
    ? {
        ...completion,
        overall: String(completion.overall),
        implementation: String(completion.implementation || 'pending'),
        verification: String(completion.verification || 'pending'),
        review: String(completion.review || 'pending'),
      }
    : computeCompletionView({
        run,
        step,
        verifications,
        obligations: obligationsForCompletionProjection(obligations),
        reviews,
        completionDecision,
      }) as CompletionProjection;

  const reviewExecution = latestReviewExecution({
    run,
    reviews,
    routeDecisions,
    usageReceipts,
  });
  const git = gitResumeState(gitCloseout, finalizationReceipt);
  const reason = run.blockedReason
    || (
      resolvedCompletion.verification === 'failed'
        ? 'verification-failed'
        : null
    )
    || (
      resolvedCompletion.review === 'failed'
        ? 'review-failed'
        : null
    )
    || (
      resolvedCompletion.kernelAcceptance === 'rejected'
        ? 'completion-rejected'
        : null
    );
  const finalizationStatus = run.finalizationStatus === 'completed'
    ? 'complete'
    : run.status === 'blocked'
      ? 'blocked'
      : run.finalizationStatus
        || finalizationReceipt?.finalizationStatus
        || 'pending';
  const resolvedContextStatus = contextStatus(context);
  const durableState = buildKernelDurableStateView({
    run,
    workAuthority,
    verifications,
    obligations,
    completion: resolvedCompletion,
    completionDecision,
  });

  return {
    schemaVersion: 1,
    durableState,
    ...(workAuthority ? { workAuthority } : {}),
    task: ['active', 'blocked'].includes(String(run.status || ''))
      ? 'active'
      : 'idle',
    kernel: {
      state: run.state || run.currentState || null,
      overall: resolvedCompletion.overall,
      reason,
      blockingClass: run.blockingClass
        || (reason ? 'safety' : null),
    },
    implementation: {
      status: resolvedCompletion.implementation,
      mutationRevision: Number(run.mutationRevision || 0),
    },
    verification: {
      status: resolvedCompletion.verification,
      current: resolvedCompletion.verification === 'passed',
    },
    review: {
      status: resolvedCompletion.review,
      execution: resolvedCompletion.review === 'not-required'
        ? 'not-required'
        : reviewExecution,
    },
    git: {
      ...git,
      requested: git.requested,
    },
    finalization: {
      status: finalizationStatus,
      receiptStatus: finalizationReceipt?.finalizationStatus || null,
    },
    context: context
      ? {
          status: resolvedContextStatus || 'unavailable',
          degraded: context.degradedContext === true
            || resolvedContextStatus !== 'ready-populated',
        }
      : null,
    resume: {
      action: resumeActionFor({
        run,
        step,
        completion: resolvedCompletion,
        reviewExecution,
        gitCloseout: git,
      }),
    },
  };
};

const atomicWriteFile = async (
  filePath: string,
  content: string,
): Promise<void> => {
  const tmpPath = `${filePath}.tmp.${Date.now()}.${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  await writeFile(tmpPath, content);
  await rename(tmpPath, filePath);
};

export const readProjection = async ({
  outputDir,
}: {
  outputDir: string;
}): Promise<UnknownRecord> => {
  const bundle = JSON.parse(
    await readFile(
      path.join(outputDir, 'projection-bundle.json'),
      'utf8',
    ),
  ) as ProjectionBundle;
  if (
    bundle.schemaVersion !== 1
    || !bundle.json
    || bundle.bundleId !== bundle.json.bundleId
  ) {
    throw new Error('Kernel projection bundle is invalid');
  }
  return bundle.json;
};

export const writeProjection = async ({
  run,
  outputDir,
}: {
  run: RunLike;
  outputDir: string;
}) => {
  await mkdir(outputDir, { recursive: true });
  const projection = buildProjection(run);

  const jsonContent = JSON.stringify(projection, null, 2);
  const mdContent = `# Kernel Run ${run.runId}\n\n`
    + `- Status: ${String(run.status)}\n`
    + `- State: ${String(run.state)}\n`
    + `- Runtime revision: ${String(run.revision)}\n`
    + `- Mutation revision: ${String(run.mutationRevision)}\n`
    + `- Source digest: ${projection.sourceDigest}\n`;

  await atomicWriteFile(
    path.join(outputDir, 'projection-bundle.json'),
    JSON.stringify({
      schemaVersion: 1,
      bundleId: projection.bundleId,
      json: projection,
      markdown: mdContent,
    }, null, 2),
  );
  await atomicWriteFile(
    path.join(outputDir, 'run-status.json'),
    jsonContent,
  );
  await atomicWriteFile(
    path.join(outputDir, 'STATE.md'),
    mdContent,
  );
  return projection;
};

export const verifyProjection = async ({
  run,
  file,
}: {
  run: RunLike;
  file: string;
}) => {
  const bundled = await readProjection({
    outputDir: path.dirname(file),
  });
  const actual = JSON.parse(
    await readFile(file, 'utf8'),
  ) as UnknownRecord;
  const expected = buildProjection(run);
  return {
    valid:
      JSON.stringify(actual) === JSON.stringify(bundled)
      && actual.sourceDigest === expected.sourceDigest
      && actual.runtimeRevision === expected.runtimeRevision
      && actual.mutationRevision === expected.mutationRevision
      && actual.status === expected.status
      && actual.currentState === expected.currentState
      && actual.runId === expected.runId,
    actual,
    expected,
  };
};

export const projectRunState = async (
  run: RunLike | null | undefined,
  {
    runtimeHome,
  }: {
    runtimeHome?: string | null;
  } = {},
) => {
  if (!run || !runtimeHome) return null;
  const outputDir = run.projectId
    ? resolveRunArtifactPaths({
        runtimeHome,
        projectId: run.projectId,
        runId: run.runId,
      }).projections
    : path.join(runtimeHome, 'projections', run.runId);
  return writeProjection({ run, outputDir });
};
