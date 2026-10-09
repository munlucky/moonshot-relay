import path from 'node:path';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolveRunArtifactPaths } from './artifact-paths.mjs';
import { computeCompletionView } from './run/completion-view.mjs';
import { buildKernelDurableStateView } from './persistence/durable-state.mjs';

const digest = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex');

export const buildProjection = (run) => ({
  schemaVersion: 1,
  runId: run.runId,
  runtimeRevision: run.revision,
  mutationRevision: run.mutationRevision,
  status: run.status,
  currentState: run.state,
  sourceDigest: digest(run),
  bundleId: `${run.runId}:${run.revision}:${run.mutationRevision ?? 0}`,
});

const reviewMatchesRun = (review, run) => {
  if (!review?.subject || !run) return false;
  if (Number(review.subject.mutationRevision) !== Number(run.mutationRevision)) return false;
  return !run.currentWorkspaceIdentity
    || review.subject.workspaceIdentity === run.currentWorkspaceIdentity;
};

const latestReviewExecution = ({ run = null, reviews = [], routeDecisions = [], usageReceipts = [] } = {}) => {
  const currentReviews = reviews.filter((review) => reviewMatchesRun(review, run));
  const reviewerDecisionIds = new Set(routeDecisions
    .filter((decision) => decision?.role === 'reviewer')
    .map((decision) => decision.decisionId)
    .filter(Boolean));
  const reviewerUsage = usageReceipts.filter((receipt) => (
    receipt?.role === 'reviewer'
    || reviewerDecisionIds.has(receipt?.decisionId)
  ));
  const reviewedUsageIds = new Set(currentReviews
    .map((review) => review.reviewer?.usageReceiptId)
    .filter(Boolean));
  const reviewedRouteIds = new Set(currentReviews
    .map((review) => review.reviewer?.routeDecisionId)
    .filter(Boolean));
  const routeIndexes = new Map(routeDecisions.map((decision, index) => [decision.decisionId, index]));
  const latestReviewedRouteIndex = Math.max(-1, ...currentReviews
    .map((review) => routeIndexes.get(review.reviewer?.routeDecisionId))
    .filter((index) => Number.isInteger(index)));
  const latestReviewAt = currentReviews.length > 0
    ? Date.parse(currentReviews.at(-1).createdAt || '')
    : Number.NaN;
  const usageAfterCurrentReview = reviewerUsage.filter((receipt) => {
    if (receipt.receiptId && reviewedUsageIds.has(receipt.receiptId)) return false;
    if (receipt.decisionId && reviewedRouteIds.has(receipt.decisionId)) return false;
    const usageAt = Date.parse(receipt.createdAt || '');
    if (Number.isFinite(usageAt) && Number.isFinite(latestReviewAt)) return usageAt > latestReviewAt;
    const routeIndex = routeIndexes.get(receipt.decisionId);
    return latestReviewedRouteIndex < 0 || (Number.isInteger(routeIndex) && routeIndex > latestReviewedRouteIndex);
  });
  if (usageAfterCurrentReview.some((receipt) => receipt.resultStatus === 'interrupted' || receipt.resultStatus === 'abandoned')) return 'interrupted';
  if (usageAfterCurrentReview.some((receipt) => receipt.resultStatus === 'failed')) return 'transport_failed';
  if (usageAfterCurrentReview.some((receipt) => receipt.resultStatus === 'completed')) return 'ingest_failed';
  if (currentReviews.length > 0) return 'completed';
  if (reviewerDecisionIds.size > 0) return 'never-started';
  return 'never-started';
};

const gitResumeState = (gitCloseout = null, finalizationReceipt = null) => {
  // Finalization is the durable source of the request itself. A closeout can
  // fail before its Git receipt is written, so a missing/skipped receipt must
  // not erase the user's explicit request from the resume view.
  const requested = Boolean(
    finalizationReceipt?.gitCloseoutRequest?.requested
      || gitCloseout?.gitCloseoutRequest?.requested
      || gitCloseout?.requested,
  );
  const receipt = gitCloseout || finalizationReceipt?.gitCloseoutReceipt || null;
  if (!receipt || receipt.status === 'skipped') {
    return {
      status: requested
        ? (finalizationReceipt?.gitCloseoutStatus === 'failed' ? 'failed' : 'pending')
        : 'not-requested',
      head: receipt?.commitSha || null,
      receiptStatus: receipt?.status || finalizationReceipt?.gitCloseoutStatus || null,
      requested,
    };
  }
  if (receipt.status === 'completed') {
    if (receipt.pushStatus === 'completed' && receipt.parity === 'matched') {
      return { status: 'pushed', head: receipt.commitSha || null, receiptStatus: receipt.status, requested };
    }
    return { status: 'committed', head: receipt.commitSha || null, receiptStatus: receipt.status, requested };
  }
  return { status: 'failed', head: receipt.commitSha || null, receiptStatus: receipt.status, requested };
};

