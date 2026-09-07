// Work cursor API (K1 + K2). The step ledger and the execution capsule are one
// concern: which unit of work is current, and what bounded context that unit is
// executed with. They live here rather than in the control plane so the control
// plane stays a control plane.
//
// These are control-plane METHODS: they are spread into the object the control
// plane returns, so `this` is the control plane and they can reach the run
// lifecycle (stage knowledge, implementation context, replan accounting).

import { buildExecutionCapsule, buildReviewCapsule, capsuleStaleness, findScopeViolations } from './execution-capsule.mjs';
import { digestOfChangedFiles, extractRelevantSymbols, rankRelevantFiles, selectKnowledgeRecords } from './capsule-selection.mjs';
import { currentStep as selectCurrentStep, dependenciesSatisfied, deriveParallelBatch, detectStepStagnation, evaluateStepCompletion } from './run-step-ledger.mjs';
import { planReplacementSteps, planRunSteps } from './step-planner.mjs';
import { scanRepositoryEvidence } from '../task/evidence-scan.mjs';
import { canonicalDigest } from '../canonical-digest.mjs';
import { gitLsFiles } from '../../lib/git-safe.mjs';
import { observeWorkspaceIdentity, observeScopedWorkspaceIdentity } from './workspace-identity.mjs';
import { authoritativeVerificationScope } from './obligation-compiler.mjs';
import { projectRunState } from '../state-projector.mjs';
import { assertAttemptLineage } from './attempt-provenance.mjs';
import { assertImplementationWorkUnitScope, resolveWorkUnitAllowedPaths } from './work-unit-scope.mjs';
import { assertRunWorktreeMutationAuthority } from './worktree-binding.mjs';

const rejectGenericRunAuthority = ({ store, run, worktree, report, stepWorkspaceId = null }) => {
  const reject = (errorCode, errorSummary, obligationId = 'worktree') => ({
    rejection: [{
      obligationId,
      command: 'kernel report',
      errorSummary,
      errorCode,
    }],
  });
  try {
    assertRunWorktreeMutationAuthority({ stateStore: store, run, worktree });
  } catch (error) {
    return reject(
      error.code || 'run_worktree_authority_invalid',
      `Report does not hold the current Run worktree authority: ${error.message}`,
    );
  }
  if (report.workspaceId) {
    const reportedWorkspace = store.getProjectWorkspace?.(report.workspaceId) || null;
    if (!reportedWorkspace || reportedWorkspace.projectId !== run.projectId) {
      return reject('report_workspace_invalid', 'Report workspace is not registered for this Run project', 'workspace');
    }
    if (run.worktreeId && report.workspaceId !== stepWorkspaceId) {
      if (reportedWorkspace.worktreeId !== run.worktreeId) {
        return reject('run_worktree_mismatch', 'Report workspace is not the Run worktree', 'workspace');
      }
    } else if (!run.worktreeId && report.workspaceId !== stepWorkspaceId && reportedWorkspace.workspaceId !== run.workspaceId) {
      return reject('run_workspace_mismatch', 'Report workspace is not the legacy Run workspace', 'workspace');
    }
  }
  return null;
};

const parallelWorkerLimit = (run) => (
  run?.proofTier === 'T3'
    && (run?.independentReviewRequired === true || run?.taskContract?.flags?.independentReviewRequired === true || run?.taskContract?.independentReview === true)
    ? 3
    : 2
);