const contextStatus = (context = null) => {
  if (!context) return null;
  const explicit = context.status || context.quality?.status || null;
  if (['ready-populated', 'ready-empty', 'stale', 'unavailable'].includes(explicit)) return explicit;
  // Receipts written before the quality vocabulary was introduced carried
  // only `ready`. Derive the new state from the retained receipt contents so
  // a fresh process does not present a legacy false-positive as current truth.
  const selectedCounts = context.quality?.selectedCounts || {
    policy: Array.isArray(context.policyAnchors) ? context.policyAnchors.length : 0,
    facts: Array.isArray(context.semanticFacts) ? context.semanticFacts.length : 0,
    constraints: Array.isArray(context.ontologyConstraints) ? context.ontologyConstraints.length : 0,
    graph: Array.isArray(context.graphSynopsis) ? context.graphSynopsis.length : 0,
  };
  const usableRecordCount = Number.isFinite(Number(context.quality?.usableRecordCount))
    ? Number(context.quality.usableRecordCount)
    : Object.values(selectedCounts).reduce((sum, count) => sum + (Number(count) || 0), 0);
  if (usableRecordCount > 0) return 'ready-populated';
  const omittedCounts = context.quality?.omittedCounts || {};
  if ((Number(omittedCounts.stale) || 0) > 0
    || (Number(omittedCounts.unavailable) || 0) > 0
    || (Array.isArray(context.staleOrUnavailable) && context.staleOrUnavailable.length > 0)) return 'stale';
  return 'ready-empty';
};

const obligationsForCompletionProjection = (obligations = []) => obligations.map((obligation) => (
  // Kernel marks an obligation `passed` after recording its receipt. The
  // completion projector still needs the row to classify that receipt as a
  // required hard/judgment outcome; otherwise a resumed Run reports
  // `not-required` after it has actually produced proof.
  obligation?.status === 'passed' ? { ...obligation, status: 'required' } : obligation
));

const resumeActionFor = ({ run, step, completion, reviewExecution, gitCloseout }) => {
  if (gitCloseout?.requested && !['committed', 'pushed'].includes(gitCloseout.status)) return 'retry-finalization';
  if (completion.overall === 'done') return 'none';
  if (run?.status === 'completed' || completion.kernelAcceptance === 'accepted') return 'retry-finalization';
  if (run?.blockedReason) {
    if (run.blockedReason === 'security-review' || reviewExecution === 'interrupted') return 'resume-independent-review';
    if (run.blockedReason === 'unsupported-verification') return 'add-supported-verification';
    return 'resolve-blocker';
  }
  if (completion.review === 'failed') return 'address-review-findings';
  if (completion.verification === 'failed') return 'fix-failing-verification';
  if (completion.review === 'pending' && ['failed', 'blocked'].includes(step?.state)) {
    return reviewExecution === 'interrupted' ? 'resume-independent-review' : 'start-independent-review';
  }
  // The derived action should describe the first unfinished obligation in
  // execution order. A judgment obligation can already be pending while the
  // implementation step is still active; surfacing review first would make a
  // resumed session skip the work Kernel has actually issued.
  if (completion.implementation !== 'complete') return 'continue-implementation';
  if (completion.verification === 'pending') return 'run-verification';
  if (completion.review === 'pending') {
    return reviewExecution === 'interrupted' ? 'resume-independent-review' : 'start-independent-review';
  }
  return 'submit-kernel-report';
};

// A read-only projection assembled from the existing Run and receipt
// authorities. None of these display fields are lifecycle state; a fresh
// process can derive the same answer after reopening SQLite.
export const buildResumeView = ({
  run,
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
} = {}) => {
  if (!run) return null;
  // Control-plane callers often pass the full evaluateCompletion result,
  // whose `decision`/`gates` fields are useful to the Kernel but which does
  // not carry the compact `overall`, `verification`, and `review` projection.
  // Recompute that read model unless the caller already supplied the compact
  // shape; otherwise resume views would expose an undefined overall state.
  const resolvedCompletion = completion?.overall
    ? completion
    : computeCompletionView({
      run,
      step,
      verifications,
      obligations: obligationsForCompletionProjection(obligations),
      reviews,
      completionDecision,
    });
  const reviewExecution = latestReviewExecution({ run, reviews, routeDecisions, usageReceipts });
  const git = gitResumeState(gitCloseout, finalizationReceipt);
  const reason = run.blockedReason
    || (resolvedCompletion.verification === 'failed' ? 'verification-failed' : null)
    || (resolvedCompletion.review === 'failed' ? 'review-failed' : null)
    || (resolvedCompletion.kernelAcceptance === 'rejected' ? 'completion-rejected' : null);
  const finalizationStatus = run.finalizationStatus === 'completed'
    ? 'complete'
    : run.status === 'blocked'
      ? 'blocked'
      : run.finalizationStatus || finalizationReceipt?.finalizationStatus || 'pending';
  const resolvedContextStatus = contextStatus(context);
  const durableState = buildKernelDurableStateView({ run, workAuthority, verifications, obligations, completion: resolvedCompletion, completionDecision });
  return {
    schemaVersion: 1,
    durableState,
    ...(workAuthority ? { workAuthority } : {}),
    task: ['active', 'blocked'].includes(run.status) ? 'active' : 'idle',
    kernel: {
      state: run.state || run.currentState || null,
      overall: resolvedCompletion.overall,
      reason,
      blockingClass: run.blockingClass || (reason ? 'safety' : null),
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
      execution: resolvedCompletion.review === 'not-required' ? 'not-required' : reviewExecution,
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
        degraded: context.degradedContext === true || resolvedContextStatus !== 'ready-populated',
      }
      : null,
    resume: {
      action: resumeActionFor({ run, step, completion: resolvedCompletion, reviewExecution, gitCloseout: git }),
    },
  };
};

const atomicWriteFile = async (filePath, content) => {
  const tmpPath = `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  await writeFile(tmpPath, content);
  await rename(tmpPath, filePath);
};

export const readProjection = async ({ outputDir }) => {
  const bundle = JSON.parse(await readFile(path.join(outputDir, 'projection-bundle.json'), 'utf8'));
  if (bundle.schemaVersion !== 1 || !bundle.json || bundle.bundleId !== bundle.json.bundleId) {
    throw new Error('Kernel projection bundle is invalid');
  }
  return bundle.json;
};

export const writeProjection = async ({ run, outputDir }) => {
  await mkdir(outputDir, { recursive: true });
  const p = buildProjection(run);

  const jsonContent = JSON.stringify(p, null, 2);
  const mdContent = `# Kernel Run ${run.runId}\n\n- Status: ${run.status}\n- State: ${run.state}\n- Runtime revision: ${run.revision}\n- Mutation revision: ${run.mutationRevision}\n- Source digest: ${p.sourceDigest}\n`;

  // The bundle is the atomic authority; the JSON and Markdown files are read-only projections.
  await atomicWriteFile(path.join(outputDir, 'projection-bundle.json'), JSON.stringify({ schemaVersion: 1, bundleId: p.bundleId, json: p, markdown: mdContent }, null, 2));
  await atomicWriteFile(path.join(outputDir, 'run-status.json'), jsonContent);
  await atomicWriteFile(path.join(outputDir, 'STATE.md'), mdContent);
  return p;
};

export const verifyProjection = async ({ run, file }) => {
  const bundled = await readProjection({ outputDir: path.dirname(file) });
  const actual = JSON.parse(await readFile(file, 'utf8'));
  const expected = buildProjection(run);
  return {
    valid:
      JSON.stringify(actual) === JSON.stringify(bundled) &&
      actual.sourceDigest === expected.sourceDigest &&
      actual.runtimeRevision === expected.runtimeRevision &&
      actual.mutationRevision === expected.mutationRevision &&
      actual.status === expected.status &&
      actual.currentState === expected.currentState &&
      actual.runId === expected.runId,
    actual,
    expected,
  };
};

export const projectRunState = async (run, { runtimeHome } = {}) => {
  if (!run || !runtimeHome) return null;
  const outputDir = run.projectId
    ? resolveRunArtifactPaths({ runtimeHome, projectId: run.projectId, runId: run.runId }).projections
    : path.join(runtimeHome, 'projections', run.runId);
  return writeProjection({ run, outputDir });
};