export const createWorkCursorApi = ({ store, projectRoot, runtimeHome, worktree = null }) => ({
  bindStepAttempt(runId, stepId, binding = {}) {
    const step = store.getRunStep(runId, stepId);
    if (!step) throw Object.assign(new Error('step-not-found'), { code: 'STEP_NOT_FOUND' });
    assertImplementationWorkUnitScope({ step, contract: store.getRun(runId)?.taskContract || null, actionType: 'implement' });
    store.updateRunStep(runId, stepId, {
      state: 'running',
      executionWorkspaceId: binding.workspaceId || null,
      baseWorkspaceIdentity: binding.baseWorkspaceIdentity || null,
      capsuleDigest: binding.capsuleDigest || null,
    });
    return store.recordStepAttempt(runId, {
      stepId,
      bindingId: binding.bindingId || store.getRunOwnerBinding?.(runId)?.bindingId || null,
      actorSessionId: binding.actorSessionId,
      capsuleId: binding.capsuleId,
      capsuleDigest: binding.capsuleDigest,
      admissionId: binding.admissionId,
      provenanceKind: 'routed',
      planRevision: step.planRevision,
      mutationRevision: store.getRun(runId)?.mutationRevision || 0,
      workspaceId: binding.workspaceId,
      workspaceRootHash: binding.workspaceRootHash,
      baseWorkspaceIdentity: binding.baseWorkspaceIdentity || null,
      workspaceIdentityStart: binding.workspaceIdentity || binding.baseWorkspaceIdentity || null,
      verificationRefs: binding.verificationRefs || [],
      knowledgeObservationRefs: binding.knowledgeObservationRefs || [],
    });
  },

  updateStepAttempt(attemptId, patch = {}) {
    return store.updateStepAttempt(attemptId, patch);
  },

  // All execution modes enter through this function. It deliberately creates
  // the canonical step attempt before a provider dispatch or a direct report;
  // the legacy run-level attempt is only a compatibility projection.
  beginAttempt(runId, {
    stepId = null,
    attemptId = null,
    bindingId = null,
    actorSessionId = null,
    capsuleId = null,
    capsuleDigest = null,
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
  } = {}) {
    const run = store.getRun(runId);
    if (!run) throw new Error(`Run ${runId} not found`);
    const step = stepId ? store.getRunStep(runId, stepId) : this.getCurrentStep(runId);
    if (!step) throw new Error(`Run ${runId} has no current step`);
    if (['ready', 'failed', 'planned'].includes(step.state)) {
      this.startStep(runId, step.stepId, { workspaceIdentity: workspaceIdentityStart, capsuleDigest });
    }
    const ownerBinding = bindingId ? null : store.getRunOwnerBinding?.(runId);
    return store.recordStepAttempt(runId, {
      stepId: step.stepId,
      attemptId,
      bindingId: bindingId || ownerBinding?.bindingId || null,
      actorSessionId: actorSessionId || ownerBinding?.sessionId || null,
      capsuleId,
      capsuleDigest,
      admissionId,
      routeDecisionId,
      usageReceiptId,
      parentAttemptId,
      provenanceKind,
      planRevision: planRevision || step.planRevision || run.planRevision,
      mutationRevision: mutationRevision ?? run.mutationRevision,
      retryReason,
      failureCategory,
      workspaceIdentityStart,
      summary,
      changedPaths,
      workspaceId,
      workspaceRootHash,
      baseWorkspaceIdentity,
      verificationRefs,
      knowledgeObservationRefs,
    });
  },

  getActiveAttempt(runId, options = {}) {
    return store.getActiveStepAttempt(runId, options);
  },

  attachAttemptLineage(attemptId, patch = {}) {
    return store.attachAttemptLineage(attemptId, patch);
  },

  assertAttemptLineage(attempt, expected = {}) {
    return assertAttemptLineage(attempt, expected);
  },

  recordStepResult(runId, stepId, result) {
    return store.recordStepResult(runId, stepId, result);
  },

  failStepAttempt(runId, stepId, failure) {
    const step = store.getRunStep(runId, stepId);
    if (!step) throw Object.assign(new Error('step-not-found'), { code: 'STEP_NOT_FOUND' });
    const attempt = store.getActiveStepAttempt(runId, { stepId })
      || store.getStepAttempts(runId, { stepId }).at(-1);
    if (attempt) {
      const reason = failure?.code || failure?.message || String(failure || 'worker-failed');
      const interrupted = attempt.status === 'interrupted';
      store.finishStepAttempt(attempt.id, {
        status: interrupted ? 'interrupted' : 'failed',
        failureReasons: [reason],
        failureCategory: interrupted ? (attempt.failureCategory || 'provider/infrastructure') : reason,
      });
    }
    return this.failStep(runId, stepId, { reason: failure?.code || failure?.message || 'worker-failed' });
  },

  // --- Run Step Ledger (K2) -------------------------------------------
  // No model-visible command is added: `next` returns the current step inside
  // the action it already returned, and `report` answers it.

  getRunSteps(runId, options = {}) {
    return store.getRunSteps(runId, options);
  },

  getCurrentStep(runId) {
    const run = store.getRun(runId);
    if (!run) return null;
    return selectCurrentStep(this.ensureRunStepsMigrated(runId), { planRevision: run.planRevision });
  },

  // K4 migration. A run that started before the ledger existed has no steps.
  // It is given a recovery step at its CURRENT state rather than being
  // replayed, and the step is marked so its origin stays readable.
  ensureRunStepsMigrated(runId) {
    const existing = store.getRunSteps(runId);
    if (existing.length > 0) return existing;
    const run = store.getRun(runId);
    if (!run) return [];
    const obligations = store.getRunObligations(runId);
    const contract = run.taskContract || {};
    const [recovery] = planRunSteps({
      run,
      contract: { ...contract, steps: [] },
      obligations,
      route: run.route || {},
      planRevision: Number(run.planRevision || 1),
    }).steps;
    store.createRunSteps(runId, [{ ...recovery, objective: `${recovery.objective}`, migrationOrigin: 'legacy-run' }]);
    // A run that is already past implementation resumes at its own state; the
    // recovery step is a cursor for what remains, not a replay of what happened.
    return store.getRunSteps(runId);
  },

  startStep(runId, stepId, { workspaceIdentity = null, capsuleDigest = null } = {}) {
    const step = store.getRunStep(runId, stepId);
    if (!step) throw new Error(`Run step ${stepId} not found for run ${runId}`);
    if (step.state === 'running') return step;
    return store.updateRunStep(runId, stepId, {
      state: 'running',
      startedAt: step.startedAt || new Date().toISOString(),
      workspaceIdentityStart: step.workspaceIdentityStart || workspaceIdentity,
      capsuleDigest: capsuleDigest || step.capsuleDigest,
    });
  },

  completeStep(runId, stepId, { workspaceIdentity = null, resultDigest = null } = {}) {
    const completed = store.updateRunStep(runId, stepId, {
      state: 'passed',
      completedAt: new Date().toISOString(),
      workspaceIdentityEnd: workspaceIdentity,
      resultDigest,
    });
    this.unlockDependentSteps(runId);
    return completed;
  },

  failStep(runId, stepId, { reason = null } = {}) {
    return store.updateRunStep(runId, stepId, { state: 'failed', blockedReason: reason });
  },

  // A step whose dependencies have all passed becomes runnable. Doing this on
  // completion, rather than at selection time, keeps the ledger readable: the
  // stored state always says what is actually available.
  unlockDependentSteps(runId) {
    const steps = store.getRunSteps(runId);
    for (const step of steps) {
      if (step.state !== 'planned') continue;
      if (!dependenciesSatisfied(step, steps)) continue;
      store.updateRunStep(runId, step.stepId, { state: 'ready' });
    }
    return store.getRunSteps(runId);
  },

  // Replan (§7.5): the live steps of the current revision are superseded and a
  // replacement plan is written at the next revision. Nothing that was already
  // attempted is edited.
  async replanSteps(runId, { steps = [], resumeBlockedReason = null } = {}) {
    const run = store.getRun(runId);
    if (!run) throw new Error(`Run ${runId} not found`);
    const nextRevision = Number(run.planRevision || 1) + 1;
    const replacement = planReplacementSteps({
      run,
      contract: run.taskContract || {},
      obligations: store.getRunObligations(runId),
      planRevision: nextRevision,
      deltaSteps: steps,
      // Step ids are unique per run, so a replacement that reuses a declared id
      // is qualified rather than silently colliding with the step it replaces.
      reservedStepIds: store.getRunSteps(runId).map((step) => step.stepId),
    });
    const replaced = store.replaceRunPlanAtomic(runId, {
      currentPlanRevision: run.planRevision,
      nextPlanRevision: nextRevision,
      steps: replacement,
      resumeBlockedReason,
    });
    await projectRunState(replaced.run, { runtimeHome });
    return { planRevision: nextRevision, steps: replaced.steps };
  },

  // The Host may ask for a derived parallel selection. The ledger remains the
  // only progress authority; selection is recomputed from current Step rows,
  // disjoint scopes, and a transient host worker bound.
  getExecutableSteps(runId) {
    const run = store.getRun(runId);
    if (!run) return { steps: [], reason: 'run-not-found', mode: 'sequential' };
    const steps = this.ensureRunStepsMigrated(runId);
    const selection = deriveParallelBatch(steps, {
      planRevision: run.planRevision,
      maxWorkers: parallelWorkerLimit(run),
    });
    return {
      steps: selection.steps,
      reason: selection.reason,
      mode: selection.steps.length > 1 ? 'parallel' : 'sequential',
      parallelEligible: selection.steps.length > 1,
    };
  },

  // True when any live step of the current plan is stuck. A later selection
  // naturally narrows to the retryable Step; no lifecycle state is suspended.
  planIsStagnant(runId) {
    const run = store.getRun(runId);
    return this.ensureRunStepsMigrated(runId)
      .filter((step) => step.planRevision === run.planRevision && !['passed', 'superseded', 'cancelled'].includes(step.state))
      .some((step) => detectStepStagnation({ step, attempts: store.getStepAttempts(runId, { stepId: step.stepId }) }).stagnant);
  },

  detectStepStagnation(runId, { stepId = null } = {}) {
    const step = stepId ? store.getRunStep(runId, stepId) : this.getCurrentStep(runId);
    if (!step) return { stagnant: false, signals: {}, attemptCount: 0, recommendation: 'retry' };
    return detectStepStagnation({ step, attempts: store.getStepAttempts(runId, { stepId: step.stepId }) });
  },

  // Which step a report answers. An explicit stepId must be the live one; with
  // a decomposed plan and several runnable units, an unnamed step is genuinely
  // ambiguous and is refused rather than guessed.
  resolveReportStep(runId, report) {
    const run = store.getRun(runId);
    const steps = this.ensureRunStepsMigrated(runId);
    if (steps.length === 0) return { step: null };
    const scoped = steps.filter((step) => step.planRevision === run.planRevision);
    const reportedStep = report.stepId ? scoped.find((step) => step.stepId === report.stepId) : null;
    const authority = rejectGenericRunAuthority({
      store,
      run,
      worktree,
      report,
      stepWorkspaceId: reportedStep?.executionWorkspaceId || null,
    });
    if (authority) return authority;
    const rejectStaleAttempt = (attempt, stepId) => {
      if (!attempt) return null;
      try {
        assertAttemptLineage(attempt, {
          runId,
          stepId,
          planRevision: run.planRevision,
          mutationRevision: run.mutationRevision,
        });
        return null;
      } catch (error) {
        return {
          rejection: [{
            obligationId: 'attempt',
            command: 'kernel report',
            errorSummary: `Attempt lineage does not match the current run: ${error.message}`,
            errorCode: error.code || 'attempt_lineage_incomplete',
          }],
        };
      }
    };
    const rejectIncompleteAttemptCredentials = (attempt, report) => {
      // Legacy rows have no stable identifier and remain readable as
      // legacy-unattributed. Once a canonical attempt exists, a report must
      // carry every credential that the attempt has bound before it can be
      // attributed to that attempt.
      if (!attempt?.attemptId) return null;
      const boundCapsuleId = attempt.capsuleId || (attempt.capsuleDigest && !String(attempt.capsuleDigest).startsWith('sha256:') ? attempt.capsuleDigest : null);
      if (boundCapsuleId && !report.capsuleId) {
        return { rejection: [{ obligationId: 'capsule', command: 'kernel report', errorSummary: 'Report must include the capsuleId of the active attempt' }] };
      }
      return null;
    };

    if (report.stepId) {
      const named = scoped.find((step) => step.stepId === report.stepId);
      if (!named) {
        const otherRevision = steps.find((step) => step.stepId === report.stepId);
        return {
          rejection: [{
            obligationId: 'step',
            command: 'kernel report',
            errorSummary: otherRevision
              ? `Step "${report.stepId}" belongs to plan revision ${otherRevision.planRevision}; this run is on revision ${run.planRevision}`
              : `Step "${report.stepId}" does not exist for this run`,
          }],
        };
      }
      if (named.state === 'passed') {
        const active = selectCurrentStep(steps, { planRevision: run.planRevision });
        const workspaceChanged = observeWorkspaceIdentity({ projectRoot }).identity !== run.currentWorkspaceIdentity;
        if (!active && workspaceChanged && report.changedPaths.length > 0 && !report.capsuleId) {
          return { step: named, reopened: true };
        }
        const lastPassedAttempt = store.getStepAttempts(runId, { stepId: named.stepId })
          .filter((attempt) => attempt.status === 'passed').at(-1);
        const normalized = (paths = []) => [...new Set(paths.map(String))].sort();
        const sameChangedPaths = JSON.stringify(normalized(report.changedPaths)) === JSON.stringify(normalized(lastPassedAttempt?.changedPaths || []));
        if (!active && run.state === 'PROVE' && sameChangedPaths && !report.capsuleId) {
          return { step: null, settledStep: named };
        }
        return { rejection: [{ obligationId: 'step', command: 'kernel report', errorSummary: `Step "${named.stepId}" is already passed and only an unchanged PROVE finalization report may follow` }] };
      }
      if (['superseded', 'cancelled'].includes(named.state)) {
        return { rejection: [{ obligationId: 'step', command: 'kernel report', errorSummary: `Step "${named.stepId}" is already ${named.state} and cannot be reported again` }] };
      }
      const attempt = store.getActiveStepAttempt(runId, {
        stepId: named.stepId,
        attemptId: report.attemptId,
        capsuleId: report.capsuleId,
      });
      if (report.attemptId && !attempt) {
        return { rejection: [{ obligationId: 'attempt', command: 'kernel report', errorSummary: `Attempt "${report.attemptId}" is not an active attempt for step "${named.stepId}"` }] };
      }
      if (attempt && report.capsuleId) {
        const boundCapsuleId = attempt.capsuleId || (attempt.capsuleDigest && !String(attempt.capsuleDigest).startsWith('sha256:') ? attempt.capsuleDigest : null);
        if (boundCapsuleId && boundCapsuleId !== report.capsuleId) {
          return { rejection: [{ obligationId: 'capsule', command: 'kernel report', errorSummary: 'Report capsule does not match the active step attempt' }] };
        }
      }
      if (report.bindingId && (!attempt || attempt.bindingId !== report.bindingId)) {
        return { rejection: [{ obligationId: 'binding', command: 'kernel report', errorSummary: 'Report binding does not match the active step attempt' }] };
      }
      const active = selectCurrentStep(steps, { planRevision: run.planRevision });
      // A derived parallel selection may have more than one running Step. An
      // explicitly identified Step with its own active attempt is authoritative
      // for that report; only an unbound competing Step is rejected.
      if (active && active.stepId !== named.stepId && !attempt) {
        return { rejection: [{ obligationId: 'step', command: 'kernel report', errorSummary: `Step "${named.stepId}" is not the current work unit and has no active attempt` }] };
      }
      const incompleteCredentials = rejectIncompleteAttemptCredentials(attempt, report);
      if (incompleteCredentials) return incompleteCredentials;
      const staleAttempt = rejectStaleAttempt(attempt, named.stepId);
      if (staleAttempt) return staleAttempt;
      return { step: named, attempt };
    }

    const runnable = deriveParallelBatch(steps, { planRevision: run.planRevision }).steps;
    const active = selectCurrentStep(steps, { planRevision: run.planRevision });
    const liveCount = scoped.filter((step) => !['passed', 'superseded', 'cancelled'].includes(step.state)).length;
    if (!active) return { step: null };
    if (liveCount > 1 && runnable.length > 1) {
      return { rejection: [{ obligationId: 'step', command: 'kernel report', errorSummary: `This run has a decomposed plan; name the stepId the report answers (current: ${active.stepId})` }] };
    }
    const attempt = store.getActiveStepAttempt(runId, {
      stepId: active.stepId,
      attemptId: report.attemptId,
      capsuleId: report.capsuleId,
    });
    if (report.attemptId && !attempt) {
      return { rejection: [{ obligationId: 'attempt', command: 'kernel report', errorSummary: `Attempt "${report.attemptId}" is not an active attempt for step "${active.stepId}"` }] };
    }
    if (report.bindingId) {
      const ownerBinding = store.getRunOwnerBinding?.(runId);
      if ((attempt && attempt.bindingId !== report.bindingId) || (!attempt && ownerBinding?.bindingId !== report.bindingId)) {
        return { rejection: [{ obligationId: 'binding', command: 'kernel report', errorSummary: 'Report binding does not match the current work unit' }] };
      }
    }
    if (attempt && report.capsuleId) {
      const boundCapsuleId = attempt.capsuleId || (attempt.capsuleDigest && !String(attempt.capsuleDigest).startsWith('sha256:') ? attempt.capsuleDigest : null);
      if (boundCapsuleId && boundCapsuleId !== report.capsuleId) {
        return { rejection: [{ obligationId: 'capsule', command: 'kernel report', errorSummary: 'Report capsule does not match the active step attempt' }] };
      }
    }
    const incompleteCredentials = rejectIncompleteAttemptCredentials(attempt, report);
    if (incompleteCredentials) return incompleteCredentials;
    const staleAttempt = rejectStaleAttempt(attempt, active.stepId);
    if (staleAttempt) return staleAttempt;
    return { step: active, attempt };
  },

  // K1: the bounded execution context for ONE unit of work. Everything in it
  // comes from persisted state, the command catalog, and a scoped repository
  // scan — never from the conversation. Built deterministically, so a fresh
  // process rebuilds the same capsule id from the same SQLite state.
  async buildCapsule(runId, { role = 'implementer', decision = null, step = null, objective = null, changedPaths = [], workspaceIdentity = null } = {}) {
    const persistedRun = store.getRun(runId);
    const run = workspaceIdentity ? { ...persistedRun, currentWorkspaceIdentity: workspaceIdentity } : persistedRun;
    if (!run) throw new Error(`Run ${runId} not found`);
    // The capsule is scoped to the step the ledger says is current (K2), so a
    // decomposed run hands each worker only its own unit.
    step = step || this.getCurrentStep(runId);
    if (role === 'reviewer') return this.buildReviewerCapsule(runId, { decision, step, changedPaths });

    const obligations = store.getRunObligations(runId);
    const verificationScopeIdentities = {};
    for (const obligation of obligations) {
      const authority = authoritativeVerificationScope(obligation);
      if (!authority) continue;
      verificationScopeIdentities[obligation.obligationId] = observeScopedWorkspaceIdentity({
        projectRoot,
        scopes: authority.scope,
      });
    }
    const completion = store.evaluateCompletion(runId, { verificationScopeIdentities });
    const outstanding = completion.unsatisfiedObligations.map((entry) => entry.obligationId);
    const knowledgeContext = await this.refreshStageKnowledge(runId);
    const contract = run.taskContract;
    const allowedPaths = resolveWorkUnitAllowedPaths({ step, contract });

    const projectContext = await this.buildImplementationContext(runId, run);
    const relevantFiles = run.projectMode === 'greenfield' ? [] : rankRelevantFiles({
      candidates: (gitLsFiles(projectRoot).stdout || '').split(/\r?\n/).filter(Boolean),
      allowedPaths,
      acceptancePaths: [],
      changedPaths: changedPaths.length > 0 ? changedPaths : scanRepositoryEvidence({ projectRoot }).dirtyPaths,
      projectRoot,
    });
    const selected = selectKnowledgeRecords({ knowledgeContext, allowedPaths });

    const capsule = buildExecutionCapsule({
      run,
      step,
      decision,
      objective,
      contract,
      obligations,
      outstandingObligations: outstanding,
      knowledgeContext,
      repositoryContext: {
        projectMode: run.projectMode,
        entrypoints: projectContext.entrypoints || [],
        manifests: projectContext.manifests || [],
        knownCommands: projectContext.knownCommands || [],
        walkingSkeleton: projectContext.walkingSkeleton || null,
        relevantFiles: relevantFiles.map((file) => ({ path: file.path, reason: file.reason, digest: file.digest })),
          relevantSymbols: extractRelevantSymbols({ projectRoot, files: relevantFiles }),
        architectureRecords: selected.architectureRecords,
        knowledgeRecords: selected.knowledgeRecords,
        baseline: {
          status: projectContext.baseline?.status || 'unknown',
          digest: null,
          knownFailures: [...(run.baselineFailures || []), ...selected.knownFailurePatterns].slice(0, 10),
        },
      },
    });
    return store.recordExecutionCapsule(runId, capsule);
  },

  // Reviewers receive a different capsule (§6.8): subject, evidence, scope —
  // no implementer reasoning, no project knowledge, no write permission.
  async buildReviewerCapsule(runId, { decision = null, step = null, stage = 'engineering', obligationId = null, requiredChecks = [], changedPaths = [] } = {}) {
    const run = store.getRun(runId);
    if (!run) throw new Error(`Run ${runId} not found`);
    const capsule = buildReviewCapsule({
      run,
      step,
      decision,
      contract: run.taskContract,
      stage,
      obligationId,
      requiredChecks,
      changedPaths,
      // Identifies the exact file states the verdict is formed on, without
      // carrying the diff itself into the capsule.
      diffDigest: digestOfChangedFiles({ projectRoot, changedPaths }),
      // Independent judgments review the current subject and hard verification
      // evidence. Feeding prior judgment rows into another judgment creates a
      // circular dependency: one stale or failed review can poison every
      // sibling review, including its own retry through the sibling chain.
      verifications: store.getVerifications(runId)
        .filter((verification) => verification.evidenceClass !== 'judgment'),
      implementationSession: store.getImplementationPrincipal(runId),
    });
    return store.recordExecutionCapsule(runId, capsule);
  },

  // Moves one step through reported -> verifying -> passed|failed against the
  // evidence that now exists. A synthetic step carries the whole run, so it is
  // settled by the run-level obligation check; a declared step is settled by
  // the acceptance and obligations it was actually made responsible for.
  settleStep(runId, {
    step,
    attempt,
    report,
    failures = [],
    outstanding = [],
    requiredObligationIds = null,
    observation,
    persistAttempt = true,
  }) {
    const run = store.getRun(runId);
    store.updateRunStep(runId, step.stepId, { state: 'reported' });
    store.updateRunStep(runId, step.stepId, { state: 'verifying' });

    const evaluation = step.synthetic
      ? { complete: outstanding.length === 0, reasons: outstanding.map((obligationId) => `obligation-unsatisfied:${obligationId}`) }
      : evaluateStepCompletion({
        step,
        verifications: store.getVerifications(runId),
        run,
        acceptance: run.taskContract?.acceptance || [],
        requiredObligationIds,
      });

    const resultDigest = canonicalDigest({
      stepId: step.stepId,
      planRevision: step.planRevision,
      mutationRevision: run.mutationRevision,
      changedPaths: [...report.changedPaths].sort(),
      failures: failures.map((failure) => failure.obligationId).sort(),
    });

    const passed = failures.length === 0 && evaluation.complete;
    if (passed) {
      this.completeStep(runId, step.stepId, { workspaceIdentity: observation.identity, resultDigest });
    } else {
      this.failStep(runId, step.stepId, { reason: evaluation.reasons[0] || 'evidence-failed' });
    }
    const attemptSettlement = attempt ? {
        status: passed ? 'passed' : 'failed',
        workspaceIdentityEnd: observation.identity,
        changedPaths: report.changedPaths,
        resultDigest,
        verificationRefs: store.getVerifications(runId).map((verification) => verification.evidenceRef).filter(Boolean),
        failureReasons: passed ? [] : [...evaluation.reasons, ...failures.map((failure) => failure.errorSummary).filter(Boolean)],
        failureCategory: passed ? null : (failures[0]?.failureCategory || 'proof'),
    } : null;
    if (attempt && persistAttempt) {
      store.finishStepAttempt(attempt.id, attemptSettlement);
    }

    const attemptsForStagnation = store.getStepAttempts(runId, { stepId: step.stepId })
      .filter((candidate) => !attempt || candidate.id !== attempt.id);
    if (attempt && attemptSettlement) {
      attemptsForStagnation.push({ ...attempt, ...attemptSettlement, stepId: step.stepId });
    }
    const stagnation = passed
      ? { stagnant: false, recommendation: 'retry', signals: {} }
      : detectStepStagnation({ step, attempts: attemptsForStagnation });
    const outcome = {
      stepId: step.stepId,
      state: passed ? 'passed' : 'failed',
      synthetic: step.synthetic,
      planRevision: step.planRevision,
      reasons: passed ? [] : evaluation.reasons,
      resultDigest,
      // A stuck step is replanned, not retried forever (§7.9).
      stagnation,
    };
    // Keep the settlement receipt available to the control plane without
    // making it part of the model-visible Step result. The control plane can
    // then commit this receipt and the exact report result together.
    Object.defineProperty(outcome, 'attemptSettlement', {
      value: attemptSettlement,
      enumerable: false,
    });
    return outcome;
  },

  // Returns the rejection list when a report cannot be accepted against the
  // capsule it claims, or null when the report is in scope. Runs that never
  // received a capsule (no Host routing) are unaffected.
  assertCapsuleScope(runId, report, step = null) {
    const run = store.getRun(runId);
    const named = report.capsuleId ? store.getExecutionCapsule(report.capsuleId, { runId }) : null;
    if (report.capsuleId && !named) {
      return [{ obligationId: 'capsule', command: 'kernel report', errorSummary: `Execution capsule "${report.capsuleId}" was not issued for this run` }];
    }
    const capsule = named || store.latestExecutionCapsule(runId, { role: 'implementer' });

    // A named capsule must still describe this run; naming a stale one is an
    // error rather than something to silently fall back from.
    const capsuleRun = step?.baseWorkspaceIdentity
      ? { ...run, currentWorkspaceIdentity: step.baseWorkspaceIdentity }
      : run;
    if (report.capsuleId) {
      const staleness = capsuleStaleness({ capsule, run: capsuleRun });
      if (staleness.stale) {
        return [{ obligationId: 'capsule', command: 'kernel report', errorSummary: `Execution capsule "${capsule.capsuleId}" no longer describes this run: ${staleness.reasons.join(', ')}. Request the current action again to receive a fresh capsule.` }];
      }
    }

    // The scope actually enforced comes from the capsule ONLY while that capsule
    // is current and belongs to the step being reported. Otherwise the step's
    // own scope governs — a superseded capsule must never widen or narrow the
    // replacement step's boundary.
    const capsuleGoverns = Boolean(capsule)
      && !capsuleStaleness({ capsule, run: capsuleRun }).stale
      && (!capsule.stepId || (Boolean(step) && capsule.stepId === step.stepId));
    const scope = capsuleGoverns
      ? { source: 'capsule', label: `work unit ${capsule.capsuleId}`, obligationId: 'capsule', allowedPaths: capsule.workUnit?.allowedPaths || [], forbiddenPaths: capsule.workUnit?.forbiddenPaths || [] }
      : (step ? { source: 'step', label: `step ${step.stepId}`, obligationId: 'step', allowedPaths: step.allowedPaths || [], forbiddenPaths: step.forbiddenPaths || [] } : null);
    if (!scope) return null;

    const violations = findScopeViolations({
      changedPaths: report.changedPaths,
      allowedPaths: scope.allowedPaths,
      forbiddenPaths: scope.forbiddenPaths,
    });
    if (violations.length === 0) return null;
    return violations.map((violation) => ({
      obligationId: scope.obligationId,
      command: 'kernel report',
      errorSummary: `Changed path "${violation.path}" is ${violation.reason === 'forbidden-path' ? 'inside a forbidden path' : 'outside the allowed paths'} of ${scope.label} (allowed: ${scope.allowedPaths.join(', ') || 'none'})`,
    }));
  },
});
